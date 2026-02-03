/**
 * Quality Statistics Route
 *
 * GET /quality - Transcode vs direct play breakdown
 * Uses prepared statement for 10-30% query plan reuse speedup (when no server filter)
 */

import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import { statsQuerySchema } from '@tracearr/shared';
import { qualityStatsSince } from '../../db/prepared.js';
import { db } from '../../db/client.js';
import { resolveDateRange } from './utils.js';
import { MEDIA_TYPE_SQL_FILTER } from '../../constants/index.js';
import { validateServerAccess } from '../../utils/serverFiltering.js';

/**
 * Build SQL server filter fragment for sessions table queries.
 */
function buildSessionServerFilter(
  serverId: string | undefined,
  authUser: { role: string; serverIds: string[] }
): ReturnType<typeof sql> {
  if (serverId) {
    return sql`AND server_id = ${serverId}`;
  }
  if (authUser.role !== 'owner') {
    if (authUser.serverIds.length === 0) {
      return sql`AND false`;
    } else if (authUser.serverIds.length === 1) {
      return sql`AND server_id = ${authUser.serverIds[0]}`;
    } else {
      const serverIdList = authUser.serverIds.map((id) => sql`${id}`);
      return sql`AND server_id IN (${sql.join(serverIdList, sql`, `)})`;
    }
  }
  return sql``;
}

export const qualityRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /quality - Transcode vs direct play breakdown
   * Uses prepared statement for better performance when no server filter
   */
  app.get('/quality', { preHandler: [app.authenticate] }, async (request, reply) => {
    const query = statsQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.badRequest('Invalid query parameters');
    }

    const { period, startDate, endDate, serverId } = query.data;
    const authUser = request.user;
    const dateRange = resolveDateRange(period, startDate, endDate);

    // Validate server access if specific server requested
    if (serverId) {
      const error = validateServerAccess(authUser, serverId);
      if (error) {
        return reply.forbidden(error);
      }
    }

    const serverFilter = buildSessionServerFilter(serverId, authUser);
    const needsServerFilter = serverId || authUser.role !== 'owner';

    let qualityStats: { isTranscode: boolean | null; count: number }[];

    // For 'all' period (no start date) OR when server filtering is needed, use raw query
    // Prepared statements don't support dynamic server filtering
    if (!dateRange.start || needsServerFilter) {
      const result = await db.execute(sql`
        SELECT
          is_transcode,
          COUNT(DISTINCT COALESCE(reference_id, id))::int as count
        FROM sessions
        WHERE true
        ${MEDIA_TYPE_SQL_FILTER}
        ${serverFilter}
        ${dateRange.start ? sql`AND started_at >= ${dateRange.start}` : sql``}
        GROUP BY is_transcode
      `);
      qualityStats = (result.rows as { is_transcode: boolean | null; count: number }[]).map(
        (r) => ({ isTranscode: r.is_transcode, count: r.count })
      );
    } else {
      // No server filter needed and has date range - use prepared statement for performance
      qualityStats = await qualityStatsSince.execute({ since: dateRange.start });
    }

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
  });
};
