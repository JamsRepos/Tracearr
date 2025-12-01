/**
 * Poller Module
 *
 * Background job for polling Plex/Jellyfin servers for active sessions.
 * This module provides a unified interface for session tracking, including:
 * - Automatic polling on configurable intervals
 * - Session state tracking (playing, paused, stopped)
 * - Pause duration accumulation
 * - Watch completion detection (80% threshold)
 * - Session grouping for resume tracking
 * - Rule evaluation and violation creation
 *
 * @example
 * import { initializePoller, startPoller, stopPoller } from './jobs/poller';
 *
 * // Initialize with cache services
 * initializePoller(cacheService, pubSubService);
 *
 * // Start polling
 * startPoller({ enabled: true, intervalMs: 15000 });
 *
 * // Stop polling
 * stopPoller();
 */

// ============================================================================
// Public API - Lifecycle Management
// ============================================================================

export {
  initializePoller,
  startPoller,
  stopPoller,
  triggerPoll,
} from './processor.js';

// ============================================================================
// Types
// ============================================================================

export type { PollerConfig } from './types.js';

// ============================================================================
// Pure Utility Functions (exported for testing)
// ============================================================================

export {
  isPrivateIP,
  parseJellyfinClient,
  formatQualityString,
} from './utils.js';

// ============================================================================
// State Tracking Functions (exported for testing)
// ============================================================================

export {
  calculatePauseAccumulation,
  calculateStopDuration,
  checkWatchCompletion,
  shouldGroupWithPreviousSession,
} from './stateTracker.js';

// ============================================================================
// Rule/Violation Functions (exported for testing)
// ============================================================================

export {
  getTrustScorePenalty,
  doesRuleApplyToUser,
} from './violations.js';
