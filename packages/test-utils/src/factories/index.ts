/**
 * Test factories for creating database entities
 *
 * @module @tracearr/test-utils/factories
 */

// Import reset functions for local use in resetAllFactoryCounters()
import { resetUserCounter } from './user.js';
import { resetServerCounter } from './server.js';
import { resetServerUserCounter } from './serverUser.js';
import { resetSessionCounter } from './session.js';
import { resetRuleCounter } from './rule.js';
import { resetViolationCounter } from './violation.js';

export {
  buildUser,
  createTestUser,
  createTestOwner,
  createTestAdmin,
  createTestMember,
  createTestUsers,
  resetUserCounter,
  type UserData,
  type CreatedUser,
} from './user.js';

export {
  buildServer,
  createTestServer,
  createTestPlexServer,
  createTestJellyfinServer,
  createTestEmbyServer,
  createTestServers,
  resetServerCounter,
  type ServerData,
  type CreatedServer,
  type ServerType,
} from './server.js';

export {
  buildServerUser,
  createTestServerUser,
  createTestServerAdmin,
  resetServerUserCounter,
  type ServerUserData,
  type CreatedServerUser,
} from './serverUser.js';

export {
  buildSession,
  createTestSession,
  createActiveSession,
  createPausedSession,
  createStoppedSession,
  createEpisodeSession,
  createConcurrentSessions,
  resetSessionCounter,
  type SessionData,
  type CreatedSession,
  type SessionState,
  type MediaType,
} from './session.js';

export {
  buildRule,
  createTestRule,
  createImpossibleTravelRule,
  createSimultaneousLocationsRule,
  createDeviceVelocityRule,
  createConcurrentStreamsRule,
  createGeoRestrictionRule,
  createAccountInactivityRule,
  resetRuleCounter,
  type RuleData,
  type CreatedRule,
  type RuleType,
  type RuleParams,
  type ImpossibleTravelParams,
  type SimultaneousLocationsParams,
  type DeviceVelocityParams,
  type ConcurrentStreamsParams,
  type GeoRestrictionParams,
  type AccountInactivityParams,
} from './rule.js';

export {
  buildViolation,
  createTestViolation,
  createLowViolation,
  createWarningViolation,
  createHighViolation,
  createAcknowledgedViolation,
  createImpossibleTravelViolation,
  createConcurrentStreamsViolation,
  resetViolationCounter,
  type ViolationData,
  type CreatedViolation,
  type ViolationSeverity,
} from './violation.js';

/**
 * Reset all factory counters
 *
 * Call this in beforeEach() if you need predictable IDs
 */
export function resetAllFactoryCounters(): void {
  resetUserCounter();
  resetServerCounter();
  resetServerUserCounter();
  resetSessionCounter();
  resetRuleCounter();
  resetViolationCounter();
}
