/**
 * Library Statistics Service Tests
 *
 * Tests for the libraryStats module that fetches and aggregates library statistics.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

// Mock dependencies
vi.mock('../../db/client.js', () => ({
  db: {
    query: {
      servers: {
        findFirst: vi.fn(),
        findMany: vi.fn(),
      },
      libraryStatistics: {
        findMany: vi.fn(),
      },
      librarySnapshots: {
        findMany: vi.fn(),
      },
    },
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('../mediaServer/index.js', () => ({
  createMediaServerClient: vi.fn(),
}));

vi.mock('../../utils/http.js', () => ({
  fetchJson: vi.fn(),
  plexHeaders: {},
}));

// Import after mocking
import { db } from '../../db/client.js';
import { createMediaServerClient } from '../mediaServer/index.js';
import { fetchJson } from '../../utils/http.js';
import {
  updateServerLibraryStats,
  createDailySnapshot,
  updateAllLibraryStats,
  getLibraryStatistics,
} from '../libraryStats.js';
import { libraryStatistics } from '../../db/schema.js';

// Helper to create mock server
function createMockServer(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    type: 'plex' as const,
    url: 'http://test.com',
    token: 'test-token',
    name: 'Test Server',
    machineIdentifier: null,
    plexAccountId: null,
    displayOrder: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// Helper to create mock library statistics
function createMockLibraryStats(overrides: Record<string, unknown> = {}) {
  const serverId = randomUUID();
  return {
    id: randomUUID(),
    serverId,
    libraryId: 'lib-1',
    libraryName: 'Movies',
    libraryType: 'movie',
    totalItems: 100,
    totalEpisodes: null,
    totalSeasons: null,
    totalShows: null,
    totalSizeBytes: 1000000000,
    totalDurationMs: 3600000,
    avgFileSizeBytes: 10000000,
    avgDurationMs: 36000,
    avgBitrateKbps: 5000,
    hdrItemCount: 20,
    lastUpdatedAt: new Date(),
    createdAt: new Date(),
    ...overrides,
  };
}

// Helper to setup insert chain mock
function mockInsertChain(result: unknown[] = []) {
  const chain = {
    values: vi.fn().mockReturnThis(),
    onConflictDoUpdate: vi.fn().mockResolvedValue(result),
    onConflictDoNothing: vi.fn().mockResolvedValue(result),
  };
  vi.mocked(db.insert).mockReturnValue(chain as never);
  return chain;
}

// Helper to setup update chain mock
function mockUpdateChain(result: unknown[] = []) {
  const chain = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(result),
  };
  vi.mocked(db.update).mockReturnValue(chain as never);
  return chain;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Library Statistics Service', () => {
  describe('updateServerLibraryStats', () => {
    it('should return early if server not found', async () => {
      vi.mocked(db.query.servers.findFirst).mockResolvedValue(undefined);

      await updateServerLibraryStats('non-existent-id');

      expect(createMediaServerClient).not.toHaveBeenCalled();
    });

    it('should return early if getLibraries fails', async () => {
      const mockServer = createMockServer();

      vi.mocked(db.query.servers.findFirst).mockResolvedValue(mockServer);
      const mockClient = {
        getLibraries: vi.fn().mockRejectedValue(new Error('API Error')),
      };
      vi.mocked(createMediaServerClient).mockReturnValue(mockClient as never);

      await updateServerLibraryStats(mockServer.id);

      expect(mockClient.getLibraries).toHaveBeenCalled();
    });

    it('should filter out collections for Jellyfin', async () => {
      const mockServer = createMockServer({ type: 'jellyfin' });

      const mockLibraries = [
        { id: 'lib-1', name: 'Movies', type: 'movie' },
        { id: 'lib-2', name: 'Collections', type: 'boxsets' },
        { id: 'lib-3', name: 'Shows', type: 'tvshows' },
      ];

      vi.mocked(db.query.servers.findFirst).mockResolvedValue(mockServer);
      const mockClient = {
        getLibraries: vi.fn().mockResolvedValue(mockLibraries),
      };
      vi.mocked(createMediaServerClient).mockReturnValue(mockClient as never);

      // Mock fetchJson for getJellyfinLibraryCount
      vi.mocked(fetchJson).mockResolvedValue({ TotalRecordCount: 100 });

      const insertChain = mockInsertChain();
      mockUpdateChain();

      await updateServerLibraryStats(mockServer.id);

      // Should process 2 libraries (Movies and Shows, not Collections)
      expect(insertChain.values).toHaveBeenCalled();
    });
  });

  describe('createDailySnapshot', () => {
    it('should create snapshots for all libraries', async () => {
      const serverId = randomUUID();
      const mockStats = [
        createMockLibraryStats({
          serverId,
          libraryId: 'lib-1',
          libraryName: 'Movies',
          libraryType: 'movie',
        }),
        createMockLibraryStats({
          serverId,
          libraryId: 'lib-2',
          libraryName: 'Shows',
          libraryType: 'tvshows',
          totalItems: 50,
          totalSizeBytes: 500000000,
          totalDurationMs: 1800000,
        }),
      ];

      vi.mocked(db.query.libraryStatistics.findMany).mockResolvedValue(mockStats);

      const insertChain = mockInsertChain();

      await createDailySnapshot(serverId);

      expect(db.query.libraryStatistics.findMany).toHaveBeenCalledWith({
        where: eq(libraryStatistics.serverId, serverId),
      });
      expect(insertChain.values).toHaveBeenCalledTimes(2);
    });

    it('should handle errors gracefully', async () => {
      const serverId = randomUUID();
      const mockStats = [createMockLibraryStats({ serverId })];

      vi.mocked(db.query.libraryStatistics.findMany).mockResolvedValue(mockStats);

      const insertChain = {
        values: vi.fn().mockReturnThis(),
        onConflictDoNothing: vi.fn().mockRejectedValue(new Error('DB Error')),
      };
      vi.mocked(db.insert).mockReturnValue(insertChain as never);

      // Should not throw
      await expect(createDailySnapshot(serverId)).resolves.not.toThrow();
    });
  });

  describe('updateAllLibraryStats', () => {
    it('should update stats for all servers', async () => {
      const mockServers = [
        createMockServer({ id: randomUUID(), name: 'Server 1' }),
        createMockServer({ id: randomUUID(), type: 'jellyfin', name: 'Server 2' }),
      ];

      vi.mocked(db.query.servers.findMany).mockResolvedValue(mockServers);
      vi.mocked(db.query.servers.findFirst).mockResolvedValue(mockServers[0]);
      const mockClient = {
        getLibraries: vi.fn().mockResolvedValue([]),
      };
      vi.mocked(createMediaServerClient).mockReturnValue(mockClient as never);

      mockInsertChain();
      mockUpdateChain();

      await updateAllLibraryStats();

      expect(db.query.servers.findMany).toHaveBeenCalled();
    });
  });

  describe('getLibraryStatistics', () => {
    it('should return empty stats when no data exists', async () => {
      vi.mocked(db.query.libraryStatistics.findMany).mockResolvedValue([]);
      vi.mocked(db.query.librarySnapshots.findMany).mockResolvedValue([]);

      const result = await getLibraryStatistics();

      expect(result.current.libraries).toEqual([]);
      expect(result.current.totalSize).toBe(0);
      expect(result.current.totalItems).toBe(0);
      expect(result.current.totalHours).toBe(0);
      expect(result.historical).toEqual([]);
    });

    it('should aggregate library statistics correctly', async () => {
      const serverId = randomUUID();
      const mockStats = [
        createMockLibraryStats({ serverId, libraryId: 'lib-1' }),
        createMockLibraryStats({
          serverId,
          libraryId: 'lib-2',
          libraryName: 'Shows',
          libraryType: 'tvshows',
          totalItems: 50,
          totalEpisodes: 500,
          totalSeasons: 25,
          totalShows: 10,
          totalSizeBytes: 500000000,
          totalDurationMs: 1800000,
        }),
      ];

      vi.mocked(db.query.libraryStatistics.findMany).mockResolvedValue(mockStats);
      vi.mocked(db.query.librarySnapshots.findMany).mockResolvedValue([]);

      const result = await getLibraryStatistics();

      expect(result.current.libraries).toHaveLength(2);
      expect(result.current.totalSize).toBe(1500000000);
      expect(result.current.totalItems).toBe(150);
      expect(result.current.totalHours).toBeCloseTo(1.5, 1); // 5400000ms / 3600000
    });

    it('should filter by serverId when provided', async () => {
      const serverId = randomUUID();
      const mockStats = [createMockLibraryStats({ serverId })];

      vi.mocked(db.query.libraryStatistics.findMany).mockResolvedValue(mockStats);
      vi.mocked(db.query.librarySnapshots.findMany).mockResolvedValue([]);

      await getLibraryStatistics(serverId);

      expect(db.query.libraryStatistics.findMany).toHaveBeenCalledWith({
        where: eq(libraryStatistics.serverId, serverId),
        with: {
          server: true,
        },
      });
    });

    it('should include historical data', async () => {
      const serverId = randomUUID();
      const mockStats = [createMockLibraryStats({ serverId })];

      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);

      const mockSnapshots = [
        {
          id: randomUUID(),
          serverId,
          libraryId: 'lib-1',
          libraryName: 'Movies',
          libraryType: 'movie',
          snapshotDate: yesterday,
          totalItems: 95,
          totalSizeBytes: 950000000,
          totalDurationMs: 3420000,
          createdAt: yesterday,
        },
        {
          id: randomUUID(),
          serverId,
          libraryId: 'lib-1',
          libraryName: 'Movies',
          libraryType: 'movie',
          snapshotDate: today,
          totalItems: 100,
          totalSizeBytes: 1000000000,
          totalDurationMs: 3600000,
          createdAt: today,
        },
      ];

      vi.mocked(db.query.libraryStatistics.findMany).mockResolvedValue(mockStats);
      vi.mocked(db.query.librarySnapshots.findMany).mockResolvedValue(mockSnapshots);

      const result = await getLibraryStatistics();

      expect(result.historical.length).toBeGreaterThan(0);
    });
  });
});
