/**
 * Account Inactivity Rule Tests
 *
 * Tests the account_inactivity rule type that detects users who have been
 * inactive for a specified period.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { RuleEngine } from '../rules.js';
import type { AccountInactivityParams } from '@tracearr/shared';

describe('RuleEngine - Account Inactivity', () => {
  let ruleEngine: RuleEngine;

  beforeEach(() => {
    ruleEngine = new RuleEngine();
  });

  // Helper to create a mock server user for inactivity checks
  const createMockServerUser = (
    overrides: {
      id?: string;
      username?: string;
      lastActivityAt?: Date | null;
    } = {}
  ): { id: string; username: string; lastActivityAt: Date | null } => ({
    id: overrides.id ?? 'user-123',
    username: overrides.username ?? 'testuser',
    // Use explicit check to preserve null values (null means never active)
    lastActivityAt:
      'lastActivityAt' in overrides ? (overrides.lastActivityAt as Date | null) : new Date(),
  });

  // Helper to create inactivity params
  const createInactivityParams = (
    overrides: Partial<AccountInactivityParams> = {}
  ): AccountInactivityParams => ({
    inactivityValue: 30,
    inactivityUnit: 'days',
    notificationMode: 'once',
    ...overrides,
  });

  describe('evaluateAccountInactivity', () => {
    describe('basic inactivity detection', () => {
      it('should not violate when user was recently active', () => {
        const user = createMockServerUser({
          lastActivityAt: new Date(), // Active now
        });
        const params = createInactivityParams({ inactivityValue: 30, inactivityUnit: 'days' });

        const result = ruleEngine.evaluateAccountInactivity(user, params);

        expect(result.violated).toBe(false);
      });

      it('should violate when user has been inactive longer than threshold', () => {
        const thirtyOneDaysAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
        const user = createMockServerUser({
          lastActivityAt: thirtyOneDaysAgo,
        });
        const params = createInactivityParams({ inactivityValue: 30, inactivityUnit: 'days' });

        const result = ruleEngine.evaluateAccountInactivity(user, params);

        expect(result.violated).toBe(true);
        expect(result.severity).toBe('low');
        expect(result.data.inactiveDays).toBeGreaterThanOrEqual(31);
        expect(result.data.thresholdDays).toBe(30);
        expect(result.data.neverActive).toBe(false);
      });

      it('should not violate when user activity is exactly at threshold', () => {
        // Exactly 30 days ago - should NOT violate (need to exceed threshold)
        const exactlyThirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000 + 1000); // +1s to be just under
        const user = createMockServerUser({
          lastActivityAt: exactlyThirtyDaysAgo,
        });
        const params = createInactivityParams({ inactivityValue: 30, inactivityUnit: 'days' });

        const result = ruleEngine.evaluateAccountInactivity(user, params);

        // Should not violate if exactly at 30 days or just under
        expect(result.violated).toBe(false);
      });
    });

    describe('time unit conversions', () => {
      it('should correctly calculate days threshold', () => {
        const fifteenDaysAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
        const user = createMockServerUser({ lastActivityAt: fifteenDaysAgo });

        // 14 days threshold - should violate (15 > 14)
        const result = ruleEngine.evaluateAccountInactivity(
          user,
          createInactivityParams({
            inactivityValue: 14,
            inactivityUnit: 'days',
          })
        );

        expect(result.violated).toBe(true);
        expect(result.data.thresholdDays).toBe(14);
      });

      it('should correctly calculate weeks threshold', () => {
        const threeWeeksAgo = new Date(Date.now() - 21 * 24 * 60 * 60 * 1000);
        const user = createMockServerUser({ lastActivityAt: threeWeeksAgo });

        // 2 weeks threshold - should violate (3 weeks > 2 weeks)
        const result = ruleEngine.evaluateAccountInactivity(
          user,
          createInactivityParams({
            inactivityValue: 2,
            inactivityUnit: 'weeks',
          })
        );

        expect(result.violated).toBe(true);
        expect(result.data.thresholdDays).toBe(14); // 2 weeks = 14 days
      });

      it('should correctly calculate months threshold', () => {
        const twoMonthsAgo = new Date(Date.now() - 65 * 24 * 60 * 60 * 1000); // ~65 days
        const user = createMockServerUser({ lastActivityAt: twoMonthsAgo });

        // 2 months threshold (~60 days) - should violate
        const result = ruleEngine.evaluateAccountInactivity(
          user,
          createInactivityParams({
            inactivityValue: 2,
            inactivityUnit: 'months',
          })
        );

        expect(result.violated).toBe(true);
        expect(result.data.thresholdDays).toBe(60); // 2 months = 60 days (30*2)
      });

      it('should not violate when within months threshold', () => {
        const fortyFiveDaysAgo = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
        const user = createMockServerUser({ lastActivityAt: fortyFiveDaysAgo });

        // 2 months threshold (~60 days) - should not violate (45 < 60)
        const result = ruleEngine.evaluateAccountInactivity(
          user,
          createInactivityParams({
            inactivityValue: 2,
            inactivityUnit: 'months',
          })
        );

        expect(result.violated).toBe(false);
      });
    });

    describe('users with no activity', () => {
      it('should violate for users who have never been active', () => {
        const user = createMockServerUser({
          lastActivityAt: null, // Never active
        });
        const params = createInactivityParams({ inactivityValue: 30, inactivityUnit: 'days' });

        const result = ruleEngine.evaluateAccountInactivity(user, params);

        expect(result.violated).toBe(true);
        expect(result.data.neverActive).toBe(true);
        expect(result.data.lastActivityAt).toBeNull();
        expect(result.data.inactiveDays).toBeNull();
      });
    });

    describe('violation data structure', () => {
      it('should include all required data fields in violation', () => {
        const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
        const user = createMockServerUser({
          username: 'inactive_user',
          lastActivityAt: sixtyDaysAgo,
        });
        const params = createInactivityParams({ inactivityValue: 30, inactivityUnit: 'days' });

        const result = ruleEngine.evaluateAccountInactivity(user, params);

        expect(result.violated).toBe(true);
        expect(result.data).toMatchObject({
          username: 'inactive_user',
          thresholdDays: 30,
          neverActive: false,
        });
        expect(result.data.lastActivityAt).toBeDefined();
        expect(typeof result.data.inactiveDays).toBe('number');
      });

      it('should return ISO string for lastActivityAt', () => {
        const thirtyOneDaysAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
        const user = createMockServerUser({ lastActivityAt: thirtyOneDaysAgo });
        const params = createInactivityParams({ inactivityValue: 30, inactivityUnit: 'days' });

        const result = ruleEngine.evaluateAccountInactivity(user, params);

        expect(typeof result.data.lastActivityAt).toBe('string');
        // Should be a valid ISO date string
        expect(() => new Date(result.data.lastActivityAt as string)).not.toThrow();
      });
    });

    describe('boundary conditions', () => {
      it('should handle very small inactivity values', () => {
        const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
        const user = createMockServerUser({ lastActivityAt: twoDaysAgo });

        const result = ruleEngine.evaluateAccountInactivity(
          user,
          createInactivityParams({
            inactivityValue: 1,
            inactivityUnit: 'days',
          })
        );

        expect(result.violated).toBe(true);
      });

      it('should handle very large inactivity values', () => {
        const oneYearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
        const user = createMockServerUser({ lastActivityAt: oneYearAgo });

        // 2 years threshold - should not violate
        const result = ruleEngine.evaluateAccountInactivity(
          user,
          createInactivityParams({
            inactivityValue: 24,
            inactivityUnit: 'months',
          })
        );

        expect(result.violated).toBe(false);
      });

      it('should handle activity just moments ago', () => {
        const justNow = new Date(Date.now() - 1000); // 1 second ago
        const user = createMockServerUser({ lastActivityAt: justNow });

        const result = ruleEngine.evaluateAccountInactivity(
          user,
          createInactivityParams({
            inactivityValue: 1,
            inactivityUnit: 'days',
          })
        );

        expect(result.violated).toBe(false);
      });
    });
  });
});
