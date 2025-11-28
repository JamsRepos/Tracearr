/**
 * Authentication routes - Plex OAuth and Jellyfin direct auth
 *
 * Flow for Plex:
 * 1. POST /auth/login (type=plex) → Returns pinId, authUrl
 * 2. User authorizes in Plex popup
 * 3. POST /auth/plex/check-pin → Checks PIN, returns servers list or auto-connects
 * 4. POST /auth/plex/connect → Completes auth with selected server (only for setup)
 *
 * Flow for Jellyfin:
 * 1. POST /auth/login (type=jellyfin, + credentials) → Returns tokens directly
 */

import type { FastifyPluginAsync } from 'fastify';
import { createHash, randomBytes } from 'crypto';
import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import { JWT_CONFIG, type AuthUser } from '@tracearr/shared';
import { db } from '../db/client.js';
import { servers, users } from '../db/schema.js';
import { PlexService, type PlexServerResource } from '../services/plex.js';
import { JellyfinService } from '../services/jellyfin.js';
import { encrypt } from '../utils/crypto.js';

// Redis key prefixes
const REFRESH_TOKEN_PREFIX = 'tracearr:refresh:';
const PLEX_TEMP_TOKEN_PREFIX = 'tracearr:plex_temp:';
const REFRESH_TOKEN_TTL = 30 * 24 * 60 * 60; // 30 days
const PLEX_TEMP_TOKEN_TTL = 10 * 60; // 10 minutes for server selection

// Schemas
const loginSchema = z.object({
  type: z.enum(['plex', 'jellyfin']),
});

const jellyfinLoginSchema = z.object({
  type: z.literal('jellyfin'),
  serverUrl: z.string().url(),
  serverName: z.string().min(1).max(100),
  username: z.string().min(1),
  password: z.string().min(1),
});

const plexCheckPinSchema = z.object({
  pinId: z.string(),
});

const plexConnectSchema = z.object({
  tempToken: z.string(),
  serverUri: z.string().url(),
  serverName: z.string().min(1).max(100),
});

const refreshSchema = z.object({
  refreshToken: z.string(),
});

// Legacy schema for backward compatibility
const plexCallbackSchema = z.object({
  pinId: z.string(),
  serverUrl: z.string().url(),
  serverName: z.string().min(1).max(100),
});

function generateRefreshToken(): string {
  return randomBytes(32).toString('hex');
}

function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function generateTempToken(): string {
  return randomBytes(24).toString('hex');
}

export const authRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Helper to create/update server and user, then generate tokens
   */
  async function completeAuth(
    plexUserId: string,
    plexUsername: string,
    plexEmail: string | null,
    plexThumb: string | null,
    plexToken: string,
    serverUrl: string,
    serverName: string
  ) {
    // Create or update server
    let server = await db
      .select()
      .from(servers)
      .where(and(eq(servers.url, serverUrl), eq(servers.type, 'plex')))
      .limit(1);

    if (server.length === 0) {
      const inserted = await db
        .insert(servers)
        .values({
          name: serverName,
          type: 'plex',
          url: serverUrl,
          token: encrypt(plexToken),
        })
        .returning();
      server = inserted;
    } else {
      const existingServer = server[0]!;
      await db
        .update(servers)
        .set({ token: encrypt(plexToken), updatedAt: new Date() })
        .where(eq(servers.id, existingServer.id));
    }

    const serverId = server[0]!.id;

    // Create or update user
    let user = await db
      .select()
      .from(users)
      .where(and(eq(users.serverId, serverId), eq(users.externalId, plexUserId)))
      .limit(1);

    if (user.length === 0) {
      const inserted = await db
        .insert(users)
        .values({
          serverId,
          externalId: plexUserId,
          username: plexUsername,
          email: plexEmail,
          thumbUrl: plexThumb,
          isOwner: true,
        })
        .returning();
      user = inserted;
    } else {
      const existingUser = user[0]!;
      await db
        .update(users)
        .set({
          username: plexUsername,
          email: plexEmail,
          thumbUrl: plexThumb,
          isOwner: true,
          updatedAt: new Date(),
        })
        .where(eq(users.id, existingUser.id));
    }

    const userId = user[0]!.id;

    // Generate tokens
    const accessPayload: AuthUser = {
      userId,
      username: plexUsername,
      role: 'owner',
      serverIds: [serverId],
    };

    const accessToken = app.jwt.sign(accessPayload, {
      expiresIn: JWT_CONFIG.ACCESS_TOKEN_EXPIRY,
    });

    const refreshToken = generateRefreshToken();
    const refreshTokenHash = hashRefreshToken(refreshToken);

    await app.redis.setex(
      `${REFRESH_TOKEN_PREFIX}${refreshTokenHash}`,
      REFRESH_TOKEN_TTL,
      JSON.stringify({ userId, serverIds: [serverId] })
    );

    return { accessToken, refreshToken, user: accessPayload };
  }

  /**
   * POST /auth/login - Initiate OAuth flow
   */
  app.post('/login', async (request, reply) => {
    const body = loginSchema.safeParse(request.body);
    if (!body.success) {
      return reply.badRequest('Invalid request body');
    }

    const { type } = body.data;

    if (type === 'plex') {
      try {
        const { pinId, authUrl } = await PlexService.initiateOAuth();
        return { pinId, authUrl };
      } catch (error) {
        app.log.error({ error }, 'Failed to initiate Plex OAuth');
        return reply.internalServerError('Failed to initiate Plex authentication');
      }
    }

    // Jellyfin - validate full schema
    const jellyfinBody = jellyfinLoginSchema.safeParse(request.body);
    if (!jellyfinBody.success) {
      return reply.badRequest('For Jellyfin: serverUrl, serverName, username, password required');
    }

    const { serverUrl, serverName, username, password } = jellyfinBody.data;

    try {
      const authResult = await JellyfinService.authenticate(serverUrl, username, password);

      if (!authResult) {
        return reply.unauthorized('Invalid Jellyfin credentials');
      }

      if (!authResult.isAdmin) {
        return reply.forbidden('Only server administrators can log in');
      }

      // Create/update server
      let server = await db
        .select()
        .from(servers)
        .where(and(eq(servers.url, serverUrl), eq(servers.type, 'jellyfin')))
        .limit(1);

      if (server.length === 0) {
        const inserted = await db
          .insert(servers)
          .values({
            name: serverName,
            type: 'jellyfin',
            url: serverUrl,
            token: encrypt(authResult.token),
          })
          .returning();
        server = inserted;
      } else {
        const existingServer = server[0]!;
        await db
          .update(servers)
          .set({ token: encrypt(authResult.token), updatedAt: new Date() })
          .where(eq(servers.id, existingServer.id));
      }

      const serverId = server[0]!.id;

      // Create/update user
      let user = await db
        .select()
        .from(users)
        .where(and(eq(users.serverId, serverId), eq(users.externalId, authResult.id)))
        .limit(1);

      if (user.length === 0) {
        const inserted = await db
          .insert(users)
          .values({
            serverId,
            externalId: authResult.id,
            username: authResult.username,
            isOwner: true,
          })
          .returning();
        user = inserted;
      } else {
        const existingUser = user[0]!;
        await db
          .update(users)
          .set({ isOwner: true, updatedAt: new Date() })
          .where(eq(users.id, existingUser.id));
      }

      const userId = user[0]!.id;

      const accessPayload: AuthUser = {
        userId,
        username: authResult.username,
        role: 'owner',
        serverIds: [serverId],
      };

      const accessToken = app.jwt.sign(accessPayload, {
        expiresIn: JWT_CONFIG.ACCESS_TOKEN_EXPIRY,
      });

      const refreshToken = generateRefreshToken();
      await app.redis.setex(
        `${REFRESH_TOKEN_PREFIX}${hashRefreshToken(refreshToken)}`,
        REFRESH_TOKEN_TTL,
        JSON.stringify({ userId, serverIds: [serverId] })
      );

      return { accessToken, refreshToken, user: accessPayload };
    } catch (error) {
      app.log.error({ error }, 'Jellyfin authentication failed');
      return reply.internalServerError('Authentication failed');
    }
  });

  /**
   * POST /auth/plex/check-pin - Check Plex PIN status and get servers
   *
   * Returns:
   * - { authorized: false } if PIN not yet claimed
   * - { authorized: true, accessToken, refreshToken, user } if returning user (auto-connect)
   * - { authorized: true, needsServerSelection: true, servers, tempToken } if new user
   */
  app.post('/plex/check-pin', async (request, reply) => {
    const body = plexCheckPinSchema.safeParse(request.body);
    if (!body.success) {
      return reply.badRequest('pinId is required');
    }

    const { pinId } = body.data;

    try {
      const authResult = await PlexService.checkOAuthPin(pinId);

      if (!authResult) {
        return { authorized: false, message: 'PIN not yet authorized' };
      }

      // Get user's servers from Plex
      const plexServers = await PlexService.getServers(authResult.token);

      if (plexServers.length === 0) {
        return reply.badRequest('No Plex Media Servers found on your account. You must own a server.');
      }

      // Check if user already has any of their servers configured in Tracearr
      const existingServers = await db.select().from(servers).where(eq(servers.type, 'plex'));

      // Find a match by checking server connections
      let matchedServer: typeof existingServers[0] | null = null;
      let matchedPlexServer: PlexServerResource | null = null;

      for (const existing of existingServers) {
        for (const plexServer of plexServers) {
          const matchingConnection = plexServer.connections.find((c) => c.uri === existing.url);
          if (matchingConnection) {
            matchedServer = existing;
            matchedPlexServer = plexServer;
            break;
          }
        }
        if (matchedServer) break;
      }

      // Returning user - auto-connect to existing server
      if (matchedServer && matchedPlexServer) {
        app.log.info({ serverId: matchedServer.id }, 'Returning Plex user, auto-connecting');

        const tokens = await completeAuth(
          authResult.id,
          authResult.username,
          authResult.email,
          authResult.thumb,
          authResult.token,
          matchedServer.url,
          matchedServer.name
        );

        return {
          authorized: true,
          ...tokens,
        };
      }

      // New user - needs to select a server
      // Store temp token in Redis for server selection step
      const tempToken = generateTempToken();
      await app.redis.setex(
        `${PLEX_TEMP_TOKEN_PREFIX}${tempToken}`,
        PLEX_TEMP_TOKEN_TTL,
        JSON.stringify({
          plexUserId: authResult.id,
          plexUsername: authResult.username,
          plexEmail: authResult.email,
          plexThumb: authResult.thumb,
          plexToken: authResult.token,
        })
      );

      // Format servers for frontend
      const formattedServers = plexServers.map((s) => ({
        name: s.name,
        platform: s.platform,
        version: s.productVersion,
        connections: s.connections.map((c) => ({
          uri: c.uri,
          local: c.local,
          address: c.address,
          port: c.port,
        })),
      }));

      return {
        authorized: true,
        needsServerSelection: true,
        servers: formattedServers,
        tempToken,
      };
    } catch (error) {
      app.log.error({ error }, 'Plex check-pin failed');
      return reply.internalServerError('Failed to check Plex authorization');
    }
  });

  /**
   * POST /auth/plex/connect - Complete Plex auth with selected server
   */
  app.post('/plex/connect', async (request, reply) => {
    const body = plexConnectSchema.safeParse(request.body);
    if (!body.success) {
      return reply.badRequest('tempToken, serverUri, and serverName are required');
    }

    const { tempToken, serverUri, serverName } = body.data;

    // Get stored Plex auth from temp token
    const stored = await app.redis.get(`${PLEX_TEMP_TOKEN_PREFIX}${tempToken}`);
    if (!stored) {
      return reply.unauthorized('Invalid or expired temp token. Please restart login.');
    }

    // Delete temp token (one-time use)
    await app.redis.del(`${PLEX_TEMP_TOKEN_PREFIX}${tempToken}`);

    const { plexUserId, plexUsername, plexEmail, plexThumb, plexToken } = JSON.parse(stored) as {
      plexUserId: string;
      plexUsername: string;
      plexEmail: string;
      plexThumb: string;
      plexToken: string;
    };

    try {
      // Verify user is admin on the selected server
      const isAdmin = await PlexService.verifyServerAdmin(plexToken, serverUri);
      if (!isAdmin) {
        return reply.forbidden('You must be an admin on the selected Plex server');
      }

      const tokens = await completeAuth(
        plexUserId,
        plexUsername,
        plexEmail,
        plexThumb,
        plexToken,
        serverUri,
        serverName
      );

      return tokens;
    } catch (error) {
      app.log.error({ error }, 'Plex connect failed');
      return reply.internalServerError('Failed to connect to Plex server');
    }
  });

  /**
   * POST /auth/callback - Legacy Plex callback (backward compatibility)
   * @deprecated Use /auth/plex/check-pin and /auth/plex/connect instead
   */
  app.post('/callback', async (request, reply) => {
    const body = plexCallbackSchema.safeParse(request.body);
    if (!body.success) {
      return reply.badRequest('Invalid request body');
    }

    const { pinId, serverUrl, serverName } = body.data;

    try {
      const authResult = await PlexService.checkOAuthPin(pinId);

      if (!authResult) {
        return { authorized: false, message: 'PIN not yet authorized' };
      }

      const isAdmin = await PlexService.verifyServerAdmin(authResult.token, serverUrl);
      if (!isAdmin) {
        return reply.forbidden('You must be an admin on the Plex server');
      }

      const tokens = await completeAuth(
        authResult.id,
        authResult.username,
        authResult.email,
        authResult.thumb,
        authResult.token,
        serverUrl,
        serverName
      );

      return { authorized: true, ...tokens };
    } catch (error) {
      app.log.error({ error }, 'Plex callback failed');
      return reply.internalServerError('Authentication failed');
    }
  });

  /**
   * POST /auth/refresh - Refresh access token
   */
  app.post('/refresh', async (request, reply) => {
    const body = refreshSchema.safeParse(request.body);
    if (!body.success) {
      return reply.badRequest('Invalid request body');
    }

    const { refreshToken } = body.data;
    const refreshTokenHash = hashRefreshToken(refreshToken);

    const stored = await app.redis.get(`${REFRESH_TOKEN_PREFIX}${refreshTokenHash}`);
    if (!stored) {
      return reply.unauthorized('Invalid or expired refresh token');
    }

    const { userId, serverIds } = JSON.parse(stored) as { userId: string; serverIds: string[] };

    const userRows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    const user = userRows[0];

    if (!user) {
      await app.redis.del(`${REFRESH_TOKEN_PREFIX}${refreshTokenHash}`);
      return reply.unauthorized('User not found');
    }

    const accessPayload: AuthUser = {
      userId,
      username: user.username,
      role: user.isOwner ? 'owner' : 'guest',
      serverIds,
    };

    const accessToken = app.jwt.sign(accessPayload, {
      expiresIn: JWT_CONFIG.ACCESS_TOKEN_EXPIRY,
    });

    // Rotate refresh token
    const newRefreshToken = generateRefreshToken();
    const newRefreshTokenHash = hashRefreshToken(newRefreshToken);

    await app.redis.del(`${REFRESH_TOKEN_PREFIX}${refreshTokenHash}`);
    await app.redis.setex(
      `${REFRESH_TOKEN_PREFIX}${newRefreshTokenHash}`,
      REFRESH_TOKEN_TTL,
      JSON.stringify({ userId, serverIds })
    );

    return { accessToken, refreshToken: newRefreshToken };
  });

  /**
   * POST /auth/logout - Revoke refresh token
   */
  app.post('/logout', { preHandler: [app.authenticate] }, async (request, reply) => {
    const body = refreshSchema.safeParse(request.body);

    if (body.success) {
      const { refreshToken } = body.data;
      await app.redis.del(`${REFRESH_TOKEN_PREFIX}${hashRefreshToken(refreshToken)}`);
    }

    reply.clearCookie('token');
    return { success: true };
  });

  /**
   * GET /auth/me - Get current user info
   */
  app.get('/me', { preHandler: [app.authenticate] }, async (request) => {
    const authUser = request.user;

    const userRows = await db
      .select()
      .from(users)
      .where(eq(users.id, authUser.userId))
      .limit(1);

    const user = userRows[0];

    if (!user) {
      return {
        ...authUser,
        trustScore: 100,
        email: null,
        thumbUrl: null,
      };
    }

    return {
      userId: user.id,
      username: user.username,
      email: user.email,
      thumbUrl: user.thumbUrl,
      role: user.isOwner ? 'owner' : 'guest',
      trustScore: user.trustScore,
      serverIds: authUser.serverIds,
    };
  });
};
