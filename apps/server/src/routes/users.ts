/**
 * User management routes
 */

import type { FastifyPluginAsync } from 'fastify';
import { eq, and, desc, sql } from 'drizzle-orm';
import {
  updateUserSchema,
  userIdParamSchema,
  paginationSchema,
  type UserLocation,
  type UserDevice,
} from '@tracearr/shared';
import { db } from '../db/client.js';
import { users, sessions, servers } from '../db/schema.js';

export const userRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /users - List all users with pagination
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
   * GET /users/:id - Get user details
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
   * PATCH /users/:id - Update user (trustScore, etc.)
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

  /**
   * GET /users/:id/sessions - Get user's session history
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

  /**
   * GET /users/:id/locations - Get user's unique locations (aggregated from sessions)
   */
  app.get(
    '/:id/locations',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const params = userIdParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply.badRequest('Invalid user ID');
      }

      const { id } = params.data;
      const authUser = request.user;

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

      // Aggregate locations from sessions
      const locationData = await db
        .select({
          city: sessions.geoCity,
          region: sessions.geoRegion,
          country: sessions.geoCountry,
          lat: sessions.geoLat,
          lon: sessions.geoLon,
          sessionCount: sql<number>`count(*)::int`,
          lastSeenAt: sql<Date>`max(${sessions.startedAt})`,
          ipAddresses: sql<string[]>`array_agg(distinct ${sessions.ipAddress})`,
        })
        .from(sessions)
        .where(eq(sessions.userId, id))
        .groupBy(
          sessions.geoCity,
          sessions.geoRegion,
          sessions.geoCountry,
          sessions.geoLat,
          sessions.geoLon
        )
        .orderBy(desc(sql`max(${sessions.startedAt})`));

      const locations: UserLocation[] = locationData.map((loc) => ({
        city: loc.city,
        region: loc.region,
        country: loc.country,
        lat: loc.lat,
        lon: loc.lon,
        sessionCount: loc.sessionCount,
        lastSeenAt: loc.lastSeenAt,
        ipAddresses: loc.ipAddresses ?? [],
      }));

      return { data: locations };
    }
  );

  /**
   * GET /users/:id/devices - Get user's unique devices (aggregated from sessions)
   */
  app.get(
    '/:id/devices',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const params = userIdParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply.badRequest('Invalid user ID');
      }

      const { id } = params.data;
      const authUser = request.user;

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

      // Aggregate devices from sessions with location data
      // Use deviceId as primary key (fallback to playerName if deviceId is null)
      // Aggregate locations where each device has been used
      const sessionData = await db
        .select({
          deviceId: sessions.deviceId,
          playerName: sessions.playerName,
          product: sessions.product,
          device: sessions.device,
          platform: sessions.platform,
          startedAt: sessions.startedAt,
          geoCity: sessions.geoCity,
          geoRegion: sessions.geoRegion,
          geoCountry: sessions.geoCountry,
        })
        .from(sessions)
        .where(eq(sessions.userId, id))
        .orderBy(desc(sessions.startedAt));

      // Group by deviceId (or playerName as fallback)
      const deviceMap = new Map<string, {
        deviceId: string | null;
        playerName: string | null;
        product: string | null;
        device: string | null;
        platform: string | null;
        sessionCount: number;
        lastSeenAt: Date;
        locationMap: Map<string, {
          city: string | null;
          region: string | null;
          country: string | null;
          sessionCount: number;
          lastSeenAt: Date;
        }>;
      }>();

      for (const session of sessionData) {
        // Use deviceId as key, or playerName as fallback, or generate a hash from metadata
        const key = session.deviceId
          ?? session.playerName
          ?? `${session.product ?? 'unknown'}-${session.device ?? 'unknown'}-${session.platform ?? 'unknown'}`;

        const existing = deviceMap.get(key);
        if (existing) {
          existing.sessionCount++;
          // Update lastSeenAt if this session is more recent
          if (session.startedAt > existing.lastSeenAt) {
            existing.lastSeenAt = session.startedAt;
            // Use most recent values for metadata
            existing.playerName = session.playerName ?? existing.playerName;
            existing.product = session.product ?? existing.product;
            existing.device = session.device ?? existing.device;
            existing.platform = session.platform ?? existing.platform;
          }

          // Aggregate location
          const locKey = `${session.geoCity ?? ''}-${session.geoRegion ?? ''}-${session.geoCountry ?? ''}`;
          const existingLoc = existing.locationMap.get(locKey);
          if (existingLoc) {
            existingLoc.sessionCount++;
            if (session.startedAt > existingLoc.lastSeenAt) {
              existingLoc.lastSeenAt = session.startedAt;
            }
          } else {
            existing.locationMap.set(locKey, {
              city: session.geoCity,
              region: session.geoRegion,
              country: session.geoCountry,
              sessionCount: 1,
              lastSeenAt: session.startedAt,
            });
          }
        } else {
          const locationMap = new Map<string, {
            city: string | null;
            region: string | null;
            country: string | null;
            sessionCount: number;
            lastSeenAt: Date;
          }>();
          const locKey = `${session.geoCity ?? ''}-${session.geoRegion ?? ''}-${session.geoCountry ?? ''}`;
          locationMap.set(locKey, {
            city: session.geoCity,
            region: session.geoRegion,
            country: session.geoCountry,
            sessionCount: 1,
            lastSeenAt: session.startedAt,
          });

          deviceMap.set(key, {
            deviceId: session.deviceId,
            playerName: session.playerName,
            product: session.product,
            device: session.device,
            platform: session.platform,
            sessionCount: 1,
            lastSeenAt: session.startedAt,
            locationMap,
          });
        }
      }

      // Convert to array and sort by last seen
      const devices: UserDevice[] = Array.from(deviceMap.values())
        .map((dev) => ({
          deviceId: dev.deviceId,
          playerName: dev.playerName,
          product: dev.product,
          device: dev.device,
          platform: dev.platform,
          sessionCount: dev.sessionCount,
          lastSeenAt: dev.lastSeenAt,
          locations: Array.from(dev.locationMap.values())
            .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime()),
        }))
        .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime());

      return { data: devices };
    }
  );
};
