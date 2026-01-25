/**
 * Maintenance Queue - BullMQ-based maintenance job processing
 *
 * Provides reliable, resumable maintenance job processing with:
 * - Restart resilience (job state persisted in Redis)
 * - Progress tracking via WebSocket
 * - Single job at a time (prevents resource contention)
 *
 * Available maintenance jobs:
 * - normalize_players: Normalize player/device/platform names in historical sessions
 */

import { Queue, Worker, type Job, type ConnectionOptions } from 'bullmq';
import type {
  MaintenanceJobProgress,
  MaintenanceJobResult,
  MaintenanceJobType,
} from '@tracearr/shared';
import { WS_EVENTS } from '@tracearr/shared';
import { sql, isNotNull, or, and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { sessions, serverUsers } from '../db/schema.js';
import { normalizeClient, normalizePlatformName } from '../utils/platformNormalizer.js';
import { getPubSubService } from '../services/cache.js';
import { rebuildTimescaleViews } from '../db/timescale.js';
import { INVALID_SNAPSHOT_CONDITION } from '../utils/snapshotValidation.js';
import countries from 'i18n-iso-countries';
import countriesEn from 'i18n-iso-countries/langs/en.json' with { type: 'json' };

// Register English locale for country name lookups
countries.registerLocale(countriesEn);

// Convert country name to ISO 3166-1 alpha-2 code
// Handles common variations like "United States", "USA", "United Kingdom", etc.
function getCountryCode(name: string): string | undefined {
  return countries.getAlpha2Code(name, 'en') ?? undefined;
}

// Job data types
export interface MaintenanceJobData {
  type: MaintenanceJobType;
  userId: string; // Audit trail - who initiated the job
  options?: {
    /** For rebuild_timescale_views: refresh all historical data (slow but complete) */
    fullRefresh?: boolean;
  };
}

// Queue configuration
const QUEUE_NAME = 'maintenance';

// Connection and instances
let connectionOptions: ConnectionOptions | null = null;
let maintenanceQueue: Queue<MaintenanceJobData> | null = null;
let maintenanceWorker: Worker<MaintenanceJobData> | null = null;

// Track active job state
let activeJobProgress: MaintenanceJobProgress | null = null;

/**
 * Initialize the maintenance queue with Redis connection
 */
export function initMaintenanceQueue(redisUrl: string): void {
  if (maintenanceQueue) {
    console.log('Maintenance queue already initialized');
    return;
  }

  connectionOptions = { url: redisUrl };

  maintenanceQueue = new Queue<MaintenanceJobData>(QUEUE_NAME, {
    connection: connectionOptions,
    defaultJobOptions: {
      attempts: 1, // Maintenance jobs should not retry automatically
      removeOnComplete: {
        count: 50, // Keep last 50 completed jobs
        age: 7 * 24 * 60 * 60, // 7 days
      },
      removeOnFail: {
        count: 25,
        age: 7 * 24 * 60 * 60,
      },
    },
  });

  console.log('Maintenance queue initialized');
}

/**
 * Start the maintenance worker to process queued jobs
 */
export function startMaintenanceWorker(): void {
  if (!connectionOptions) {
    throw new Error('Maintenance queue not initialized. Call initMaintenanceQueue first.');
  }

  if (maintenanceWorker) {
    console.log('Maintenance worker already running');
    return;
  }

  maintenanceWorker = new Worker<MaintenanceJobData>(
    QUEUE_NAME,
    async (job: Job<MaintenanceJobData>) => {
      const startTime = Date.now();
      console.log(`[Maintenance] Starting job ${job.id} (${job.data.type})`);

      try {
        const result = await processMaintenanceJob(job);
        const duration = Math.round((Date.now() - startTime) / 1000);
        console.log(`[Maintenance] Job ${job.id} completed in ${duration}s:`, result);
        return result;
      } catch (error) {
        const duration = Math.round((Date.now() - startTime) / 1000);
        console.error(`[Maintenance] Job ${job.id} failed after ${duration}s:`, error);
        throw error;
      }
    },
    {
      connection: connectionOptions,
      concurrency: 1, // Only 1 maintenance job at a time
      lockDuration: 60 * 60 * 1000, // 1 hour - maintenance jobs can be long-running
      stalledInterval: 30 * 1000, // Check for stalled jobs every 30 seconds
      maxStalledCount: 2, // Retry stalled jobs up to 2 times before failing
    }
  );

  // Handle stalled jobs - clear state so UI updates correctly
  maintenanceWorker.on('stalled', (jobId) => {
    console.warn(`[Maintenance] Job ${jobId} stalled - will be retried`);
    activeJobProgress = null;
  });

  // Handle job failures
  maintenanceWorker.on('failed', (job, error) => {
    if (!job) return;
    activeJobProgress = null;

    const pubSubService = getPubSubService();
    if (pubSubService) {
      void pubSubService.publish(WS_EVENTS.MAINTENANCE_PROGRESS, {
        type: job.data.type,
        status: 'error',
        totalRecords: 0,
        processedRecords: 0,
        updatedRecords: 0,
        skippedRecords: 0,
        errorRecords: 0,
        message: `Job failed: ${error?.message || 'Unknown error'}`,
      });
    }
  });

  maintenanceWorker.on('error', (error) => {
    console.error('[Maintenance] Worker error:', error);
  });

  console.log('Maintenance worker started');
}

/**
 * Process a single maintenance job (routes to appropriate handler)
 */
async function processMaintenanceJob(job: Job<MaintenanceJobData>): Promise<MaintenanceJobResult> {
  switch (job.data.type) {
    case 'normalize_players':
      return processNormalizePlayersJob(job);
    case 'normalize_countries':
      return processNormalizeCountriesJob(job);
    case 'fix_imported_progress':
      return processFixImportedProgressJob(job);
    case 'rebuild_timescale_views':
      return processRebuildTimescaleViewsJob(job);
    case 'normalize_codecs':
      return processNormalizeCodecsJob(job);
    case 'backfill_user_dates':
      return processBackfillUserDatesJob(job);
    case 'backfill_library_snapshots':
      return processBackfillLibrarySnapshotsJob(job);
    default:
      throw new Error(`Unknown maintenance job type: ${job.data.type}`);
  }
}

/**
 * Normalize player names in historical sessions
 *
 * Updates the `device` and `platform` columns based on the existing
 * `product` and `playerName` values using the platformNormalizer utility.
 */
async function processNormalizePlayersJob(
  job: Job<MaintenanceJobData>
): Promise<MaintenanceJobResult> {
  const startTime = Date.now();
  const pubSubService = getPubSubService();
  const BATCH_SIZE = 500;

  // Initialize progress
  activeJobProgress = {
    type: 'normalize_players',
    status: 'running',
    totalRecords: 0,
    processedRecords: 0,
    updatedRecords: 0,
    skippedRecords: 0,
    errorRecords: 0,
    message: 'Counting sessions...',
    startedAt: new Date().toISOString(),
  };

  const publishProgress = async () => {
    if (pubSubService && activeJobProgress) {
      await pubSubService.publish(WS_EVENTS.MAINTENANCE_PROGRESS, activeJobProgress);
    }
  };

  try {
    // Count total sessions that have player/product info
    const [countResult] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(sessions)
      .where(
        or(
          isNotNull(sessions.product),
          isNotNull(sessions.playerName),
          isNotNull(sessions.platform)
        )
      );

    const totalRecords = countResult?.count ?? 0;
    activeJobProgress.totalRecords = totalRecords;
    activeJobProgress.message = `Processing ${totalRecords.toLocaleString()} sessions...`;
    await publishProgress();

    if (totalRecords === 0) {
      activeJobProgress.status = 'complete';
      activeJobProgress.message = 'No sessions to normalize';
      activeJobProgress.completedAt = new Date().toISOString();
      await publishProgress();
      return {
        success: true,
        type: 'normalize_players',
        processed: 0,
        updated: 0,
        skipped: 0,
        errors: 0,
        durationMs: Date.now() - startTime,
        message: 'No sessions to normalize',
      };
    }

    let lastId = ''; // Cursor for pagination
    let totalProcessed = 0;
    let totalUpdated = 0;
    let totalSkipped = 0;
    let totalErrors = 0;

    // Small delay between batches to avoid overwhelming the database
    const BATCH_DELAY_MS = 50;

    while (totalProcessed < totalRecords) {
      // Fetch batch of sessions using cursor-based pagination
      const whereCondition = or(
        isNotNull(sessions.product),
        isNotNull(sessions.playerName),
        isNotNull(sessions.platform)
      );

      const batch = await db
        .select({
          id: sessions.id,
          product: sessions.product,
          playerName: sessions.playerName,
          device: sessions.device,
          platform: sessions.platform,
        })
        .from(sessions)
        .where(lastId ? and(whereCondition, sql`${sessions.id} > ${lastId}`) : whereCondition)
        .orderBy(sessions.id)
        .limit(BATCH_SIZE);

      // No more records to process
      if (batch.length === 0) {
        break;
      }

      // Update cursor to last record in batch
      const lastRecord = batch[batch.length - 1];
      if (lastRecord) lastId = lastRecord.id;

      // Collect updates for batch processing
      const updates: Array<{ id: string; device: string; platform: string }> = [];

      for (const session of batch) {
        try {
          // Get the client string to normalize (prefer product, fallback to playerName)
          // This is the RAW value from the media server API
          const clientString = session.product || session.playerName || '';

          if (!clientString && !session.platform) {
            totalSkipped++;
            continue;
          }

          // Normalize using the platformNormalizer
          // DON'T pass session.device as hint - that's the old/bad value we're trying to fix
          // The normalizer derives device from the client string
          const normalized = normalizeClient(clientString);

          // For platform: if we have an existing platform value, normalize it
          // Otherwise use what the normalizer derived from the client string
          const normalizedPlatform = session.platform
            ? normalizePlatformName(session.platform)
            : normalized.platform;

          // Check if update is needed
          const needsUpdate =
            normalized.device !== session.device || normalizedPlatform !== session.platform;

          if (needsUpdate) {
            updates.push({
              id: session.id,
              device: normalized.device,
              platform: normalizedPlatform,
            });
          } else {
            totalSkipped++;
          }
        } catch (error) {
          console.error(`[Maintenance] Error processing session ${session.id}:`, error);
          totalErrors++;
        }
      }

      // Execute updates sequentially to avoid exhausting the connection pool
      // Maintenance jobs are not time-critical, so sequential is fine
      if (updates.length > 0) {
        for (const update of updates) {
          try {
            await db
              .update(sessions)
              .set({
                device: update.device,
                platform: update.platform,
              })
              .where(eq(sessions.id, update.id));
            totalUpdated++;
          } catch (error) {
            console.error(`[Maintenance] Error updating session ${update.id}:`, error);
            totalErrors++;
          }
        }
      }

      totalProcessed += batch.length;
      activeJobProgress.processedRecords = totalProcessed;
      activeJobProgress.updatedRecords = totalUpdated;
      activeJobProgress.skippedRecords = totalSkipped;
      activeJobProgress.errorRecords = totalErrors;
      activeJobProgress.message = `Processed ${totalProcessed.toLocaleString()} of ${totalRecords.toLocaleString()} sessions...`;

      // Update job progress
      const percent = Math.round((totalProcessed / totalRecords) * 100);
      await job.updateProgress(percent);
      await publishProgress();

      // Extend lock to prevent stalled job detection
      try {
        await job.extendLock(job.token ?? '', 10 * 60 * 1000);
      } catch {
        console.warn(`[Maintenance] Failed to extend lock for job ${job.id}`);
      }

      // Brief pause between batches to let other operations through
      if (totalProcessed < totalRecords) {
        await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
      }
    }

    const durationMs = Date.now() - startTime;
    activeJobProgress.status = 'complete';
    activeJobProgress.message = `Completed! Updated ${totalUpdated.toLocaleString()} sessions in ${Math.round(durationMs / 1000)}s`;
    activeJobProgress.completedAt = new Date().toISOString();
    await publishProgress();

    activeJobProgress = null;

    return {
      success: true,
      type: 'normalize_players',
      processed: totalRecords,
      updated: totalUpdated,
      skipped: totalSkipped,
      errors: totalErrors,
      durationMs,
      message: `Normalized ${totalUpdated.toLocaleString()} sessions`,
    };
  } catch (error) {
    if (activeJobProgress) {
      activeJobProgress.status = 'error';
      activeJobProgress.message = error instanceof Error ? error.message : 'Unknown error';
      await publishProgress();
      activeJobProgress = null;
    }
    throw error;
  }
}

/**
 * Normalize country names to ISO codes in historical sessions
 *
 * Converts full country names (e.g., "United States") to ISO 3166-1 alpha-2 codes (e.g., "US").
 * This fixes historical data from before the system was updated to store country codes.
 */
async function processNormalizeCountriesJob(
  job: Job<MaintenanceJobData>
): Promise<MaintenanceJobResult> {
  const startTime = Date.now();
  const pubSubService = getPubSubService();
  const BATCH_SIZE = 500;
  const BATCH_DELAY_MS = 50;

  // Initialize progress
  activeJobProgress = {
    type: 'normalize_countries',
    status: 'running',
    totalRecords: 0,
    processedRecords: 0,
    updatedRecords: 0,
    skippedRecords: 0,
    errorRecords: 0,
    message: 'Counting sessions with country data...',
    startedAt: new Date().toISOString(),
  };

  const publishProgress = async () => {
    if (pubSubService && activeJobProgress) {
      await pubSubService.publish(WS_EVENTS.MAINTENANCE_PROGRESS, activeJobProgress);
    }
  };

  try {
    // Count sessions that need geo normalization:
    // - geoCountry longer than 2 chars (not already ISO codes)
    // - OR geoCity is "Local" (old format that should be geoCountry="Local Network")
    const [countResult] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(sessions)
      .where(
        or(
          and(isNotNull(sessions.geoCountry), sql`length(${sessions.geoCountry}) > 2`),
          sql`lower(${sessions.geoCity}) = 'local'`
        )
      );

    const totalRecords = countResult?.count ?? 0;
    activeJobProgress.totalRecords = totalRecords;
    activeJobProgress.message = `Processing ${totalRecords.toLocaleString()} sessions...`;
    await publishProgress();

    if (totalRecords === 0) {
      activeJobProgress.status = 'complete';
      activeJobProgress.message = 'No sessions need country normalization';
      activeJobProgress.completedAt = new Date().toISOString();
      await publishProgress();
      return {
        success: true,
        type: 'normalize_countries',
        processed: 0,
        updated: 0,
        skipped: 0,
        errors: 0,
        durationMs: Date.now() - startTime,
        message: 'No sessions need country normalization',
      };
    }

    let lastId = ''; // Cursor for pagination
    let totalProcessed = 0;
    let totalUpdated = 0;
    let totalSkipped = 0;
    let totalErrors = 0;

    while (totalProcessed < totalRecords) {
      // Fetch batch of sessions that need geo normalization
      // Use cursor-based pagination (id > lastId) to ensure we process each record exactly once
      const whereCondition = or(
        and(isNotNull(sessions.geoCountry), sql`length(${sessions.geoCountry}) > 2`),
        sql`lower(${sessions.geoCity}) = 'local'`
      );

      const batch = await db
        .select({
          id: sessions.id,
          geoCity: sessions.geoCity,
          geoCountry: sessions.geoCountry,
        })
        .from(sessions)
        .where(lastId ? and(whereCondition, sql`${sessions.id} > ${lastId}`) : whereCondition)
        .orderBy(sessions.id)
        .limit(BATCH_SIZE);

      // No more records to process
      if (batch.length === 0) {
        break;
      }

      // Update cursor to last record in batch
      const lastRecord = batch[batch.length - 1];
      if (lastRecord) lastId = lastRecord.id;

      // Collect updates for batch processing
      const updates: Array<{ id: string; geoCity: string | null; geoCountry: string }> = [];

      for (const session of batch) {
        try {
          const currentCity = session.geoCity;
          const currentCountry = session.geoCountry;

          // Fix old format: geoCity="Local" should be geoCity=null, geoCountry="Local Network"
          if (currentCity?.toLowerCase() === 'local') {
            updates.push({
              id: session.id,
              geoCity: null,
              geoCountry: 'Local Network',
            });
            continue;
          }

          if (!currentCountry || currentCountry.length <= 2) {
            // Already looks like a code
            totalSkipped++;
            continue;
          }

          // Standardize "Local" variants to "Local Network"
          if (
            currentCountry.toLowerCase() === 'local' ||
            currentCountry.toLowerCase() === 'local network'
          ) {
            if (currentCountry !== 'Local Network') {
              updates.push({
                id: session.id,
                geoCity: currentCity,
                geoCountry: 'Local Network',
              });
            } else {
              totalSkipped++;
            }
            continue;
          }

          // Try to convert country name to ISO code
          const isoCode = getCountryCode(currentCountry);

          if (isoCode) {
            updates.push({
              id: session.id,
              geoCity: currentCity,
              geoCountry: isoCode,
            });
          } else {
            // Could not find a matching ISO code - skip
            totalSkipped++;
          }
        } catch (error) {
          console.error(`[Maintenance] Error processing session ${session.id}:`, error);
          totalErrors++;
        }
      }

      // Execute updates sequentially to avoid exhausting the connection pool
      if (updates.length > 0) {
        for (const update of updates) {
          try {
            await db
              .update(sessions)
              .set({ geoCity: update.geoCity, geoCountry: update.geoCountry })
              .where(eq(sessions.id, update.id));
            totalUpdated++;
          } catch (error) {
            console.error(`[Maintenance] Error updating session ${update.id}:`, error);
            totalErrors++;
          }
        }
      }

      totalProcessed += batch.length;
      activeJobProgress.processedRecords = totalProcessed;
      activeJobProgress.updatedRecords = totalUpdated;
      activeJobProgress.skippedRecords = totalSkipped;
      activeJobProgress.errorRecords = totalErrors;
      activeJobProgress.message = `Processed ${totalProcessed.toLocaleString()} of ${totalRecords.toLocaleString()} sessions...`;

      const percent = Math.round((totalProcessed / totalRecords) * 100);
      await job.updateProgress(percent);
      await publishProgress();

      try {
        await job.extendLock(job.token ?? '', 10 * 60 * 1000);
      } catch {
        console.warn(`[Maintenance] Failed to extend lock for job ${job.id}`);
      }

      if (totalProcessed < totalRecords) {
        await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
      }
    }

    const durationMs = Date.now() - startTime;
    activeJobProgress.status = 'complete';
    activeJobProgress.message = `Completed! Converted ${totalUpdated.toLocaleString()} country names to ISO codes in ${Math.round(durationMs / 1000)}s`;
    activeJobProgress.completedAt = new Date().toISOString();
    await publishProgress();

    activeJobProgress = null;

    return {
      success: true,
      type: 'normalize_countries',
      processed: totalRecords,
      updated: totalUpdated,
      skipped: totalSkipped,
      errors: totalErrors,
      durationMs,
      message: `Converted ${totalUpdated.toLocaleString()} country names to ISO codes`,
    };
  } catch (error) {
    if (activeJobProgress) {
      activeJobProgress.status = 'error';
      activeJobProgress.message = error instanceof Error ? error.message : 'Unknown error';
      await publishProgress();
      activeJobProgress = null;
    }
    throw error;
  }
}

/**
 * Fix imported sessions with missing progress data
 *
 * Recalculates progressMs and totalDurationMs for sessions imported from Tautulli
 * that have durationMs but null progress values. Uses the externalSessionId to
 * identify imported sessions.
 */
async function processFixImportedProgressJob(
  job: Job<MaintenanceJobData>
): Promise<MaintenanceJobResult> {
  const startTime = Date.now();
  const pubSubService = getPubSubService();
  const BATCH_SIZE = 500;
  const BATCH_DELAY_MS = 50;

  // Initialize progress
  activeJobProgress = {
    type: 'fix_imported_progress',
    status: 'running',
    totalRecords: 0,
    processedRecords: 0,
    updatedRecords: 0,
    skippedRecords: 0,
    errorRecords: 0,
    message: 'Counting imported sessions with missing progress...',
    startedAt: new Date().toISOString(),
  };

  const publishProgress = async () => {
    if (pubSubService && activeJobProgress) {
      await pubSubService.publish(WS_EVENTS.MAINTENANCE_PROGRESS, activeJobProgress);
    }
  };

  try {
    // Count sessions that:
    // - Have an externalSessionId (indicating they came from import)
    // - Have durationMs set
    // - Have null progressMs or null totalDurationMs
    const [countResult] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(sessions)
      .where(
        and(
          isNotNull(sessions.externalSessionId),
          isNotNull(sessions.durationMs),
          or(sql`${sessions.progressMs} IS NULL`, sql`${sessions.totalDurationMs} IS NULL`)
        )
      );

    const totalRecords = countResult?.count ?? 0;
    activeJobProgress.totalRecords = totalRecords;
    activeJobProgress.message = `Processing ${totalRecords.toLocaleString()} imported sessions...`;
    await publishProgress();

    if (totalRecords === 0) {
      activeJobProgress.status = 'complete';
      activeJobProgress.message = 'No imported sessions need progress fixes';
      activeJobProgress.completedAt = new Date().toISOString();
      await publishProgress();
      return {
        success: true,
        type: 'fix_imported_progress',
        processed: 0,
        updated: 0,
        skipped: 0,
        errors: 0,
        durationMs: Date.now() - startTime,
        message: 'No imported sessions need progress fixes',
      };
    }

    let lastId = ''; // Cursor for pagination
    let totalProcessed = 0;
    let totalUpdated = 0;
    let totalSkipped = 0;
    let totalErrors = 0;

    while (totalProcessed < totalRecords) {
      // Fetch batch of sessions
      // Use cursor-based pagination (id > lastId) to ensure we process each record exactly once
      const whereCondition = and(
        isNotNull(sessions.externalSessionId),
        isNotNull(sessions.durationMs),
        or(sql`${sessions.progressMs} IS NULL`, sql`${sessions.totalDurationMs} IS NULL`)
      );

      const batch = await db
        .select({
          id: sessions.id,
          durationMs: sessions.durationMs,
          progressMs: sessions.progressMs,
          totalDurationMs: sessions.totalDurationMs,
          watched: sessions.watched,
          mediaType: sessions.mediaType,
        })
        .from(sessions)
        .where(lastId ? and(whereCondition, sql`${sessions.id} > ${lastId}`) : whereCondition)
        .orderBy(sessions.id)
        .limit(BATCH_SIZE);

      // No more records to process
      if (batch.length === 0) {
        break;
      }

      // Update cursor to last record in batch
      const lastRecord = batch[batch.length - 1];
      if (lastRecord) lastId = lastRecord.id;

      // Collect updates for batch processing
      const updates: Array<{ id: string; progressMs: number; totalDurationMs: number }> = [];

      for (const session of batch) {
        try {
          const durationMs = session.durationMs;
          if (durationMs === null || durationMs <= 0) {
            totalSkipped++;
            continue;
          }

          // Calculate totalDurationMs based on watched status
          // If watched = true, assume they completed ~85% (typical watch threshold)
          // If watched = false, we don't know - skip these to avoid showing 100%
          // Note: This is a best-effort fix for legacy Tautulli imports
          let totalDurationMs: number;
          let progressMs: number;

          if (session.watched) {
            // If marked as watched, assume they hit ~85% threshold
            // So total = durationMs / 0.85 (inverse of watch threshold)
            totalDurationMs = Math.round(durationMs / 0.85);
            progressMs = durationMs;
          } else {
            // For unwatched sessions, use median content duration based on media type
            // These medians are derived from actual session data in the database
            const medianDurations: Record<string, number> = {
              episode: 42 * 60 * 1000, // 42 minutes
              movie: 109 * 60 * 1000, // 109 minutes
              track: 4 * 60 * 1000, // 4 minutes
            };
            const medianDuration = medianDurations[session.mediaType ?? ''] ?? 60 * 60 * 1000; // default 1 hour

            // Use the larger of median or actual watch time (they may have watched longer than average)
            totalDurationMs = Math.max(medianDuration, durationMs);
            progressMs = durationMs;
          }

          // Check if update is actually needed
          if (session.progressMs === progressMs && session.totalDurationMs === totalDurationMs) {
            totalSkipped++;
            continue;
          }

          updates.push({
            id: session.id,
            progressMs,
            totalDurationMs,
          });
        } catch (error) {
          console.error(`[Maintenance] Error processing session ${session.id}:`, error);
          totalErrors++;
        }
      }

      // Execute updates sequentially to avoid exhausting the connection pool
      if (updates.length > 0) {
        for (const update of updates) {
          try {
            await db
              .update(sessions)
              .set({
                progressMs: update.progressMs,
                totalDurationMs: update.totalDurationMs,
              })
              .where(eq(sessions.id, update.id));
            totalUpdated++;
          } catch (error) {
            console.error(`[Maintenance] Error updating session ${update.id}:`, error);
            totalErrors++;
          }
        }
      }

      totalProcessed += batch.length;
      activeJobProgress.processedRecords = totalProcessed;
      activeJobProgress.updatedRecords = totalUpdated;
      activeJobProgress.skippedRecords = totalSkipped;
      activeJobProgress.errorRecords = totalErrors;
      activeJobProgress.message = `Processed ${totalProcessed.toLocaleString()} of ${totalRecords.toLocaleString()} sessions...`;

      const percent = Math.round((totalProcessed / totalRecords) * 100);
      await job.updateProgress(percent);
      await publishProgress();

      try {
        await job.extendLock(job.token ?? '', 10 * 60 * 1000);
      } catch {
        console.warn(`[Maintenance] Failed to extend lock for job ${job.id}`);
      }

      if (totalProcessed < totalRecords) {
        await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
      }
    }

    const durationMs = Date.now() - startTime;
    activeJobProgress.status = 'complete';
    activeJobProgress.message = `Completed! Fixed progress data for ${totalUpdated.toLocaleString()} sessions in ${Math.round(durationMs / 1000)}s`;
    activeJobProgress.completedAt = new Date().toISOString();
    await publishProgress();

    activeJobProgress = null;

    return {
      success: true,
      type: 'fix_imported_progress',
      processed: totalRecords,
      updated: totalUpdated,
      skipped: totalSkipped,
      errors: totalErrors,
      durationMs,
      message: `Fixed progress data for ${totalUpdated.toLocaleString()} sessions`,
    };
  } catch (error) {
    if (activeJobProgress) {
      activeJobProgress.status = 'error';
      activeJobProgress.message = error instanceof Error ? error.message : 'Unknown error';
      await publishProgress();
      activeJobProgress = null;
    }
    throw error;
  }
}

/**
 * Rebuild TimescaleDB views and continuous aggregates
 *
 * Drops and recreates all engagement tracking views to fix broken views
 * or apply updated view definitions after an upgrade.
 */
async function processRebuildTimescaleViewsJob(
  job: Job<MaintenanceJobData>
): Promise<MaintenanceJobResult> {
  const startTime = Date.now();
  const pubSubService = getPubSubService();

  // Initialize progress
  activeJobProgress = {
    type: 'rebuild_timescale_views',
    status: 'running',
    totalRecords: 9, // Total steps in the rebuild process
    processedRecords: 0,
    updatedRecords: 0,
    skippedRecords: 0,
    errorRecords: 0,
    message: 'Starting TimescaleDB view rebuild...',
    startedAt: new Date().toISOString(),
  };

  const publishProgress = async () => {
    if (pubSubService && activeJobProgress) {
      await pubSubService.publish(WS_EVENTS.MAINTENANCE_PROGRESS, activeJobProgress);
    }
  };

  try {
    await publishProgress();

    const fullRefresh = job.data.options?.fullRefresh ?? false;

    // Call the rebuild function with options
    const result = await rebuildTimescaleViews({
      fullRefresh,
      progressCallback: (step, total, message) => {
        if (activeJobProgress) {
          activeJobProgress.processedRecords = step;
          activeJobProgress.totalRecords = total;
          activeJobProgress.message = message;
          void publishProgress();
        }

        // Update job progress percentage
        const percent = Math.round((step / total) * 100);
        void job.updateProgress(percent);
      },
    });

    const durationMs = Date.now() - startTime;

    if (result.success) {
      activeJobProgress.status = 'complete';
      activeJobProgress.processedRecords = 9;
      activeJobProgress.updatedRecords = 6; // Number of views created
      activeJobProgress.message = `${result.message} in ${Math.round(durationMs / 1000)}s`;
      activeJobProgress.completedAt = new Date().toISOString();
      await publishProgress();
      activeJobProgress = null;

      return {
        success: true,
        type: 'rebuild_timescale_views',
        processed: 9,
        updated: 6,
        skipped: 0,
        errors: 0,
        durationMs,
        message: result.message,
      };
    } else {
      activeJobProgress.status = 'error';
      activeJobProgress.errorRecords = 1;
      activeJobProgress.message = result.message;
      await publishProgress();
      activeJobProgress = null;

      return {
        success: false,
        type: 'rebuild_timescale_views',
        processed: 0,
        updated: 0,
        skipped: 0,
        errors: 1,
        durationMs,
        message: result.message,
      };
    }
  } catch (error) {
    if (activeJobProgress) {
      activeJobProgress.status = 'error';
      activeJobProgress.message = error instanceof Error ? error.message : 'Unknown error';
      await publishProgress();
      activeJobProgress = null;
    }
    throw error;
  }
}

/**
 * Normalize codec names to uppercase in historical sessions
 *
 * Converts codec values (source_video_codec, source_audio_codec, stream_video_codec,
 * stream_audio_codec) to uppercase for consistency. This fixes data imported before
 * the Tautulli enrichment was updated to uppercase codecs.
 */
async function processNormalizeCodecsJob(
  job: Job<MaintenanceJobData>
): Promise<MaintenanceJobResult> {
  const startTime = Date.now();
  const pubSubService = getPubSubService();
  const BATCH_SIZE = 1000; // Bulk update batch size

  // Initialize progress
  activeJobProgress = {
    type: 'normalize_codecs',
    status: 'running',
    totalRecords: 0,
    processedRecords: 0,
    updatedRecords: 0,
    skippedRecords: 0,
    errorRecords: 0,
    message: 'Counting sessions with lowercase codecs...',
    startedAt: new Date().toISOString(),
  };

  const publishProgress = async () => {
    if (pubSubService && activeJobProgress) {
      await pubSubService.publish(WS_EVENTS.MAINTENANCE_PROGRESS, activeJobProgress);
    }
  };

  try {
    // Count sessions that have codec values not already uppercase
    const [countResult] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(sessions)
      .where(
        or(
          sql`${sessions.sourceVideoCodec} IS DISTINCT FROM UPPER(${sessions.sourceVideoCodec})`,
          sql`${sessions.sourceAudioCodec} IS DISTINCT FROM UPPER(${sessions.sourceAudioCodec})`,
          sql`${sessions.streamVideoCodec} IS DISTINCT FROM UPPER(${sessions.streamVideoCodec})`,
          sql`${sessions.streamAudioCodec} IS DISTINCT FROM UPPER(${sessions.streamAudioCodec})`
        )
      );

    const totalRecords = countResult?.count ?? 0;
    activeJobProgress.totalRecords = totalRecords;
    activeJobProgress.message = `Processing ${totalRecords.toLocaleString()} sessions...`;
    await publishProgress();

    if (totalRecords === 0) {
      activeJobProgress.status = 'complete';
      activeJobProgress.message = 'All codec names are already normalized';
      activeJobProgress.completedAt = new Date().toISOString();
      await publishProgress();
      return {
        success: true,
        type: 'normalize_codecs',
        processed: 0,
        updated: 0,
        skipped: 0,
        errors: 0,
        durationMs: Date.now() - startTime,
        message: 'All codec names are already normalized',
      };
    }

    let totalUpdated = 0;
    let totalErrors = 0;

    // Use bulk UPDATE with LIMIT subquery - much more efficient than individual updates
    // This avoids exhausting PostgreSQL's lock pool
    while (totalUpdated < totalRecords) {
      try {
        // Single bulk UPDATE that updates up to BATCH_SIZE rows at once
        const result = await db.execute(sql`
          UPDATE ${sessions}
          SET
            source_video_codec = UPPER(source_video_codec),
            source_audio_codec = UPPER(source_audio_codec),
            stream_video_codec = UPPER(stream_video_codec),
            stream_audio_codec = UPPER(stream_audio_codec)
          WHERE id IN (
            SELECT id FROM ${sessions}
            WHERE source_video_codec IS DISTINCT FROM UPPER(source_video_codec)
               OR source_audio_codec IS DISTINCT FROM UPPER(source_audio_codec)
               OR stream_video_codec IS DISTINCT FROM UPPER(stream_video_codec)
               OR stream_audio_codec IS DISTINCT FROM UPPER(stream_audio_codec)
            LIMIT ${BATCH_SIZE}
          )
        `);

        const updatedCount = Number(result.rowCount ?? 0);

        // No more rows to update
        if (updatedCount === 0) {
          break;
        }

        totalUpdated += updatedCount;
      } catch (error) {
        console.error(`[Maintenance] Error in bulk update:`, error);
        totalErrors++;
        break;
      }

      activeJobProgress.processedRecords = totalUpdated;
      activeJobProgress.updatedRecords = totalUpdated;
      activeJobProgress.errorRecords = totalErrors;
      activeJobProgress.message = `Updated ${totalUpdated.toLocaleString()} of ${totalRecords.toLocaleString()} sessions...`;

      const percent = Math.min(100, Math.round((totalUpdated / totalRecords) * 100));
      await job.updateProgress(percent);
      await publishProgress();

      try {
        await job.extendLock(job.token ?? '', 10 * 60 * 1000);
      } catch {
        console.warn(`[Maintenance] Failed to extend lock for job ${job.id}`);
      }
    }

    const durationMs = Date.now() - startTime;
    activeJobProgress.status = 'complete';
    activeJobProgress.processedRecords = totalUpdated;
    activeJobProgress.message = `Completed! Normalized ${totalUpdated.toLocaleString()} codec values in ${Math.round(durationMs / 1000)}s`;
    activeJobProgress.completedAt = new Date().toISOString();
    await publishProgress();

    activeJobProgress = null;

    return {
      success: true,
      type: 'normalize_codecs',
      processed: totalUpdated,
      updated: totalUpdated,
      skipped: 0,
      errors: totalErrors,
      durationMs,
      message: `Normalized ${totalUpdated.toLocaleString()} codec values to uppercase`,
    };
  } catch (error) {
    if (activeJobProgress) {
      activeJobProgress.status = 'error';
      activeJobProgress.message = error instanceof Error ? error.message : 'Unknown error';
      await publishProgress();
      activeJobProgress = null;
    }
    throw error;
  }
}

/**
 * Backfill joinedAt and lastActivityAt for server_users from session history
 *
 * Sets:
 * - joinedAt: Earliest session start time for each user (if currently NULL)
 * - lastActivityAt: Most recent session start time for each user (always updates)
 *
 * This fixes users who were synced before Tracearr tracked activity timestamps,
 * or where imports didn't populate these fields.
 */
async function processBackfillUserDatesJob(
  job: Job<MaintenanceJobData>
): Promise<MaintenanceJobResult> {
  const startTime = Date.now();
  const pubSubService = getPubSubService();

  // Initialize progress
  activeJobProgress = {
    type: 'backfill_user_dates',
    status: 'running',
    totalRecords: 0,
    processedRecords: 0,
    updatedRecords: 0,
    skippedRecords: 0,
    errorRecords: 0,
    message: 'Counting users needing backfill...',
    startedAt: new Date().toISOString(),
  };

  const publishProgress = async () => {
    if (pubSubService && activeJobProgress) {
      await pubSubService.publish(WS_EVENTS.MAINTENANCE_PROGRESS, activeJobProgress);
    }
  };

  try {
    await publishProgress();

    // Count users that have sessions but missing dates
    const [countResult] = await db
      .select({ count: sql<number>`count(DISTINCT ${serverUsers.id})::int` })
      .from(serverUsers)
      .innerJoin(sessions, eq(sessions.serverUserId, serverUsers.id))
      .where(or(sql`${serverUsers.joinedAt} IS NULL`, sql`${serverUsers.lastActivityAt} IS NULL`));

    const totalRecords = countResult?.count ?? 0;
    activeJobProgress.totalRecords = totalRecords;

    if (totalRecords === 0) {
      activeJobProgress.status = 'complete';
      activeJobProgress.message = 'All users already have activity dates populated';
      activeJobProgress.completedAt = new Date().toISOString();
      await publishProgress();
      activeJobProgress = null;

      return {
        success: true,
        type: 'backfill_user_dates',
        processed: 0,
        updated: 0,
        skipped: 0,
        errors: 0,
        durationMs: Date.now() - startTime,
        message: 'All users already have activity dates populated',
      };
    }

    activeJobProgress.message = `Backfilling dates for ${totalRecords.toLocaleString()} users...`;
    await publishProgress();

    let joinedAtUpdated = 0;
    let lastActivityUpdated = 0;
    let totalErrors = 0;

    // Step 1: Update joinedAt to earliest session for users with NULL joinedAt
    activeJobProgress.message = 'Setting joinedAt from earliest sessions...';
    await publishProgress();

    try {
      const joinedResult = await db.execute(sql`
        UPDATE server_users su
        SET joined_at = earliest.min_started
        FROM (
          SELECT server_user_id, MIN(started_at) as min_started
          FROM sessions
          GROUP BY server_user_id
        ) earliest
        WHERE su.id = earliest.server_user_id
          AND su.joined_at IS NULL
      `);
      joinedAtUpdated = Number(joinedResult.rowCount ?? 0);
    } catch (error) {
      console.error('[Maintenance] Error updating joinedAt:', error);
      totalErrors++;
    }

    activeJobProgress.processedRecords = joinedAtUpdated;
    activeJobProgress.message = `Updated joinedAt for ${joinedAtUpdated} users. Now updating lastActivityAt...`;
    await job.updateProgress(50);
    await publishProgress();

    // Step 2: Update lastActivityAt to most recent session for all users with sessions
    // We update even if not NULL to ensure it's the most recent activity
    try {
      const activityResult = await db.execute(sql`
        UPDATE server_users su
        SET last_activity_at = latest.max_started
        FROM (
          SELECT server_user_id, MAX(started_at) as max_started
          FROM sessions
          GROUP BY server_user_id
        ) latest
        WHERE su.id = latest.server_user_id
          AND (su.last_activity_at IS NULL OR su.last_activity_at < latest.max_started)
      `);
      lastActivityUpdated = Number(activityResult.rowCount ?? 0);
    } catch (error) {
      console.error('[Maintenance] Error updating lastActivityAt:', error);
      totalErrors++;
    }

    const totalUpdated = joinedAtUpdated + lastActivityUpdated;
    const durationMs = Date.now() - startTime;

    activeJobProgress.status = 'complete';
    activeJobProgress.processedRecords = totalRecords;
    activeJobProgress.updatedRecords = totalUpdated;
    activeJobProgress.errorRecords = totalErrors;
    activeJobProgress.message = `Completed! Updated joinedAt for ${joinedAtUpdated} users, lastActivityAt for ${lastActivityUpdated} users in ${Math.round(durationMs / 1000)}s`;
    activeJobProgress.completedAt = new Date().toISOString();
    await job.updateProgress(100);
    await publishProgress();

    activeJobProgress = null;

    return {
      success: true,
      type: 'backfill_user_dates',
      processed: totalRecords,
      updated: totalUpdated,
      skipped: 0,
      errors: totalErrors,
      durationMs,
      message: `Updated joinedAt for ${joinedAtUpdated} users, lastActivityAt for ${lastActivityUpdated} users`,
    };
  } catch (error) {
    if (activeJobProgress) {
      activeJobProgress.status = 'error';
      activeJobProgress.message = error instanceof Error ? error.message : 'Unknown error';
      await publishProgress();
      activeJobProgress = null;
    }
    throw error;
  }
}

/**
 * Backfill library snapshots from library_items.created_at
 *
 * Creates historical snapshots by reconstructing library state over time using
 * cumulative window functions on item creation dates. This enables proper
 * deletion/upgrade tracking in charts by preserving historical state.
 *
 * Process:
 * 1. Get all server+library combinations with their date ranges
 * 2. For each library, generate daily snapshots using window functions
 * 3. Skip days that already have snapshots (idempotent)
 */
async function processBackfillLibrarySnapshotsJob(
  job: Job<MaintenanceJobData>
): Promise<MaintenanceJobResult> {
  const startTime = Date.now();
  const pubSubService = getPubSubService();

  // Initialize progress
  activeJobProgress = {
    type: 'backfill_library_snapshots',
    status: 'running',
    totalRecords: 0,
    processedRecords: 0,
    updatedRecords: 0,
    skippedRecords: 0,
    errorRecords: 0,
    message: 'Analyzing libraries...',
    startedAt: new Date().toISOString(),
  };

  const publishProgress = async () => {
    if (pubSubService && activeJobProgress) {
      await pubSubService.publish(WS_EVENTS.MAINTENANCE_PROGRESS, activeJobProgress);
    }
  };

  try {
    await publishProgress();

    // Get all server+library combinations with their date ranges
    const librariesResult = await db.execute(sql`
      SELECT
        server_id,
        library_id,
        MIN(created_at)::date AS start_date,
        CURRENT_DATE AS end_date,
        COUNT(*) AS item_count
      FROM library_items
      WHERE created_at IS NOT NULL
      GROUP BY server_id, library_id
    `);

    const libraries = librariesResult.rows as Array<{
      server_id: string;
      library_id: string;
      start_date: string;
      end_date: string;
      item_count: string;
    }>;

    if (libraries.length === 0) {
      activeJobProgress.status = 'complete';
      activeJobProgress.message = 'No libraries found to backfill';
      activeJobProgress.completedAt = new Date().toISOString();
      await publishProgress();
      activeJobProgress = null;

      return {
        success: true,
        type: 'backfill_library_snapshots',
        processed: 0,
        updated: 0,
        skipped: 0,
        errors: 0,
        durationMs: Date.now() - startTime,
        message: 'No libraries found to backfill',
      };
    }

    activeJobProgress.totalRecords = libraries.length;
    activeJobProgress.message = `Processing ${libraries.length} libraries...`;
    await publishProgress();

    let totalProcessed = 0;
    let totalSnapshotsCreated = 0;
    let totalErrors = 0;

    for (const lib of libraries) {
      try {
        // Insert daily snapshots for this library using window functions
        // This reconstructs historical state from item creation dates
        const result = await db.execute(sql`
          INSERT INTO library_snapshots (
            server_id, library_id, snapshot_time,
            item_count, total_size,
            movie_count, episode_count, season_count, show_count, music_count,
            count_4k, count_1080p, count_720p, count_sd,
            hevc_count, h264_count, av1_count,
            enrichment_pending, enrichment_complete
          )
          WITH daily_additions AS (
            -- Get per-day additions with all metrics
            SELECT
              DATE(created_at) AS day,
              COUNT(*) AS items,
              COALESCE(SUM(file_size), 0) AS size,
              COUNT(*) FILTER (WHERE media_type = 'movie') AS movies,
              COUNT(*) FILTER (WHERE media_type = 'episode') AS episodes,
              COUNT(*) FILTER (WHERE media_type = 'season') AS seasons,
              COUNT(*) FILTER (WHERE media_type = 'show') AS shows,
              COUNT(*) FILTER (WHERE media_type IN ('artist', 'album', 'track')) AS music,
              COUNT(*) FILTER (WHERE video_resolution = '4k') AS c4k,
              COUNT(*) FILTER (WHERE video_resolution = '1080p') AS c1080p,
              COUNT(*) FILTER (WHERE video_resolution = '720p') AS c720p,
              COUNT(*) FILTER (WHERE video_resolution IN ('480p', 'sd')
                                OR (video_resolution IS NOT NULL
                                    AND video_resolution NOT IN ('4k', '1080p', '720p'))) AS csd,
              COUNT(*) FILTER (WHERE video_codec IN ('hevc', 'h265', 'x265', 'HEVC', 'H265', 'X265')) AS hevc,
              COUNT(*) FILTER (WHERE video_codec IN ('h264', 'avc', 'x264', 'H264', 'AVC', 'X264')) AS h264,
              COUNT(*) FILTER (WHERE video_codec IN ('av1', 'AV1')) AS av1
            FROM library_items
            WHERE server_id = ${lib.server_id}::uuid
              AND library_id = ${lib.library_id}
            GROUP BY DATE(created_at)
          ),
          date_series AS (
            SELECT d::date AS day FROM generate_series(
              ${lib.start_date}::date, ${lib.end_date}::date, '1 day'
            ) d
          ),
          filled AS (
            SELECT ds.day,
              COALESCE(da.items, 0) AS items, COALESCE(da.size, 0) AS size,
              COALESCE(da.movies, 0) AS movies, COALESCE(da.episodes, 0) AS episodes,
              COALESCE(da.seasons, 0) AS seasons, COALESCE(da.shows, 0) AS shows,
              COALESCE(da.music, 0) AS music,
              COALESCE(da.c4k, 0) AS c4k, COALESCE(da.c1080p, 0) AS c1080p,
              COALESCE(da.c720p, 0) AS c720p, COALESCE(da.csd, 0) AS csd,
              COALESCE(da.hevc, 0) AS hevc, COALESCE(da.h264, 0) AS h264,
              COALESCE(da.av1, 0) AS av1
            FROM date_series ds
            LEFT JOIN daily_additions da ON da.day = ds.day
          ),
          cumulative AS (
            SELECT
              f.day,
              -- Cumulative counts using window functions
              SUM(items) OVER w AS item_count,
              SUM(size) OVER w AS total_size,
              SUM(movies) OVER w AS movie_count,
              SUM(episodes) OVER w AS episode_count,
              SUM(seasons) OVER w AS season_count,
              SUM(shows) OVER w AS show_count,
              SUM(music) OVER w AS music_count,
              SUM(c4k) OVER w AS count_4k,
              SUM(c1080p) OVER w AS count_1080p,
              SUM(c720p) OVER w AS count_720p,
              SUM(csd) OVER w AS count_sd,
              SUM(hevc) OVER w AS hevc_count,
              SUM(h264) OVER w AS h264_count,
              SUM(av1) OVER w AS av1_count
            FROM filled f
            WINDOW w AS (ORDER BY day ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
          )
          SELECT
            ${lib.server_id}::uuid,
            ${lib.library_id},
            (c.day + INTERVAL '23 hours 59 minutes 59 seconds')::timestamptz,
            c.item_count::int,
            c.total_size::bigint,
            c.movie_count::int,
            c.episode_count::int,
            c.season_count::int,
            c.show_count::int,
            c.music_count::int,
            c.count_4k::int,
            c.count_1080p::int,
            c.count_720p::int,
            c.count_sd::int,
            c.hevc_count::int,
            c.h264_count::int,
            c.av1_count::int,
            0,  -- enrichment_pending: all historical items already enriched
            c.item_count::int  -- enrichment_complete
          FROM cumulative c
          -- Skip days that already have snapshots (idempotent)
          WHERE NOT EXISTS (
            SELECT 1 FROM library_snapshots ls
            WHERE ls.server_id = ${lib.server_id}::uuid
              AND ls.library_id = ${lib.library_id}
              AND DATE(ls.snapshot_time) = c.day
          )
        `);

        const snapshotsCreated = Number(result.rowCount ?? 0);
        totalSnapshotsCreated += snapshotsCreated;
        totalProcessed++;

        activeJobProgress.processedRecords = totalProcessed;
        activeJobProgress.updatedRecords = totalSnapshotsCreated;
        activeJobProgress.message = `Processed ${totalProcessed} of ${libraries.length} libraries (${totalSnapshotsCreated} snapshots created)...`;

        const percent = Math.round((totalProcessed / libraries.length) * 100);
        await job.updateProgress(percent);
        await publishProgress();

        // Extend lock to prevent stalled job detection
        try {
          await job.extendLock(job.token ?? '', 10 * 60 * 1000);
        } catch {
          console.warn(`[Maintenance] Failed to extend lock for job ${job.id}`);
        }
      } catch (error) {
        console.error(
          `[Maintenance] Error processing library ${lib.server_id}/${lib.library_id}:`,
          error
        );
        totalErrors++;
        activeJobProgress.errorRecords = totalErrors;
      }
    }

    // Clean up empty snapshots (from bad dates like 1969/1970 or gaps before real data)
    // Note: We only delete snapshots with no items in any category.
    // Snapshots with items but total_size=0 are kept (items may lack file_size metadata).
    // See snapshotValidation.ts for the centralized definition of invalid snapshots.
    activeJobProgress.message = 'Cleaning up empty snapshots...';
    await publishProgress();

    const cleanupResult = await db.execute(sql`
      DELETE FROM library_snapshots
      WHERE ${INVALID_SNAPSHOT_CONDITION}
    `);
    const cleanedUp = Number(cleanupResult.rowCount ?? 0);
    if (cleanedUp > 0) {
      console.log(`[Maintenance] Cleaned up ${cleanedUp} empty snapshots`);
    }

    // Refresh the continuous aggregate to include backfilled data
    activeJobProgress.message = 'Refreshing library_stats_daily continuous aggregate...';
    await publishProgress();

    // Get the earliest snapshot date to refresh from
    const earliestResult = await db.execute(sql`
      SELECT MIN(snapshot_time)::date AS earliest FROM library_snapshots
    `);
    const earliestDate = (earliestResult.rows[0] as { earliest: string | null })?.earliest;

    if (earliestDate) {
      await db.execute(sql`
        CALL refresh_continuous_aggregate('library_stats_daily', ${earliestDate}::date, NOW()::date + INTERVAL '1 day')
      `);
    }

    const durationMs = Date.now() - startTime;
    activeJobProgress.status = 'complete';
    activeJobProgress.processedRecords = totalProcessed;
    activeJobProgress.skippedRecords = cleanedUp;
    activeJobProgress.message = `Completed! Created ${totalSnapshotsCreated.toLocaleString()} snapshots for ${totalProcessed} libraries${cleanedUp > 0 ? `, cleaned up ${cleanedUp} empty` : ''} in ${Math.round(durationMs / 1000)}s`;
    activeJobProgress.completedAt = new Date().toISOString();
    await publishProgress();

    activeJobProgress = null;

    return {
      success: true,
      type: 'backfill_library_snapshots',
      processed: totalProcessed,
      updated: totalSnapshotsCreated,
      skipped: cleanedUp,
      errors: totalErrors,
      durationMs,
      message: `Created ${totalSnapshotsCreated.toLocaleString()} snapshots for ${totalProcessed} libraries${cleanedUp > 0 ? `, cleaned up ${cleanedUp} empty` : ''}`,
    };
  } catch (error) {
    if (activeJobProgress) {
      activeJobProgress.status = 'error';
      activeJobProgress.message = error instanceof Error ? error.message : 'Unknown error';
      await publishProgress();
      activeJobProgress = null;
    }
    throw error;
  }
}

/**
 * Get current job progress (if any)
 */
export function getMaintenanceProgress(): MaintenanceJobProgress | null {
  return activeJobProgress;
}

/**
 * Enqueue a new maintenance job
 */
export async function enqueueMaintenanceJob(
  type: MaintenanceJobType,
  userId: string,
  options?: MaintenanceJobData['options']
): Promise<string> {
  if (!maintenanceQueue) {
    throw new Error('Maintenance queue not initialized');
  }

  // Check for existing active job
  const activeJobs = await maintenanceQueue.getJobs(['active', 'waiting', 'delayed']);
  if (activeJobs.length > 0) {
    throw new Error('A maintenance job is already in progress');
  }

  // Use a deterministic job ID to prevent race conditions
  // BullMQ will reject if a job with this ID already exists
  const newJobId = `maintenance-${type}-${Date.now()}`;
  const job = await maintenanceQueue.add(
    `maintenance-${type}`,
    {
      type,
      userId,
      options,
    },
    {
      jobId: newJobId,
    }
  );

  const jobId = job.id ?? newJobId;
  console.log(`[Maintenance] Enqueued job ${jobId} (${type})`);
  return jobId;
}

/**
 * Get maintenance job status
 */
export async function getMaintenanceJobStatus(jobId: string): Promise<{
  jobId: string;
  state: string;
  progress: number | object | null;
  result?: MaintenanceJobResult;
  failedReason?: string;
  createdAt?: number;
  finishedAt?: number;
} | null> {
  if (!maintenanceQueue) {
    return null;
  }

  const job = await maintenanceQueue.getJob(jobId);
  if (!job) {
    return null;
  }

  const state = await job.getState();
  const progress = job.progress;

  return {
    jobId: job.id ?? jobId,
    state,
    progress: typeof progress === 'number' || typeof progress === 'object' ? progress : null,
    result: job.returnvalue as MaintenanceJobResult | undefined,
    failedReason: job.failedReason,
    createdAt: job.timestamp,
    finishedAt: job.finishedOn,
  };
}

/**
 * Get queue statistics
 */
export async function getMaintenanceQueueStats(): Promise<{
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
} | null> {
  if (!maintenanceQueue) {
    return null;
  }

  const [waiting, active, completed, failed, delayed] = await Promise.all([
    maintenanceQueue.getWaitingCount(),
    maintenanceQueue.getActiveCount(),
    maintenanceQueue.getCompletedCount(),
    maintenanceQueue.getFailedCount(),
    maintenanceQueue.getDelayedCount(),
  ]);

  return { waiting, active, completed, failed, delayed };
}

/**
 * Get recent job history
 */
export async function getMaintenanceJobHistory(limit: number = 10): Promise<
  Array<{
    jobId: string;
    type: MaintenanceJobType;
    state: string;
    createdAt: number;
    finishedAt?: number;
    result?: MaintenanceJobResult;
  }>
> {
  if (!maintenanceQueue) {
    return [];
  }

  const jobs = await maintenanceQueue.getJobs(['completed', 'failed'], 0, limit);

  return jobs.map((job) => ({
    jobId: job.id ?? 'unknown',
    type: job.data.type,
    state: job.finishedOn ? (job.failedReason ? 'failed' : 'completed') : 'unknown',
    createdAt: job.timestamp ?? 0,
    finishedAt: job.finishedOn,
    result: job.returnvalue as MaintenanceJobResult | undefined,
  }));
}

/**
 * Check if a specific maintenance job type is currently running or queued
 */
export async function isMaintenanceJobRunning(
  jobType: MaintenanceJobType
): Promise<{ isRunning: boolean; state: 'active' | 'waiting' | 'delayed' | null }> {
  if (!maintenanceQueue) {
    return { isRunning: false, state: null };
  }

  const jobs = await maintenanceQueue.getJobs(['active', 'waiting', 'delayed']);
  const matchingJob = jobs.find((job) => job.data.type === jobType);

  if (!matchingJob) {
    return { isRunning: false, state: null };
  }

  const state = await matchingJob.getState();
  return {
    isRunning: true,
    state: state as 'active' | 'waiting' | 'delayed',
  };
}

/**
 * Gracefully shutdown
 */
export async function shutdownMaintenanceQueue(): Promise<void> {
  console.log('Shutting down maintenance queue...');

  if (maintenanceWorker) {
    await maintenanceWorker.close();
    maintenanceWorker = null;
  }

  if (maintenanceQueue) {
    await maintenanceQueue.close();
    maintenanceQueue = null;
  }

  console.log('Maintenance queue shutdown complete');
}
