/**
 * Session State Tracking
 *
 * Pure functions for tracking session state transitions, pause accumulation,
 * watch completion, and session grouping (resume detection).
 */

import { SESSION_LIMITS, type SessionState } from '@tracearr/shared';
import type { PauseAccumulationResult, StopDurationResult, SessionPauseData } from './types.js';

// ============================================================================
// Pause Tracking
// ============================================================================

/**
 * Calculate pause accumulation when session state changes.
 * Handles transitions between playing and paused states.
 *
 * @param previousState - Previous playback state
 * @param newState - New playback state
 * @param existingSession - Current session pause data
 * @param now - Current timestamp
 * @returns Updated pause tracking data
 *
 * @example
 * // Starting to pause
 * calculatePauseAccumulation('playing', 'paused', { lastPausedAt: null, pausedDurationMs: 0 }, now);
 * // Returns: { lastPausedAt: now, pausedDurationMs: 0 }
 *
 * // Resuming playback after 5 minutes paused
 * calculatePauseAccumulation('paused', 'playing', { lastPausedAt: fiveMinutesAgo, pausedDurationMs: 0 }, now);
 * // Returns: { lastPausedAt: null, pausedDurationMs: 300000 }
 */
export function calculatePauseAccumulation(
  previousState: SessionState,
  newState: SessionState,
  existingSession: { lastPausedAt: Date | null; pausedDurationMs: number },
  now: Date
): PauseAccumulationResult {
  let lastPausedAt = existingSession.lastPausedAt;
  let pausedDurationMs = existingSession.pausedDurationMs;

  if (previousState === 'playing' && newState === 'paused') {
    // Started pausing - record timestamp
    lastPausedAt = now;
  } else if (previousState === 'paused' && newState === 'playing') {
    // Resumed playing - accumulate pause duration
    if (existingSession.lastPausedAt) {
      const pausedMs = now.getTime() - existingSession.lastPausedAt.getTime();
      pausedDurationMs = (existingSession.pausedDurationMs || 0) + pausedMs;
    }
    lastPausedAt = null;
  }

  return { lastPausedAt, pausedDurationMs };
}

/**
 * Calculate final duration when a session is stopped.
 * Accounts for any remaining pause time if stopped while paused.
 *
 * @param session - Session pause tracking data
 * @param stoppedAt - Timestamp when session stopped
 * @returns Actual watch duration and final paused duration
 *
 * @example
 * // Session that was playing when stopped
 * calculateStopDuration({ startedAt: tenMinutesAgo, lastPausedAt: null, pausedDurationMs: 60000 }, now);
 * // Returns: { durationMs: 540000, finalPausedDurationMs: 60000 } (9 min watch, 1 min paused)
 *
 * // Session that was paused when stopped (adds remaining pause time)
 * calculateStopDuration({ startedAt: tenMinutesAgo, lastPausedAt: twoMinutesAgo, pausedDurationMs: 60000 }, now);
 * // Returns: { durationMs: 420000, finalPausedDurationMs: 180000 } (7 min watch, 3 min paused)
 */
export function calculateStopDuration(
  session: SessionPauseData,
  stoppedAt: Date
): StopDurationResult {
  const totalElapsedMs = stoppedAt.getTime() - session.startedAt.getTime();

  // Calculate final paused duration - accumulate any remaining pause if stopped while paused
  let finalPausedDurationMs = session.pausedDurationMs || 0;
  if (session.lastPausedAt) {
    // Session was stopped while paused - add the remaining pause time
    finalPausedDurationMs += stoppedAt.getTime() - session.lastPausedAt.getTime();
  }

  // Calculate actual watch duration (excludes all paused time)
  const durationMs = Math.max(0, totalElapsedMs - finalPausedDurationMs);

  return { durationMs, finalPausedDurationMs };
}

// ============================================================================
// Watch Completion
// ============================================================================

/**
 * Check if a session should be marked as "watched" (>=80% progress).
 *
 * @param progressMs - Current playback position in milliseconds
 * @param totalDurationMs - Total media duration in milliseconds
 * @returns true if watched at least 80% of the content
 *
 * @example
 * checkWatchCompletion(4800000, 6000000);  // true (80%)
 * checkWatchCompletion(3000000, 6000000);  // false (50%)
 * checkWatchCompletion(null, 6000000);     // false (no progress)
 */
export function checkWatchCompletion(
  progressMs: number | null,
  totalDurationMs: number | null
): boolean {
  if (!progressMs || !totalDurationMs) return false;
  return (progressMs / totalDurationMs) >= SESSION_LIMITS.WATCH_COMPLETION_THRESHOLD;
}

// ============================================================================
// Session Grouping (Resume Detection)
// ============================================================================

/**
 * Determine if a new session should be grouped with a previous session (resume tracking).
 * Returns the referenceId to link to, or null if sessions shouldn't be grouped.
 *
 * Sessions are grouped when:
 * - Same user and same media item (ratingKey)
 * - Previous session stopped within 24 hours
 * - Previous session wasn't fully watched
 * - New session starts at same or later position (resuming, not rewatching)
 *
 * @param previousSession - Previous session data for the same user/media
 * @param newProgressMs - Current playback position of new session
 * @param oneDayAgo - Date threshold for session grouping (24 hours ago)
 * @returns referenceId to link to, or null if not grouping
 *
 * @example
 * // Resuming a paused movie
 * shouldGroupWithPreviousSession(
 *   { id: 'sess-1', referenceId: null, progressMs: 1800000, watched: false, stoppedAt: oneHourAgo },
 *   1800000,
 *   oneDayAgo
 * ); // Returns: 'sess-1'
 *
 * // Rewatching from beginning (not grouped)
 * shouldGroupWithPreviousSession(
 *   { id: 'sess-1', referenceId: null, progressMs: 5400000, watched: false, stoppedAt: oneHourAgo },
 *   0,
 *   oneDayAgo
 * ); // Returns: null (position went backward)
 */
export function shouldGroupWithPreviousSession(
  previousSession: {
    referenceId: string | null;
    id: string;
    progressMs: number | null;
    watched: boolean;
    stoppedAt: Date | null;
  },
  newProgressMs: number,
  oneDayAgo: Date
): string | null {
  // Must be recent (within 24h) and not fully watched
  if (!previousSession.stoppedAt || previousSession.stoppedAt < oneDayAgo) return null;
  if (previousSession.watched) return null;

  // New session must be resuming from same or later position
  const prevProgress = previousSession.progressMs || 0;
  if (newProgressMs >= prevProgress) {
    // Link to the first session in the chain
    return previousSession.referenceId || previousSession.id;
  }

  return null;
}
