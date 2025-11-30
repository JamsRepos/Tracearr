/**
 * Tautulli API integration and import service
 */

import { eq, and } from 'drizzle-orm';
import type { TautulliImportProgress, TautulliImportResult } from '@tracearr/shared';
import { db } from '../db/client.js';
import { sessions, users, settings } from '../db/schema.js';
import { refreshAggregates } from '../db/timescale.js';
import { geoipService } from './geoip.js';
import type { PubSubService } from './cache.js';

const PAGE_SIZE = 100;

interface TautulliHistoryRecord {
  reference_id: string; // Unique session identifier
  row_id: number;
  date: number; // Unix timestamp
  started: number; // Unix timestamp
  stopped: number; // Unix timestamp
  duration: number; // Seconds watched
  paused_counter: number; // Seconds paused
  user_id: number;
  user: string; // friendly_name
  friendly_name: string;
  platform: string;
  product: string;
  player: string;
  ip_address: string;
  live: number;
  machine_id: string;
  location: string;
  secure: number;
  relayed: number;
  media_type: string;
  rating_key: string;
  parent_rating_key: string;
  grandparent_rating_key: string;
  full_title: string;
  title: string;
  grandparent_title: string;
  original_title: string;
  year: number;
  media_index: number;
  parent_media_index: number;
  thumb: string;
  originally_available_at: string;
  guid: string;
  transcode_decision: string;
  percent_complete: number;
  watched_status: number;
  group_count: number;
  group_ids: string;
  state: string | null;
  session_key: string | null;
}

interface TautulliHistoryResponse {
  response: {
    result: string;
    message: string | null;
    data: {
      recordsFiltered: number;
      recordsTotal: number;
      data: TautulliHistoryRecord[];
      draw: number;
      filter_duration: string;
      total_duration: string;
    };
  };
}

interface TautulliUserRecord {
  user_id: number;
  username: string;
  friendly_name: string;
  email: string;
  thumb: string;
  is_home_user: number;
  is_admin: number;
  is_active: number;
  do_notify: number;
}

interface TautulliUsersResponse {
  response: {
    result: string;
    message: string | null;
    data: TautulliUserRecord[];
  };
}

export class TautulliService {
  private baseUrl: string;
  private apiKey: string;

  constructor(url: string, apiKey: string) {
    this.baseUrl = url.replace(/\/$/, '');
    this.apiKey = apiKey;
  }

  /**
   * Make API request to Tautulli
   */
  private async request<T>(cmd: string, params: Record<string, string | number> = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}/api/v2`);
    url.searchParams.set('apikey', this.apiKey);
    url.searchParams.set('cmd', cmd);

    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, String(value));
    }

    const response = await fetch(url.toString());

    if (!response.ok) {
      throw new Error(`Tautulli API error: ${response.status}`);
    }

    return response.json() as Promise<T>;
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
    const result = await this.request<TautulliUsersResponse>('get_users');
    return result.response.data ?? [];
  }

  /**
   * Get paginated history from Tautulli
   */
  async getHistory(
    start: number = 0,
    length: number = PAGE_SIZE
  ): Promise<{ records: TautulliHistoryRecord[]; total: number }> {
    const result = await this.request<TautulliHistoryResponse>('get_history', {
      start,
      length,
      order_column: 'date',
      order_dir: 'desc',
    });

    return {
      records: result.response.data?.data ?? [],
      total: result.response.data?.recordsTotal ?? 0,
    };
  }

  /**
   * Import all history from Tautulli into Tracearr
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

    const publishProgress = async () => {
      if (pubSubService) {
        await pubSubService.publish('import:progress', progress);
      }
    };

    await publishProgress();

    // Get user mapping (Tautulli user_id → Tracearr user_id)
    const userMap = new Map<number, string>();

    // Get all Tracearr users for this server
    const tracearrUsers = await db
      .select()
      .from(users)
      .where(eq(users.serverId, serverId));

    // Map by externalId (Plex user ID)
    for (const user of tracearrUsers) {
      const plexUserId = parseInt(user.externalId, 10);
      if (!isNaN(plexUserId)) {
        userMap.set(plexUserId, user.id);
      }
    }

    // Get total count
    const { total } = await tautulli.getHistory(0, 1);
    progress.totalRecords = total;
    progress.totalPages = Math.ceil(total / PAGE_SIZE);
    progress.message = `Found ${total} records to import`;
    await publishProgress();

    let imported = 0;
    let skipped = 0;
    let errors = 0;
    let page = 0;

    // Process all pages
    while (page * PAGE_SIZE < total) {
      progress.status = 'processing';
      progress.currentPage = page + 1;
      progress.message = `Processing page ${page + 1} of ${progress.totalPages}`;
      await publishProgress();

      const { records } = await tautulli.getHistory(page * PAGE_SIZE, PAGE_SIZE);

      for (const record of records) {
        progress.processedRecords++;

        try {
          // Find Tracearr user by Plex user ID
          const userId = userMap.get(record.user_id);
          if (!userId) {
            // User not found in Tracearr - skip
            skipped++;
            progress.skippedRecords++;
            continue;
          }

          // Check for existing session by externalSessionId
          const existingByRef = await db
            .select()
            .from(sessions)
            .where(
              and(
                eq(sessions.serverId, serverId),
                eq(sessions.externalSessionId, record.reference_id)
              )
            )
            .limit(1);

          if (existingByRef.length > 0) {
            // Session already imported - update with final data
            const existing = existingByRef[0]!;
            await db
              .update(sessions)
              .set({
                stoppedAt: new Date(record.stopped * 1000),
                durationMs: record.duration * 1000,
                pausedDurationMs: record.paused_counter * 1000,
                watched: record.watched_status === 1,
                progressMs: Math.round(
                  (record.percent_complete / 100) * (existing.totalDurationMs ?? 0)
                ),
              })
              .where(eq(sessions.id, existing.id));

            skipped++;
            progress.skippedRecords++;
            continue;
          }

          // Check for duplicate by ratingKey + startedAt (fallback dedup)
          const startedAt = new Date(record.started * 1000);
          const existingByTime = await db
            .select()
            .from(sessions)
            .where(
              and(
                eq(sessions.serverId, serverId),
                eq(sessions.userId, userId),
                eq(sessions.ratingKey, record.rating_key),
                eq(sessions.startedAt, startedAt)
              )
            )
            .limit(1);

          if (existingByTime.length > 0) {
            // Update with externalSessionId for future dedup
            const existingSession = existingByTime[0]!;
            await db
              .update(sessions)
              .set({
                externalSessionId: record.reference_id,
                stoppedAt: new Date(record.stopped * 1000),
                durationMs: record.duration * 1000,
                pausedDurationMs: record.paused_counter * 1000,
                watched: record.watched_status === 1,
              })
              .where(eq(sessions.id, existingSession.id));

            skipped++;
            progress.skippedRecords++;
            continue;
          }

          // Lookup GeoIP data
          const geo = geoipService.lookup(record.ip_address);

          // Map media type
          let mediaType: 'movie' | 'episode' | 'track' = 'movie';
          if (record.media_type === 'episode') {
            mediaType = 'episode';
          } else if (record.media_type === 'track') {
            mediaType = 'track';
          }

          // Insert new session
          await db.insert(sessions).values({
            serverId,
            userId,
            sessionKey: record.session_key ?? `tautulli-${record.reference_id}`,
            ratingKey: record.rating_key,
            externalSessionId: record.reference_id,
            state: 'stopped', // Historical data is always stopped
            mediaType,
            mediaTitle: record.full_title || record.title,
            startedAt,
            stoppedAt: new Date(record.stopped * 1000),
            durationMs: record.duration * 1000,
            totalDurationMs: null, // Tautulli doesn't provide total duration directly
            progressMs: null, // Will calculate from percent_complete if needed
            // Pause tracking from Tautulli
            pausedDurationMs: record.paused_counter * 1000,
            watched: record.watched_status === 1,
            // Network/device info
            ipAddress: record.ip_address || '0.0.0.0',
            geoCity: geo.city,
            geoRegion: geo.region,
            geoCountry: geo.country,
            geoLat: geo.lat,
            geoLon: geo.lon,
            playerName: record.player || record.product,
            platform: record.platform,
            quality: record.transcode_decision === 'transcode' ? 'Transcode' : 'Direct',
            isTranscode: record.transcode_decision === 'transcode',
            bitrate: null,
          });

          imported++;
          progress.importedRecords++;
        } catch (error) {
          console.error('Error importing record:', record.reference_id, error);
          errors++;
          progress.errorRecords++;
        }

        // Publish progress every 10 records
        if (progress.processedRecords % 10 === 0) {
          await publishProgress();
        }
      }

      page++;
    }

    // Refresh TimescaleDB aggregates so imported data appears in stats immediately
    progress.message = 'Refreshing aggregates...';
    await publishProgress();
    try {
      await refreshAggregates();
    } catch (err) {
      console.warn('Failed to refresh aggregates after import:', err);
    }

    // Final progress update
    progress.status = 'complete';
    progress.message = `Import complete: ${imported} imported, ${skipped} skipped, ${errors} errors`;
    await publishProgress();

    return {
      success: true,
      imported,
      skipped,
      errors,
      message: progress.message,
    };
  }
}
