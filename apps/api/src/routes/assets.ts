import { createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { DeleteObjectCommand, DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { assets, categories, jobs, renditions, aiJobs, ASSET_STATUS, SOURCE_TYPE, JOB_STATUS, JOB_TYPE, S3_PATHS, ID_LENGTH, TIER_LIMITS, UNLIMITED_TIER_LIMITS, WEBHOOK_EVENT, METADATA_LIMITS, type OrgTier } from '@hovod/db';
import { db } from '../db.js';
import { env, hasStripe } from '../env.js';
import { s3Client, s3PublicClient } from '../s3.js';
import { enqueueTranscodeJob } from '../queue.js';
import { findAssetOrFail, getThumbnailUrl, getSourceKey } from '../services/asset.js';
import { findCategoryOrFail } from './categories.js';
import { checkLimit } from '../services/metering.js';
import { dispatchWebhook } from '../services/webhooks.js';
import { AppError, NotFoundError } from '../middleware/error-handler.js';
import { generateVttFromSegments } from '../services/vtt.js';

const customMetadataSchema = z.record(
  z.string().min(1).max(METADATA_LIMITS.MAX_KEY_LENGTH),
  z.string().max(METADATA_LIMITS.MAX_VALUE_LENGTH),
).refine(
  (obj) => Object.keys(obj).length <= METADATA_LIMITS.MAX_KEYS,
  `Maximum ${METADATA_LIMITS.MAX_KEYS} metadata entries allowed`,
);

const createAssetBody = z.object({
  title: z.string().min(1).max(255),
  metadata: customMetadataSchema.optional(),
  categoryId: z.string().min(1).max(36).optional(),
});
const importAssetBody = z.object({
  sourceUrl: z.string().url().max(2048).refine(
    (url) => url.startsWith('https://') || url.startsWith('http://'),
    'Only http and https URLs are allowed',
  ),
});

const supportedUploadContentTypes = [
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-matroska',
  'video/x-msvideo',
  'video/mpeg',
  'video/ogg',
] as const;
const MAX_SOURCE_UPLOAD_BYTES = 50 * 1024 * 1024 * 1024;

/** Sentinel `categoryId` selecting assets that have none. */
const UNCATEGORIZED = 'uncategorized';
// ponytail: `GET /v1/assets` has no pagination, so export inherits that ceiling.
// Raise it behind pagination + a streaming response, not by bumping this number.
const EXPORT_ROW_LIMIT = 10_000;

/** RFC 4180 cell: quote when the value contains a comma, quote or newline. */
function csvCell(value: string | number) {
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const uploadUrlBody = z.object({
  // Optional so existing clients that always upload MP4 keep working.
  contentType: z.string().min(1).max(100).optional(),
}).optional();

const processBody = z.object({
  aiOptions: z.object({
    transcription: z.boolean().default(true),
    subtitles: z.boolean().default(true),
    chapters: z.boolean().default(true),
  }).optional(),
}).optional();

type ProcessBody = z.infer<typeof processBody>;

type QueueResult = {
  jobId: string;
  alreadyQueued: boolean;
};

export async function assetRoutes(app: FastifyInstance) {
  const findActiveTranscodeJob = async (assetId: string) => {
    const [activeJob] = await db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(
        eq(jobs.assetId, assetId),
        eq(jobs.type, JOB_TYPE.TRANSCODE),
        inArray(jobs.status, [JOB_STATUS.QUEUED, JOB_STATUS.PROCESSING]),
      ))
      .orderBy(desc(jobs.createdAt))
      .limit(1);
    return activeJob;
  };

  /** Atomically create the durable queue-outbox record and state transition. */
  const queueAssetForTranscode = async (
    assetId: string,
    expectedStatus: typeof ASSET_STATUS.UPLOADED | typeof ASSET_STATUS.ERROR,
    body?: ProcessBody,
    currentMetadata?: unknown,
  ): Promise<QueueResult> => {
    const jobId = nanoid(ID_LENGTH.JOB);
    const metadata = body?.aiOptions
      ? JSON.stringify({
          ...(currentMetadata
            ? (typeof currentMetadata === 'string' ? JSON.parse(currentMetadata) : currentMetadata) as Record<string, unknown>
            : {}),
          aiOptions: body.aiOptions,
        })
      : undefined;

    const createdJobId = await db.transaction(async (tx) => {
      const updateResult = await tx.update(assets)
        .set({
          status: ASSET_STATUS.QUEUED,
          errorMessage: null,
          ...(metadata ? { metadata } : {}),
        })
        .where(and(eq(assets.id, assetId), eq(assets.status, expectedStatus)));

      if (updateResult[0].affectedRows === 0) return null;

      // A failed attempt may have written a subset of renditions before a
      // later step failed. They are not playable without a ready asset and
      // must not be duplicated by the retry.
      if (expectedStatus === ASSET_STATUS.ERROR) {
        await tx.delete(renditions).where(eq(renditions.assetId, assetId));
      }

      await tx.insert(jobs).values({
        id: jobId,
        assetId,
        type: JOB_TYPE.TRANSCODE,
        status: JOB_STATUS.QUEUED,
        attempts: 0,
      });
      return jobId;
    });

    if (createdJobId) return { jobId: createdJobId, alreadyQueued: false };

    // A concurrent click/retry won the conditional state transition. Return
    // that active job instead of inserting a duplicate queue record.
    const activeJob = await findActiveTranscodeJob(assetId);
    if (activeJob) return { jobId: activeJob.id, alreadyQueued: true };

    throw new AppError(409, 'Asset is no longer in a processable state', 'ASSET_ALREADY_PROCESSING');
  };

  const ensureRetrySourceExists = async (asset: typeof assets.$inferSelect) => {
    if (asset.sourceUrl) return;

    if (asset.sourceKey) {
      const inObjectStorage = await s3Client
        .send(new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: asset.sourceKey }))
        .then(() => true)
        .catch(() => false);
      if (inObjectStorage) return;
    }

    // Direct/proxy uploads can still be waiting on the shared volume when a
    // transcode fails before its archival S3 upload.
    const localSource = path.join(env.UPLOAD_DIR, asset.id, 'input.mp4');
    const localStat = await stat(localSource).catch(() => null);
    if (localStat?.isFile() && localStat.size > 0) return;

    throw new AppError(409, 'The uploaded source is no longer available', 'ASSET_SOURCE_MISSING');
  };

  const enqueueOrReportUnavailable = async (assetId: string, jobId: string) => {
    try {
      await enqueueTranscodeJob(jobId, assetId);
    } catch (error) {
      app.log.warn({ err: error, assetId, jobId }, 'Transcode job was committed but could not be enqueued');
      // The reconciler will retry this durable queued job. Returning an
      // explicit error lets the client display an honest recoverable state.
      throw new AppError(503, 'Processing queue is temporarily unavailable; the job will be retried automatically', 'QUEUE_UNAVAILABLE');
    }
  };

  /* Create asset */
  app.post<{ Body: z.infer<typeof createAssetBody> }>('/v1/assets', async (request, reply) => {
    const body = createAssetBody.parse(request.body);
    const id = nanoid(ID_LENGTH.ASSET);
    const playbackId = nanoid(ID_LENGTH.PLAYBACK);

    // Check asset limit (enforced only with Stripe billing)
    if (hasStripe && request.orgId) {
      const limits = TIER_LIMITS[request.orgTier as OrgTier] ?? TIER_LIMITS.free;
      if (limits.maxAssets !== -1) {
        const existing = await db.select({ id: assets.id }).from(assets).where(eq(assets.orgId, request.orgId!));
        if (existing.length >= limits.maxAssets) {
          throw new AppError(403, `Asset limit reached (${limits.maxAssets} on ${request.orgTier} plan). Upgrade for unlimited assets.`);
        }
      }
    }

    // Reject a stale/foreign category before creating anything.
    if (body.categoryId) await findCategoryOrFail(body.categoryId, request.orgId);

    await db.insert(assets).values({
      id,
      orgId: request.orgId!,
      title: body.title,
      categoryId: body.categoryId ?? null,
      playbackId,
      status: ASSET_STATUS.CREATED,
      sourceType: SOURCE_TYPE.UPLOAD,
      ...(body.metadata ? { customMetadata: body.metadata } : {}),
    });

    reply.code(201);
    return { data: { id, playbackId, status: ASSET_STATUS.CREATED } };
  });

  /** Assets of one org, newest first, optionally narrowed to a single category.
   *  `uncategorized` selects the assets with no category. */
  const listAssetsForOrg = async (orgId: string, categoryId?: string) => {
    const filters = [eq(assets.orgId, orgId)];
    if (categoryId === UNCATEGORIZED) filters.push(isNull(assets.categoryId));
    else if (categoryId) filters.push(eq(assets.categoryId, categoryId));

    return db
      .select({ asset: assets, category: { id: categories.id, name: categories.name, color: categories.color } })
      .from(assets)
      .leftJoin(categories, eq(assets.categoryId, categories.id))
      .where(and(...filters))
      .orderBy(desc(assets.createdAt))
      .limit(EXPORT_ROW_LIMIT + 1);
  };

  /* List assets */
  app.get<{ Querystring: { categoryId?: string } }>('/v1/assets', async (request) => {
    const rows = await listAssetsForOrg(request.orgId!, request.query.categoryId);
    return {
      data: rows.slice(0, EXPORT_ROW_LIMIT).map(({ asset: a, category }) => ({
        ...a,
        category: category?.id ? category : null,
        thumbnailUrl: getThumbnailUrl(a.id, a.status, a.customThumbnailKey),
        hasCustomThumbnail: !!a.customThumbnailKey,
      })),
    };
  });

  /* Export assets + their category as CSV */
  app.get<{ Querystring: { categoryId?: string } }>('/v1/assets/export.csv', async (request, reply) => {
    const rows = await listAssetsForOrg(request.orgId!, request.query.categoryId);
    const truncated = rows.length > EXPORT_ROW_LIMIT;

    const header = ['id', 'title', 'category', 'status', 'duration_sec', 'playback_id', 'created_at'];
    const lines = [header.join(',')];
    for (const { asset: a, category } of rows.slice(0, EXPORT_ROW_LIMIT)) {
      lines.push([
        a.id, a.title, category?.name ?? '', a.status,
        a.durationSec ?? '', a.playbackId, a.createdAt.toISOString(),
      ].map(csvCell).join(','));
    }

    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="videos-${new Date().toISOString().slice(0, 10)}.csv"`);
    if (truncated) reply.header('X-Truncated', 'true');
    // Excel opens UTF-8 CSV as latin-1 without a BOM, mangling non-ASCII titles.
    return reply.send('\uFEFF' + lines.join('\n'));
  });

  /* Get asset by ID */
  app.get<{ Params: { id: string } }>('/v1/assets/:id', async (request) => {
    const asset = await findAssetOrFail(request.params.id, request.orgId);
    const assetRenditions = await db.select().from(renditions).where(eq(renditions.assetId, asset.id));
    const [aiJob] = await db.select().from(aiJobs).where(eq(aiJobs.assetId, asset.id)).limit(1);
    const [activeJob] = await db.select({ currentStep: jobs.currentStep }).from(jobs).where(and(eq(jobs.assetId, asset.id), eq(jobs.status, JOB_STATUS.PROCESSING))).limit(1);
    const [category] = asset.categoryId
      ? await db.select({ id: categories.id, name: categories.name, color: categories.color }).from(categories).where(eq(categories.id, asset.categoryId)).limit(1)
      : [];
    return {
      data: {
        ...asset,
        category: category ?? null,
        thumbnailUrl: getThumbnailUrl(asset.id, asset.status, asset.customThumbnailKey),
        hasCustomThumbnail: !!asset.customThumbnailKey,
        currentStep: activeJob?.currentStep ?? null,
        renditions: assetRenditions,
        aiJob: aiJob ? {
          status: aiJob.status,
          transcriptionStatus: aiJob.transcriptionStatus,
          subtitlesStatus: aiJob.subtitlesStatus,
          chaptersStatus: aiJob.chaptersStatus,
          language: aiJob.language,
        } : null,
      },
    };
  });

  /* Get upload URL */
  app.post<{ Params: { id: string }; Body: z.infer<typeof uploadUrlBody> }>('/v1/assets/:id/upload-url', async (request) => {
    const body = uploadUrlBody.parse(request.body);
    const asset = await findAssetOrFail(request.params.id, request.orgId);
    if (asset.status !== ASSET_STATUS.CREATED) {
      throw new AppError(409, 'An upload source has already been confirmed for this asset', 'ASSET_ALREADY_PROCESSING');
    }
    const sourceKey = getSourceKey(asset.id);
    const contentType = (body?.contentType ?? 'video/mp4').toLowerCase();
    if (!(supportedUploadContentTypes as readonly string[]).includes(contentType)) {
      throw new AppError(415, 'Unsupported video content type', 'UNSUPPORTED_MEDIA_TYPE');
    }

    const command = new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: sourceKey,
      ContentType: contentType,
    });

    const uploadUrl = await getSignedUrl(s3PublicClient, command, { expiresIn: 3600 });
    await db.update(assets).set({ sourceKey }).where(eq(assets.id, asset.id));

    return { data: { uploadUrl, sourceKey, method: 'PUT', expiresIn: 3600 } };
  });

  /* Confirm S3 presigned upload completed — verifies file exists before marking uploaded */
  app.post<{ Params: { id: string } }>('/v1/assets/:id/upload-complete', async (request) => {
    const asset = await findAssetOrFail(request.params.id, request.orgId);
    if (!asset.sourceKey) {
      throw new AppError(409, 'No upload URL was generated for this asset', 'UPLOAD_NOT_CONFIRMED');
    }

    if (asset.status !== ASSET_STATUS.CREATED) {
      return { data: { id: asset.id, status: asset.status, alreadyConfirmed: true } };
    }

    // Verify the file actually exists on S3
    try {
      const source = await s3Client.send(new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: asset.sourceKey }));
      if (!source.ContentLength) {
        throw new AppError(400, 'Uploaded file is empty', 'UPLOAD_NOT_CONFIRMED');
      }
      if (source.ContentLength > MAX_SOURCE_UPLOAD_BYTES) {
        throw new AppError(413, 'Uploaded file exceeds the 50 GB source limit', 'FILE_TOO_LARGE');
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(400, 'File not found on storage — upload may have failed', 'UPLOAD_NOT_CONFIRMED');
    }

    const updateResult = await db.update(assets)
      .set({ status: ASSET_STATUS.UPLOADED })
      .where(and(eq(assets.id, asset.id), eq(assets.status, ASSET_STATUS.CREATED)));

    if (updateResult[0].affectedRows === 0) {
      const latest = await findAssetOrFail(asset.id, request.orgId);
      return { data: { id: latest.id, status: latest.status, alreadyConfirmed: true } };
    }

    return { data: { id: asset.id, status: ASSET_STATUS.UPLOADED, alreadyConfirmed: false } };
  });

  /* Direct upload (saves to shared volume — Worker reads directly, no S3 round-trip) */
  app.register(async function uploadProxy(scope) {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', function (_req, payload, done) {
      done(null, payload);
    });

    scope.put<{ Params: { id: string } }>('/v1/assets/:id/upload', {
      bodyLimit: 5_368_709_120, // 5 GB
    }, async (request, reply) => {
      const asset = await findAssetOrFail(request.params.id, request.orgId);
      if (asset.status !== ASSET_STATUS.CREATED) {
        return reply.code(409).send({ error: 'Asset already has a source' });
      }

      const uploadDir = path.join(env.UPLOAD_DIR, asset.id);
      await mkdir(uploadDir, { recursive: true });
      const filePath = path.join(uploadDir, 'input.mp4');

      await pipeline(request.body as Readable, createWriteStream(filePath));

      const sourceKey = getSourceKey(asset.id);
      const updateResult = await db.update(assets)
        .set({ sourceKey, status: ASSET_STATUS.UPLOADED })
        .where(and(eq(assets.id, asset.id), eq(assets.status, ASSET_STATUS.CREATED)));

      if (updateResult[0].affectedRows === 0) {
        return reply.code(409).send({ error: 'Asset was modified concurrently' });
      }

      return { data: { id: asset.id, sourceKey, status: ASSET_STATUS.UPLOADED } };
    });
  });

  /* Import from URL */
  app.post<{ Params: { id: string }; Body: z.infer<typeof importAssetBody> }>('/v1/assets/:id/import', async (request) => {
    const { id } = request.params;
    const body = importAssetBody.parse(request.body);

    // Verify ownership in cloud mode
    await findAssetOrFail(id, request.orgId);

    const result = await db
      .update(assets)
      .set({ sourceType: SOURCE_TYPE.URL, sourceUrl: body.sourceUrl, status: ASSET_STATUS.UPLOADED })
      .where(eq(assets.id, id));

    if (result[0].affectedRows === 0) {
      await findAssetOrFail(id);
    }

    return { data: { id, sourceUrl: body.sourceUrl, status: ASSET_STATUS.UPLOADED } };
  });

  /* Start processing */
  app.post<{ Params: { id: string }; Body: ProcessBody }>('/v1/assets/:id/process', async (request) => {
    const body = processBody.parse(request.body);
    const asset = await findAssetOrFail(request.params.id, request.orgId);

    if (asset.status === ASSET_STATUS.QUEUED || asset.status === ASSET_STATUS.PROCESSING) {
      const activeJob = await findActiveTranscodeJob(asset.id);
      if (!activeJob) {
        throw new AppError(409, 'Asset is already being processed', 'ASSET_ALREADY_PROCESSING');
      }
      return {
        data: {
          assetId: asset.id,
          jobId: activeJob.id,
          status: JOB_STATUS.QUEUED,
          accepted: true,
          alreadyQueued: true,
        },
      };
    }

    // Check encoding minutes limit (enforced only with Stripe billing)
    if (hasStripe && request.orgId) {
      const limits = TIER_LIMITS[request.orgTier as OrgTier] ?? TIER_LIMITS.free;
      const withinLimit = await checkLimit(request.orgId, 'encodingMinutes', limits.encodingMinutes);
      if (!withinLimit) {
        throw new AppError(403, `Encoding minutes limit reached (${limits.encodingMinutes} min on ${request.orgTier} plan). Upgrade for more.`);
      }
    }

    if (asset.status !== ASSET_STATUS.UPLOADED) {
      const errorCode = asset.status === ASSET_STATUS.CREATED ? 'UPLOAD_NOT_CONFIRMED' : 'ASSET_NOT_RETRYABLE';
      throw new AppError(409, 'Asset must have an uploaded source before it can be processed', errorCode);
    }

    const result = await queueAssetForTranscode(asset.id, ASSET_STATUS.UPLOADED, body, asset.metadata);
    if (!result.alreadyQueued) await enqueueOrReportUnavailable(asset.id, result.jobId);

    return {
      data: {
        assetId: asset.id,
        jobId: result.jobId,
        status: JOB_STATUS.QUEUED,
        accepted: true,
        alreadyQueued: result.alreadyQueued,
      },
    };
  });

  /* Requeue an asset after terminal transcode failure. */
  app.post<{ Params: { id: string }; Body: ProcessBody }>('/v1/assets/:id/retry', async (request) => {
    const body = processBody.parse(request.body);
    const asset = await findAssetOrFail(request.params.id, request.orgId);
    if (asset.status !== ASSET_STATUS.ERROR) {
      throw new AppError(409, 'Only failed assets can be retried', 'ASSET_NOT_RETRYABLE');
    }

    await ensureRetrySourceExists(asset);
    const result = await queueAssetForTranscode(asset.id, ASSET_STATUS.ERROR, body, asset.metadata);
    if (!result.alreadyQueued) await enqueueOrReportUnavailable(asset.id, result.jobId);

    return {
      data: {
        assetId: asset.id,
        jobId: result.jobId,
        status: JOB_STATUS.QUEUED,
        accepted: true,
        alreadyQueued: result.alreadyQueued,
      },
    };
  });

  /* Delete asset (hard delete: DB + S3) */
  app.delete<{ Params: { id: string } }>('/v1/assets/:id', async (request) => {
    const asset = await findAssetOrFail(request.params.id, request.orgId);

    // Delete all S3 objects under sources/{id}/ and playback/{id}/
    const prefixes = [
      `${S3_PATHS.SOURCES_PREFIX}/${asset.id}/`,
      `${S3_PATHS.PLAYBACK_PREFIX}/${asset.id}/`,
    ];

    for (const prefix of prefixes) {
      let continuationToken: string | undefined;
      do {
        const list = await s3Client.send(new ListObjectsV2Command({
          Bucket: env.S3_BUCKET,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }));

        if (list.Contents && list.Contents.length > 0) {
          await s3Client.send(new DeleteObjectsCommand({
            Bucket: env.S3_BUCKET,
            Delete: { Objects: list.Contents.map((o) => ({ Key: o.Key })) },
          }));
        }

        continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
      } while (continuationToken);
    }

    // Hard delete from DB (FK CASCADE removes renditions + jobs)
    await db.delete(assets).where(eq(assets.id, asset.id));

    // Dispatch webhook (fire-and-forget)
    dispatchWebhook(WEBHOOK_EVENT.ASSET_DELETED, { assetId: asset.id, title: asset.title }, asset.orgId).catch(() => {});

    return { data: { id: asset.id, deleted: true } };
  });

  /* ─── Inline editing endpoints ─────────────────────────── */

  const publicSettingsSchema = z.object({
    allowDownload: z.boolean(),
    showTranscript: z.boolean(),
    showChapters: z.boolean(),
    showComments: z.boolean(),
  });

  const updateAssetBody = z.object({
    title: z.string().min(1).max(255).optional(),
    description: z.string().max(10000).optional(),
    publicSettings: publicSettingsSchema.optional(),
    metadata: customMetadataSchema.optional(),
    categoryId: z.string().min(1).max(36).nullable().optional(),
  });

  /* Update asset (title + description + public settings + metadata) */
  app.patch<{ Params: { id: string } }>('/v1/assets/:id', async (request) => {
    const body = updateAssetBody.parse(request.body);
    if (!body.title && body.description === undefined && !body.publicSettings && body.metadata === undefined && body.categoryId === undefined) {
      throw new AppError(400, 'Nothing to update');
    }
    const asset = await findAssetOrFail(request.params.id, request.orgId);
    const updates: Record<string, unknown> = {};
    if (body.title) updates.title = body.title;
    if (body.description !== undefined) updates.description = body.description || null;
    if (body.publicSettings) updates.publicSettings = body.publicSettings;
    if (body.metadata !== undefined) updates.customMetadata = body.metadata;
    if (body.categoryId !== undefined) {
      if (body.categoryId) await findCategoryOrFail(body.categoryId, request.orgId);
      updates.categoryId = body.categoryId;
    }
    await db.update(assets).set(updates).where(eq(assets.id, asset.id));
    return { data: { id: asset.id, ...updates } };
  });

  /* Upload custom thumbnail */
  app.register(async function thumbnailUpload(scope) {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', function (_req, payload, done) {
      done(null, payload);
    });

    scope.put<{ Params: { id: string }; Body: AsyncIterable<Buffer> }>('/v1/assets/:id/thumbnail', {
      bodyLimit: 10_485_760, // 10 MB
    }, async (request) => {
      const asset = await findAssetOrFail(request.params.id, request.orgId);
      const contentType = (request.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      const extMap: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
      const ext = extMap[contentType];
      if (!ext) throw new AppError(400, 'Unsupported image type — use JPG, PNG, or WebP');
      // Unique key per upload so the public URL changes on every replacement (cache-bust by design)
      const thumbnailKey = `${S3_PATHS.PLAYBACK_PREFIX}/${asset.id}/custom-thumbnail-${nanoid(8)}.${ext}`;

      const chunks: Buffer[] = [];
      for await (const chunk of request.body) {
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);
      if (buffer.length === 0) throw new AppError(400, 'Empty image file');

      await s3Client.send(new PutObjectCommand({
        Bucket: env.S3_BUCKET,
        Key: thumbnailKey,
        Body: buffer,
        ContentType: contentType,
        ACL: 'public-read',
      }));

      // Remove the previous custom thumbnail to avoid orphaned objects
      if (asset.customThumbnailKey && asset.customThumbnailKey !== thumbnailKey) {
        await s3Client.send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: asset.customThumbnailKey })).catch(() => {});
      }

      await db.update(assets).set({ customThumbnailKey: thumbnailKey }).where(eq(assets.id, asset.id));

      return {
        data: { thumbnailUrl: `${env.S3_PUBLIC_BASE_URL}/${thumbnailKey}`, hasCustomThumbnail: true },
      };
    });
  });

  /* Reset thumbnail to the auto-generated frame (removes the custom override) */
  app.delete<{ Params: { id: string } }>('/v1/assets/:id/thumbnail', async (request) => {
    const asset = await findAssetOrFail(request.params.id, request.orgId);
    if (asset.customThumbnailKey) {
      await s3Client.send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: asset.customThumbnailKey })).catch(() => {});
      await db.update(assets).set({ customThumbnailKey: null }).where(eq(assets.id, asset.id));
    }
    return {
      data: {
        thumbnailUrl: getThumbnailUrl(asset.id, asset.status, null),
        hasCustomThumbnail: false,
      },
    };
  });

  /* Download original source file or rendition */
  app.get<{ Params: { id: string }; Querystring: { quality?: string } }>('/v1/assets/:id/download', async (request) => {
    const asset = await findAssetOrFail(request.params.id, request.orgId);
    const { quality } = request.query;

    if (quality) {
      // Download a specific rendition MP4
      const s3Key = `${S3_PATHS.PLAYBACK_PREFIX}/${asset.id}/${quality}/download.mp4`;
      const [headResult, downloadUrl] = await Promise.all([
        s3Client.send(new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: s3Key })).catch(() => null),
        getSignedUrl(s3PublicClient, new GetObjectCommand({
          Bucket: env.S3_BUCKET,
          Key: s3Key,
          ResponseContentDisposition: `attachment; filename="${encodeURIComponent(asset.title)}-${quality}.mp4"`,
        }), { expiresIn: 3600 }),
      ]);
      if (!headResult) throw new NotFoundError('Rendition download not available');
      return { data: { downloadUrl, fileSizeBytes: headResult.ContentLength ?? null } };
    }

    // Download original source
    if (!asset.sourceKey) throw new NotFoundError('No source file available');

    const [headResult, downloadUrl] = await Promise.all([
      s3Client.send(new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: asset.sourceKey })).catch(() => null),
      getSignedUrl(s3PublicClient, new GetObjectCommand({
        Bucket: env.S3_BUCKET,
        Key: asset.sourceKey,
        ResponseContentDisposition: `attachment; filename="${encodeURIComponent(asset.title)}.mp4"`,
      }), { expiresIn: 3600 }),
    ]);

    return { data: { downloadUrl, fileSizeBytes: headResult?.ContentLength ?? null } };
  });

  const updateTranscriptBody = z.object({
    transcript: z.object({
      language: z.string(),
      duration: z.number(),
      text: z.string(),
      segments: z.array(z.object({
        id: z.number(),
        start: z.number(),
        end: z.number(),
        text: z.string(),
        words: z.array(z.object({ word: z.string(), start: z.number(), end: z.number() })).optional(),
      })),
    }),
  });

  /* Update transcript + regenerate subtitles */
  app.patch<{ Params: { id: string }; Body: z.infer<typeof updateTranscriptBody> }>('/v1/assets/:id/transcript', async (request) => {
    const { transcript } = updateTranscriptBody.parse(request.body);
    const asset = await findAssetOrFail(request.params.id, request.orgId);
    const prefix = `${S3_PATHS.PLAYBACK_PREFIX}/${asset.id}`;

    // Upload updated transcript.json
    await s3Client.send(new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: `${prefix}/${S3_PATHS.AI_TRANSCRIPT}`,
      Body: JSON.stringify(transcript, null, 2),
      ContentType: 'application/json',
      ACL: 'public-read',
    }));

    // Regenerate and upload subtitles.vtt
    const vtt = generateVttFromSegments(transcript.segments);
    await s3Client.send(new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: `${prefix}/${S3_PATHS.AI_SUBTITLES}`,
      Body: vtt,
      ContentType: 'text/vtt',
      ACL: 'public-read',
    }));

    return { data: { id: asset.id, updated: ['transcript', 'subtitles'] } };
  });

  const updateChaptersBody = z.object({
    chapters: z.array(z.object({
      title: z.string(),
      startTime: z.number(),
      endTime: z.number(),
    })),
  });

  /* Update chapters */
  app.patch<{ Params: { id: string }; Body: z.infer<typeof updateChaptersBody> }>('/v1/assets/:id/chapters', async (request) => {
    const { chapters } = updateChaptersBody.parse(request.body);
    const asset = await findAssetOrFail(request.params.id, request.orgId);
    const prefix = `${S3_PATHS.PLAYBACK_PREFIX}/${asset.id}`;

    await s3Client.send(new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: `${prefix}/${S3_PATHS.AI_CHAPTERS}`,
      Body: JSON.stringify({ chapters }, null, 2),
      ContentType: 'application/json',
      ACL: 'public-read',
    }));

    return { data: { id: asset.id, updated: ['chapters'] } };
  });
}
