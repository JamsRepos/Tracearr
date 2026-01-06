/**
 * Concurrent Streams Statistics Route
 *
 * GET /concurrent - Concurrent stream history
 */

import type { FastifyPluginAsync } from 'fastify';
import { sql, gte } from 'drizzle-orm';
import { statsQuerySchema } from '@tracearr/shared';
import { db } from '../../db/client.js';
import { sessions } from '../../db/schema.js';
import { resolveDateRange, hasAggregates } from './utils.js';

export const concurrentRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /concurrent - Concurrent stream history
   */
  app.get('/concurrent', { preHandler: [app.authenticate] }, async (request, reply) => {
    const query = statsQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.badRequest('Invalid query parameters');
    }

    const { period, startDate, endDate } = query.data;
    const dateRange = resolveDateRange(period, startDate, endDate);

    let hourlyData: { hour: string; maxConcurrent: number }[];

    if (await hasAggregates()) {
      // Use continuous aggregate - sums across servers
      const baseWhere = dateRange.start ? sql`WHERE hour >= ${dateRange.start}` : sql`WHERE true`;

      const result = await db.execute(sql`
        SELECT
          hour::text,
          SUM(stream_count)::int as max_concurrent
        FROM hourly_concurrent_streams
        ${baseWhere}
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
      if (dateRange.start) {
        const result = await db
          .select({
            hour: sql<string>`date_trunc('hour', started_at)::text`,
            maxConcurrent: sql<number>`count(*)::int`,
          })
          .from(sessions)
          .where(gte(sessions.startedAt, dateRange.start))
          .groupBy(sql`date_trunc('hour', started_at)`)
          .orderBy(sql`date_trunc('hour', started_at)`);
        hourlyData = result;
      } else {
        // All-time query
        const result = await db
          .select({
            hour: sql<string>`date_trunc('hour', started_at)::text`,
            maxConcurrent: sql<number>`count(*)::int`,
          })
          .from(sessions)
          .groupBy(sql`date_trunc('hour', started_at)`)
          .orderBy(sql`date_trunc('hour', started_at)`);
        hourlyData = result;
      }
    }

    return { data: hourlyData };
  });
};
