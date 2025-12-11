/**
 * Tautulli API integration and import service
 */

import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { TautulliImportProgress, TautulliImportResult } from '@tracearr/shared';
import { db } from '../db/client.js';
import { sessions, serverUsers, settings } from '../db/schema.js';
import { refreshAggregates } from '../db/timescale.js';
import { geoipService } from './geoip.js';
import type { PubSubService } from './cache.js';

const PAGE_SIZE = 1000; // Larger batches = fewer API calls
const REQUEST_TIMEOUT_MS = 30000; // 30 seconds
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000; // Base delay, will be multiplied by attempt number

// Helper for fields that can be number or empty string (Tautulli API inconsistency)
// Exported for testing
export const numberOrEmptyString = z.union([z.number(), z.literal('')]);

// Zod schemas for runtime validation of Tautulli API responses
// Based on actual API response from http://192.168.1.32:8181
// Exported for testing
export const TautulliHistoryRecordSchema = z.object({
  // IDs - can be null for active sessions
  reference_id: z.number().nullable(),
  row_id: z.number().nullable(),
  id: z.number().nullable(), // Additional ID field

  // Timestamps and durations - always numbers
  date: z.number(),
  started: z.number(),
  stopped: z.number(),
  duration: z.number(),
  play_duration: z.number(), // Actual play time
  paused_counter: z.number(),

  // User info
  user_id: z.number(),
  user: z.string(),
  friendly_name: z.string(),
  user_thumb: z.string(), // User avatar URL

  // Player/client info
  platform: z.string(),
  product: z.string(),
  player: z.string(),
  ip_address: z.string(),
  machine_id: z.string(),
  location: z.string(),

  // Boolean-like flags (0/1)
  live: z.number(),
  secure: z.number(),
  relayed: z.number(),

  // Media info
  media_type: z.string(),
  rating_key: z.number(), // Always number per actual API
  // These CAN be empty string for movies, number for episodes
  parent_rating_key: numberOrEmptyString,
  grandparent_rating_key: numberOrEmptyString,
  full_title: z.string(),
  title: z.string(),
  parent_title: z.string(),
  grandparent_title: z.string(),
  original_title: z.string(),
  // year: number for movies, empty string "" for episodes
  year: numberOrEmptyString,
  // media_index: number for episodes, empty string for movies
  media_index: numberOrEmptyString,
  parent_media_index: numberOrEmptyString,
  thumb: z.string(),
  originally_available_at: z.string(),
  guid: z.string(),

  // Playback info
  transcode_decision: z.string(),
  percent_complete: z.number(),
  watched_status: z.number(), // 0, 0.75, 1

  // Session grouping
  group_count: z.number().nullable(),
  group_ids: z.string().nullable(),
  state: z.string().nullable(),
  session_key: z.number().nullable(), // Actually just number | null per API
});

export const TautulliHistoryResponseSchema = z.object({
  response: z.object({
    result: z.string(),
    message: z.string().nullable(),
    data: z.object({
      recordsFiltered: z.number(),
      recordsTotal: z.number(),
      data: z.array(TautulliHistoryRecordSchema),
      draw: z.number(),
      filter_duration: z.string(),
      total_duration: z.string(),
    }),
  }),
});

export const TautulliUserRecordSchema = z.object({
  user_id: z.number(),
  username: z.string(),
  friendly_name: z.string(),
  email: z.string().nullable(), // Can be null for local users
  thumb: z.string().nullable(), // Can be null for local users
  is_home_user: z.number().nullable(), // Can be null for local users
  is_admin: z.number(),
  is_active: z.number(),
  do_notify: z.number(),
});

export const TautulliUsersResponseSchema = z.object({
  response: z.object({
    result: z.string(),
    message: z.string().nullable(),
    data: z.array(TautulliUserRecordSchema),
  }),
});

// Infer types from schemas - exported for testing
export type TautulliHistoryRecord = z.infer<typeof TautulliHistoryRecordSchema>;
export type TautulliHistoryResponse = z.infer<typeof TautulliHistoryResponseSchema>;
export type TautulliUserRecord = z.infer<typeof TautulliUserRecordSchema>;
export type TautulliUsersResponse = z.infer<typeof TautulliUsersResponseSchema>;

export class TautulliService {
  private baseUrl: string;
  private apiKey: string;

  constructor(url: string, apiKey: string) {
    this.baseUrl = url.replace(/\/$/, '');
    this.apiKey = apiKey;
  }

  /**
   * Make API request to Tautulli with timeout and retry logic
   */
  private async request<T>(
    cmd: string,
    params: Record<string, string | number> = {},
    schema?: z.ZodType<T>
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}/api/v2`);
    url.searchParams.set('apikey', this.apiKey);
    url.searchParams.set('cmd', cmd);

    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, String(value));
    }

    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      try {
        const response = await fetch(url.toString(), {
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          throw new Error(`Tautulli API error: ${response.status} ${response.statusText}`);
        }

        const json = await response.json();

        // Validate response with Zod schema if provided
        if (schema) {
          const parsed = schema.safeParse(json);
          if (!parsed.success) {
            console.error('Tautulli API response validation failed:', z.treeifyError(parsed.error));
            throw new Error(`Invalid Tautulli API response: ${parsed.error.message}`);
          }
          return parsed.data;
        }

        return json as T;
      } catch (error) {
        clearTimeout(timeoutId);

        if (error instanceof Error) {
          // Don't retry on abort (timeout) after max retries
          if (error.name === 'AbortError') {
            lastError = new Error(`Tautulli API timeout after ${REQUEST_TIMEOUT_MS}ms`);
          } else {
            lastError = error;
          }
        } else {
          lastError = new Error('Unknown error');
        }

        // Don't retry on validation errors
        if (lastError.message.includes('Invalid Tautulli API response')) {
          throw lastError;
        }

        // Wait before retrying (exponential backoff)
        if (attempt < MAX_RETRIES) {
          const delay = RETRY_DELAY_MS * attempt;
          console.warn(`Tautulli API request failed (attempt ${attempt}/${MAX_RETRIES}), retrying in ${delay}ms...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError ?? new Error('Tautulli API request failed after retries');
  }

  /**
   * Test connection to Tautulli
   */
  async testConnection(): Promise<boolean> {
    try {
      const result = await this.request<{ response: { result: string } }>('arnold');
      return result.response.result === 'success';
    } catch {
      return false;
    }
  }

  /**
   * Get all users from Tautulli
   */
  async getUsers(): Promise<TautulliUserRecord[]> {
    const result = await this.request<TautulliUsersResponse>(
      'get_users',
      {},
      TautulliUsersResponseSchema
    );
    return result.response.data ?? [];
  }

  /**
   * Get paginated history from Tautulli
   */
  async getHistory(
    start: number = 0,
    length: number = PAGE_SIZE
  ): Promise<{ records: TautulliHistoryRecord[]; total: number }> {
    const result = await this.request<TautulliHistoryResponse>(
      'get_history',
      {
        start,
        length,
        order_column: 'date',
        order_dir: 'desc',
      },
      TautulliHistoryResponseSchema
    );

    return {
      records: result.response.data?.data ?? [],
      total: result.response.data?.recordsTotal ?? 0,
    };
  }

  /**
   * Import all history from Tautulli into Tracearr (OPTIMIZED)
   *
   * Performance improvements over original:
   * - Pre-fetches all existing sessions (1 query vs N queries for dedup)
   * - Batches INSERT operations (100 per batch vs individual inserts)
   * - Batches UPDATE operations in transactions
   * - Caches GeoIP lookups per IP address
   * - Throttles WebSocket updates (every 100 records or 2 seconds)
   */
  static async importHistory(
    serverId: string,
    pubSubService?: PubSubService
  ): Promise<TautulliImportResult> {
    // Get Tautulli settings
    const settingsRow = await db
      .select()
      .from(settings)
      .where(eq(settings.id, 1))
      .limit(1);

    const config = settingsRow[0];
    if (!config?.tautulliUrl || !config?.tautulliApiKey) {
      return {
        success: false,
        imported: 0,
        skipped: 0,
        errors: 0,
        message: 'Tautulli is not configured. Please add URL and API key in Settings.',
      };
    }

    const tautulli = new TautulliService(config.tautulliUrl, config.tautulliApiKey);

    // Test connection
    const connected = await tautulli.testConnection();
    if (!connected) {
      return {
        success: false,
        imported: 0,
        skipped: 0,
        errors: 0,
        message: 'Failed to connect to Tautulli. Please check URL and API key.',
      };
    }

    // Initialize progress
    const progress: TautulliImportProgress = {
      status: 'fetching',
      totalRecords: 0,
      processedRecords: 0,
      importedRecords: 0,
      skippedRecords: 0,
      errorRecords: 0,
      currentPage: 0,
      totalPages: 0,
      message: 'Connecting to Tautulli...',
    };

    // Throttled progress publishing (fire-and-forget, every 100 records or 2 seconds)
    let lastProgressTime = Date.now();
    const publishProgress = () => {
      if (pubSubService) {
        pubSubService.publish('import:progress', progress).catch((err: unknown) => {
          console.warn('Failed to publish progress:', err);
        });
      }
    };

    publishProgress();

    // Get user mapping (Tautulli user_id → Tracearr user_id)
    const userMap = new Map<number, string>();

    // Get all Tracearr server users for this server
    const tracearrUsers = await db
      .select()
      .from(serverUsers)
      .where(eq(serverUsers.serverId, serverId));

    // Map by externalId (Plex user ID)
    for (const serverUser of tracearrUsers) {
      if (serverUser.externalId) {
        const plexUserId = parseInt(serverUser.externalId, 10);
        if (!isNaN(plexUserId)) {
          userMap.set(plexUserId, serverUser.id);
        }
      }
    }

    // Get total count
    const { total } = await tautulli.getHistory(0, 1);
    progress.totalRecords = total;
    progress.totalPages = Math.ceil(total / PAGE_SIZE);
    progress.message = `Found ${total} records to import`;
    publishProgress();

    // === OPTIMIZATION: Pre-fetch all existing sessions for this server ===
    console.log('[Import] Pre-fetching existing sessions for deduplication...');
    const existingSessions = await db
      .select({
        id: sessions.id,
        externalSessionId: sessions.externalSessionId,
        ratingKey: sessions.ratingKey,
        startedAt: sessions.startedAt,
        serverUserId: sessions.serverUserId,
        totalDurationMs: sessions.totalDurationMs,
        // Fields needed for change detection
        stoppedAt: sessions.stoppedAt,
        durationMs: sessions.durationMs,
        pausedDurationMs: sessions.pausedDurationMs,
        watched: sessions.watched,
      })
      .from(sessions)
      .where(eq(sessions.serverId, serverId));

    // Build O(1) lookup maps
    type ExistingSession = (typeof existingSessions)[0];
    const sessionByExternalId = new Map<string, ExistingSession>();
    const sessionByTimeKey = new Map<string, ExistingSession>();

    for (const s of existingSessions) {
      if (s.externalSessionId) {
        sessionByExternalId.set(s.externalSessionId, s);
      }
      if (s.ratingKey && s.serverUserId && s.startedAt) {
        const timeKey = `${s.serverUserId}:${s.ratingKey}:${s.startedAt.getTime()}`;
        sessionByTimeKey.set(timeKey, s);
      }
    }
    console.log(`[Import] Pre-fetched ${existingSessions.length} existing sessions`);

    // === OPTIMIZATION: GeoIP cache ===
    const geoCache = new Map<string, ReturnType<typeof geoipService.lookup>>();

    // === OPTIMIZATION: Batch collections ===
    // Inserts are batched per page (100 records) and flushed at end of each page
    const insertBatch: (typeof sessions.$inferInsert)[] = [];

    // Update batches - collected and flushed per page
    interface SessionUpdate {
      id: string;
      externalSessionId?: string;
      stoppedAt: Date;
      durationMs: number;
      pausedDurationMs: number;
      watched: boolean;
      progressMs?: number;
    }
    const updateBatch: SessionUpdate[] = [];

    let imported = 0;
    let skipped = 0;
    let errors = 0;
    let page = 0;

    // Track skipped users for warning message
    const skippedUsers = new Map<number, { username: string; count: number }>();

    // Helper to flush batches
    const flushBatches = async () => {
      // Flush inserts
      if (insertBatch.length > 0) {
        await db.insert(sessions).values(insertBatch);
        insertBatch.length = 0;
      }

      // Flush updates in a transaction
      if (updateBatch.length > 0) {
        await db.transaction(async (tx) => {
          for (const update of updateBatch) {
            await tx
              .update(sessions)
              .set({
                externalSessionId: update.externalSessionId,
                stoppedAt: update.stoppedAt,
                durationMs: update.durationMs,
                pausedDurationMs: update.pausedDurationMs,
                watched: update.watched,
                progressMs: update.progressMs,
              })
              .where(eq(sessions.id, update.id));
          }
        });
        updateBatch.length = 0;
      }
    };

    // Process all pages
    while (page * PAGE_SIZE < total) {
      progress.status = 'processing';
      progress.currentPage = page + 1;
      progress.message = `Processing page ${page + 1} of ${progress.totalPages}`;

      const { records } = await tautulli.getHistory(page * PAGE_SIZE, PAGE_SIZE);

      for (const record of records) {
        progress.processedRecords++;

        try {
          // Find Tracearr server user by Plex user ID
          const serverUserId = userMap.get(record.user_id);
          if (!serverUserId) {
            // User not found in Tracearr - track for warning
            const existing = skippedUsers.get(record.user_id);
            if (existing) {
              existing.count++;
            } else {
              skippedUsers.set(record.user_id, {
                username: record.friendly_name || record.user,
                count: 1,
              });
            }
            skipped++;
            progress.skippedRecords++;
            continue;
          }

          // Skip records without reference_id (active/in-progress sessions)
          if (record.reference_id === null) {
            skipped++;
            progress.skippedRecords++;
            continue;
          }

          const referenceIdStr = String(record.reference_id);

          // === OPTIMIZATION: O(1) lookup instead of DB query ===
          const existingByRef = sessionByExternalId.get(referenceIdStr);
          if (existingByRef) {
            // Calculate new values
            const newStoppedAt = new Date(record.stopped * 1000);
            const newDurationMs = record.duration * 1000;
            const newPausedDurationMs = record.paused_counter * 1000;
            const newWatched = record.watched_status === 1;
            const newProgressMs = Math.round(
              (record.percent_complete / 100) * (existingByRef.totalDurationMs ?? 0)
            );

            // Only update if something actually changed
            const stoppedAtChanged = existingByRef.stoppedAt?.getTime() !== newStoppedAt.getTime();
            const durationChanged = existingByRef.durationMs !== newDurationMs;
            const pausedChanged = existingByRef.pausedDurationMs !== newPausedDurationMs;
            const watchedChanged = existingByRef.watched !== newWatched;

            if (stoppedAtChanged || durationChanged || pausedChanged || watchedChanged) {
              updateBatch.push({
                id: existingByRef.id,
                stoppedAt: newStoppedAt,
                durationMs: newDurationMs,
                pausedDurationMs: newPausedDurationMs,
                watched: newWatched,
                progressMs: newProgressMs,
              });
            }

            skipped++;
            progress.skippedRecords++;
            continue;
          }

          // Fallback dedup check
          const startedAt = new Date(record.started * 1000);
          const ratingKeyStr =
            typeof record.rating_key === 'number' ? String(record.rating_key) : null;

          if (ratingKeyStr) {
            const timeKey = `${serverUserId}:${ratingKeyStr}:${startedAt.getTime()}`;
            const existingByTime = sessionByTimeKey.get(timeKey);

            if (existingByTime) {
              // Calculate new values
              const newStoppedAt = new Date(record.stopped * 1000);
              const newDurationMs = record.duration * 1000;
              const newPausedDurationMs = record.paused_counter * 1000;
              const newWatched = record.watched_status === 1;

              // Check if externalSessionId needs to be set (fallback match means it was missing)
              const needsExternalId = !existingByTime.externalSessionId;

              // Check if other fields changed
              const stoppedAtChanged = existingByTime.stoppedAt?.getTime() !== newStoppedAt.getTime();
              const durationChanged = existingByTime.durationMs !== newDurationMs;
              const pausedChanged = existingByTime.pausedDurationMs !== newPausedDurationMs;
              const watchedChanged = existingByTime.watched !== newWatched;

              // Only update if externalSessionId is missing OR something actually changed
              if (needsExternalId || stoppedAtChanged || durationChanged || pausedChanged || watchedChanged) {
                updateBatch.push({
                  id: existingByTime.id,
                  externalSessionId: referenceIdStr,
                  stoppedAt: newStoppedAt,
                  durationMs: newDurationMs,
                  pausedDurationMs: newPausedDurationMs,
                  watched: newWatched,
                });
              }

              // Add to lookup map for this session
              sessionByExternalId.set(referenceIdStr, existingByTime);

              skipped++;
              progress.skippedRecords++;
              continue;
            }
          }

          // === OPTIMIZATION: Cached GeoIP lookup ===
          let geo = geoCache.get(record.ip_address);
          if (!geo) {
            geo = geoipService.lookup(record.ip_address);
            geoCache.set(record.ip_address, geo);
          }

          // Map media type
          let mediaType: 'movie' | 'episode' | 'track' = 'movie';
          if (record.media_type === 'episode') {
            mediaType = 'episode';
          } else if (record.media_type === 'track') {
            mediaType = 'track';
          }

          const sessionKey =
            record.session_key != null
              ? String(record.session_key)
              : `tautulli-${record.reference_id}`;

          // === OPTIMIZATION: Collect insert instead of executing ===
          insertBatch.push({
            serverId,
            serverUserId,
            sessionKey,
            ratingKey: ratingKeyStr,
            externalSessionId: referenceIdStr,
            state: 'stopped',
            mediaType,
            mediaTitle: record.full_title || record.title,
            grandparentTitle: record.grandparent_title || null,
            seasonNumber:
              typeof record.parent_media_index === 'number' ? record.parent_media_index : null,
            episodeNumber: typeof record.media_index === 'number' ? record.media_index : null,
            year: record.year || null,
            thumbPath: record.thumb || null,
            startedAt,
            lastSeenAt: startedAt,
            stoppedAt: new Date(record.stopped * 1000),
            durationMs: record.duration * 1000,
            totalDurationMs: null,
            progressMs: null,
            pausedDurationMs: record.paused_counter * 1000,
            watched: record.watched_status === 1,
            ipAddress: record.ip_address || '0.0.0.0',
            geoCity: geo.city,
            geoRegion: geo.region,
            geoCountry: geo.country,
            geoLat: geo.lat,
            geoLon: geo.lon,
            playerName: record.player || record.product,
            deviceId: record.machine_id || null,
            product: record.product || null,
            platform: record.platform,
            quality: record.transcode_decision === 'transcode' ? 'Transcode' : 'Direct',
            isTranscode: record.transcode_decision === 'transcode',
            bitrate: null,
          });

          // Add to lookup map to prevent duplicates within same import
          sessionByExternalId.set(referenceIdStr, {
            id: '', // Will be assigned by DB
            externalSessionId: referenceIdStr,
            ratingKey: ratingKeyStr,
            startedAt,
            serverUserId,
            totalDurationMs: null,
            // Include fields needed for change detection (use values we're inserting)
            stoppedAt: new Date(record.stopped * 1000),
            durationMs: record.duration * 1000,
            pausedDurationMs: record.paused_counter * 1000,
            watched: record.watched_status === 1,
          });

          imported++;
          progress.importedRecords++;
        } catch (error) {
          console.error('Error processing record:', record.reference_id, error);
          errors++;
          progress.errorRecords++;
        }

        // === OPTIMIZATION: Throttled progress updates ===
        const now = Date.now();
        if (progress.processedRecords % 100 === 0 || now - lastProgressTime > 2000) {
          publishProgress();
          lastProgressTime = now;
        }
      }

      // Flush batches at end of each page
      await flushBatches();

      page++;
    }

    // Final flush for any remaining records
    await flushBatches();

    // Refresh TimescaleDB aggregates so imported data appears in stats immediately
    progress.message = 'Refreshing aggregates...';
    publishProgress();
    try {
      await refreshAggregates();
    } catch (err) {
      console.warn('Failed to refresh aggregates after import:', err);
    }

    // Build final message with skipped user warnings
    let message = `Import complete: ${imported} imported, ${skipped} skipped, ${errors} errors`;

    if (skippedUsers.size > 0) {
      const skippedUserList = [...skippedUsers.values()]
        .sort((a, b) => b.count - a.count)
        .slice(0, 5) // Show top 5 skipped users
        .map((u) => `${u.username} (${u.count} records)`)
        .join(', ');

      const moreUsers = skippedUsers.size > 5 ? ` and ${skippedUsers.size - 5} more` : '';
      message += `. Warning: ${skippedUsers.size} users not found in Tracearr: ${skippedUserList}${moreUsers}. Sync your server to import these users first.`;

      console.warn(
        `Tautulli import skipped users: ${[...skippedUsers.values()].map((u) => u.username).join(', ')}`
      );
    }

    // Final progress update
    progress.status = 'complete';
    progress.message = message;
    publishProgress();

    return {
      success: true,
      imported,
      skipped,
      errors,
      message,
      skippedUsers:
        skippedUsers.size > 0
          ? [...skippedUsers.entries()].map(([id, data]) => ({
              tautulliUserId: id,
              username: data.username,
              recordCount: data.count,
            }))
          : undefined,
    };
  }
}
