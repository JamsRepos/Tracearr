/**
 * User Locations Route
 *
 * GET /:id/locations - Get user's unique locations (aggregated from sessions)
 */

import type { FastifyPluginAsync } from 'fastify';
import { eq, desc, sql } from 'drizzle-orm';
import { userIdParamSchema, type UserLocation } from '@tracearr/shared';
import { db } from '../../db/client.js';
import { users, sessions } from '../../db/schema.js';

export const locationsRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /:id/locations - Get user's unique locations (aggregated from sessions)
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
};
