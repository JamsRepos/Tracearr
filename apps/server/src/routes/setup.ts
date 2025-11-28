/**
 * Setup routes - Check if Tracearr has been configured
 */

import type { FastifyPluginAsync } from 'fastify';
import { db } from '../db/client.js';
import { servers } from '../db/schema.js';

export const setupRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /setup/status - Check if any servers have been configured
   *
   * This endpoint is public (no auth required) so the frontend
   * can determine whether to show the setup wizard or login page.
   */
  app.get('/status', async () => {
    const serverList = await db.select({ id: servers.id }).from(servers).limit(1);

    return {
      hasServers: serverList.length > 0,
      needsSetup: serverList.length === 0,
    };
  });
};
