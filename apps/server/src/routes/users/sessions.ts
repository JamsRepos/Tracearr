/**
 * User Sessions Route
 *
 * GET /:id/sessions - Get user's session history
 */

import type { FastifyPluginAsync } from 'fastify';
import { eq, desc, sql } from 'drizzle-orm';
import { userIdParamSchema, paginationSchema } from '@tracearr/shared';
import { db } from '../../db/client.js';
import { users, sessions, servers } from '../../db/schema.js';

export const sessionsRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /:id/sessions - Get user's session history
   */
  app.get(
    '/:id/sessions',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const params = userIdParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply.badRequest('Invalid user ID');
      }

      const query = paginationSchema.safeParse(request.query);
      if (!query.success) {
        return reply.badRequest('Invalid query parameters');
      }

      const { id } = params.data;
      const { page = 1, pageSize = 50 } = query.data;
      const authUser = request.user;
      const offset = (page - 1) * pageSize;

      // Verify user exists and access
      const userRows = await db
        .select()
        .from(users)
        .where(eq(users.id, id))
        .limit(1);

      const user = userRows[0];
      if (!user) {
        return reply.notFound('User not found');
      }

      if (user.serverId && !authUser.serverIds.includes(user.serverId)) {
        return reply.forbidden('You do not have access to this user');
      }

      // Get sessions
      const sessionData = await db
        .select({
          id: sessions.id,
          serverId: sessions.serverId,
          serverName: servers.name,
          sessionKey: sessions.sessionKey,
          state: sessions.state,
          mediaType: sessions.mediaType,
          mediaTitle: sessions.mediaTitle,
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
          playerName: sessions.playerName,
          platform: sessions.platform,
          quality: sessions.quality,
          isTranscode: sessions.isTranscode,
        })
        .from(sessions)
        .innerJoin(servers, eq(sessions.serverId, servers.id))
        .where(eq(sessions.userId, id))
        .orderBy(desc(sessions.startedAt))
        .limit(pageSize)
        .offset(offset);

      // Get total count
      const countResult = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(sessions)
        .where(eq(sessions.userId, id));

      const total = countResult[0]?.count ?? 0;

      return {
        data: sessionData,
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      };
    }
  );
};
