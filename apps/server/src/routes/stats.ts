/**
 * Statistics routes - Dashboard metrics and analytics
 */

import type { FastifyPluginAsync } from 'fastify';
import { eq, sql, gte, desc, and, isNotNull } from 'drizzle-orm';
import {
  statsQuerySchema,
  REDIS_KEYS,
  type DashboardStats,
  type ActiveSession,
} from '@tracearr/shared';
import { db } from '../db/client.js';
import { sessions, users, violations, servers } from '../db/schema.js';

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

      // Get today's plays
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);

      const todayPlaysResult = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(sessions)
        .where(gte(sessions.startedAt, todayStart));

      const todayPlays = todayPlaysResult[0]?.count ?? 0;

      // Get watch time in last 24 hours
      const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
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

      // Group by date
      const playsByDate = await db
        .select({
          date: sql<string>`date_trunc('day', started_at)::date::text`,
          count: sql<number>`count(*)::int`,
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

      // Get play count and watch time per user
      const userStats = await db
        .select({
          userId: users.id,
          username: users.username,
          thumbUrl: users.thumbUrl,
          playCount: sql<number>`count(${sessions.id})::int`,
          watchTimeMs: sql<number>`coalesce(sum(${sessions.durationMs}), 0)::bigint`,
        })
        .from(users)
        .leftJoin(
          sessions,
          and(eq(sessions.userId, users.id), gte(sessions.startedAt, startDate))
        )
        .groupBy(users.id, users.username, users.thumbUrl)
        .orderBy(desc(sql`count(${sessions.id})`))
        .limit(20);

      return {
        data: userStats.map((u) => ({
          userId: u.userId,
          username: u.username,
          thumbUrl: u.thumbUrl,
          playCount: u.playCount,
          watchTimeHours: Math.round((Number(u.watchTimeMs) / (1000 * 60 * 60)) * 10) / 10,
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

      const platformStats = await db
        .select({
          platform: sessions.platform,
          count: sql<number>`count(*)::int`,
        })
        .from(sessions)
        .where(gte(sessions.startedAt, startDate))
        .groupBy(sessions.platform)
        .orderBy(desc(sql`count(*)`));

      return { data: platformStats };
    }
  );

  /**
   * GET /stats/locations - Geo data for stream map
   */
  app.get(
    '/locations',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const query = statsQuerySchema.safeParse(request.query);
      if (!query.success) {
        return reply.badRequest('Invalid query parameters');
      }

      const { period } = query.data;
      const startDate = getDateRange(period);

      const locationStats = await db
        .select({
          city: sessions.geoCity,
          country: sessions.geoCountry,
          lat: sessions.geoLat,
          lon: sessions.geoLon,
          count: sql<number>`count(*)::int`,
        })
        .from(sessions)
        .where(
          and(
            gte(sessions.startedAt, startDate),
            isNotNull(sessions.geoLat),
            isNotNull(sessions.geoLon)
          )
        )
        .groupBy(sessions.geoCity, sessions.geoCountry, sessions.geoLat, sessions.geoLon)
        .orderBy(desc(sql`count(*)`))
        .limit(100);

      return { data: locationStats };
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

      const topContent = await db
        .select({
          mediaTitle: sessions.mediaTitle,
          mediaType: sessions.mediaType,
          count: sql<number>`count(*)::int`,
          totalWatchMs: sql<number>`coalesce(sum(duration_ms), 0)::bigint`,
        })
        .from(sessions)
        .where(gte(sessions.startedAt, startDate))
        .groupBy(sessions.mediaTitle, sessions.mediaType)
        .orderBy(desc(sql`count(*)`))
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

      const topUsers = await db
        .select({
          userId: users.id,
          username: users.username,
          thumbUrl: users.thumbUrl,
          trustScore: users.trustScore,
          playCount: sql<number>`count(${sessions.id})::int`,
          watchTimeMs: sql<number>`coalesce(sum(${sessions.durationMs}), 0)::bigint`,
        })
        .from(users)
        .leftJoin(
          sessions,
          and(eq(sessions.userId, users.id), gte(sessions.startedAt, startDate))
        )
        .groupBy(users.id, users.username, users.thumbUrl, users.trustScore)
        .orderBy(desc(sql`coalesce(sum(${sessions.durationMs}), 0)`))
        .limit(10);

      return {
        data: topUsers.map((u) => ({
          userId: u.userId,
          username: u.username,
          thumbUrl: u.thumbUrl,
          trustScore: u.trustScore,
          playCount: u.playCount,
          watchTimeHours: Math.round((Number(u.watchTimeMs) / (1000 * 60 * 60)) * 10) / 10,
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

      // Get hourly max concurrent streams
      // This is simplified - a production version would use time-range overlaps
      const hourlyData = await db
        .select({
          hour: sql<string>`date_trunc('hour', started_at)::text`,
          maxConcurrent: sql<number>`count(*)::int`,
        })
        .from(sessions)
        .where(gte(sessions.startedAt, startDate))
        .groupBy(sql`date_trunc('hour', started_at)`)
        .orderBy(sql`date_trunc('hour', started_at)`);

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

      const qualityStats = await db
        .select({
          isTranscode: sessions.isTranscode,
          count: sql<number>`count(*)::int`,
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
