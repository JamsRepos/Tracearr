/**
 * Authentication routes - Local accounts, Plex OAuth, and server connections
 *
 * Auth Flow Options:
 * 1. Local signup: POST /auth/signup → Create account with username/password
 * 2. Local login: POST /auth/login (type=local) → Login with username/password
 * 3. Plex OAuth: POST /auth/login (type=plex) → Login/signup with Plex
 *
 * Server Connection (separate from auth):
 * - POST /auth/plex/connect → Connect a Plex server after login
 * - POST /auth/jellyfin/connect → Connect a Jellyfin server after login
 */

import type { FastifyPluginAsync } from 'fastify';
import { createHash, randomBytes } from 'crypto';
import { eq, and, isNotNull } from 'drizzle-orm';
import { z } from 'zod';
import { JWT_CONFIG, type AuthUser } from '@tracearr/shared';
import { db } from '../db/client.js';
import { servers, users } from '../db/schema.js';
import { PlexService } from '../services/plex.js';
import { JellyfinService } from '../services/jellyfin.js';
import { encrypt } from '../utils/crypto.js';
import { hashPassword, verifyPassword } from '../utils/password.js';

// Redis key prefixes
const REFRESH_TOKEN_PREFIX = 'tracearr:refresh:';
const PLEX_TEMP_TOKEN_PREFIX = 'tracearr:plex_temp:';
const REFRESH_TOKEN_TTL = 30 * 24 * 60 * 60; // 30 days
const PLEX_TEMP_TOKEN_TTL = 10 * 60; // 10 minutes for server selection

// Schemas
const signupSchema = z.object({
  username: z.string().min(3).max(50),
  password: z.string().min(8).max(100),
  email: z.string().email().optional(),
});

const localLoginSchema = z.object({
  type: z.literal('local'),
  username: z.string().min(1),
  password: z.string().min(1),
});

const plexLoginSchema = z.object({
  type: z.literal('plex'),
});

const loginSchema = z.discriminatedUnion('type', [localLoginSchema, plexLoginSchema]);

const plexCheckPinSchema = z.object({
  pinId: z.string(),
});

const plexConnectSchema = z.object({
  tempToken: z.string(),
  serverUri: z.string().url(),
  serverName: z.string().min(1).max(100),
});

const jellyfinConnectSchema = z.object({
  serverUrl: z.string().url(),
  serverName: z.string().min(1).max(100),
  username: z.string().min(1),
  password: z.string().min(1),
});

const refreshSchema = z.object({
  refreshToken: z.string(),
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
   * Get all server IDs for owner tokens
   */
  async function getAllServerIds(): Promise<string[]> {
    const allServers = await db.select({ id: servers.id }).from(servers);
    return allServers.map((s) => s.id);
  }

  /**
   * Generate tokens for a user
   */
  async function generateTokens(
    userId: string,
    username: string,
    isOwner: boolean
  ) {
    // Owners get access to ALL servers
    const serverIds = isOwner ? await getAllServerIds() : [];

    const accessPayload: AuthUser = {
      userId,
      username,
      role: isOwner ? 'owner' : 'guest',
      serverIds,
    };

    const accessToken = app.jwt.sign(accessPayload, {
      expiresIn: JWT_CONFIG.ACCESS_TOKEN_EXPIRY,
    });

    const refreshToken = generateRefreshToken();
    const refreshTokenHash = hashRefreshToken(refreshToken);

    await app.redis.setex(
      `${REFRESH_TOKEN_PREFIX}${refreshTokenHash}`,
      REFRESH_TOKEN_TTL,
      JSON.stringify({ userId, serverIds })
    );

    return { accessToken, refreshToken, user: accessPayload };
  }

  /**
   * POST /auth/signup - Create a local account
   */
  app.post('/signup', async (request, reply) => {
    const body = signupSchema.safeParse(request.body);
    if (!body.success) {
      return reply.badRequest('Invalid signup data: username (3-50 chars), password (8+ chars) required');
    }

    const { username, password, email } = body.data;

    // Check if username already exists
    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, username))
      .limit(1);

    if (existing.length > 0) {
      return reply.conflict('Username already taken');
    }

    // Check if this is the first user (will be owner)
    const anyOwner = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.isOwner, true))
      .limit(1);

    const isFirstUser = anyOwner.length === 0;

    // Create user with password hash
    const passwordHashValue = await hashPassword(password);

    const [newUser] = await db
      .insert(users)
      .values({
        username,
        email: email ?? null,
        passwordHash: passwordHashValue,
        isOwner: isFirstUser, // First user is always owner
        // serverId and externalId are null for local accounts
      })
      .returning();

    if (!newUser) {
      return reply.internalServerError('Failed to create user');
    }

    app.log.info({ userId: newUser.id, isOwner: isFirstUser }, 'Local account created');

    return generateTokens(newUser.id, newUser.username, newUser.isOwner);
  });

  /**
   * POST /auth/login - Login with local credentials or initiate Plex OAuth
   */
  app.post('/login', async (request, reply) => {
    const body = loginSchema.safeParse(request.body);
    if (!body.success) {
      return reply.badRequest('Invalid login request');
    }

    const { type } = body.data;

    if (type === 'local') {
      const { username, password } = body.data;

      // Find user by username with password hash
      const userRows = await db
        .select()
        .from(users)
        .where(and(eq(users.username, username), isNotNull(users.passwordHash)))
        .limit(1);

      const user = userRows[0];
      if (!user?.passwordHash) {
        return reply.unauthorized('Invalid username or password');
      }

      // Verify password
      const valid = await verifyPassword(password, user.passwordHash);
      if (!valid) {
        return reply.unauthorized('Invalid username or password');
      }

      app.log.info({ userId: user.id }, 'Local login successful');

      return generateTokens(user.id, user.username, user.isOwner);
    }

    // Plex OAuth - initiate flow
    try {
      const { pinId, authUrl } = await PlexService.initiateOAuth();
      return { pinId, authUrl };
    } catch (error) {
      app.log.error({ error }, 'Failed to initiate Plex OAuth');
      return reply.internalServerError('Failed to initiate Plex authentication');
    }
  });

  /**
   * POST /auth/plex/check-pin - Check Plex PIN status
   *
   * Returns:
   * - { authorized: false } if PIN not yet claimed
   * - { authorized: true, accessToken, refreshToken, user } if user found by plexAccountId
   * - { authorized: true, needsServerSelection: true, servers, tempToken } if new Plex user
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

      // Check if user exists by Plex account ID (global Plex.tv ID)
      let existingUser = await db
        .select()
        .from(users)
        .where(eq(users.plexAccountId, authResult.id))
        .limit(1);

      // Fallback: Check by external_id (server-synced users may have Plex ID there)
      if (existingUser.length === 0) {
        existingUser = await db
          .select()
          .from(users)
          .where(eq(users.externalId, authResult.id))
          .limit(1);
      }

      if (existingUser.length > 0) {
        // Returning Plex user - update their info and link plex_account_id
        const user = existingUser[0]!;

        await db
          .update(users)
          .set({
            username: authResult.username,
            email: authResult.email,
            thumbUrl: authResult.thumb,
            plexAccountId: authResult.id, // Link the Plex account ID
            updatedAt: new Date(),
          })
          .where(eq(users.id, user.id));

        app.log.info({ userId: user.id }, 'Returning Plex user login');

        return {
          authorized: true,
          ...(await generateTokens(user.id, authResult.username, user.isOwner)),
        };
      }

      // New Plex user - check if they own any servers
      const plexServers = await PlexService.getServers(authResult.token);

      // Check if this is the first owner
      const anyOwner = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.isOwner, true))
        .limit(1);

      const isFirstUser = anyOwner.length === 0;

      // Store temp token for completing registration
      const tempToken = generateTempToken();
      await app.redis.setex(
        `${PLEX_TEMP_TOKEN_PREFIX}${tempToken}`,
        PLEX_TEMP_TOKEN_TTL,
        JSON.stringify({
          plexAccountId: authResult.id,
          plexUsername: authResult.username,
          plexEmail: authResult.email,
          plexThumb: authResult.thumb,
          plexToken: authResult.token,
          isFirstUser,
        })
      );

      // If they have servers, let them select one to connect
      if (plexServers.length > 0) {
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
      }

      // No servers - create account without server connection
      const [newUser] = await db
        .insert(users)
        .values({
          username: authResult.username,
          email: authResult.email,
          thumbUrl: authResult.thumb,
          plexAccountId: authResult.id,
          isOwner: isFirstUser,
        })
        .returning();

      if (!newUser) {
        return reply.internalServerError('Failed to create user');
      }

      // Clean up temp token
      await app.redis.del(`${PLEX_TEMP_TOKEN_PREFIX}${tempToken}`);

      app.log.info({ userId: newUser.id, isOwner: isFirstUser }, 'New Plex user created (no servers)');

      return {
        authorized: true,
        ...(await generateTokens(newUser.id, newUser.username, newUser.isOwner)),
      };
    } catch (error) {
      app.log.error({ error }, 'Plex check-pin failed');
      return reply.internalServerError('Failed to check Plex authorization');
    }
  });

  /**
   * POST /auth/plex/connect - Complete Plex signup and connect a server
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

    const { plexAccountId, plexUsername, plexEmail, plexThumb, plexToken, isFirstUser } = JSON.parse(
      stored
    ) as {
      plexAccountId: string;
      plexUsername: string;
      plexEmail: string;
      plexThumb: string;
      plexToken: string;
      isFirstUser: boolean;
    };

    try {
      // Verify user is admin on the selected server
      const isAdmin = await PlexService.verifyServerAdmin(plexToken, serverUri);
      if (!isAdmin) {
        return reply.forbidden('You must be an admin on the selected Plex server');
      }

      // Create or update server
      let server = await db
        .select()
        .from(servers)
        .where(and(eq(servers.url, serverUri), eq(servers.type, 'plex')))
        .limit(1);

      if (server.length === 0) {
        const inserted = await db
          .insert(servers)
          .values({
            name: serverName,
            type: 'plex',
            url: serverUri,
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

      // Create user with Plex account ID
      const [newUser] = await db
        .insert(users)
        .values({
          serverId,
          username: plexUsername,
          email: plexEmail,
          thumbUrl: plexThumb,
          plexAccountId: plexAccountId,
          isOwner: isFirstUser,
        })
        .returning();

      if (!newUser) {
        return reply.internalServerError('Failed to create user');
      }

      app.log.info({ userId: newUser.id, serverId, isOwner: isFirstUser }, 'New Plex user with server created');

      return generateTokens(newUser.id, newUser.username, newUser.isOwner);
    } catch (error) {
      app.log.error({ error }, 'Plex connect failed');
      return reply.internalServerError('Failed to connect to Plex server');
    }
  });

  /**
   * POST /auth/jellyfin/connect - Connect a Jellyfin server (requires authentication)
   */
  app.post(
    '/jellyfin/connect',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const body = jellyfinConnectSchema.safeParse(request.body);
      if (!body.success) {
        return reply.badRequest('serverUrl, serverName, username, and password are required');
      }

      const authUser = request.user;

      // Only owners can add servers
      if (authUser.role !== 'owner') {
        return reply.forbidden('Only owners can add servers');
      }

      const { serverUrl, serverName, username, password } = body.data;

      try {
        const authResult = await JellyfinService.authenticate(serverUrl, username, password);

        if (!authResult) {
          return reply.unauthorized('Invalid Jellyfin credentials');
        }

        if (!authResult.isAdmin) {
          return reply.forbidden('You must be an administrator on the Jellyfin server');
        }

        // Create or update server
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
            .set({
              name: serverName,
              token: encrypt(authResult.token),
              updatedAt: new Date(),
            })
            .where(eq(servers.id, existingServer.id));
        }

        const serverId = server[0]!.id;

        app.log.info({ userId: authUser.userId, serverId }, 'Jellyfin server connected');

        // Return updated tokens with new server access
        return generateTokens(authUser.userId, authUser.username, true);
      } catch (error) {
        app.log.error({ error }, 'Jellyfin connect failed');
        return reply.internalServerError('Failed to connect Jellyfin server');
      }
    }
  );

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

    const { userId } = JSON.parse(stored) as { userId: string; serverIds: string[] };

    const userRows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    const user = userRows[0];

    if (!user) {
      await app.redis.del(`${REFRESH_TOKEN_PREFIX}${refreshTokenHash}`);
      return reply.unauthorized('User not found');
    }

    // Get fresh server IDs (in case servers were added/removed)
    const serverIds = user.isOwner ? await getAllServerIds() : [];

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
      // User in JWT doesn't exist in database - token is invalid
      throw app.httpErrors.unauthorized('User no longer exists');
    }

    // Get fresh server IDs
    const serverIds = user.isOwner ? await getAllServerIds() : [];

    return {
      userId: user.id,
      username: user.username,
      email: user.email,
      thumbUrl: user.thumbUrl,
      role: user.isOwner ? 'owner' : 'guest',
      trustScore: user.trustScore,
      serverIds,
      hasPassword: !!user.passwordHash,
      hasPlexLinked: !!user.plexAccountId,
    };
  });
};
