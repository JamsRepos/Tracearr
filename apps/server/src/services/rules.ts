/**
 * Rule evaluation engine
 */

import type {
  Rule,
  Session,
  ViolationSeverity,
  ImpossibleTravelParams,
  SimultaneousLocationsParams,
  DeviceVelocityParams,
  ConcurrentStreamsParams,
  GeoRestrictionParams,
} from '@tracearr/shared';
import { GEOIP_CONFIG, TIME_MS } from '@tracearr/shared';

export interface RuleEvaluationResult {
  violated: boolean;
  severity: ViolationSeverity;
  data: Record<string, unknown>;
}

export class RuleEngine {
  /**
   * Evaluate all active rules against a new session
   */
  async evaluateSession(
    session: Session,
    activeRules: Rule[],
    recentSessions: Session[]
  ): Promise<RuleEvaluationResult[]> {
    const results: RuleEvaluationResult[] = [];

    for (const rule of activeRules) {
      // Skip rules that don't apply to this user
      if (rule.userId !== null && rule.userId !== session.userId) {
        continue;
      }

      const result = await this.evaluateRule(rule, session, recentSessions);
      if (result.violated) {
        results.push(result);
      }
    }

    return results;
  }

  private async evaluateRule(
    rule: Rule,
    session: Session,
    recentSessions: Session[]
  ): Promise<RuleEvaluationResult> {
    switch (rule.type) {
      case 'impossible_travel':
        return this.checkImpossibleTravel(
          session,
          recentSessions,
          rule.params as ImpossibleTravelParams
        );
      case 'simultaneous_locations':
        return this.checkSimultaneousLocations(
          session,
          recentSessions,
          rule.params as SimultaneousLocationsParams
        );
      case 'device_velocity':
        return this.checkDeviceVelocity(
          session,
          recentSessions,
          rule.params as DeviceVelocityParams
        );
      case 'concurrent_streams':
        return this.checkConcurrentStreams(
          session,
          recentSessions,
          rule.params as ConcurrentStreamsParams
        );
      case 'geo_restriction':
        return this.checkGeoRestriction(session, rule.params as GeoRestrictionParams);
      default:
        return { violated: false, severity: 'low', data: {} };
    }
  }

  private checkImpossibleTravel(
    session: Session,
    recentSessions: Session[],
    params: ImpossibleTravelParams
  ): RuleEvaluationResult {
    // Find most recent session from same user with different location
    const userSessions = recentSessions.filter(
      (s) =>
        s.userId === session.userId &&
        s.geoLat !== null &&
        s.geoLon !== null &&
        session.geoLat !== null &&
        session.geoLon !== null
    );

    for (const prevSession of userSessions) {
      const distance = this.calculateDistance(
        prevSession.geoLat!,
        prevSession.geoLon!,
        session.geoLat!,
        session.geoLon!
      );

      const timeDiffHours =
        (session.startedAt.getTime() - prevSession.startedAt.getTime()) / (1000 * 60 * 60);

      if (timeDiffHours > 0) {
        const speed = distance / timeDiffHours;
        if (speed > params.maxSpeedKmh) {
          return {
            violated: true,
            severity: 'high',
            data: {
              previousLocation: { lat: prevSession.geoLat, lon: prevSession.geoLon },
              currentLocation: { lat: session.geoLat, lon: session.geoLon },
              distance,
              timeDiffHours,
              calculatedSpeed: speed,
              maxAllowedSpeed: params.maxSpeedKmh,
            },
          };
        }
      }
    }

    return { violated: false, severity: 'low', data: {} };
  }

  private checkSimultaneousLocations(
    session: Session,
    recentSessions: Session[],
    params: SimultaneousLocationsParams
  ): RuleEvaluationResult {
    // Check for active sessions from same user at different locations
    const activeSessions = recentSessions.filter(
      (s) =>
        s.userId === session.userId &&
        s.state === 'playing' &&
        s.geoLat !== null &&
        s.geoLon !== null &&
        session.geoLat !== null &&
        session.geoLon !== null
    );

    for (const activeSession of activeSessions) {
      const distance = this.calculateDistance(
        activeSession.geoLat!,
        activeSession.geoLon!,
        session.geoLat!,
        session.geoLon!
      );

      if (distance > params.minDistanceKm) {
        return {
          violated: true,
          severity: 'warning',
          data: {
            locations: [
              { lat: activeSession.geoLat, lon: activeSession.geoLon },
              { lat: session.geoLat, lon: session.geoLon },
            ],
            distance,
            minRequiredDistance: params.minDistanceKm,
          },
        };
      }
    }

    return { violated: false, severity: 'low', data: {} };
  }

  private checkDeviceVelocity(
    session: Session,
    recentSessions: Session[],
    params: DeviceVelocityParams
  ): RuleEvaluationResult {
    const windowStart = new Date(session.startedAt.getTime() - params.windowHours * TIME_MS.HOUR);

    const userSessions = recentSessions.filter(
      (s) => s.userId === session.userId && s.startedAt >= windowStart
    );

    const uniqueIps = new Set(userSessions.map((s) => s.ipAddress));
    uniqueIps.add(session.ipAddress);

    if (uniqueIps.size > params.maxIps) {
      return {
        violated: true,
        severity: 'warning',
        data: {
          uniqueIpCount: uniqueIps.size,
          maxAllowedIps: params.maxIps,
          windowHours: params.windowHours,
          ips: Array.from(uniqueIps),
        },
      };
    }

    return { violated: false, severity: 'low', data: {} };
  }

  private checkConcurrentStreams(
    session: Session,
    recentSessions: Session[],
    params: ConcurrentStreamsParams
  ): RuleEvaluationResult {
    const activeSessions = recentSessions.filter(
      (s) => s.userId === session.userId && s.state === 'playing'
    );

    // Add 1 for current session
    const totalStreams = activeSessions.length + 1;

    if (totalStreams > params.maxStreams) {
      return {
        violated: true,
        severity: 'low',
        data: {
          activeStreamCount: totalStreams,
          maxAllowedStreams: params.maxStreams,
        },
      };
    }

    return { violated: false, severity: 'low', data: {} };
  }

  private checkGeoRestriction(
    session: Session,
    params: GeoRestrictionParams
  ): RuleEvaluationResult {
    if (session.geoCountry && params.blockedCountries.includes(session.geoCountry)) {
      return {
        violated: true,
        severity: 'high',
        data: {
          country: session.geoCountry,
          blockedCountries: params.blockedCountries,
        },
      };
    }

    return { violated: false, severity: 'low', data: {} };
  }

  /**
   * Calculate distance between two points using Haversine formula
   */
  private calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = GEOIP_CONFIG.EARTH_RADIUS_KM;
    const dLat = this.toRadians(lat2 - lat1);
    const dLon = this.toRadians(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.toRadians(lat1)) *
        Math.cos(this.toRadians(lat2)) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  private toRadians(degrees: number): number {
    return degrees * (Math.PI / 180);
  }
}

export const ruleEngine = new RuleEngine();
