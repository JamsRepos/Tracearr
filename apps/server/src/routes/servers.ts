/**
 * Server management routes - CRUD for Plex/Jellyfin servers
 */

import type { FastifyPluginAsync } from 'fastify';
import { eq } from 'drizzle-orm';
import { createServerSchema, serverIdParamSchema } from '@tracearr/shared';
import { db } from '../db/client.js';
import { servers, users } from '../db/schema.js';
import { encrypt, decrypt } from '../utils/crypto.js';
import { PlexService } from '../services/plex.js';
import { JellyfinService } from '../services/jellyfin.js';
import { syncServer } from '../services/sync.js';

export const serverRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /servers - List connected servers
   * Returns all servers (without tokens) for the authenticated user
   */
  app.get(
    '/',
    { preHandler: [app.authenticate] },
    async (request) => {
      const authUser = request.user;

      // Get servers the user has access to
      const serverList = await db
        .select({
          id: servers.id,
          name: servers.name,
          type: servers.type,
          url: servers.url,
          createdAt: servers.createdAt,
          updatedAt: servers.updatedAt,
        })
        .from(servers)
        .where(
          authUser.serverIds.length > 0
            ? eq(servers.id, authUser.serverIds[0] as string)
            : undefined
        );

      return { data: serverList };
    }
  );

  /**
   * POST /servers - Add a new server
   * Encrypts the token before storage
   */
  app.post(
    '/',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const body = createServerSchema.safeParse(request.body);
      if (!body.success) {
        return reply.badRequest('Invalid request body');
      }

      const { name, type, url, token } = body.data;
      const authUser = request.user;

      // Only owners can add servers
      if (authUser.role !== 'owner') {
        return reply.forbidden('Only server owners can add servers');
      }

      // Check if server already exists
      const existing = await db
        .select()
        .from(servers)
        .where(eq(servers.url, url))
        .limit(1);

      if (existing.length > 0) {
        return reply.conflict('A server with this URL already exists');
      }

      // Verify the server connection
      try {
        if (type === 'plex') {
          const isAdmin = await PlexService.verifyServerAdmin(token, url);
          if (!isAdmin) {
            return reply.forbidden('Token does not have admin access to this Plex server');
          }
        } else if (type === 'jellyfin') {
          const isAdmin = await JellyfinService.verifyServerAdmin(token, url);
          if (!isAdmin) {
            return reply.forbidden('Token does not have admin access to this Jellyfin server');
          }
        }
      } catch (error) {
        app.log.error({ error }, 'Failed to verify server connection');
        return reply.badRequest('Failed to connect to server. Please verify URL and token.');
      }

      // Encrypt token and save
      const encryptedToken = encrypt(token);

      const inserted = await db
        .insert(servers)
        .values({
          name,
          type,
          url,
          token: encryptedToken,
        })
        .returning({
          id: servers.id,
          name: servers.name,
          type: servers.type,
          url: servers.url,
          createdAt: servers.createdAt,
          updatedAt: servers.updatedAt,
        });

      const server = inserted[0];
      if (!server) {
        return reply.internalServerError('Failed to create server');
      }

      return reply.status(201).send(server);
    }
  );

  /**
   * DELETE /servers/:id - Remove a server
   * Cascades to delete all related users, sessions, violations
   */
  app.delete(
    '/:id',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const params = serverIdParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply.badRequest('Invalid server ID');
      }

      const { id } = params.data;
      const authUser = request.user;

      // Only owners can delete servers
      if (authUser.role !== 'owner') {
        return reply.forbidden('Only server owners can delete servers');
      }

      // Check if server exists and user has access
      const server = await db
        .select()
        .from(servers)
        .where(eq(servers.id, id))
        .limit(1);

      if (server.length === 0) {
        return reply.notFound('Server not found');
      }

      // Delete server (cascade will handle related records)
      await db.delete(servers).where(eq(servers.id, id));

      return { success: true };
    }
  );

  /**
   * POST /servers/:id/sync - Force sync users and libraries from server
   * For Plex: Fetches users from Plex.tv including shared users
   * For Jellyfin: Fetches users from the server
   */
  app.post(
    '/:id/sync',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const params = serverIdParamSchema.safeParse(request.params);
      if (!params.success) {
        return reply.badRequest('Invalid server ID');
      }

      const { id } = params.data;
      const authUser = request.user;

      // Only owners can sync
      if (authUser.role !== 'owner') {
        return reply.forbidden('Only server owners can sync servers');
      }

      // Check server exists
      const serverRows = await db
        .select()
        .from(servers)
        .where(eq(servers.id, id))
        .limit(1);

      if (serverRows.length === 0) {
        return reply.notFound('Server not found');
      }

      try {
        const result = await syncServer(id, { syncUsers: true, syncLibraries: true });

        // Update server's updatedAt timestamp
        await db
          .update(servers)
          .set({ updatedAt: new Date() })
          .where(eq(servers.id, id));

        return {
          success: result.errors.length === 0,
          usersAdded: result.usersAdded,
          usersUpdated: result.usersUpdated,
          librariesSynced: result.librariesSynced,
          errors: result.errors,
          syncedAt: new Date().toISOString(),
        };
      } catch (error) {
        app.log.error({ error, serverId: id }, 'Failed to sync server');
        return reply.internalServerError('Failed to sync server');
      }
    }
  );

  /**
   * GET /servers/:id/image/* - Proxy images from Plex/Jellyfin servers
   * This endpoint fetches images without exposing server tokens to the client
   *
   * For Plex: /servers/:id/image/library/metadata/123/thumb/456
   * For Jellyfin: /servers/:id/image/Items/123/Images/Primary?tag=abc
   *
   * Note: Accepts auth via header OR query param (?token=xxx) since browser
   * <img> tags don't send Authorization headers
   */
  app.get(
    '/:id/image/*',
    async (request, reply) => {
      // Custom auth: try header first, fall back to query param for <img> tags
      const queryToken = (request.query as { token?: string }).token;
      if (queryToken) {
        // Manually set authorization header for jwtVerify to work
        request.headers.authorization = `Bearer ${queryToken}`;
      }

      try {
        await request.jwtVerify();
      } catch {
        return reply.unauthorized('Invalid or missing token');
      }

      const { id } = request.params as { id: string; '*': string };
      const imagePath = (request.params as { '*': string })['*'];

      if (!imagePath) {
        return reply.badRequest('Image path is required');
      }

      // Get server with token
      const serverRows = await db
        .select()
        .from(servers)
        .where(eq(servers.id, id))
        .limit(1);

      const server = serverRows[0];
      if (!server) {
        return reply.notFound('Server not found');
      }

      const baseUrl = server.url.replace(/\/$/, '');
      const token = decrypt(server.token);

      try {
        let imageUrl: string;
        let headers: Record<string, string>;

        if (server.type === 'plex') {
          // Plex uses X-Plex-Token query param
          const separator = imagePath.includes('?') ? '&' : '?';
          imageUrl = `${baseUrl}/${imagePath}${separator}X-Plex-Token=${token}`;
          headers = { Accept: 'image/*' };
        } else {
          // Jellyfin uses X-Emby-Authorization header
          imageUrl = `${baseUrl}/${imagePath}`;
          headers = {
            'X-Emby-Authorization': `MediaBrowser Client="Tracearr", Device="Tracearr Server", DeviceId="tracearr-server", Version="1.0.0", Token="${token}"`,
            Accept: 'image/*',
          };
        }

        const response = await fetch(imageUrl, { headers });

        if (!response.ok) {
          return reply.notFound('Image not found');
        }

        const contentType = response.headers.get('content-type') || 'image/jpeg';
        const buffer = await response.arrayBuffer();

        reply.header('Content-Type', contentType);
        reply.header('Cache-Control', 'public, max-age=86400'); // Cache for 24 hours
        return reply.send(Buffer.from(buffer));
      } catch (error) {
        app.log.error({ error, serverId: id, imagePath }, 'Failed to fetch image from server');
        return reply.internalServerError('Failed to fetch image');
      }
    }
  );
};
