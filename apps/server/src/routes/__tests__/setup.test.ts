/**
 * Setup routes unit tests
 *
 * Tests the API endpoint for checking Tracearr configuration status:
 * - GET /status - Check if setup is needed
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';

// Mock the database module before importing routes
vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(),
  },
}));

// Import the mocked db and the routes
import { db } from '../../db/client.js';
import { setupRoutes } from '../setup.js';

/**
 * Helper to mock db.select with multiple chained calls
 * Setup route uses Promise.all with 5 parallel queries:
 * 1. All servers
 * 2. Jellyfin servers (where type = 'jellyfin')
 * 3. Plex servers (where type = 'plex')
 * 4. Owners (where role = 'owner')
 * 5. Password users (where passwordHash is not null)
 * Plus a 6th query for settings (primaryAuthMethod, enabledLoginMethods)
 */
function mockDbSelectMultiple(results: unknown[][]) {
  let callIndex = 0;
  const createChain = () => ({
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockImplementation(() => {
      return Promise.resolve(results[callIndex++] || []);
    }),
  });

  vi.mocked(db.select).mockImplementation(() => createChain() as never);
}

/**
 * Build a test Fastify instance
 * Note: Setup routes are public (no auth required)
 */
async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  // Register sensible for HTTP error helpers
  await app.register(sensible);

  // Register routes
  await app.register(setupRoutes, { prefix: '/setup' });

  return app;
}

describe('Setup Routes', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  describe('GET /setup/status', () => {
    it('returns needsSetup true when no owners exist', async () => {
      app = await buildTestApp();

      // Mock: servers exist, no jellyfin servers, no plex servers, no owners, no password users
      mockDbSelectMultiple([
        [{ id: 'server-1' }], // servers query
        [], // jellyfin servers query
        [], // plex servers query
        [], // owners query (empty = needs setup)
        [], // password users query
        [], // settings (no row = defaults)
      ]);

      const response = await app.inject({
        method: 'GET',
        url: '/setup/status',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toEqual({
        needsSetup: true,
        hasServers: true,
        hasJellyfinServers: false,
        hasPlexServers: false,
        hasPasswordAuth: false,
        primaryAuthMethod: 'local',
        enabledLoginMethods: null,
      });
    });

    it('returns needsSetup false when owner exists', async () => {
      app = await buildTestApp();

      // Mock: servers exist, jellyfin servers exist, no plex, owner exists, password user exists
      mockDbSelectMultiple([
        [{ id: 'server-1' }], // servers query
        [{ id: 'server-1' }], // jellyfin servers query
        [], // plex servers query
        [{ id: 'user-1' }], // owners query (has owner)
        [{ id: 'user-1' }], // password users query
        [{ primaryAuthMethod: 'local', enabledLoginMethods: null }], // settings
      ]);

      const response = await app.inject({
        method: 'GET',
        url: '/setup/status',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toEqual({
        needsSetup: false,
        hasServers: true,
        hasJellyfinServers: true,
        hasPlexServers: false,
        hasPasswordAuth: true,
        primaryAuthMethod: 'local',
        enabledLoginMethods: null,
      });
    });

    it('returns hasServers false when no servers configured', async () => {
      app = await buildTestApp();

      // Mock: no servers, no jellyfin servers, no plex, no owners, no password users
      mockDbSelectMultiple([
        [], // servers query (empty)
        [], // jellyfin servers query
        [], // plex servers query
        [], // owners query
        [], // password users query
        [], // settings
      ]);

      const response = await app.inject({
        method: 'GET',
        url: '/setup/status',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toEqual({
        needsSetup: true,
        hasServers: false,
        hasJellyfinServers: false,
        hasPlexServers: false,
        hasPasswordAuth: false,
        primaryAuthMethod: 'local',
        enabledLoginMethods: null,
      });
    });

    it('returns hasPasswordAuth true when user has password set', async () => {
      app = await buildTestApp();

      // Mock: no servers, no jellyfin, no plex, owner exists, password user exists
      mockDbSelectMultiple([
        [], // servers query
        [], // jellyfin servers query
        [], // plex servers query
        [{ id: 'user-1' }], // owners query
        [{ id: 'user-1' }], // password users query (has password)
        [], // settings
      ]);

      const response = await app.inject({
        method: 'GET',
        url: '/setup/status',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toEqual({
        needsSetup: false,
        hasServers: false,
        hasJellyfinServers: false,
        hasPlexServers: false,
        hasPasswordAuth: true,
        primaryAuthMethod: 'local',
        enabledLoginMethods: null,
      });
    });

    it('returns hasPasswordAuth false when no users have passwords', async () => {
      app = await buildTestApp();

      // Mock: servers exist, jellyfin servers exist, no plex, owner exists, no password users
      mockDbSelectMultiple([
        [{ id: 'server-1' }], // servers query
        [{ id: 'server-1' }], // jellyfin servers query
        [], // plex servers query
        [{ id: 'user-1' }], // owners query
        [], // password users query (empty)
        [], // settings
      ]);

      const response = await app.inject({
        method: 'GET',
        url: '/setup/status',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toEqual({
        needsSetup: false,
        hasServers: true,
        hasJellyfinServers: true,
        hasPlexServers: false,
        hasPasswordAuth: false,
        primaryAuthMethod: 'local',
        enabledLoginMethods: null,
      });
    });

    it('handles fresh installation state correctly', async () => {
      app = await buildTestApp();

      // Mock: completely empty database
      mockDbSelectMultiple([
        [], // no servers
        [], // no jellyfin servers
        [], // no plex servers
        [], // no owners
        [], // no password users
        [], // settings
      ]);

      const response = await app.inject({
        method: 'GET',
        url: '/setup/status',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toEqual({
        needsSetup: true,
        hasServers: false,
        hasJellyfinServers: false,
        hasPlexServers: false,
        hasPasswordAuth: false,
        primaryAuthMethod: 'local',
        enabledLoginMethods: null,
      });
    });

    it('handles fully configured state correctly', async () => {
      app = await buildTestApp();

      // Mock: fully configured installation
      mockDbSelectMultiple([
        [{ id: 'server-1' }, { id: 'server-2' }], // multiple servers
        [{ id: 'server-1' }], // jellyfin servers
        [{ id: 'server-2' }], // plex servers
        [{ id: 'owner-1' }], // owner exists
        [{ id: 'owner-1' }, { id: 'user-2' }], // multiple password users
        [{ primaryAuthMethod: 'local', enabledLoginMethods: ['plex', 'jellyfin', 'local'] }], // settings
      ]);

      const response = await app.inject({
        method: 'GET',
        url: '/setup/status',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toEqual({
        needsSetup: false,
        hasServers: true,
        hasJellyfinServers: true,
        hasPlexServers: true,
        hasPasswordAuth: true,
        primaryAuthMethod: 'jellyfin', // derived from order: first jellyfin or local in enabledLoginMethods
        enabledLoginMethods: ['plex', 'jellyfin', 'local'],
      });
    });
  });
});
