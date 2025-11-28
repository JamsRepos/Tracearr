/**
 * Session routes - Query historical and active sessions
 */

import type { FastifyPluginAsync } from 'fastify';
import { eq, and, desc, gte, lte, sql } from 'drizzle-orm';
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

      // Build conditions
      const conditions = [];

      // Filter by user's accessible servers
      if (authUser.serverIds.length > 0) {
        // For now, just filter to first server
        // In a real multi-server setup, we'd use IN clause
        conditions.push(eq(sessions.serverId, authUser.serverIds[0] as string));
      }

      if (userId) {
        conditions.push(eq(sessions.userId, userId));
      }

      if (serverId) {
        conditions.push(eq(sessions.serverId, serverId));
      }

      if (state) {
        conditions.push(eq(sessions.state, state));
      }

      if (mediaType) {
        conditions.push(eq(sessions.mediaType, mediaType));
      }

      if (startDate) {
        conditions.push(gte(sessions.startedAt, startDate));
      }

      if (endDate) {
        conditions.push(lte(sessions.startedAt, endDate));
      }

      // Query with joins for user and server info
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
          ipAddress: sessions.ipAddress,
          geoCity: sessions.geoCity,
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
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(sessions.startedAt))
        .limit(pageSize)
        .offset(offset);

      // Get total count
      const countResult = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(sessions)
        .where(conditions.length > 0 ? and(...conditions) : undefined);

      const total = countResult[0]?.count ?? 0;

      return {
        data: sessionData,
        pagination: {
          page,
          pageSize,
          total,
          totalPages: Math.ceil(total / pageSize),
        },
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

      // Query from database
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
          ipAddress: sessions.ipAddress,
          geoCity: sessions.geoCity,
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
