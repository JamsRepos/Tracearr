/**
 * Import routes - Data import from external sources
 */

import type { FastifyPluginAsync } from 'fastify';
import { tautulliImportSchema } from '@tracearr/shared';
import { TautulliService } from '../services/tautulli.js';
import { getPubSubService } from '../services/cache.js';

export const importRoutes: FastifyPluginAsync = async (app) => {
  /**
   * POST /import/tautulli - Import history from Tautulli
   */
  app.post(
    '/tautulli',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const body = tautulliImportSchema.safeParse(request.body);
      if (!body.success) {
        return reply.badRequest('Invalid request body: serverId is required');
      }

      const authUser = request.user;

      // Only owners can import data
      if (authUser.role !== 'owner') {
        return reply.forbidden('Only server owners can import data');
      }

      const { serverId } = body.data;

      // Get pubsub service for progress updates
      const pubSubService = getPubSubService();

      // Start import in background (non-blocking)
      // The progress will be published via WebSocket
      TautulliService.importHistory(serverId, pubSubService ?? undefined)
        .then((result) => {
          console.log(`[Import] Tautulli import completed:`, result);
        })
        .catch((error) => {
          console.error(`[Import] Tautulli import failed:`, error);
        });

      // Return immediately - client will receive progress via WebSocket
      return {
        status: 'started',
        message: 'Import started. Watch for progress updates via WebSocket.',
      };
    }
  );

  /**
   * POST /import/tautulli/test - Test Tautulli connection
   */
  app.post(
    '/tautulli/test',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const authUser = request.user;

      // Only owners can test connection
      if (authUser.role !== 'owner') {
        return reply.forbidden('Only server owners can test Tautulli connection');
      }

      const body = request.body as { url?: string; apiKey?: string } | undefined;

      if (!body?.url || !body?.apiKey) {
        return reply.badRequest('URL and API key are required');
      }

      try {
        const tautulli = new TautulliService(body.url, body.apiKey);
        const connected = await tautulli.testConnection();

        if (connected) {
          // Get user count to verify full access
          const users = await tautulli.getUsers();
          const { total } = await tautulli.getHistory(0, 1);

          return {
            success: true,
            message: 'Connection successful',
            users: users.length,
            historyRecords: total,
          };
        } else {
          return {
            success: false,
            message: 'Connection failed. Please check URL and API key.',
          };
        }
      } catch (error) {
        return {
          success: false,
          message: error instanceof Error ? error.message : 'Connection failed',
        };
      }
    }
  );
};
