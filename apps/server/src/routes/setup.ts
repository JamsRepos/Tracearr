/**
 * Setup routes - Check if Tracearr has been configured
 */

import type { FastifyPluginAsync } from 'fastify';
import { isNotNull, eq } from 'drizzle-orm';
import { getPrimaryAuthMethod } from '@tracearr/shared';
import { db } from '../db/client.js';
import { servers, users, settings } from '../db/schema.js';

export const setupRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /setup/status - Check Tracearr configuration status
   *
   * This endpoint is public (no auth required) so the frontend
   * can determine whether to show the setup wizard or login page.
   *
   * Returns:
   * - needsSetup: true if no owner accounts exist
   * - hasServers: true if at least one server is configured
   * - hasPasswordAuth: true if at least one user has password login enabled
   */
  app.get('/status', async () => {
    // Check for servers and users in parallel
    const [serverList, jellyfinServerList, plexServerList, ownerList, passwordUserList] =
      await Promise.all([
        db.select({ id: servers.id }).from(servers).limit(1),
        db.select({ id: servers.id }).from(servers).where(eq(servers.type, 'jellyfin')).limit(1),
        db.select({ id: servers.id }).from(servers).where(eq(servers.type, 'plex')).limit(1),
        db.select({ id: users.id }).from(users).where(eq(users.role, 'owner')).limit(1),
        db.select({ id: users.id }).from(users).where(isNotNull(users.passwordHash)).limit(1),
      ]);

    // Try to get primaryAuthMethod and enabledLoginMethods from settings (columns may not exist yet)
    let primaryAuthMethod: 'jellyfin' | 'local' = 'local';
    let enabledLoginMethods: ('plex' | 'jellyfin' | 'local')[] | null = null;
    try {
      const settingsRow = await db
        .select({
          primaryAuthMethod: settings.primaryAuthMethod,
          enabledLoginMethods: settings.enabledLoginMethods,
        })
        .from(settings)
        .limit(1);
      const row = settingsRow[0];
      if (row?.primaryAuthMethod) {
        primaryAuthMethod = row.primaryAuthMethod;
      }
      if (row && 'enabledLoginMethods' in row && Array.isArray(row.enabledLoginMethods)) {
        enabledLoginMethods = row.enabledLoginMethods;
        primaryAuthMethod = getPrimaryAuthMethod(enabledLoginMethods);
      }
    } catch {
      // Columns don't exist yet (migration not run) - use defaults
      primaryAuthMethod = 'local';
    }

    return {
      needsSetup: ownerList.length === 0,
      hasServers: serverList.length > 0,
      hasJellyfinServers: jellyfinServerList.length > 0,
      hasPlexServers: plexServerList.length > 0,
      hasPasswordAuth: passwordUserList.length > 0,
      primaryAuthMethod,
      enabledLoginMethods,
    };
  });
};
