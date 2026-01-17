/**
 * Library Stats Queue - BullMQ-based periodic library statistics update
 *
 * Fetches library metadata and statistics from media servers and stores
 * them in the database. Runs daily and can be triggered manually.
 */

import { Queue, Worker, type Job, type ConnectionOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import {
  updateServerLibraryStats,
  updateAllLibraryStats,
  createDailySnapshot,
} from '../services/libraryStats.js';

// Queue name
const QUEUE_NAME = 'library-stats-update';

// Job names
const SCHEDULED_UPDATE_JOB = 'scheduled-update';
const MANUAL_UPDATE_JOB = 'manual-update';

// Job types
interface LibraryStatsJobData {
  type: 'update-all' | 'update-server';
  serverId?: string; // If set, only update this specific server
}

// Connection options (set during initialization)
let connectionOptions: ConnectionOptions | null = null;

// Queue and worker instances
let libraryStatsQueue: Queue<LibraryStatsJobData> | null = null;
let libraryStatsWorker: Worker<LibraryStatsJobData> | null = null;

// Redis client reference
let _redisClient: Redis | null = null;

/**
 * Initialize the library stats update queue with Redis connection
 */
export function initLibraryStatsQueue(redisUrl: string, redis: Redis): void {
  if (libraryStatsQueue) {
    console.log('[LibraryStats] Queue already initialized');
    return;
  }

  connectionOptions = { url: redisUrl };
  _redisClient = redis;

  // Create the library stats queue
  libraryStatsQueue = new Queue<LibraryStatsJobData>(QUEUE_NAME, {
    connection: connectionOptions,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 60000, // 1m, 2m, 4m (library updates can be slow)
      },
      removeOnComplete: {
        count: 30, // Keep last 30 for debugging
        age: 7 * 24 * 60 * 60, // 7 days
      },
      removeOnFail: {
        count: 50,
        age: 7 * 24 * 60 * 60, // 7 days
      },
    },
  });

  console.log('[LibraryStats] Queue initialized');
}

/**
 * Start the library stats update worker
 */
export function startLibraryStatsWorker(): void {
  if (!connectionOptions) {
    throw new Error('Library stats queue not initialized. Call initLibraryStatsQueue first.');
  }

  if (libraryStatsWorker) {
    console.log('[LibraryStats] Worker already running');
    return;
  }

  libraryStatsWorker = new Worker<LibraryStatsJobData>(
    QUEUE_NAME,
    async (job: Job<LibraryStatsJobData>) => {
      const startTime = Date.now();
      try {
        await processLibraryStatsJob(job);
        const duration = Date.now() - startTime;
        console.log(`[LibraryStats] Job ${job.id} completed in ${Math.round(duration / 1000)}s`);
      } catch (error) {
        const duration = Date.now() - startTime;
        console.error(
          `[LibraryStats] Job ${job.id} failed after ${Math.round(duration / 1000)}s:`,
          error
        );
        throw error;
      }
    },
    {
      connection: connectionOptions,
      concurrency: 1, // Only one update at a time to avoid overwhelming media servers
    }
  );

  libraryStatsWorker.on('error', (error) => {
    console.error('[LibraryStats] Worker error:', error);
  });

  libraryStatsWorker.on('failed', (job, error) => {
    console.error(`[LibraryStats] Job ${job?.id} failed:`, error.message);
  });

  libraryStatsWorker.on('active', (job) => {
    console.log(`[LibraryStats] Job ${job.id} is now active`);
  });

  libraryStatsWorker.on('completed', (job) => {
    console.log(`[LibraryStats] Job ${job.id} completed successfully`);
  });

  libraryStatsWorker.on('stalled', (jobId) => {
    console.warn(`[LibraryStats] Job ${jobId} stalled`);
  });

  console.log('[LibraryStats] Worker started');
}

/**
 * Schedule the daily library stats update
 *
 * Uses BullMQ repeatable jobs to run at 3 AM daily.
 */
export async function scheduleLibraryStatsUpdate(): Promise<void> {
  if (!libraryStatsQueue) {
    throw new Error('Library stats queue not initialized');
  }

  // Remove any existing scheduled jobs to avoid duplicates
  const schedulers = await libraryStatsQueue.getJobSchedulers();
  for (const scheduler of schedulers) {
    if (scheduler.name === SCHEDULED_UPDATE_JOB) {
      await libraryStatsQueue.removeJobScheduler(scheduler.key);
    }
  }

  // Schedule daily update at 3 AM server time
  await libraryStatsQueue.add(
    SCHEDULED_UPDATE_JOB,
    { type: 'update-all' },
    {
      repeat: {
        pattern: '0 3 * * *', // 3 AM daily (cron format)
      },
      jobId: 'library-stats-daily',
    }
  );

  console.log('[LibraryStats] Scheduled daily update at 3 AM');
}

/**
 * Trigger an immediate library stats update
 *
 * @param serverId - Optional server ID to update only that server
 * @returns Job ID
 */
export async function enqueueLibraryStatsUpdate(serverId?: string): Promise<string> {
  if (!libraryStatsQueue) {
    throw new Error('Library stats queue not initialized');
  }

  // Check for existing completed/failed job with same ID and remove it
  const existingJobId = serverId ? `manual-update-${serverId}` : 'manual-update-all';
  const existingJob = await libraryStatsQueue.getJob(existingJobId);

  if (existingJob) {
    const state = await existingJob.getState();

    if (state === 'completed' || state === 'failed') {
      // Remove old job to create a fresh one
      await existingJob.remove();
    } else if (state === 'active' || state === 'waiting') {
      // Job already running, don't create duplicate
      return existingJob.id ?? 'unknown';
    }
  }

  const job = await libraryStatsQueue.add(
    MANUAL_UPDATE_JOB,
    {
      type: serverId ? 'update-server' : 'update-all',
      serverId,
    },
    {
      // Prevent duplicate manual updates running simultaneously
      jobId: existingJobId,
    }
  );

  console.log(
    `[LibraryStats] Enqueued manual update${serverId ? ` for server ${serverId}` : ''}, job: ${job.id}`
  );

  return job.id ?? 'unknown';
}

/**
 * Process a library stats update job
 */
async function processLibraryStatsJob(job: Job<LibraryStatsJobData>): Promise<void> {
  const { type, serverId } = job.data;

  console.log(
    `[LibraryStats] Processing job ${job.id}: ${type}${serverId ? ` (server: ${serverId})` : ''}`
  );

  if (type === 'update-server' && serverId) {
    // Update specific server
    await updateServerLibraryStats(serverId);
    await createDailySnapshot(serverId);
  } else {
    // Update all servers
    await updateAllLibraryStats();
  }
}

/**
 * Trigger library stats update when a new server is added
 * Called from server creation flow
 */
export async function onServerAdded(serverId: string): Promise<void> {
  try {
    await enqueueLibraryStatsUpdate(serverId);
  } catch (error) {
    console.error(`[LibraryStats] Failed to enqueue update for new server ${serverId}:`, error);
  }
}

/**
 * Shutdown the library stats queue and worker gracefully
 */
export async function shutdownLibraryStatsQueue(): Promise<void> {
  if (libraryStatsWorker) {
    console.log('[LibraryStats] Stopping worker...');
    await libraryStatsWorker.close();
    libraryStatsWorker = null;
  }

  if (libraryStatsQueue) {
    console.log('[LibraryStats] Closing queue...');
    await libraryStatsQueue.close();
    libraryStatsQueue = null;
  }

  connectionOptions = null;
  _redisClient = null;

  console.log('[LibraryStats] Shutdown complete');
}

/**
 * Get the current status of the library stats queue
 */
export async function getLibraryStatsQueueStatus(): Promise<{
  isInitialized: boolean;
  isWorkerRunning: boolean;
  activeJobs: number;
  waitingJobs: number;
  failedJobs: number;
}> {
  if (!libraryStatsQueue) {
    return {
      isInitialized: false,
      isWorkerRunning: false,
      activeJobs: 0,
      waitingJobs: 0,
      failedJobs: 0,
    };
  }

  const [active, waiting, failed] = await Promise.all([
    libraryStatsQueue.getActiveCount(),
    libraryStatsQueue.getWaitingCount(),
    libraryStatsQueue.getFailedCount(),
  ]);

  return {
    isInitialized: true,
    isWorkerRunning: libraryStatsWorker !== null,
    activeJobs: active,
    waitingJobs: waiting,
    failedJobs: failed,
  };
}
