/**
 * Session routes - Query historical and active sessions
 *
 * Activity history is grouped by reference_id to show unique "plays" rather than
 * individual session records. Multiple pause/resume cycles for the same content
 * are aggregated into a single row with combined duration.
 */

import type { FastifyPluginAsync } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import {
  sessionQuerySchema,
  sessionIdParamSchema,
  REDIS_KEYS,
  type ActiveSession,
} from '@tracearr/shared';
import { db } from '../db/client.js';
import { sessions, users, servers } from '../db/schema.js';

export const sessionRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /sessions - Query historical sessions with pagination and filters
   *
   * Sessions are grouped by reference_id to show unique "plays". Multiple
   * pause/resume cycles for the same content appear as one row with:
   * - Aggregated duration (total watch time)
   * - First session's start time
   * - Last session's stop time
   * - Segment count (how many pause/resume cycles)
   */
  app.get(
    '/',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const query = sessionQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.badRequest('Invalid query parameters');
      }

      const {
        page = 1,
        pageSize = 50,
        userId,
        serverId,
        state,
        mediaType,
        startDate,
        endDate,
      } = query.data;

      const authUser = request.user;
      const offset = (page - 1) * pageSize;

      // Build WHERE clause conditions dynamically for raw SQL CTE query
      // Note: Using sql.join() pattern because this query requires a CTE for reference_id grouping,
      // which isn't expressible in Drizzle's query builder.
      const conditions: ReturnType<typeof sql>[] = [];

      // Filter by user's accessible servers
      if (authUser.serverIds.length > 0) {
        conditions.push(sql`s.server_id = ${authUser.serverIds[0]}`);
      }

      if (userId) {
        conditions.push(sql`s.user_id = ${userId}`);
      }

      if (serverId) {
        conditions.push(sql`s.server_id = ${serverId}`);
      }

      if (state) {
        conditions.push(sql`s.state = ${state}`);
      }

      if (mediaType) {
        conditions.push(sql`s.media_type = ${mediaType}`);
      }

      if (startDate) {
        conditions.push(sql`s.started_at >= ${startDate}`);
      }

      if (endDate) {
        conditions.push(sql`s.started_at <= ${endDate}`);
      }

      // Build the WHERE clause
      const whereClause = conditions.length > 0
        ? sql`WHERE ${sql.join(conditions, sql` AND `)}`
        : sql``;

      // Query sessions grouped by reference_id (or id if no reference)
      const result = await db.execute(sql`
        WITH grouped_sessions AS (
          SELECT
            COALESCE(s.reference_id, s.id) as play_id,
            MIN(s.started_at) as started_at,
            MAX(s.stopped_at) as stopped_at,
            SUM(COALESCE(s.duration_ms, 0)) as duration_ms,
            SUM(COALESCE(s.paused_duration_ms, 0)) as paused_duration_ms,
            MAX(s.progress_ms) as progress_ms,
            COUNT(*) as segment_count,
            BOOL_OR(s.watched) as watched,
            (array_agg(s.id ORDER BY s.started_at))[1] as first_session_id,
            (array_agg(s.state ORDER BY s.started_at DESC))[1] as state
          FROM sessions s
          ${whereClause}
          GROUP BY COALESCE(s.reference_id, s.id)
          ORDER BY MIN(s.started_at) DESC
          LIMIT ${pageSize} OFFSET ${offset}
        )
        SELECT
          gs.play_id as id,
          gs.started_at,
          gs.stopped_at,
          gs.duration_ms,
          gs.paused_duration_ms,
          gs.progress_ms,
          gs.segment_count,
          gs.watched,
          gs.state,
          s.server_id,
          sv.name as server_name,
          sv.type as server_type,
          s.user_id,
          u.username,
          u.thumb_url as user_thumb,
          s.session_key,
          s.media_type,
          s.media_title,
          s.grandparent_title,
          s.season_number,
          s.episode_number,
          s.year,
          s.thumb_path,
          s.reference_id,
          s.ip_address,
          s.geo_city,
          s.geo_region,
          s.geo_country,
          s.geo_lat,
          s.geo_lon,
          s.player_name,
          s.device_id,
          s.product,
          s.device,
          s.platform,
          s.quality,
          s.is_transcode,
          s.bitrate
        FROM grouped_sessions gs
        JOIN sessions s ON s.id = gs.first_session_id
        JOIN users u ON u.id = s.user_id
        JOIN servers sv ON sv.id = s.server_id
        ORDER BY gs.started_at DESC
      `);

      // Type the result
      const sessionData = (result.rows as {
        id: string;
        started_at: Date;
        stopped_at: Date | null;
        duration_ms: string | null;
        paused_duration_ms: string | null;
        progress_ms: number | null;
        segment_count: string;
        watched: boolean;
        state: string;
        server_id: string;
        server_name: string;
        server_type: string;
        user_id: string;
        username: string;
        user_thumb: string | null;
        session_key: string;
        media_type: string;
        media_title: string;
        grandparent_title: string | null;
        season_number: number | null;
        episode_number: number | null;
        year: number | null;
        thumb_path: string | null;
        reference_id: string | null;
        ip_address: string | null;
        geo_city: string | null;
        geo_region: string | null;
        geo_country: string | null;
        geo_lat: number | null;
        geo_lon: number | null;
        player_name: string | null;
        device_id: string | null;
        product: string | null;
        device: string | null;
        platform: string | null;
        quality: string | null;
        is_transcode: boolean | null;
        bitrate: number | null;
      }[]).map((row) => ({
        id: row.id,
        serverId: row.server_id,
        serverName: row.server_name,
        serverType: row.server_type,
        userId: row.user_id,
        username: row.username,
        userThumb: row.user_thumb,
        sessionKey: row.session_key,
        state: row.state,
        mediaType: row.media_type,
        mediaTitle: row.media_title,
        grandparentTitle: row.grandparent_title,
        seasonNumber: row.season_number,
        episodeNumber: row.episode_number,
        year: row.year,
        thumbPath: row.thumb_path,
        startedAt: row.started_at,
        stoppedAt: row.stopped_at,
        durationMs: row.duration_ms ? Number(row.duration_ms) : null,
        pausedDurationMs: row.paused_duration_ms ? Number(row.paused_duration_ms) : null,
        progressMs: row.progress_ms,
        referenceId: row.reference_id,
        watched: row.watched,
        segmentCount: Number(row.segment_count),
        ipAddress: row.ip_address,
        geoCity: row.geo_city,
        geoRegion: row.geo_region,
        geoCountry: row.geo_country,
        geoLat: row.geo_lat,
        geoLon: row.geo_lon,
        playerName: row.player_name,
        deviceId: row.device_id,
        product: row.product,
        device: row.device,
        platform: row.platform,
        quality: row.quality,
        isTranscode: row.is_transcode,
        bitrate: row.bitrate,
      }));

      // Get total count of unique plays
      const countResult = await db.execute(sql`
        SELECT COUNT(DISTINCT COALESCE(s.reference_id, s.id))::int as count
        FROM sessions s
        ${whereClause}
      `);
      const total = (countResult.rows[0] as { count: number })?.count ?? 0;

      return {
        data: sessionData,
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      };
    }
  );

  /**
   * GET /sessions/active - Get currently active streams from cache
   */
  app.get(
    '/active',
    { preHandler: [app.authenticate] },
    async (request) => {
      const authUser = request.user;

      // Get active sessions from Redis cache
      const cached = await app.redis.get(REDIS_KEYS.ACTIVE_SESSIONS);

      if (!cached) {
        return { data: [] };
      }

      let activeSessions: ActiveSession[];
      try {
        activeSessions = JSON.parse(cached) as ActiveSession[];
      } catch {
        return { data: [] };
      }

      // Filter by user's accessible servers
      if (authUser.serverIds.length > 0) {
        activeSessions = activeSessions.filter((session) =>
          authUser.serverIds.includes(session.serverId)
        );
      }

      return { data: activeSessions };
    }
  );

  /**
   * GET /sessions/:id - Get detailed info for a specific session
   */
  app.get(
    '/:id',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const params = sessionIdParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply.badRequest('Invalid session ID');
      }

      const { id } = params.data;
      const authUser = request.user;

      // Try cache first for active sessions
      const cached = await app.redis.get(REDIS_KEYS.SESSION_BY_ID(id));
      if (cached) {
        try {
          const activeSession = JSON.parse(cached) as ActiveSession;
          // Verify access
          if (authUser.serverIds.includes(activeSession.serverId)) {
            return activeSession;
          }
        } catch {
          // Fall through to DB
        }
      }

      // Query from database using manual JOINs
      // Note: We use manual JOINs here instead of relational queries because:
      // 1. The API expects a flat response shape (serverName, username vs nested objects)
      // 2. Manual JOINs produce the exact shape without transformation
      // 3. Type-safe via explicit select fields
      // See drizzle-orm-research-findings.md for when to use relational vs manual JOINs
      const sessionData = await db
        .select({
          id: sessions.id,
          serverId: sessions.serverId,
          serverName: servers.name,
          serverType: servers.type,
          userId: sessions.userId,
          username: users.username,
          userThumb: users.thumbUrl,
          sessionKey: sessions.sessionKey,
          state: sessions.state,
          mediaType: sessions.mediaType,
          mediaTitle: sessions.mediaTitle,
          // Enhanced media metadata
          grandparentTitle: sessions.grandparentTitle,
          seasonNumber: sessions.seasonNumber,
          episodeNumber: sessions.episodeNumber,
          year: sessions.year,
          thumbPath: sessions.thumbPath,
          startedAt: sessions.startedAt,
          stoppedAt: sessions.stoppedAt,
          durationMs: sessions.durationMs,
          // Pause tracking fields
          lastPausedAt: sessions.lastPausedAt,
          pausedDurationMs: sessions.pausedDurationMs,
          referenceId: sessions.referenceId,
          watched: sessions.watched,
          ipAddress: sessions.ipAddress,
          geoCity: sessions.geoCity,
          geoRegion: sessions.geoRegion,
          geoCountry: sessions.geoCountry,
          geoLat: sessions.geoLat,
          geoLon: sessions.geoLon,
          playerName: sessions.playerName,
          deviceId: sessions.deviceId,
          product: sessions.product,
          device: sessions.device,
          platform: sessions.platform,
          quality: sessions.quality,
          isTranscode: sessions.isTranscode,
          bitrate: sessions.bitrate,
        })
        .from(sessions)
        .innerJoin(users, eq(sessions.userId, users.id))
        .innerJoin(servers, eq(sessions.serverId, servers.id))
        .where(eq(sessions.id, id))
        .limit(1);

      const session = sessionData[0];
      if (!session) {
        return reply.notFound('Session not found');
      }

      // Verify access
      if (!authUser.serverIds.includes(session.serverId)) {
        return reply.forbidden('You do not have access to this session');
      }

      return session;
    }
  );
};
