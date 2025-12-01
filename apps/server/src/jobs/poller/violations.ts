/**
 * Violation Handling
 *
 * Functions for creating violations, calculating trust score penalties,
 * and determining rule applicability.
 */

import { eq, sql } from 'drizzle-orm';
import type { Rule, ViolationSeverity, ViolationWithDetails, WS_EVENTS } from '@tracearr/shared';
import { WS_EVENTS as WS_EVENTS_CONST } from '@tracearr/shared';
import { db } from '../../db/client.js';
import { users, violations } from '../../db/schema.js';
import type { RuleEvaluationResult } from '../../services/rules.js';
import type { PubSubService } from '../../services/cache.js';

// ============================================================================
// Trust Score Calculation
// ============================================================================

/**
 * Calculate trust score penalty based on violation severity.
 *
 * @param severity - Violation severity level
 * @returns Trust score penalty (negative value to subtract)
 *
 * @example
 * getTrustScorePenalty('high');    // 20
 * getTrustScorePenalty('warning'); // 10
 * getTrustScorePenalty('low');     // 5
 */
export function getTrustScorePenalty(severity: ViolationSeverity): number {
  return severity === 'high' ? 20 : severity === 'warning' ? 10 : 5;
}

// ============================================================================
// Rule Applicability
// ============================================================================

/**
 * Check if a rule applies to a specific user.
 *
 * Global rules (userId=null) apply to all users.
 * User-specific rules only apply to that user.
 *
 * @param rule - Rule to check
 * @param userId - User ID to check against
 * @returns true if the rule applies to this user
 *
 * @example
 * doesRuleApplyToUser({ userId: null }, 'user-123');       // true (global rule)
 * doesRuleApplyToUser({ userId: 'user-123' }, 'user-123'); // true (user-specific)
 * doesRuleApplyToUser({ userId: 'user-456' }, 'user-123'); // false (different user)
 */
export function doesRuleApplyToUser(
  rule: { userId: string | null },
  userId: string
): boolean {
  return rule.userId === null || rule.userId === userId;
}

// ============================================================================
// Violation Creation
// ============================================================================

/**
 * Create a violation from rule evaluation result.
 * Uses a transaction to ensure violation insert and trust score update are atomic.
 *
 * @param ruleId - ID of the rule that was violated
 * @param userId - ID of the user who violated the rule
 * @param sessionId - ID of the session where violation occurred
 * @param result - Rule evaluation result with severity and data
 * @param rule - Full rule object for broadcast details
 * @param pubSubService - Optional pub/sub service for WebSocket broadcast
 *
 * @example
 * await createViolation(
 *   'rule-123',
 *   'user-456',
 *   'session-789',
 *   { violated: true, severity: 'warning', data: { reason: 'Multiple streams' } },
 *   rule,
 *   pubSubService
 * );
 */
export async function createViolation(
  ruleId: string,
  userId: string,
  sessionId: string,
  result: RuleEvaluationResult,
  rule: Rule,
  pubSubService: PubSubService | null
): Promise<void> {
  // Calculate trust penalty based on severity
  const trustPenalty = getTrustScorePenalty(result.severity);

  // Use transaction to ensure violation creation and trust score update are atomic
  const created = await db.transaction(async (tx) => {
    const [violation] = await tx
      .insert(violations)
      .values({
        ruleId,
        userId,
        sessionId,
        severity: result.severity,
        data: result.data,
      })
      .returning();

    // Decrease user trust score based on severity (atomic within transaction)
    await tx
      .update(users)
      .set({
        trustScore: sql`GREATEST(0, ${users.trustScore} - ${trustPenalty})`,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));

    return violation;
  });

  // Get user details for the violation broadcast (outside transaction - read only)
  const [user] = await db
    .select({
      id: users.id,
      username: users.username,
      thumbUrl: users.thumbUrl,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  // Publish violation event for WebSocket broadcast
  if (pubSubService && created && user) {
    const violationWithDetails: ViolationWithDetails = {
      id: created.id,
      ruleId: created.ruleId,
      userId: created.userId,
      sessionId: created.sessionId,
      severity: created.severity,
      data: created.data,
      acknowledgedAt: created.acknowledgedAt,
      createdAt: created.createdAt,
      user: {
        id: user.id,
        username: user.username,
        thumbUrl: user.thumbUrl,
      },
      rule: {
        id: rule.id,
        name: rule.name,
        type: rule.type,
      },
    };

    await pubSubService.publish(WS_EVENTS_CONST.VIOLATION_NEW, violationWithDetails);
    console.log(`[Poller] Violation broadcast: ${rule.name} for user ${user.username}`);
  }
}
