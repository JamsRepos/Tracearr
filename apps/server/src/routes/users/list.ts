/**
 * User List and CRUD Routes
 *
 * GET / - List all users with pagination
 * GET /:id - Get user details
 * PATCH /:id - Update user (trustScore, etc.)
 */

import type { FastifyPluginAsync } from 'fastify';
import { eq, and, sql } from 'drizzle-orm';
import {
  updateUserSchema,
  userIdParamSchema,
  paginationSchema,
} from '@tracearr/shared';
import { db } from '../../db/client.js';
import { users, sessions, servers } from '../../db/schema.js';

export const listRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET / - List all users with pagination
   */
  app.get(
    '/',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const query = paginationSchema.safeParse(request.query);
      if (!query.success) {
        return reply.badRequest('Invalid query parameters');
      }

      const { page = 1, pageSize = 50 } = query.data;
      const authUser = request.user;
      const offset = (page - 1) * pageSize;

      // Get users from servers the authenticated user has access to
      const conditions = [];
      if (authUser.serverIds.length > 0) {
        conditions.push(eq(users.serverId, authUser.serverIds[0] as string));
      }

      const userList = await db
        .select({
          id: users.id,
          serverId: users.serverId,
          serverName: servers.name,
          externalId: users.externalId,
          username: users.username,
          email: users.email,
          thumbUrl: users.thumbUrl,
          isOwner: users.isOwner,
          trustScore: users.trustScore,
          createdAt: users.createdAt,
          updatedAt: users.updatedAt,
        })
        .from(users)
        .innerJoin(servers, eq(users.serverId, servers.id))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(users.username)
        .limit(pageSize)
        .offset(offset);

      // Get total count
      const countResult = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(users)
        .where(conditions.length > 0 ? and(...conditions) : undefined);

      const total = countResult[0]?.count ?? 0;

      return {
        data: userList,
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      };
    }
  );

  /**
   * GET /:id - Get user details
   */
  app.get(
    '/:id',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const params = userIdParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply.badRequest('Invalid user ID');
      }

      const { id } = params.data;
      const authUser = request.user;

      const userRows = await db
        .select({
          id: users.id,
          serverId: users.serverId,
          serverName: servers.name,
          externalId: users.externalId,
          username: users.username,
          email: users.email,
          thumbUrl: users.thumbUrl,
          isOwner: users.isOwner,
          trustScore: users.trustScore,
          createdAt: users.createdAt,
          updatedAt: users.updatedAt,
        })
        .from(users)
        .innerJoin(servers, eq(users.serverId, servers.id))
        .where(eq(users.id, id))
        .limit(1);

      const user = userRows[0];
      if (!user) {
        return reply.notFound('User not found');
      }

      // Verify access
      if (user.serverId && !authUser.serverIds.includes(user.serverId)) {
        return reply.forbidden('You do not have access to this user');
      }

      // Get session stats for this user
      const statsResult = await db
        .select({
          totalSessions: sql<number>`count(*)::int`,
          totalWatchTime: sql<number>`coalesce(sum(duration_ms), 0)::bigint`,
        })
        .from(sessions)
        .where(eq(sessions.userId, id));

      const stats = statsResult[0];

      return {
        ...user,
        stats: {
          totalSessions: stats?.totalSessions ?? 0,
          totalWatchTime: Number(stats?.totalWatchTime ?? 0),
        },
      };
    }
  );

  /**
   * PATCH /:id - Update user (trustScore, etc.)
   */
  app.patch(
    '/:id',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const params = userIdParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply.badRequest('Invalid user ID');
      }

      const body = updateUserSchema.safeParse(request.body);
      if (!body.success) {
        return reply.badRequest('Invalid request body');
      }

      const { id } = params.data;
      const authUser = request.user;

      // Only owners can update users
      if (authUser.role !== 'owner') {
        return reply.forbidden('Only server owners can update users');
      }

      // Get existing user
      const userRows = await db
        .select()
        .from(users)
        .where(eq(users.id, id))
        .limit(1);

      const user = userRows[0];
      if (!user) {
        return reply.notFound('User not found');
      }

      // Verify access
      if (user.serverId && !authUser.serverIds.includes(user.serverId)) {
        return reply.forbidden('You do not have access to this user');
      }

      // Build update object
      const updateData: Partial<{
        trustScore: number;
        updatedAt: Date;
      }> = {
        updatedAt: new Date(),
      };

      if (body.data.trustScore !== undefined) {
        updateData.trustScore = body.data.trustScore;
      }

      // Update user
      const updated = await db
        .update(users)
        .set(updateData)
        .where(eq(users.id, id))
        .returning({
          id: users.id,
          serverId: users.serverId,
          externalId: users.externalId,
          username: users.username,
          email: users.email,
          thumbUrl: users.thumbUrl,
          isOwner: users.isOwner,
          trustScore: users.trustScore,
          createdAt: users.createdAt,
          updatedAt: users.updatedAt,
        });

      const updatedUser = updated[0];
      if (!updatedUser) {
        return reply.internalServerError('Failed to update user');
      }

      return updatedUser;
    }
  );
};
