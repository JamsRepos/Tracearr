/**
 * Statistics routes - Dashboard metrics and analytics
 *
 * Uses TimescaleDB continuous aggregates where possible for better performance:
 * - daily_plays_by_user: Pre-aggregated daily play counts per user
 * - daily_plays_by_platform: Pre-aggregated daily play counts per platform
 * - hourly_concurrent_streams: Pre-aggregated hourly stream counts per server
 */

import type { FastifyPluginAsync } from 'fastify';
import { sql, gte, desc, and, isNotNull } from 'drizzle-orm';
import {
  statsQuerySchema,
  locationStatsQuerySchema,
  REDIS_KEYS,
  type DashboardStats,
  type ActiveSession,
} from '@tracearr/shared';
import { db } from '../db/client.js';
import { sessions, violations } from '../db/schema.js';
import { getTimescaleStatus } from '../db/timescale.js';

// Cache whether aggregates are available (checked once at startup)
let aggregatesAvailable: boolean | null = null;

async function hasAggregates(): Promise<boolean> {
  if (aggregatesAvailable !== null) {
    return aggregatesAvailable;
  }
  try {
    const status = await getTimescaleStatus();
    aggregatesAvailable = status.continuousAggregates.length >= 3;
    return aggregatesAvailable;
  } catch {
    aggregatesAvailable = false;
    return false;
  }
}

// Helper to calculate date range based on period
function getDateRange(period: 'day' | 'week' | 'month' | 'year'): Date {
  const now = new Date();
  switch (period) {
    case 'day':
      return new Date(now.getTime() - 24 * 60 * 60 * 1000);
    case 'week':
      return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    case 'month':
      return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    case 'year':
      return new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
  }
}

export const statsRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /stats/dashboard - Dashboard summary metrics
   */
  app.get(
    '/dashboard',
    { preHandler: [app.authenticate] },
    async () => {
      // Try cache first
      const cached = await app.redis.get(REDIS_KEYS.DASHBOARD_STATS);
      if (cached) {
        try {
          return JSON.parse(cached) as DashboardStats;
        } catch {
          // Fall through to compute
        }
      }

      // Get active streams count
      const activeCached = await app.redis.get(REDIS_KEYS.ACTIVE_SESSIONS);
      let activeStreams = 0;
      if (activeCached) {
        try {
          const sessions = JSON.parse(activeCached) as ActiveSession[];
          activeStreams = sessions.length;
        } catch {
          // Ignore
        }
      }

      // Get today's plays and watch time
      // Always use raw queries for real-time dashboard stats (aggregates exclude last hour)
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

      // Count unique plays (grouped by reference_id, or standalone if no reference)
      const todayPlaysResult = await db
        .select({ count: sql<number>`count(DISTINCT COALESCE(reference_id, id))::int` })
        .from(sessions)
        .where(gte(sessions.startedAt, todayStart));
      const todayPlays = todayPlaysResult[0]?.count ?? 0;

      const watchTimeResult = await db
        .select({
          totalMs: sql<number>`coalesce(sum(duration_ms), 0)::bigint`,
        })
        .from(sessions)
        .where(gte(sessions.startedAt, last24h));
      const watchTimeHours = Math.round(
        (Number(watchTimeResult[0]?.totalMs ?? 0) / (1000 * 60 * 60)) * 10
      ) / 10;

      // Get alerts in last 24 hours
      const alertsResult = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(violations)
        .where(gte(violations.createdAt, last24h));

      const alertsLast24h = alertsResult[0]?.count ?? 0;

      const stats: DashboardStats = {
        activeStreams,
        todayPlays,
        watchTimeHours,
        alertsLast24h,
      };

      // Cache for 60 seconds
      await app.redis.setex(REDIS_KEYS.DASHBOARD_STATS, 60, JSON.stringify(stats));

      return stats;
    }
  );

  /**
   * GET /stats/plays - Plays over time
   */
  app.get(
    '/plays',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const query = statsQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.badRequest('Invalid query parameters');
      }

      const { period } = query.data;
      const startDate = getDateRange(period);

      // Note: Continuous aggregates use COUNT(*) which counts sessions, not unique plays.
      // For accurate play counts, we use raw query with DISTINCT COALESCE(reference_id, id).
      // TODO: Recreate continuous aggregates with proper grouping for better performance.
      const playsByDate = await db
        .select({
          date: sql<string>`date_trunc('day', started_at)::date::text`,
          count: sql<number>`count(DISTINCT COALESCE(reference_id, id))::int`,
        })
        .from(sessions)
        .where(gte(sessions.startedAt, startDate))
        .groupBy(sql`date_trunc('day', started_at)`)
        .orderBy(sql`date_trunc('day', started_at)`);

      return { data: playsByDate };
    }
  );

  /**
   * GET /stats/users - User statistics
   */
  app.get(
    '/users',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const query = statsQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.badRequest('Invalid query parameters');
      }

      const { period } = query.data;
      const startDate = getDateRange(period);

      // Use raw query with proper play counting (DISTINCT reference_id)
      const result = await db.execute(sql`
        SELECT
          u.id as user_id,
          u.username,
          u.thumb_url,
          COUNT(DISTINCT COALESCE(s.reference_id, s.id))::int as play_count,
          COALESCE(SUM(s.duration_ms), 0)::bigint as watch_time_ms
        FROM users u
        LEFT JOIN sessions s ON s.user_id = u.id AND s.started_at >= ${startDate}
        GROUP BY u.id, u.username, u.thumb_url
        ORDER BY play_count DESC
        LIMIT 20
      `);
      const userStats = (result.rows as {
        user_id: string;
        username: string;
        thumb_url: string | null;
        play_count: number;
        watch_time_ms: string;
      }[]).map((r) => ({
        userId: r.user_id,
        username: r.username,
        thumbUrl: r.thumb_url,
        playCount: r.play_count,
        watchTimeMs: Number(r.watch_time_ms),
      }));

      return {
        data: userStats.map((u) => ({
          userId: u.userId,
          username: u.username,
          thumbUrl: u.thumbUrl,
          playCount: u.playCount,
          watchTimeHours: Math.round((u.watchTimeMs / (1000 * 60 * 60)) * 10) / 10,
        })),
      };
    }
  );

  /**
   * GET /stats/platforms - Plays by platform
   */
  app.get(
    '/platforms',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const query = statsQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.badRequest('Invalid query parameters');
      }

      const { period } = query.data;
      const startDate = getDateRange(period);

      // Use raw query with proper play counting
      const platformStats = await db
        .select({
          platform: sessions.platform,
          count: sql<number>`count(DISTINCT COALESCE(reference_id, id))::int`,
        })
        .from(sessions)
        .where(gte(sessions.startedAt, startDate))
        .groupBy(sessions.platform)
        .orderBy(desc(sql`count(DISTINCT COALESCE(reference_id, id))`));

      return { data: platformStats };
    }
  );

  /**
   * GET /stats/locations - Geo data for stream map with filtering
   *
   * Supports filtering by:
   * - days: Number of days to look back (default: 30)
   * - userId: Filter to specific user
   * - serverId: Filter to specific server
   * - mediaType: Filter by movie/episode/track
   */
  app.get(
    '/locations',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const query = locationStatsQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.badRequest('Invalid query parameters');
      }

      const { days, userId, serverId, mediaType } = query.data;
      const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

      // Build WHERE conditions dynamically (all qualified with 's.' for sessions table)
      const conditions: ReturnType<typeof sql>[] = [
        sql`s.started_at >= ${startDate}`,
        sql`s.geo_lat IS NOT NULL`,
        sql`s.geo_lon IS NOT NULL`,
      ];

      if (userId) {
        conditions.push(sql`s.user_id = ${userId}`);
      }
      if (serverId) {
        conditions.push(sql`s.server_id = ${serverId}`);
      }
      if (mediaType) {
        conditions.push(sql`s.media_type = ${mediaType}`);
      }

      const whereClause = sql`WHERE ${sql.join(conditions, sql` AND `)}`;

      // Count unique plays per location with filters
      // Include contextual data based on what's being filtered
      const result = await db.execute(sql`
        SELECT
          s.geo_city as city,
          s.geo_region as region,
          s.geo_country as country,
          s.geo_lat as lat,
          s.geo_lon as lon,
          COUNT(DISTINCT COALESCE(s.reference_id, s.id))::int as count,
          MAX(s.started_at) as last_activity,
          MIN(s.started_at) as first_activity,
          COUNT(DISTINCT COALESCE(s.device_id, s.player_name))::int as device_count,
          JSON_AGG(DISTINCT jsonb_build_object('id', u.id, 'username', u.username, 'thumbUrl', u.thumb_url))
            FILTER (WHERE u.id IS NOT NULL) as user_info
        FROM sessions s
        LEFT JOIN users u ON s.user_id = u.id
        ${whereClause}
        GROUP BY s.geo_city, s.geo_region, s.geo_country, s.geo_lat, s.geo_lon
        ORDER BY count DESC
        LIMIT 200
      `);

      const locationStats = (result.rows as {
        city: string | null;
        region: string | null;
        country: string | null;
        lat: number;
        lon: number;
        count: number;
        last_activity: Date;
        first_activity: Date;
        device_count: number;
        user_info: { id: string; username: string; thumbUrl: string | null }[] | null;
      }[]).map((row) => ({
        city: row.city,
        region: row.region,
        country: row.country,
        lat: row.lat,
        lon: row.lon,
        count: row.count,
        lastActivity: row.last_activity,
        firstActivity: row.first_activity,
        deviceCount: row.device_count,
        // Only include users array if NOT filtering by a specific user
        users: userId ? undefined : (row.user_info ?? []).slice(0, 5),
      }));

      // Calculate summary stats for the overlay card
      const totalStreams = locationStats.reduce((sum, loc) => sum + loc.count, 0);
      const uniqueLocations = locationStats.length;
      const topCity = locationStats[0]?.city ?? null;

      // Build available filter options based on OTHER active filters
      // For each dimension, we query what values exist given the other filters

      // Base conditions (time + geo) that apply to all filter queries
      const baseConditions = [
        sql`s.started_at >= ${startDate}`,
        sql`s.geo_lat IS NOT NULL`,
        sql`s.geo_lon IS NOT NULL`,
      ];

      // Available users (apply server + mediaType filters, not user filter)
      const userConditions = [...baseConditions];
      if (serverId) userConditions.push(sql`s.server_id = ${serverId}`);
      if (mediaType) userConditions.push(sql`s.media_type = ${mediaType}`);
      const usersResult = await db.execute(sql`
        SELECT DISTINCT u.id, u.username
        FROM sessions s
        JOIN users u ON s.user_id = u.id
        WHERE ${sql.join(userConditions, sql` AND `)}
        ORDER BY u.username
      `);
      const availableUsers = (usersResult.rows as { id: string; username: string }[]);

      // Available servers (apply user + mediaType filters, not server filter)
      const serverConditions = [...baseConditions];
      if (userId) serverConditions.push(sql`s.user_id = ${userId}`);
      if (mediaType) serverConditions.push(sql`s.media_type = ${mediaType}`);
      const serversResult = await db.execute(sql`
        SELECT DISTINCT sv.id, sv.name
        FROM sessions s
        JOIN servers sv ON s.server_id = sv.id
        WHERE ${sql.join(serverConditions, sql` AND `)}
        ORDER BY sv.name
      `);
      const availableServers = (serversResult.rows as { id: string; name: string }[]);

      // Available media types (apply user + server filters, not mediaType filter)
      const mediaConditions = [...baseConditions];
      if (userId) mediaConditions.push(sql`s.user_id = ${userId}`);
      if (serverId) mediaConditions.push(sql`s.server_id = ${serverId}`);
      const mediaResult = await db.execute(sql`
        SELECT DISTINCT s.media_type
        FROM sessions s
        WHERE ${sql.join(mediaConditions, sql` AND `)}
        ORDER BY s.media_type
      `);
      const availableMediaTypes = (mediaResult.rows as { media_type: string }[])
        .map(r => r.media_type)
        .filter((t): t is 'movie' | 'episode' | 'track' =>
          t === 'movie' || t === 'episode' || t === 'track'
        );

      return {
        data: locationStats,
        summary: {
          totalStreams,
          uniqueLocations,
          topCity,
        },
        availableFilters: {
          users: availableUsers,
          servers: availableServers,
          mediaTypes: availableMediaTypes,
        },
      };
    }
  );

  /**
   * GET /stats/watch-time - Total watch time breakdown
   */
  app.get(
    '/watch-time',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const query = statsQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.badRequest('Invalid query parameters');
      }

      const { period } = query.data;
      const startDate = getDateRange(period);

      // Total watch time
      const totalResult = await db
        .select({
          totalMs: sql<number>`coalesce(sum(duration_ms), 0)::bigint`,
        })
        .from(sessions)
        .where(gte(sessions.startedAt, startDate));

      // By media type
      const byTypeResult = await db
        .select({
          mediaType: sessions.mediaType,
          totalMs: sql<number>`coalesce(sum(duration_ms), 0)::bigint`,
        })
        .from(sessions)
        .where(gte(sessions.startedAt, startDate))
        .groupBy(sessions.mediaType);

      return {
        totalHours: Math.round((Number(totalResult[0]?.totalMs ?? 0) / (1000 * 60 * 60)) * 10) / 10,
        byType: byTypeResult.map((t) => ({
          mediaType: t.mediaType,
          hours: Math.round((Number(t.totalMs) / (1000 * 60 * 60)) * 10) / 10,
        })),
      };
    }
  );

  /**
   * GET /stats/libraries - Library counts (placeholder - would need library sync)
   */
  app.get(
    '/libraries',
    { preHandler: [app.authenticate] },
    async () => {
      // In a real implementation, we'd sync library counts from servers
      // For now, return a placeholder
      return {
        movies: 0,
        shows: 0,
        episodes: 0,
        tracks: 0,
      };
    }
  );

  /**
   * GET /stats/top-content - Top movies, shows by play count
   */
  app.get(
    '/top-content',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const query = statsQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.badRequest('Invalid query parameters');
      }

      const { period } = query.data;
      const startDate = getDateRange(period);

      // Count unique plays per title
      const topContent = await db
        .select({
          mediaTitle: sessions.mediaTitle,
          mediaType: sessions.mediaType,
          count: sql<number>`count(DISTINCT COALESCE(reference_id, id))::int`,
          totalWatchMs: sql<number>`coalesce(sum(duration_ms), 0)::bigint`,
        })
        .from(sessions)
        .where(gte(sessions.startedAt, startDate))
        .groupBy(sessions.mediaTitle, sessions.mediaType)
        .orderBy(desc(sql`count(DISTINCT COALESCE(reference_id, id))`))
        .limit(20);

      return {
        data: topContent.map((c) => ({
          title: c.mediaTitle,
          type: c.mediaType,
          playCount: c.count,
          watchTimeHours: Math.round((Number(c.totalWatchMs) / (1000 * 60 * 60)) * 10) / 10,
        })),
      };
    }
  );

  /**
   * GET /stats/top-users - User leaderboard
   */
  app.get(
    '/top-users',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const query = statsQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.badRequest('Invalid query parameters');
      }

      const { period } = query.data;
      const startDate = getDateRange(period);

      // Use raw query with proper play counting (DISTINCT reference_id)
      const topUsersResult = await db.execute(sql`
        SELECT
          u.id as user_id,
          u.username,
          u.thumb_url,
          u.trust_score,
          COUNT(DISTINCT COALESCE(s.reference_id, s.id))::int as play_count,
          COALESCE(SUM(s.duration_ms), 0)::bigint as watch_time_ms
        FROM users u
        LEFT JOIN sessions s ON s.user_id = u.id AND s.started_at >= ${startDate}
        GROUP BY u.id, u.username, u.thumb_url, u.trust_score
        ORDER BY watch_time_ms DESC
        LIMIT 10
      `);
      const topUsers = (topUsersResult.rows as {
        user_id: string;
        username: string;
        thumb_url: string | null;
        trust_score: number;
        play_count: number;
        watch_time_ms: string;
      }[]).map((r) => ({
        userId: r.user_id,
        username: r.username,
        thumbUrl: r.thumb_url,
        trustScore: r.trust_score,
        playCount: r.play_count,
        watchTimeMs: Number(r.watch_time_ms),
      }));

      return {
        data: topUsers.map((u) => ({
          userId: u.userId,
          username: u.username,
          thumbUrl: u.thumbUrl,
          trustScore: u.trustScore,
          playCount: u.playCount,
          watchTimeHours: Math.round((u.watchTimeMs / (1000 * 60 * 60)) * 10) / 10,
        })),
      };
    }
  );

  /**
   * GET /stats/concurrent - Concurrent stream history
   */
  app.get(
    '/concurrent',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const query = statsQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.badRequest('Invalid query parameters');
      }

      const { period } = query.data;
      const startDate = getDateRange(period);

      let hourlyData: { hour: string; maxConcurrent: number }[];

      if (await hasAggregates()) {
        // Use continuous aggregate - sums across servers
        const result = await db.execute(sql`
          SELECT
            hour::text,
            SUM(stream_count)::int as max_concurrent
          FROM hourly_concurrent_streams
          WHERE hour >= ${startDate}
          GROUP BY hour
          ORDER BY hour
        `);
        hourlyData = (result.rows as { hour: string; max_concurrent: number }[]).map((r) => ({
          hour: r.hour,
          maxConcurrent: r.max_concurrent,
        }));
      } else {
        // Fallback to raw sessions query
        // This is simplified - a production version would use time-range overlaps
        const result = await db
          .select({
            hour: sql<string>`date_trunc('hour', started_at)::text`,
            maxConcurrent: sql<number>`count(*)::int`,
          })
          .from(sessions)
          .where(gte(sessions.startedAt, startDate))
          .groupBy(sql`date_trunc('hour', started_at)`)
          .orderBy(sql`date_trunc('hour', started_at)`);
        hourlyData = result;
      }

      return { data: hourlyData };
    }
  );

  /**
   * GET /stats/quality - Transcode vs direct play breakdown
   */
  app.get(
    '/quality',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const query = statsQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.badRequest('Invalid query parameters');
      }

      const { period } = query.data;
      const startDate = getDateRange(period);

      // Count unique plays by transcode status
      const qualityStats = await db
        .select({
          isTranscode: sessions.isTranscode,
          count: sql<number>`count(DISTINCT COALESCE(reference_id, id))::int`,
        })
        .from(sessions)
        .where(gte(sessions.startedAt, startDate))
        .groupBy(sessions.isTranscode);

      const directPlay = qualityStats.find((q) => !q.isTranscode)?.count ?? 0;
      const transcode = qualityStats.find((q) => q.isTranscode)?.count ?? 0;
      const total = directPlay + transcode;

      return {
        directPlay,
        transcode,
        total,
        directPlayPercent: total > 0 ? Math.round((directPlay / total) * 100) : 0,
        transcodePercent: total > 0 ? Math.round((transcode / total) * 100) : 0,
      };
    }
  );
};
