import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
import { Queue, UnrecoverableError, Worker } from 'bullmq';
import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import { Redis } from 'ioredis';
import { nanoid } from 'nanoid';
import { assetDeletionTasks, assetSourceCleanupTasks, analyticsAssetStats, analyticsDaily, analyticsEvents, assets, organizations, settings, aiJobs, createDb, jobs, renditions, ASSET_STATUS, DELETION_TASK_STATUS, SOURCE_CLEANUP_TASK_STATUS, JOB_STATUS, AI_JOB_STATUS, S3_PATHS, ID_LENGTH, WEBHOOK_EVENT, PROCESSING_STEP } from '@hovod/db';
import { isNull } from 'drizzle-orm';
import { env } from './env.js';
import { createAnalyticsWorker } from './analytics-worker.js';
import { ffprobe } from './ffmpeg.js';
import { s3, uploadDirectory } from './s3.js';
import { generateThumbnails } from './thumbnails.js';
import {
  TRANSCODING_LADDER,
  filterLadder,
  transcodeRendition,
  createDownloadableMp4,
  extractPosterThumbnail,
  createMasterPlaylist,
  type EncodedRendition,
} from './transcoding.js';
import { isAiConfigured } from './ai/provider-factory.js';
import { processAi } from './ai/process.js';

const MAX_SOURCE_SIZE_BYTES = 50 * 1024 * 1024 * 1024; // 50 GB
const MAX_ERROR_MESSAGE_LENGTH = 200;

const jobDataSchema = z.object({
  assetId: z.string().min(1).max(36),
  jobId: z.string().min(1).max(36),
});

const deletionJobDataSchema = z.object({
  taskId: z.string().min(1).max(36),
  assetId: z.string().min(1).max(36),
});

const sourceCleanupJobDataSchema = z.object({
  taskId: z.string().min(1).max(36),
  assetId: z.string().min(1).max(36),
});

function sanitizeErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : 'Unknown worker error';
  return raw.slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

function isTerminalSourceError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : '';
  return /no source available|source file exceeds size limit|downloaded source file exceeds size limit|source video has no valid video stream|only http and https source urls are supported/i.test(message);
}

/* ─── Hardware-adaptive configuration ─────────────────────── */

function computeWorkerConfig() {
  const cpuCores = os.cpus().length;
  const totalMemGB = os.totalmem() / (1024 ** 3);
  // Reserve 1 GB for OS + Node.js overhead
  const availableMemGB = Math.max(1, totalMemGB - 1);

  // Each FFmpeg job uses ~1–1.5 GB (decoder + encoder buffers + Node overhead)
  const MEM_PER_JOB_GB = 1.5;
  // FFmpeg x264 sweet spot is ~4 threads; beyond that, diminishing returns
  const idealThreadsPerJob = Math.min(4, cpuCores);

  const memBasedConcurrency = Math.floor(availableMemGB / MEM_PER_JOB_GB);
  const cpuBasedConcurrency = Math.floor(cpuCores / idealThreadsPerJob);

  const concurrency = env.WORKER_CONCURRENCY
    ?? Math.max(1, Math.min(memBasedConcurrency, cpuBasedConcurrency));
  const ffmpegThreads = env.FFMPEG_THREADS
    ?? Math.max(1, Math.floor(cpuCores / concurrency));
  const dbPoolSize = env.DB_POOL_SIZE
    ?? Math.max(5, concurrency * 2 + 2);

  return { concurrency, ffmpegThreads, dbPoolSize, cpuCores, totalMemGB };
}

const workerConfig = computeWorkerConfig();

console.log('[worker] Hardware-adaptive config:');
console.log(`  CPU cores:      ${workerConfig.cpuCores}`);
console.log(`  Total RAM:      ${workerConfig.totalMemGB.toFixed(1)} GB`);
console.log(`  Concurrency:    ${workerConfig.concurrency} job(s)${env.WORKER_CONCURRENCY ? ' (override)' : ''}`);
console.log(`  FFmpeg threads: ${workerConfig.ffmpegThreads} per job${env.FFMPEG_THREADS !== undefined ? ' (override)' : ''}`);
console.log(`  DB pool size:   ${workerConfig.dbPoolSize}${env.DB_POOL_SIZE ? ' (override)' : ''}`);

const { db } = createDb(env.DATABASE_URL, {
  connectionLimit: workerConfig.dbPoolSize,
  idleTimeout: 60_000,
});

/* ─── Metering & Webhooks helpers (cloud mode) ───────────── */

const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 3, lazyConnect: true });
redis.connect().catch(() => { /* non-fatal */ });

const sourceCleanupQueue = new Queue('source-cleanup', { connection: { url: env.REDIS_URL } });
const SOURCE_CLEANUP_JOB_OPTIONS = { attempts: 3, backoff: { type: 'exponential' as const, delay: 1_000 } };

async function enqueueSourceCleanupTask(taskId: string, assetId: string) {
  return sourceCleanupQueue.add('source-cleanup', { taskId, assetId }, {
    ...SOURCE_CLEANUP_JOB_OPTIONS,
    jobId: taskId,
  });
}

async function trackEncoding(orgId: string | null, durationSec: number): Promise<void> {
  if (!orgId) return;
  const minutes = Math.ceil(durationSec / 60);
  const month = new Date().toISOString().slice(0, 7); // YYYY-MM
  const key = `usage:${orgId}:encodingMinutes:${month}`;
  const newVal = await redis.incrby(key, minutes);
  if (newVal === minutes) await redis.expire(key, 90 * 86400).catch(() => {});
}

async function resolveWebhookUrls(orgId: string | null): Promise<string[]> {
  const urls: string[] = [];
  if (orgId) {
    try {
      const [org] = await db.select({ webhookUrl: organizations.webhookUrl }).from(organizations).where(eq(organizations.id, orgId)).limit(1);
      if (org?.webhookUrl) urls.push(org.webhookUrl);
    } catch { /* non-fatal: org table may not exist in self-hosted */ }
  }
  if (env.WEBHOOK_URL) urls.push(env.WEBHOOK_URL);
  return urls;
}

async function fireWebhook(event: string, data: Record<string, unknown>, orgId?: string | null): Promise<void> {
  const urls = await resolveWebhookUrls(orgId ?? null);
  if (urls.length === 0) return;

  const payload = JSON.stringify({ type: event, data, timestamp: new Date().toISOString() });

  await Promise.allSettled(urls.map(async (url) => {
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      console.warn(`[worker] Webhook ${event} to ${url} failed: ${(err as Error).message}`);
    }
  }));
}

const worker = new Worker(
  'transcode',
  async (job) => {
    const { assetId, jobId } = jobDataSchema.parse(job.data);

    console.log(`[worker] Starting job ${jobId} for asset ${assetId}`);

    const [asset] = await db.select().from(assets).where(eq(assets.id, assetId)).limit(1);
    if (!asset) throw new Error(`Asset not found: ${assetId}`);

    // Skip if already processed (idempotency)
    if (asset.status === ASSET_STATUS.READY) {
      console.log(`[worker] Asset ${assetId} already ready, skipping`);
      return;
    }

    const setStep = (step: string) => db.update(jobs).set({ currentStep: step }).where(eq(jobs.id, jobId)).catch(() => {});

    await db.update(jobs).set({
      status: JOB_STATUS.PROCESSING,
      currentStep: PROCESSING_STEP.DOWNLOADING,
      attempts: job.attemptsMade + 1,
      errorMessage: null,
    }).where(eq(jobs.id, jobId));
    await db.update(assets).set({ status: ASSET_STATUS.PROCESSING }).where(eq(assets.id, assetId));

    const tmpDir = path.join(os.tmpdir(), `hovod-${randomUUID()}`);
    let sourcePath = path.join(tmpDir, 'source.mp4');
    const outputDir = path.join(tmpDir, 'hls');
    await mkdir(outputDir, { recursive: true });

    let cleanupSourceDir: string | null = null;

    try {
      /* Resolve source: local shared volume → URL → S3 fallback */
      const localSourcePath = path.join(env.UPLOAD_DIR, assetId, 'input.mp4');
      let useLocalSource = false;

      try {
        const localStat = await stat(localSourcePath);
        if (localStat.size === 0) throw new Error('Local source file is empty');
        if (localStat.size > MAX_SOURCE_SIZE_BYTES) throw new Error('Source file exceeds size limit');
        sourcePath = localSourcePath;
        useLocalSource = true;
        cleanupSourceDir = path.dirname(localSourcePath);
        console.log(`[worker] Using local source (${(localStat.size / (1024 * 1024)).toFixed(1)} MB)`);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;

        // Not available locally — download to tmpDir
        if (asset.sourceUrl) {
          const parsedUrl = new URL(asset.sourceUrl);
          if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
            throw new Error('Only http and https source URLs are supported');
          }

          console.log('[worker] Downloading from URL...');
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 10 * 60 * 1000);
          try {
            const response = await fetch(asset.sourceUrl, { signal: controller.signal });
            if (!response.ok) throw new Error(`Failed to fetch source URL: ${response.statusText}`);
            if (!response.body) throw new Error('Response body is empty');

            const contentLength = Number(response.headers.get('content-length') || '0');
            if (contentLength > MAX_SOURCE_SIZE_BYTES) {
              throw new Error(`Source file too large: ${(contentLength / (1024 * 1024 * 1024)).toFixed(1)} GB exceeds limit`);
            }

            await pipeline(Readable.fromWeb(response.body as never), createWriteStream(sourcePath));
          } finally {
            clearTimeout(timeout);
          }
        } else if (asset.sourceKey) {
          console.log('[worker] Downloading from S3 (fallback)...');
          const sourceObject = await s3.send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: asset.sourceKey }));
          if (sourceObject.ContentLength && sourceObject.ContentLength > MAX_SOURCE_SIZE_BYTES) {
            throw new Error(`Source file too large: ${(sourceObject.ContentLength / (1024 * 1024 * 1024)).toFixed(1)} GB exceeds limit`);
          }
          await pipeline(Readable.from(sourceObject.Body as AsyncIterable<Uint8Array>), createWriteStream(sourcePath));
        } else {
          throw new Error('No source available for asset');
        }
      }

      // Verify source file
      if (!useLocalSource) {
        const fileStat = await stat(sourcePath);
        if (fileStat.size > MAX_SOURCE_SIZE_BYTES) throw new Error('Downloaded source file exceeds size limit');
        if (fileStat.size === 0) throw new Error('Downloaded source file is empty');
      }

      /* Probe source video */
      await setStep(PROCESSING_STEP.PROBING);
      const probe = await ffprobe(sourcePath);
      console.log(`[worker] Source: ${probe.width}x${probe.height}, ${probe.duration.toFixed(1)}s`);

      if (probe.width === 0 || probe.height === 0) {
        throw new Error('Source video has no valid video stream');
      }

      /* Read the organization's output-quality setting. A malformed or
       * unavailable setting falls back to the standard four-rung ladder so a
       * transient settings failure never prevents playback. */
      let enabledRenditions = ['360p', '480p', '720p', '1080p'];
      try {
        const condition = asset.orgId ? eq(settings.orgId, asset.orgId) : isNull(settings.orgId);
        const [settingsRow] = await db.select({ enabledRenditions: settings.enabledRenditions })
          .from(settings).where(condition).limit(1);
        const configured = JSON.parse(settingsRow?.enabledRenditions ?? '[]');
        if (Array.isArray(configured) && configured.length > 0) {
          const allowed = new Set(['360p', '480p', '720p', '1080p']);
          const unique = [...new Set(configured)];
          if (unique.every((quality) => typeof quality === 'string' && allowed.has(quality))) {
            enabledRenditions = unique;
          }
        }
      } catch { /* retain the safe default */ }

      /* Transcode selected renditions only, skipping profiles above the source.
       * filterLadder retains the lowest selected profile for tiny sources so
       * every successfully processed video still has a playable stream. */
      const selectedProfiles = TRANSCODING_LADDER.filter((profile) => enabledRenditions.includes(profile.quality));
      const ladder = filterLadder(probe.width, probe.height, selectedProfiles);
      console.log(`[worker] Ladder: ${ladder.map(p => p.quality).join(', ')}`);

      const encoded: EncodedRendition[] = [];
      for (const profile of ladder) {
        console.log(`[worker] Transcoding ${profile.quality}...`);
        await setStep(`transcoding_${profile.quality}`);
        await transcodeRendition(sourcePath, outputDir, profile, probe.duration, workerConfig.ffmpegThreads);

        // Create a downloadable MP4 from HLS segments (fast remux, no re-encoding)
        await createDownloadableMp4(outputDir, profile);
        const mp4Path = path.join(outputDir, profile.quality, 'download.mp4');
        const mp4Stat = await stat(mp4Path).catch(() => null);

        // The profile is only an upper bound; record what ffmpeg actually
        // produced so portrait sources are not published as landscape. A probe
        // failure falls back to the profile rather than failing the asset.
        const probed = await ffprobe(mp4Path).catch(() => null);
        const output = probed !== null && probed.width > 0 && probed.height > 0
          ? { width: probed.width, height: probed.height }
          : { width: profile.width, height: profile.height };
        encoded.push({ profile, ...output });

        await db.insert(renditions).values({
          id: randomUUID(),
          assetId,
          quality: profile.quality,
          width: output.width,
          height: output.height,
          bitrateKbps: profile.bitrateKbps,
          fileSizeBytes: mp4Stat?.size ?? null,
          codec: 'h264',
          playlistPath: `${S3_PATHS.PLAYBACK_PREFIX}/${assetId}/${profile.quality}/index.m3u8`,
        });
      }

      /* Generate thumbnails */
      await setStep(PROCESSING_STEP.THUMBNAILS);
      console.log('[worker] Generating thumbnails...');
      await generateThumbnails(sourcePath, outputDir, probe.width, probe.height, probe.duration);
      await extractPosterThumbnail(sourcePath, outputDir, probe.duration);

      /* Create master playlist and upload */
      await createMasterPlaylist(outputDir, encoded);

      await setStep(PROCESSING_STEP.UPLOADING);
      console.log('[worker] Uploading to S3...');
      await uploadDirectory(outputDir, `${S3_PATHS.PLAYBACK_PREFIX}/${assetId}`);

      /* Mark as ready and durably request source cleanup when this org has
       * opted out of original retention. The task can safely run while AI
       * enrichment uses the local source file. */
      let keepOriginalSourceFiles = true;
      try {
        const condition = asset.orgId ? eq(settings.orgId, asset.orgId) : isNull(settings.orgId);
        const [settingsRow] = await db.select({ keepOriginalSourceFiles: settings.keepOriginalSourceFiles })
          .from(settings).where(condition).limit(1);
        keepOriginalSourceFiles = settingsRow?.keepOriginalSourceFiles !== 'false';
      } catch { /* preserve originals if settings are temporarily unavailable */ }

      const sourceCleanupTaskId = !keepOriginalSourceFiles && asset.sourceKey
        ? nanoid(ID_LENGTH.SOURCE_CLEANUP_TASK)
        : null;
      await db.transaction(async (tx) => {
        await tx.update(assets).set({ status: ASSET_STATUS.READY, durationSec: Math.round(probe.duration), errorMessage: null }).where(eq(assets.id, assetId));
        if (sourceCleanupTaskId) {
          await tx.insert(assetSourceCleanupTasks).values({
            id: sourceCleanupTaskId,
            assetId,
            orgId: asset.orgId,
            status: SOURCE_CLEANUP_TASK_STATUS.QUEUED,
            attempts: 0,
          });
        }
      });
      await db.update(jobs).set({ status: JOB_STATUS.COMPLETED, currentStep: null }).where(eq(jobs.id, jobId));
      if (sourceCleanupTaskId) {
        await enqueueSourceCleanupTask(sourceCleanupTaskId, assetId)
          .catch((error) => console.warn(`[source-cleanup] Task ${sourceCleanupTaskId} will be reconciled:`, (error as Error).message));
      }

      /* AI Processing — non-blocking enrichment (asset is already READY) */
      const meta = asset.metadata ? (typeof asset.metadata === 'string' ? JSON.parse(asset.metadata as string) : asset.metadata) as Record<string, unknown> : {};
      let aiOptions = meta.aiOptions as { transcription?: boolean; subtitles?: boolean; chapters?: boolean } | undefined;

      /* Read platform AI defaults from settings table if no per-asset override */
      if (!aiOptions) {
        try {
          const condition = asset.orgId ? eq(settings.orgId, asset.orgId) : isNull(settings.orgId);
          const [settingsRow] = await db.select({ aiAutoTranscribe: settings.aiAutoTranscribe, aiAutoChapter: settings.aiAutoChapter }).from(settings).where(condition).limit(1);
          if (settingsRow) {
            const transcribe = settingsRow.aiAutoTranscribe === 'true';
            const chapter = settingsRow.aiAutoChapter === 'true';
            if (!transcribe && !chapter) {
              console.log('[worker] AI processing disabled in platform settings, skipping');
            }
            aiOptions = { transcription: transcribe, subtitles: transcribe, chapters: chapter };
          }
        } catch { /* settings table may not exist yet — default to running AI */ }
      }

      if (isAiConfigured()) {
        await setStep(PROCESSING_STEP.AI_PROCESSING);
        const aiJobId = nanoid(ID_LENGTH.AI_JOB);
        await db.insert(aiJobs).values({ id: aiJobId, assetId, status: AI_JOB_STATUS.QUEUED });
        try {
          await processAi({ assetId, aiJobId, sourcePath, outputDir: tmpDir, durationSec: probe.duration, db, aiOptions });
          const aiDir = path.join(tmpDir, 'ai');
          await uploadDirectory(aiDir, `${S3_PATHS.PLAYBACK_PREFIX}/${assetId}/ai`);
          console.log(`[worker] AI outputs uploaded for asset ${assetId}`);
        } catch (aiError) {
          console.error('[worker] AI processing failed (non-fatal):', (aiError as Error).message);
        }
      }

      await setStep(PROCESSING_STEP.FINALIZING);

      /* Track encoding usage & fire webhook (fire-and-forget) */
      trackEncoding(asset.orgId, probe.duration).catch(() => {});
      fireWebhook(WEBHOOK_EVENT.ASSET_READY, {
        assetId,
        playbackId: asset.playbackId,
        duration: Math.round(probe.duration),
      }, asset.orgId).catch(() => {});

      /* Upload original source to S3 for download feature */
      if (asset.sourceKey && keepOriginalSourceFiles) {
        try {
          console.log('[worker] Uploading source to S3 for archival...');
          await s3.send(new PutObjectCommand({
            Bucket: env.S3_BUCKET,
            Key: asset.sourceKey,
            Body: createReadStream(sourcePath),
            ContentType: 'video/mp4',
          }));
        } catch (err) {
          console.warn('[worker] Source upload to S3 failed (non-fatal):', (err as Error).message);
        }
      }

      /* Clean up local source from shared volume */
      if (cleanupSourceDir) {
        try { await rm(cleanupSourceDir, { recursive: true, force: true }); } catch {}
      }

      console.log(`[worker] Job ${jobId} completed successfully`);
    } catch (error) {
      const message = sanitizeErrorMessage(error);
      console.error(`[worker] Job ${jobId} failed:`, message);

      const maximumAttempts = typeof job.opts.attempts === 'number' ? job.opts.attempts : 1;
      const failedAttempts = job.attemptsMade + 1;
      const terminal = isTerminalSourceError(error) || failedAttempts >= maximumAttempts;

      try {
        if (terminal) {
          await db.update(assets).set({ status: ASSET_STATUS.ERROR, errorMessage: message }).where(eq(assets.id, assetId));
          await db.update(jobs).set({
            status: JOB_STATUS.FAILED,
            currentStep: null,
            attempts: failedAttempts,
            errorMessage: message,
          }).where(and(eq(jobs.id, jobId), eq(jobs.assetId, assetId)));
        } else {
          // BullMQ applies the exponential backoff. Keep the durable records
          // queued so a restart/reconciler cannot mistake this for a terminal
          // failure while BullMQ is scheduling its next attempt.
          await db.update(assets).set({ status: ASSET_STATUS.QUEUED, errorMessage: null }).where(eq(assets.id, assetId));
          await db.update(jobs).set({
            status: JOB_STATUS.QUEUED,
            currentStep: null,
            attempts: failedAttempts,
            errorMessage: message,
          }).where(and(eq(jobs.id, jobId), eq(jobs.assetId, assetId)));
        }
      } catch (dbError) {
        console.error('[worker] Failed to update error status in database');
      }

      if (terminal) {
        fireWebhook(WEBHOOK_EVENT.ASSET_ERROR, { assetId, errorMessage: message }, asset.orgId).catch(() => {});
      }

      // Avoid retrying validation/source errors; infrastructure and provider
      // errors keep BullMQ's configured retry/backoff behavior.
      throw terminal ? new UnrecoverableError(message) : error;
    } finally {
      try {
        await rm(tmpDir, { recursive: true, force: true });
      } catch (cleanupError) {
        console.error(`[worker] Failed to clean up temp directory: ${tmpDir}`);
      }
    }
  },
  {
    connection: { url: env.REDIS_URL },
    concurrency: workerConfig.concurrency,
  },
);

worker.on('ready', () => {
  console.log('[worker] Worker ready, waiting for jobs...');
});

worker.on('failed', (job, err) => {
  console.error(`[worker] Job ${job?.id} failed:`, err.message);
});

/* ─── Asset deletion worker ───────────────────────────────── */

const assetDeletionWorker = new Worker(
  'asset-deletion',
  async (job) => {
    const { taskId, assetId } = deletionJobDataSchema.parse(job.data);
    const [task] = await db.select().from(assetDeletionTasks).where(eq(assetDeletionTasks.id, taskId)).limit(1);
    if (!task) return;

    const [asset] = await db.select().from(assets).where(eq(assets.id, assetId)).limit(1);
    if (!asset || asset.status !== ASSET_STATUS.DELETED) return;

    await db.update(assetDeletionTasks).set({
      status: DELETION_TASK_STATUS.PROCESSING,
      attempts: job.attemptsMade + 1,
      lastError: null,
    }).where(eq(assetDeletionTasks.id, taskId));

    try {
      for (const prefix of [
        `${S3_PATHS.SOURCES_PREFIX}/${assetId}/`,
        `${S3_PATHS.PLAYBACK_PREFIX}/${assetId}/`,
      ]) {
        let continuationToken: string | undefined;
        do {
          const list = await s3.send(new ListObjectsV2Command({
            Bucket: env.S3_BUCKET,
            Prefix: prefix,
            ContinuationToken: continuationToken,
          }));
          if (list.Contents?.length) {
            await s3.send(new DeleteObjectsCommand({
              Bucket: env.S3_BUCKET,
              Delete: { Objects: list.Contents.flatMap((object) => object.Key ? [{ Key: object.Key }] : []) },
            }));
          }
          continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
        } while (continuationToken);
      }

      // All dependant rows, including the task, are removed by FK cascade only
      // after storage cleanup succeeds.
      await Promise.all([
        db.delete(analyticsEvents).where(eq(analyticsEvents.assetId, assetId)),
        db.delete(analyticsDaily).where(eq(analyticsDaily.assetId, assetId)),
        db.delete(analyticsAssetStats).where(eq(analyticsAssetStats.assetId, assetId)),
      ]);
      await db.delete(assets).where(and(eq(assets.id, assetId), eq(assets.status, ASSET_STATUS.DELETED)));
    } catch (error) {
      const message = sanitizeErrorMessage(error);
      const maximumAttempts = typeof job.opts.attempts === 'number' ? job.opts.attempts : 1;
      const terminal = job.attemptsMade + 1 >= maximumAttempts;
      await db.update(assetDeletionTasks).set({
        status: terminal ? DELETION_TASK_STATUS.FAILED : DELETION_TASK_STATUS.QUEUED,
        attempts: job.attemptsMade + 1,
        lastError: message,
      }).where(eq(assetDeletionTasks.id, taskId));
      throw terminal ? new UnrecoverableError(message) : error;
    }
  },
  { connection: { url: env.REDIS_URL }, concurrency: 2 },
);

assetDeletionWorker.on('failed', (job, err) => {
  console.error(`[asset-deletion] Task ${job?.id} failed:`, err.message);
});

/* ─── Original source cleanup worker ──────────────────────── */

const sourceCleanupWorker = new Worker(
  'source-cleanup',
  async (job) => {
    const { taskId, assetId } = sourceCleanupJobDataSchema.parse(job.data);
    const [task] = await db.select().from(assetSourceCleanupTasks).where(eq(assetSourceCleanupTasks.id, taskId)).limit(1);
    if (!task) return;
    const [asset] = await db.select().from(assets).where(eq(assets.id, assetId)).limit(1);
    if (!asset) return;
    if (!asset.sourceKey) {
      await db.delete(assetSourceCleanupTasks).where(eq(assetSourceCleanupTasks.id, taskId));
      return;
    }
    const sourceKey = asset.sourceKey;

    await db.update(assetSourceCleanupTasks).set({
      status: SOURCE_CLEANUP_TASK_STATUS.PROCESSING,
      attempts: job.attemptsMade + 1,
      lastError: null,
    }).where(eq(assetSourceCleanupTasks.id, taskId));

    try {
      const prefix = `${S3_PATHS.SOURCES_PREFIX}/${assetId}/`;
      let continuationToken: string | undefined;
      do {
        const list = await s3.send(new ListObjectsV2Command({
          Bucket: env.S3_BUCKET,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }));
        if (list.Contents?.length) {
          await s3.send(new DeleteObjectsCommand({
            Bucket: env.S3_BUCKET,
            Delete: { Objects: list.Contents.flatMap((object) => object.Key ? [{ Key: object.Key }] : []) },
          }));
        }
        continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
      } while (continuationToken);

      await db.transaction(async (tx) => {
        await tx.update(assets).set({ sourceKey: null }).where(and(eq(assets.id, assetId), eq(assets.sourceKey, sourceKey)));
        await tx.delete(assetSourceCleanupTasks).where(eq(assetSourceCleanupTasks.id, taskId));
      });
    } catch (error) {
      const message = sanitizeErrorMessage(error);
      const maximumAttempts = typeof job.opts.attempts === 'number' ? job.opts.attempts : 1;
      const terminal = job.attemptsMade + 1 >= maximumAttempts;
      await db.update(assetSourceCleanupTasks).set({
        status: terminal ? SOURCE_CLEANUP_TASK_STATUS.FAILED : SOURCE_CLEANUP_TASK_STATUS.QUEUED,
        attempts: job.attemptsMade + 1,
        lastError: message,
      }).where(eq(assetSourceCleanupTasks.id, taskId));
      throw terminal ? new UnrecoverableError(message) : error;
    }
  },
  { connection: { url: env.REDIS_URL }, concurrency: 2 },
);

sourceCleanupWorker.on('failed', (job, err) => {
  console.error(`[source-cleanup] Task ${job?.id} failed:`, err.message);
});

/* ─── Analytics Worker ────────────────────────────────────── */

const analyticsWorker = createAnalyticsWorker(env.REDIS_URL);

/* Graceful shutdown */
async function shutdown(signal: string) {
  console.log(`[worker] Received ${signal}, shutting down...`);
  await Promise.all([worker.close(), assetDeletionWorker.close(), sourceCleanupWorker.close(), sourceCleanupQueue.close(), analyticsWorker.close(), redis.quit()]);
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
