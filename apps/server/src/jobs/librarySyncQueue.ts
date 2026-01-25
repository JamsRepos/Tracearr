/**
 * Library Sync Queue - BullMQ-based library synchronization job processing
 *
 * Provides scheduled and manual library sync jobs with:
 * - Daily 3 AM UTC auto-sync for all servers
 * - Manual sync trigger via API
 * - Progress tracking via WebSocket
 * - Concurrent sync prevention per server
 */

import { Queue, Worker, type Job, type ConnectionOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { sql } from 'drizzle-orm';
import { WS_EVENTS, REDIS_KEYS } from '@tracearr/shared';
import type { LibrarySyncProgress } from '@tracearr/shared';
import { db } from '../db/client.js';
import { servers } from '../db/schema.js';
import { librarySyncService } from '../services/librarySync.js';
import { getPubSubService } from '../services/cache.js';
import { enqueueMaintenanceJob } from './maintenanceQueue.js';
import { VALID_LIBRARY_ITEM_CONDITION } from '../utils/snapshotValidation.js';

// Job data interface
export interface LibrarySyncJobData {
  serverId: string;
  triggeredBy: 'manual' | 'scheduled';
  userId?: string; // For audit trail on manual syncs
}

// Queue configuration
const QUEUE_NAME = 'library-sync';

// Module-level state
let connectionOptions: ConnectionOptions | null = null;
let librarySyncQueue: Queue<LibrarySyncJobData> | null = null;
let librarySyncWorker: Worker<LibrarySyncJobData> | null = null;
let redisClient: Redis | null = null;
const activeSyncs = new Map<string, boolean>();

/**
 * Invalidate library-related caches after sync completes.
 * Uses pattern matching to clear all variants (per-server, per-library, with timezone, etc.)
 */
async function invalidateLibraryCaches(serverId: string): Promise<void> {
  if (!redisClient) return;

  const patterns = [
    `${REDIS_KEYS.LIBRARY_STATS}*`,
    `${REDIS_KEYS.LIBRARY_GROWTH}*`,
    `${REDIS_KEYS.LIBRARY_QUALITY}*`,
    `${REDIS_KEYS.LIBRARY_STORAGE}*`,
    `${REDIS_KEYS.LIBRARY_DUPLICATES}*`,
    `${REDIS_KEYS.LIBRARY_STALE}*`,
    `${REDIS_KEYS.LIBRARY_WATCH}*`,
    `${REDIS_KEYS.LIBRARY_COMPLETION}*`,
    `${REDIS_KEYS.LIBRARY_PATTERNS}*`,
    `${REDIS_KEYS.LIBRARY_ROI}*`,
    `${REDIS_KEYS.LIBRARY_TOP_MOVIES}*`,
    `${REDIS_KEYS.LIBRARY_TOP_SHOWS}*`,
    `${REDIS_KEYS.LIBRARY_CODECS}*`,
    `${REDIS_KEYS.LIBRARY_RESOLUTION}*`,
  ];

  let totalDeleted = 0;
  for (const pattern of patterns) {
    const keys = await redisClient.keys(pattern);
    if (keys.length > 0) {
      await redisClient.del(...keys);
      totalDeleted += keys.length;
    }
  }

  if (totalDeleted > 0) {
    console.log(`[LibrarySync] Invalidated ${totalDeleted} cache keys for server ${serverId}`);
  }
}

/**
 * Initialize the library sync queue with Redis connection
 */
export function initLibrarySyncQueue(redisUrl: string): void {
  if (librarySyncQueue) {
    console.log('Library sync queue already initialized');
    return;
  }

  connectionOptions = { url: redisUrl };
  redisClient = new Redis(redisUrl);

  librarySyncQueue = new Queue<LibrarySyncJobData>(QUEUE_NAME, {
    connection: connectionOptions,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 60000, // 1 minute initial delay
      },
      removeOnComplete: {
        count: 100, // Keep last 100 completed jobs
        age: 7 * 24 * 60 * 60, // 7 days
      },
      removeOnFail: {
        count: 50, // Keep last 50 failed jobs
      },
    },
  });

  console.log('Library sync queue initialized');
}

/**
 * Start the library sync worker to process queued jobs
 */
export function startLibrarySyncWorker(): void {
  if (!connectionOptions) {
    throw new Error('Library sync queue not initialized. Call initLibrarySyncQueue first.');
  }

  if (librarySyncWorker) {
    console.log('Library sync worker already running');
    return;
  }

  librarySyncWorker = new Worker<LibrarySyncJobData>(
    QUEUE_NAME,
    async (job: Job<LibrarySyncJobData>) => {
      const { serverId, triggeredBy } = job.data;
      const startTime = Date.now();
      console.log(`[LibrarySync] Starting job ${job.id} for server ${serverId} (${triggeredBy})`);

      // Check if already syncing this server
      if (activeSyncs.get(serverId)) {
        console.log(
          `[LibrarySync] Skipping job ${job.id} - sync already in progress for server ${serverId}`
        );
        return { skipped: true, reason: 'sync already in progress' };
      }

      // Mark as active
      activeSyncs.set(serverId, true);

      try {
        // Progress callback for WebSocket updates
        const onProgress = (progress: LibrarySyncProgress) => {
          // Update job progress percentage
          if (progress.totalItems > 0) {
            const percent = Math.round((progress.processedItems / progress.totalItems) * 100);
            void job.updateProgress(percent);
          }

          // Publish to WebSocket via pubsub
          const pubSubService = getPubSubService();
          if (pubSubService) {
            void pubSubService.publish(WS_EVENTS.LIBRARY_SYNC_PROGRESS, progress);
          }
        };

        // Execute sync
        const results = await librarySyncService.syncServer(serverId, onProgress);

        // Invalidate library caches after successful sync
        await invalidateLibraryCaches(serverId);

        const duration = Math.round((Date.now() - startTime) / 1000);
        console.log(`[LibrarySync] Job ${job.id} completed in ${duration}s:`, {
          libraries: results.length,
          totalItems: results.reduce((sum, r) => sum + r.itemsProcessed, 0),
          added: results.reduce((sum, r) => sum + r.itemsAdded, 0),
          removed: results.reduce((sum, r) => sum + r.itemsRemoved, 0),
        });

        return { success: true, results };
      } finally {
        // Always clear active sync flag
        activeSyncs.delete(serverId);
      }
    },
    {
      connection: connectionOptions,
      concurrency: 2, // Allow 2 concurrent syncs (different servers)
      lockDuration: 60 * 60 * 1000, // 1 hour - large libraries take time
      stalledInterval: 30 * 1000, // Check for stalled jobs every 30 seconds
      maxStalledCount: 2, // Retry stalled jobs up to 2 times before failing
    }
  );

  // Handle stalled jobs
  librarySyncWorker.on('stalled', (jobId) => {
    console.warn(`[LibrarySync] Job ${jobId} stalled - will be retried`);
  });

  // Handle job failures
  librarySyncWorker.on('failed', (job, error) => {
    if (!job) return;
    const { serverId } = job.data;

    // Clear active sync flag
    activeSyncs.delete(serverId);

    // Publish error to WebSocket
    const pubSubService = getPubSubService();
    if (pubSubService) {
      void pubSubService.publish(WS_EVENTS.LIBRARY_SYNC_PROGRESS, {
        serverId,
        serverName: 'Unknown',
        status: 'error',
        totalLibraries: 0,
        processedLibraries: 0,
        totalItems: 0,
        processedItems: 0,
        message: `Sync failed: ${error?.message || 'Unknown error'}`,
        startedAt: new Date().toISOString(),
      } satisfies LibrarySyncProgress);
    }

    console.error(`[LibrarySync] Job ${job.id} failed:`, error);
  });

  librarySyncWorker.on('error', (error) => {
    console.error('[LibrarySync] Worker error:', error);
  });

  // After sync completes, check if snapshot backfill is needed
  librarySyncWorker.on('completed', () => {
    void checkAndTriggerSnapshotBackfill();
  });

  console.log('Library sync worker started');
}

/**
 * Check if library snapshots need backfilling and trigger if so.
 * Compares earliest library_items.created_at (with valid size) with earliest snapshot_time.
 * Only considers items with file_size since those without can't produce meaningful snapshots.
 * Runs non-blocking - errors are logged but don't affect other operations.
 */
async function checkAndTriggerSnapshotBackfill(): Promise<void> {
  try {
    // Get earliest item date (only items with valid size) and earliest snapshot date
    // See snapshotValidation.ts for why we filter on file_size
    const result = await db.execute(sql`
      SELECT
        (SELECT MIN(created_at)::date FROM library_items
         WHERE ${VALID_LIBRARY_ITEM_CONDITION}) AS earliest_item,
        (SELECT MIN(snapshot_time)::date FROM library_snapshots) AS earliest_snapshot,
        (SELECT COUNT(*) FROM library_items) AS item_count,
        (SELECT COUNT(*) FROM library_snapshots) AS snapshot_count
    `);

    const row = result.rows[0] as {
      earliest_item: string | null;
      earliest_snapshot: string | null;
      item_count: string;
      snapshot_count: string;
    };

    const itemCount = parseInt(row.item_count, 10);
    const snapshotCount = parseInt(row.snapshot_count, 10);

    // No items = nothing to backfill
    if (itemCount === 0) {
      return;
    }

    // No snapshots yet, or snapshots start after items - need backfill
    const needsBackfill =
      snapshotCount === 0 ||
      (row.earliest_item &&
        row.earliest_snapshot &&
        new Date(row.earliest_item) < new Date(row.earliest_snapshot));

    if (needsBackfill) {
      console.log(
        `[LibrarySync] Snapshot backfill needed: items from ${row.earliest_item}, snapshots from ${row.earliest_snapshot || 'none'}`
      );

      // Trigger backfill job (non-blocking, will be queued)
      // Use a system user ID since this is automated
      await enqueueMaintenanceJob('backfill_library_snapshots', 'system');
      console.log('[LibrarySync] Snapshot backfill job queued');
    }
  } catch (error) {
    // Log but don't throw - this is a non-critical background task
    if (error instanceof Error && error.message.includes('already in progress')) {
      // Backfill already running, that's fine
      console.log('[LibrarySync] Snapshot backfill already in progress');
    } else {
      console.error('[LibrarySync] Failed to check/trigger snapshot backfill:', error);
    }
  }
}

/**
 * Schedule daily auto-sync for all servers at 3 AM UTC
 */
export async function scheduleAutoSync(): Promise<void> {
  if (!librarySyncQueue) {
    throw new Error('Library sync queue not initialized');
  }

  // Query all servers from database
  const allServers = await db.select({ id: servers.id, name: servers.name }).from(servers);

  if (allServers.length === 0) {
    console.log('[LibrarySync] No servers found - skipping auto-sync scheduling');
    return;
  }

  // Remove existing job schedulers first (in case servers changed)
  const schedulers = await librarySyncQueue.getJobSchedulers();
  for (const scheduler of schedulers) {
    await librarySyncQueue.removeJobScheduler(scheduler.key);
  }

  // Add repeatable job for each server
  for (const server of allServers) {
    await librarySyncQueue.add(
      `auto-sync-${server.id}`,
      {
        serverId: server.id,
        triggeredBy: 'scheduled',
      },
      {
        repeat: {
          pattern: '0 * * * *', // Every hour
          tz: 'UTC',
        },
        jobId: `scheduled-${server.id}`,
      }
    );
  }

  console.log(`[LibrarySync] Scheduled auto-sync for ${allServers.length} server(s) every hour`);

  // Queue an immediate sync on boot (non-blocking, staggered to avoid overwhelming startup)
  // Check for any pending/delayed jobs first to avoid duplicates after rapid restarts
  const pendingJobs = await librarySyncQueue.getJobs(['delayed', 'waiting']);
  const pendingServerIds = new Set(pendingJobs.map((j) => j.data.serverId));

  for (let i = 0; i < allServers.length; i++) {
    const server = allServers[i];
    if (!server) continue;

    // Skip if there's already a pending job for this server
    if (pendingServerIds.has(server.id)) {
      console.log(`[LibrarySync] Skipping boot sync for ${server.name} - job already pending`);
      continue;
    }

    await librarySyncQueue.add(
      `boot-sync-${server.id}`,
      {
        serverId: server.id,
        triggeredBy: 'scheduled',
      },
      {
        delay: (i + 1) * 10000, // Stagger by 10 seconds per server
        jobId: `boot-sync-${server.id}-${Date.now()}`,
      }
    );
  }

  console.log(`[LibrarySync] Queued boot sync for ${allServers.length} server(s)`);
}

/**
 * Manually trigger a library sync for a server
 */
export async function enqueueLibrarySync(serverId: string, userId?: string): Promise<string> {
  if (!librarySyncQueue) {
    throw new Error('Library sync queue not initialized');
  }

  // Only block if there's an active sync running - scheduled jobs shouldn't block manual syncs
  const activeJobs = await librarySyncQueue.getJobs(['active']);
  const existingJob = activeJobs.find((job) => job.data.serverId === serverId);

  if (existingJob) {
    throw new Error('A sync is already in progress for this server');
  }

  // Add job with unique ID
  const job = await librarySyncQueue.add(
    `manual-sync-${serverId}`,
    {
      serverId,
      triggeredBy: 'manual',
      userId,
    },
    {
      jobId: `manual-${serverId}-${Date.now()}`,
    }
  );

  console.log(`[LibrarySync] Enqueued manual sync for server ${serverId} (job ${job.id})`);
  return job.id ?? `manual-${serverId}-${Date.now()}`;
}

/**
 * Get sync status for a server
 */
export async function getLibrarySyncStatus(
  serverId: string
): Promise<{ isActive: boolean; progress?: number; jobId?: string } | null> {
  if (!librarySyncQueue) {
    return null;
  }

  // Find job for this server in active/waiting jobs
  const jobs = await librarySyncQueue.getJobs(['active', 'waiting', 'delayed']);
  const job = jobs.find((j) => j.data.serverId === serverId);

  if (!job) {
    return { isActive: false };
  }

  const state = await job.getState();
  const progress = job.progress;

  return {
    isActive: state === 'active',
    progress: typeof progress === 'number' ? progress : undefined,
    jobId: job.id ?? undefined,
  };
}

/**
 * Get all active/pending library sync jobs
 */
export async function getAllActiveLibrarySyncs(): Promise<
  Array<{
    jobId: string;
    serverId: string;
    triggeredBy: 'manual' | 'scheduled';
    state: string;
    progress: number | null;
    createdAt: number;
  }>
> {
  if (!librarySyncQueue) {
    return [];
  }

  const jobs = await librarySyncQueue.getJobs(['active', 'waiting', 'delayed']);

  return Promise.all(
    jobs.map(async (job) => {
      const state = await job.getState();
      const progress = job.progress;
      return {
        jobId: job.id ?? 'unknown',
        serverId: job.data.serverId,
        triggeredBy: job.data.triggeredBy,
        state,
        progress: typeof progress === 'number' ? progress : null,
        createdAt: job.timestamp ?? Date.now(),
      };
    })
  );
}

/**
 * Gracefully shutdown the library sync queue
 */
export async function shutdownLibrarySyncQueue(): Promise<void> {
  console.log('Shutting down library sync queue...');

  if (librarySyncWorker) {
    await librarySyncWorker.close();
    librarySyncWorker = null;
  }

  if (librarySyncQueue) {
    await librarySyncQueue.close();
    librarySyncQueue = null;
  }

  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
  }

  console.log('Library sync queue shutdown complete');
}
