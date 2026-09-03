import { Queue, type JobsOptions } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { jobs, JOB_STATUS, JOB_TYPE } from '@hovod/db';
import { db } from './db.js';
import { env } from './env.js';

export const transcodeQueue = new Queue('transcode', {
  connection: { url: env.REDIS_URL },
});

/**
 * A queued DB job is the durable source of truth. BullMQ is deliberately
 * configured as a retrying delivery mechanism, rather than the only record
 * that a transcode was requested.
 */
export const TRANSCODE_JOB_OPTIONS: Omit<JobsOptions, 'jobId'> = {
  attempts: 3,
  backoff: {
    type: 'exponential',
    delay: 1_000,
  },
};

export async function enqueueTranscodeJob(jobId: string, assetId: string) {
  return transcodeQueue.add('transcode', { assetId, jobId }, {
    ...TRANSCODE_JOB_OPTIONS,
    jobId,
  });
}

/**
 * Re-deliver DB jobs that committed successfully while Redis was unavailable.
 * BullMQ's jobId de-duplicates concurrent API instances doing the same work.
 */
export async function reconcileTranscodeJobs(): Promise<number> {
  const queuedJobs = await db
    .select({ id: jobs.id, assetId: jobs.assetId })
    .from(jobs)
    .where(and(eq(jobs.type, JOB_TYPE.TRANSCODE), eq(jobs.status, JOB_STATUS.QUEUED)));

  let enqueued = 0;
  for (const queuedJob of queuedJobs) {
    const existingQueueJob = await transcodeQueue.getJob(queuedJob.id);
    if (existingQueueJob) continue;

    await enqueueTranscodeJob(queuedJob.id, queuedJob.assetId);
    enqueued += 1;
  }

  return enqueued;
}

export function startTranscodeReconciler(intervalMs = 30_000): () => void {
  const run = () => {
    reconcileTranscodeJobs()
      .then((count) => {
        if (count > 0) console.info(`[queue] Reconciled ${count} transcode job(s)`);
      })
      .catch((error) => console.warn('[queue] Transcode reconciliation failed:', (error as Error).message));
  };

  run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

export const analyticsQueue = new Queue('analytics-aggregation', {
  connection: { url: env.REDIS_URL },
});

export async function scheduleAnalyticsJobs() {
  await analyticsQueue.upsertJobScheduler(
    'hourly-aggregation',
    { every: 300_000 },
    { name: 'aggregate', data: { type: 'hourly' } },
  );

  await analyticsQueue.upsertJobScheduler(
    'daily-aggregation',
    { every: 86_400_000 },
    { name: 'aggregate', data: { type: 'daily' } },
  );

  await analyticsQueue.upsertJobScheduler(
    'cleanup-events',
    { every: 86_400_000 },
    { name: 'aggregate', data: { type: 'cleanup', retentionDays: 30 } },
  );
}
