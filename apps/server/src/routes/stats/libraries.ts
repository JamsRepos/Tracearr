/**
 * Library Statistics Route
 *
 * GET /libraries - Get library statistics from database
 * POST /libraries/refresh - Trigger manual refresh of library statistics
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { getLibraryStatistics } from '../../services/libraryStats.js';
import { enqueueLibraryStatsUpdate } from '../../jobs/libraryStatsQueue.js';
import { validateServerAccess } from '../../utils/serverFiltering.js';

// Query schema for library stats
const libraryStatsQuerySchema = z.object({
  serverId: z.uuid().optional(),
  days: z.coerce.number().int().min(1).max(365).optional().default(90),
});

// Body schema for refresh endpoint
const refreshBodySchema = z.object({
  serverId: z.uuid().optional(),
});

export const librariesRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /libraries - Get library statistics
   *
   * Query params:
   * - serverId: Optional UUID to filter stats to a specific server
   * - days: Number of days of historical data (default: 90, max: 365)
   */
  app.get('/libraries', { preHandler: [app.authenticate] }, async (request, reply) => {
    const query = libraryStatsQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.badRequest('Invalid query parameters');
    }

    const { serverId, days } = query.data;
    const authUser = request.user;

    // Validate server access if specific server requested
    if (serverId) {
      const error = validateServerAccess(authUser, serverId);
      if (error) {
        return reply.forbidden(error);
      }
    }

    try {
      const stats = await getLibraryStatistics(serverId, days);

      app.log.info(
        {
          serverId,
          librariesCount: stats.current.libraries.length,
          userRole: authUser.role,
          userServerIds: authUser.serverIds,
          totalSize: stats.current.totalSize,
        },
        'Library stats fetched'
      );

      // Filter by user's accessible servers if they have restricted access
      // Owners and admins have access to all servers (empty serverIds array)
      if (authUser.role !== 'owner' && authUser.role !== 'admin' && authUser.serverIds.length > 0) {
        stats.current.libraries = stats.current.libraries.filter((lib) =>
          authUser.serverIds.includes(lib.serverId)
        );

        app.log.info(
          {
            librariesAfterFilter: stats.current.libraries.length,
          },
          'Libraries filtered by user access'
        );

        // Recalculate totals after filtering
        stats.current.totalSize = stats.current.libraries.reduce((sum, lib) => sum + lib.size, 0);
        stats.current.totalItems = stats.current.libraries.reduce(
          (sum, lib) => sum + lib.itemCount,
          0
        );
        stats.current.totalHours = stats.current.libraries.reduce((sum, lib) => sum + lib.hours, 0);
      }

      return stats;
    } catch (error) {
      app.log.error({ error }, 'Failed to get library statistics');
      return reply.internalServerError('Failed to get library statistics');
    }
  });

  /**
   * POST /libraries/refresh - Trigger manual refresh of library statistics
   *
   * Body:
   * - serverId: Optional UUID to refresh only a specific server
   *
   * Only owner and admin can trigger refreshes.
   */
  app.post('/libraries/refresh', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authUser = request.user;

    // Only owner and admin can trigger refreshes
    if (authUser.role !== 'owner' && authUser.role !== 'admin') {
      return reply.forbidden('Only owners and admins can trigger library stats refresh');
    }

    const body = refreshBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.badRequest('Invalid request body');
    }

    const { serverId } = body.data;

    // Validate server access if specific server requested
    if (serverId) {
      const error = validateServerAccess(authUser, serverId);
      if (error) {
        return reply.forbidden(error);
      }
    }

    try {
      const jobId = await enqueueLibraryStatsUpdate(serverId);

      return {
        success: true,
        message: serverId
          ? `Library stats refresh queued for server`
          : 'Library stats refresh queued for all servers',
        jobId,
      };
    } catch (error) {
      app.log.error({ error }, 'Failed to enqueue library stats refresh');
      return reply.internalServerError('Failed to enqueue library stats refresh');
    }
  });
};
