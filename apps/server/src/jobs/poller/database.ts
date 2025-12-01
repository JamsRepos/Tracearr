/**
 * Poller Database Operations
 *
 * Database query functions used by the poller.
 * Includes batch loading for performance optimization and rule fetching.
 */

import { eq, and, desc, gte, inArray } from 'drizzle-orm';
import { TIME_MS, SESSION_LIMITS, type Session, type Rule, type RuleParams } from '@tracearr/shared';
import { db } from '../../db/client.js';
import { sessions, rules } from '../../db/schema.js';
import { mapSessionRow } from './sessionMapper.js';

// ============================================================================
// Session Batch Loading
// ============================================================================

/**
 * Batch load recent sessions for multiple users (eliminates N+1 in polling loop)
 *
 * This function fetches sessions from the last N hours for a batch of users
 * in a single query, avoiding the performance penalty of querying per-user.
 *
 * @param userIds - Array of user IDs to load sessions for
 * @param hours - Number of hours to look back (default: 24)
 * @returns Map of userId -> Session[] for each user
 *
 * @example
 * const sessionMap = await batchGetRecentUserSessions(['user-1', 'user-2', 'user-3']);
 * const user1Sessions = sessionMap.get('user-1') ?? [];
 */
export async function batchGetRecentUserSessions(
  userIds: string[],
  hours = 24
): Promise<Map<string, Session[]>> {
  if (userIds.length === 0) return new Map();

  const since = new Date(Date.now() - hours * TIME_MS.HOUR);
  const result = new Map<string, Session[]>();

  // Initialize empty arrays for all users
  for (const userId of userIds) {
    result.set(userId, []);
  }

  // Single query to get recent sessions for all users using inArray
  const recentSessions = await db
    .select()
    .from(sessions)
    .where(and(
      inArray(sessions.userId, userIds),
      gte(sessions.startedAt, since)
    ))
    .orderBy(desc(sessions.startedAt));

  // Group by user (limit per user to prevent memory issues)
  for (const s of recentSessions) {
    const userSessions = result.get(s.userId) ?? [];
    if (userSessions.length < SESSION_LIMITS.MAX_RECENT_PER_USER) {
      userSessions.push(mapSessionRow(s));
    }
    result.set(s.userId, userSessions);
  }

  return result;
}

// ============================================================================
// Rule Loading
// ============================================================================

/**
 * Get all active rules for evaluation
 *
 * @returns Array of active Rule objects
 *
 * @example
 * const rules = await getActiveRules();
 * // Evaluate each session against these rules
 */
export async function getActiveRules(): Promise<Rule[]> {
  const activeRules = await db.select().from(rules).where(eq(rules.isActive, true));

  return activeRules.map((r) => ({
    id: r.id,
    name: r.name,
    type: r.type,
    params: r.params as unknown as RuleParams,
    userId: r.userId,
    isActive: r.isActive,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}
