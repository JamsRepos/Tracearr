/**
 * Redis cache service for Tracearr
 * Handles caching of active sessions, dashboard stats, and other frequently accessed data
 */

import type { Redis } from 'ioredis';
import { REDIS_KEYS, CACHE_TTL } from '@tracearr/shared';
import type { ActiveSession, DashboardStats } from '@tracearr/shared';

export interface CacheService {
  // Active sessions
  getActiveSessions(): Promise<ActiveSession[] | null>;
  setActiveSessions(sessions: ActiveSession[]): Promise<void>;

  // Dashboard stats
  getDashboardStats(): Promise<DashboardStats | null>;
  setDashboardStats(stats: DashboardStats): Promise<void>;

  // Session by ID
  getSessionById(id: string): Promise<ActiveSession | null>;
  setSessionById(id: string, session: ActiveSession): Promise<void>;
  deleteSessionById(id: string): Promise<void>;

  // User sessions
  getUserSessions(userId: string): Promise<string[] | null>;
  addUserSession(userId: string, sessionId: string): Promise<void>;
  removeUserSession(userId: string, sessionId: string): Promise<void>;

  // Generic cache operations
  invalidateCache(key: string): Promise<void>;
  invalidatePattern(pattern: string): Promise<void>;

  // Health check
  ping(): Promise<boolean>;
}

export function createCacheService(redis: Redis): CacheService {
  return {
    // Active sessions
    async getActiveSessions(): Promise<ActiveSession[] | null> {
      const data = await redis.get(REDIS_KEYS.ACTIVE_SESSIONS);
      if (!data) return null;
      try {
        return JSON.parse(data) as ActiveSession[];
      } catch {
        return null;
      }
    },

    async setActiveSessions(sessions: ActiveSession[]): Promise<void> {
      await redis.setex(
        REDIS_KEYS.ACTIVE_SESSIONS,
        CACHE_TTL.ACTIVE_SESSIONS,
        JSON.stringify(sessions)
      );
    },

    // Dashboard stats
    async getDashboardStats(): Promise<DashboardStats | null> {
      const data = await redis.get(REDIS_KEYS.DASHBOARD_STATS);
      if (!data) return null;
      try {
        return JSON.parse(data) as DashboardStats;
      } catch {
        return null;
      }
    },

    async setDashboardStats(stats: DashboardStats): Promise<void> {
      await redis.setex(
        REDIS_KEYS.DASHBOARD_STATS,
        CACHE_TTL.DASHBOARD_STATS,
        JSON.stringify(stats)
      );
    },

    // Session by ID
    async getSessionById(id: string): Promise<ActiveSession | null> {
      const data = await redis.get(REDIS_KEYS.SESSION_BY_ID(id));
      if (!data) return null;
      try {
        return JSON.parse(data) as ActiveSession;
      } catch {
        return null;
      }
    },

    async setSessionById(id: string, session: ActiveSession): Promise<void> {
      await redis.setex(
        REDIS_KEYS.SESSION_BY_ID(id),
        CACHE_TTL.ACTIVE_SESSIONS,
        JSON.stringify(session)
      );
    },

    async deleteSessionById(id: string): Promise<void> {
      await redis.del(REDIS_KEYS.SESSION_BY_ID(id));
    },

    // User sessions (set of session IDs for a user)
    async getUserSessions(userId: string): Promise<string[] | null> {
      const data = await redis.smembers(REDIS_KEYS.USER_SESSIONS(userId));
      if (!data || data.length === 0) return null;
      return data;
    },

    async addUserSession(userId: string, sessionId: string): Promise<void> {
      const key = REDIS_KEYS.USER_SESSIONS(userId);
      await redis.sadd(key, sessionId);
      await redis.expire(key, CACHE_TTL.USER_SESSIONS);
    },

    async removeUserSession(userId: string, sessionId: string): Promise<void> {
      await redis.srem(REDIS_KEYS.USER_SESSIONS(userId), sessionId);
    },

    // Generic cache operations
    async invalidateCache(key: string): Promise<void> {
      await redis.del(key);
    },

    async invalidatePattern(pattern: string): Promise<void> {
      const keys = await redis.keys(pattern);
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    },

    // Health check
    async ping(): Promise<boolean> {
      try {
        const result = await redis.ping();
        return result === 'PONG';
      } catch {
        return false;
      }
    },
  };
}

// Pub/Sub helper functions for real-time events
export interface PubSubService {
  publish(event: string, data: unknown): Promise<void>;
  subscribe(channel: string, callback: (message: string) => void): Promise<void>;
  unsubscribe(channel: string): Promise<void>;
}

// Module-level storage for pubsub service instance
let pubSubServiceInstance: PubSubService | null = null;

/**
 * Get the global PubSub service instance
 * Must be called after createPubSubService has been called
 */
export function getPubSubService(): PubSubService | null {
  return pubSubServiceInstance;
}

export function createPubSubService(
  publisher: Redis,
  subscriber: Redis
): PubSubService {
  const callbacks = new Map<string, (message: string) => void>();

  subscriber.on('message', (channel: string, message: string) => {
    const callback = callbacks.get(channel);
    if (callback) {
      callback(message);
    }
  });

  const service: PubSubService = {
    async publish(event: string, data: unknown): Promise<void> {
      await publisher.publish(
        REDIS_KEYS.PUBSUB_EVENTS,
        JSON.stringify({ event, data, timestamp: Date.now() })
      );
    },

    async subscribe(
      channel: string,
      callback: (message: string) => void
    ): Promise<void> {
      callbacks.set(channel, callback);
      await subscriber.subscribe(channel);
    },

    async unsubscribe(channel: string): Promise<void> {
      callbacks.delete(channel);
      await subscriber.unsubscribe(channel);
    },
  };

  // Store instance for global access
  pubSubServiceInstance = service;

  return service;
}
