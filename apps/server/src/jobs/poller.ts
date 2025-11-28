/**
 * Background job for polling Plex/Jellyfin servers for active sessions
 */

import { eq, and, desc, isNull, sql, gte } from 'drizzle-orm';
import { POLLING_INTERVALS, WS_EVENTS, type Session, type ActiveSession, type Rule, type RuleParams, type ViolationWithDetails } from '@tracearr/shared';
import { db } from '../db/client.js';
import { servers, users, sessions, rules, violations } from '../db/schema.js';
import { PlexService, type PlexSession } from '../services/plex.js';
import { JellyfinService, type JellyfinSession } from '../services/jellyfin.js';
import { geoipService, type GeoLocation } from '../services/geoip.js';
import { ruleEngine, type RuleEvaluationResult } from '../services/rules.js';
import { type CacheService, type PubSubService } from '../services/cache.js';

let pollingInterval: NodeJS.Timeout | null = null;
let cacheService: CacheService | null = null;
let pubSubService: PubSubService | null = null;

export interface PollerConfig {
  enabled: boolean;
  intervalMs: number;
}

const defaultConfig: PollerConfig = {
  enabled: true,
  intervalMs: POLLING_INTERVALS.SESSIONS,
};

interface ServerWithToken {
  id: string;
  name: string;
  type: 'plex' | 'jellyfin';
  url: string;
  token: string;
  createdAt: Date;
  updatedAt: Date;
}

interface ProcessedSession {
  sessionKey: string;
  ratingKey: string; // Plex/Jellyfin media identifier
  // User identification from media server
  externalUserId: string; // Plex/Jellyfin user ID for lookup
  username: string; // Display name from media server
  userThumb: string; // Avatar URL from media server
  mediaTitle: string;
  mediaType: 'movie' | 'episode' | 'track';
  // Enhanced media metadata
  grandparentTitle: string; // Show name (for episodes)
  seasonNumber: number; // Season number (for episodes)
  episodeNumber: number; // Episode number (for episodes)
  year: number; // Release year
  thumbPath: string; // Poster path
  // Connection info
  ipAddress: string;
  playerName: string;
  deviceId: string; // Unique device identifier (machineIdentifier)
  product: string; // Product/app name (e.g., "Plex for iOS")
  device: string; // Device type (e.g., "iPhone")
  platform: string;
  quality: string;
  isTranscode: boolean;
  bitrate: number;
  state: 'playing' | 'paused';
  totalDurationMs: number; // Total media length
  progressMs: number; // Current playback position
}

/**
 * Map Plex session to common format
 */
function mapPlexSession(session: PlexSession): ProcessedSession {
  // Use remotePublicAddress for geo-location if client is not local
  // This gives us the real public IP for accurate location tracking
  const ipAddress = !session.player.local && session.player.remotePublicAddress
    ? session.player.remotePublicAddress
    : session.player.address;

  // For episodes, use show poster (grandparentThumb); for movies, use thumb
  const isEpisode = session.type === 'episode';
  const thumbPath = isEpisode && session.grandparentThumb
    ? session.grandparentThumb
    : session.thumb;

  return {
    sessionKey: session.sessionKey,
    ratingKey: session.ratingKey,
    // User data from Plex session
    externalUserId: session.user.id,
    username: session.user.title || 'Unknown',
    userThumb: session.user.thumb || '',
    mediaTitle: session.title,
    mediaType: session.type === 'movie' ? 'movie' : session.type === 'episode' ? 'episode' : 'track',
    // Enhanced media metadata
    grandparentTitle: session.grandparentTitle,
    seasonNumber: session.parentIndex,
    episodeNumber: session.index,
    year: session.year,
    thumbPath,
    // Connection info
    ipAddress,
    playerName: session.player.title,
    deviceId: session.player.machineIdentifier,
    product: session.player.product,
    device: session.player.device,
    platform: session.player.platform,
    quality: `${Math.round(session.media.bitrate / 1000)}Mbps`,
    isTranscode: session.media.videoDecision !== 'directplay',
    bitrate: session.media.bitrate,
    state: session.player.state === 'paused' ? 'paused' : 'playing',
    totalDurationMs: session.duration,
    progressMs: session.viewOffset,
  };
}

/**
 * Map Jellyfin session to common format
 */
function mapJellyfinSession(session: JellyfinSession): ProcessedSession {
  const runTimeTicks = session.nowPlayingItem?.runTimeTicks ?? 0;
  const positionTicks = session.playState?.positionTicks ?? 0;
  const nowPlaying = session.nowPlayingItem;
  const isEpisode = nowPlaying?.type === 'Episode';

  // Build Jellyfin image URL path for media poster
  // For episodes, use series image; for movies, use item image
  let thumbPath = '';
  if (nowPlaying) {
    if (isEpisode && nowPlaying.seriesId && nowPlaying.seriesPrimaryImageTag) {
      thumbPath = `/Items/${nowPlaying.seriesId}/Images/Primary?tag=${nowPlaying.seriesPrimaryImageTag}`;
    } else if (nowPlaying.imageTags?.Primary) {
      thumbPath = `/Items/${nowPlaying.id}/Images/Primary?tag=${nowPlaying.imageTags.Primary}`;
    }
  }

  // Build user avatar URL from Jellyfin
  const userThumb = session.userPrimaryImageTag
    ? `/Users/${session.userId}/Images/Primary?tag=${session.userPrimaryImageTag}`
    : '';

  return {
    sessionKey: session.id,
    ratingKey: nowPlaying?.id ?? '', // Jellyfin item ID
    // User data from Jellyfin session
    externalUserId: session.userId,
    username: session.userName || 'Unknown',
    userThumb,
    mediaTitle: nowPlaying?.name ?? 'Unknown',
    mediaType: isEpisode ? 'episode' : nowPlaying?.type === 'Movie' ? 'movie' : 'track',
    // Enhanced media metadata
    grandparentTitle: nowPlaying?.seriesName ?? '',
    seasonNumber: nowPlaying?.parentIndexNumber ?? 0,
    episodeNumber: nowPlaying?.indexNumber ?? 0,
    year: nowPlaying?.productionYear ?? 0,
    thumbPath,
    // Connection info
    ipAddress: session.remoteEndPoint,
    playerName: session.deviceName,
    deviceId: session.deviceId, // Jellyfin device ID
    product: session.client, // Client app name
    device: session.deviceType ?? '', // Device type
    platform: session.client,
    quality: session.transcodingInfo
      ? `${Math.round((session.transcodingInfo.bitrate || 0) / 1000)}Mbps`
      : 'Direct',
    isTranscode: !(session.transcodingInfo?.isVideoDirect ?? true),
    bitrate: session.transcodingInfo?.bitrate ?? 0,
    state: session.playState?.isPaused ? 'paused' : 'playing',
    totalDurationMs: runTimeTicks / 10000, // Ticks to ms
    progressMs: positionTicks / 10000,
  };
}

/**
 * Find or create user for the session, updating user data if changed
 * This ensures user info (username, avatar) stays fresh from media server
 */
async function findOrCreateUser(
  serverId: string,
  externalId: string,
  username: string,
  thumbUrl: string | null
): Promise<string> {
  const existingUser = await db
    .select()
    .from(users)
    .where(and(eq(users.serverId, serverId), eq(users.externalId, externalId)))
    .limit(1);

  const existing = existingUser[0];
  if (existing) {
    // Update user data if it changed (keeps info fresh from media server)
    const needsUpdate =
      existing.username !== username ||
      (thumbUrl && existing.thumbUrl !== thumbUrl);

    if (needsUpdate) {
      await db
        .update(users)
        .set({
          username,
          thumbUrl: thumbUrl || existing.thumbUrl, // Don't overwrite with empty
          updatedAt: new Date(),
        })
        .where(eq(users.id, existing.id));
    }
    return existing.id;
  }

  // Create new user with full data
  const newUser = await db
    .insert(users)
    .values({
      serverId,
      externalId,
      username,
      thumbUrl,
    })
    .returning();

  const created = newUser[0];
  if (!created) {
    throw new Error('Failed to create user');
  }
  return created.id;
}

/**
 * Get recent sessions for a user for rule evaluation
 */
async function getRecentUserSessions(userId: string, hours = 24): Promise<Session[]> {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);

  const recentSessions = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.userId, userId), gte(sessions.startedAt, since)))
    .orderBy(desc(sessions.startedAt))
    .limit(100);

  return recentSessions.map((s) => ({
    id: s.id,
    serverId: s.serverId,
    userId: s.userId,
    sessionKey: s.sessionKey,
    state: s.state,
    mediaType: s.mediaType,
    mediaTitle: s.mediaTitle,
    // Enhanced media metadata
    grandparentTitle: s.grandparentTitle,
    seasonNumber: s.seasonNumber,
    episodeNumber: s.episodeNumber,
    year: s.year,
    thumbPath: s.thumbPath,
    ratingKey: s.ratingKey,
    externalSessionId: s.externalSessionId,
    startedAt: s.startedAt,
    stoppedAt: s.stoppedAt,
    durationMs: s.durationMs,
    totalDurationMs: s.totalDurationMs,
    progressMs: s.progressMs,
    ipAddress: s.ipAddress,
    geoCity: s.geoCity,
    geoCountry: s.geoCountry,
    geoLat: s.geoLat,
    geoLon: s.geoLon,
    playerName: s.playerName,
    deviceId: s.deviceId,
    product: s.product,
    device: s.device,
    platform: s.platform,
    quality: s.quality,
    isTranscode: s.isTranscode,
    bitrate: s.bitrate,
  }));
}

/**
 * Get all active rules for evaluation
 */
async function getActiveRules(): Promise<Rule[]> {
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

/**
 * Create a violation from rule evaluation result
 */
async function createViolation(
  ruleId: string,
  userId: string,
  sessionId: string,
  result: RuleEvaluationResult,
  rule: Rule
): Promise<void> {
  const [created] = await db
    .insert(violations)
    .values({
      ruleId,
      userId,
      sessionId,
      severity: result.severity,
      data: result.data,
    })
    .returning();

  // Decrease user trust score based on severity
  const trustPenalty = result.severity === 'high' ? 20 : result.severity === 'warning' ? 10 : 5;
  await db
    .update(users)
    .set({
      trustScore: sql`GREATEST(0, ${users.trustScore} - ${trustPenalty})`,
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId));

  // Get user details for the violation broadcast
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
      severity: created.severity as 'low' | 'warning' | 'high',
      data: created.data as Record<string, unknown>,
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
        type: rule.type as ViolationWithDetails['rule']['type'],
      },
    };

    await pubSubService.publish(WS_EVENTS.VIOLATION_NEW, violationWithDetails);
    console.log(`[Poller] Violation broadcast: ${rule.name} for user ${user.username}`);
  }
}

/**
 * Process a single server's sessions
 */
async function processServerSessions(
  server: ServerWithToken,
  activeRules: Rule[],
  cachedSessionKeys: Set<string>
): Promise<{
  newSessions: ActiveSession[];
  stoppedSessionKeys: string[];
  updatedSessions: ActiveSession[];
}> {
  const newSessions: ActiveSession[] = [];
  const updatedSessions: ActiveSession[] = [];
  const currentSessionKeys = new Set<string>();

  try {
    // Fetch sessions from server
    let processedSessions: ProcessedSession[] = [];

    if (server.type === 'plex') {
      const plexService = new PlexService(server);
      const plexSessions = await plexService.getSessions();
      processedSessions = plexSessions.map(mapPlexSession);
    } else {
      const jellyfinService = new JellyfinService(server);
      const jellyfinSessions = await jellyfinService.getSessions();
      processedSessions = jellyfinSessions.map(mapJellyfinSession);
    }

    // Process each session
    for (const processed of processedSessions) {
      const sessionKey = `${server.id}:${processed.sessionKey}`;
      currentSessionKeys.add(sessionKey);

      // Get user ID (find or create)
      const userId = await findOrCreateUser(
        server.id,
        processed.externalUserId,
        processed.username,
        processed.userThumb || null
      );

      // Get user details
      const userDetails = await db
        .select({ id: users.id, username: users.username, thumbUrl: users.thumbUrl })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);

      // Get GeoIP location
      const geo: GeoLocation = geoipService.lookup(processed.ipAddress);

      const isNew = !cachedSessionKeys.has(sessionKey);

      // Get user details
      const userDetail = userDetails[0] ?? { id: userId, username: 'Unknown', thumbUrl: null };

      if (isNew) {
        // Insert new session
        const insertedRows = await db
          .insert(sessions)
          .values({
            serverId: server.id,
            userId,
            sessionKey: processed.sessionKey,
            ratingKey: processed.ratingKey || null,
            state: processed.state,
            mediaType: processed.mediaType,
            mediaTitle: processed.mediaTitle,
            // Enhanced media metadata
            grandparentTitle: processed.grandparentTitle || null,
            seasonNumber: processed.seasonNumber || null,
            episodeNumber: processed.episodeNumber || null,
            year: processed.year || null,
            thumbPath: processed.thumbPath || null,
            startedAt: new Date(),
            totalDurationMs: processed.totalDurationMs || null,
            progressMs: processed.progressMs || null,
            ipAddress: processed.ipAddress,
            geoCity: geo.city,
            geoCountry: geo.country,
            geoLat: geo.lat,
            geoLon: geo.lon,
            playerName: processed.playerName,
            deviceId: processed.deviceId || null,
            product: processed.product || null,
            device: processed.device || null,
            platform: processed.platform,
            quality: processed.quality,
            isTranscode: processed.isTranscode,
            bitrate: processed.bitrate,
          })
          .returning();

        const inserted = insertedRows[0];
        if (!inserted) {
          console.error('Failed to insert session');
          continue;
        }

        const session: Session = {
          id: inserted.id,
          serverId: server.id,
          userId,
          sessionKey: processed.sessionKey,
          state: processed.state,
          mediaType: processed.mediaType,
          mediaTitle: processed.mediaTitle,
          // Enhanced media metadata
          grandparentTitle: processed.grandparentTitle || null,
          seasonNumber: processed.seasonNumber || null,
          episodeNumber: processed.episodeNumber || null,
          year: processed.year || null,
          thumbPath: processed.thumbPath || null,
          ratingKey: processed.ratingKey || null,
          externalSessionId: null,
          startedAt: inserted.startedAt,
          stoppedAt: null,
          durationMs: null,
          totalDurationMs: processed.totalDurationMs || null,
          progressMs: processed.progressMs || null,
          ipAddress: processed.ipAddress,
          geoCity: geo.city,
          geoCountry: geo.country,
          geoLat: geo.lat,
          geoLon: geo.lon,
          playerName: processed.playerName,
          deviceId: processed.deviceId || null,
          product: processed.product || null,
          device: processed.device || null,
          platform: processed.platform,
          quality: processed.quality,
          isTranscode: processed.isTranscode,
          bitrate: processed.bitrate,
        };

        const activeSession: ActiveSession = {
          ...session,
          user: userDetail,
          server: { id: server.id, name: server.name, type: server.type },
        };

        newSessions.push(activeSession);

        // Evaluate rules for new session
        const recentSessions = await getRecentUserSessions(userId);
        const ruleResults = await ruleEngine.evaluateSession(session, activeRules, recentSessions);

        // Create violations for triggered rules
        for (const result of ruleResults) {
          const matchingRule = activeRules.find(
            (r) =>
              (r.userId === null || r.userId === userId) && result.violated
          );
          if (matchingRule) {
            // createViolation handles both DB insert and WebSocket broadcast
            await createViolation(matchingRule.id, userId, inserted.id, result, matchingRule);
          }
        }
      } else {
        // Update existing session (state changes and progress)
        await db
          .update(sessions)
          .set({
            state: processed.state,
            quality: processed.quality,
            bitrate: processed.bitrate,
            progressMs: processed.progressMs || null,
          })
          .where(
            and(eq(sessions.serverId, server.id), eq(sessions.sessionKey, processed.sessionKey))
          );

        // Get the session ID for cache update
        const existingRows = await db
          .select()
          .from(sessions)
          .where(
            and(eq(sessions.serverId, server.id), eq(sessions.sessionKey, processed.sessionKey))
          )
          .limit(1);

        const existingSession = existingRows[0];
        if (existingSession) {
          const activeSession: ActiveSession = {
            id: existingSession.id,
            serverId: server.id,
            userId,
            sessionKey: processed.sessionKey,
            state: processed.state,
            mediaType: processed.mediaType,
            mediaTitle: processed.mediaTitle,
            // Enhanced media metadata
            grandparentTitle: processed.grandparentTitle || null,
            seasonNumber: processed.seasonNumber || null,
            episodeNumber: processed.episodeNumber || null,
            year: processed.year || null,
            thumbPath: processed.thumbPath || null,
            ratingKey: processed.ratingKey || null,
            externalSessionId: existingSession.externalSessionId,
            startedAt: existingSession.startedAt,
            stoppedAt: null,
            durationMs: null,
            totalDurationMs: processed.totalDurationMs || null,
            progressMs: processed.progressMs || null,
            ipAddress: processed.ipAddress,
            geoCity: geo.city,
            geoCountry: geo.country,
            geoLat: geo.lat,
            geoLon: geo.lon,
            playerName: processed.playerName,
            deviceId: processed.deviceId || null,
            product: processed.product || null,
            device: processed.device || null,
            platform: processed.platform,
            quality: processed.quality,
            isTranscode: processed.isTranscode,
            bitrate: processed.bitrate,
            user: userDetail,
            server: { id: server.id, name: server.name, type: server.type },
          };
          updatedSessions.push(activeSession);
        }
      }
    }

    // Find stopped sessions
    const stoppedSessionKeys: string[] = [];
    for (const cachedKey of cachedSessionKeys) {
      if (cachedKey.startsWith(`${server.id}:`) && !currentSessionKeys.has(cachedKey)) {
        stoppedSessionKeys.push(cachedKey);

        // Mark session as stopped in database
        const sessionKey = cachedKey.replace(`${server.id}:`, '');
        const stoppedRows = await db
          .select()
          .from(sessions)
          .where(
            and(
              eq(sessions.serverId, server.id),
              eq(sessions.sessionKey, sessionKey),
              isNull(sessions.stoppedAt)
            )
          )
          .limit(1);

        const stoppedSession = stoppedRows[0];
        if (stoppedSession) {
          const stoppedAt = new Date();
          const durationMs = stoppedAt.getTime() - stoppedSession.startedAt.getTime();

          await db
            .update(sessions)
            .set({
              state: 'stopped',
              stoppedAt,
              durationMs,
            })
            .where(eq(sessions.id, stoppedSession.id));
        }
      }
    }

    return { newSessions, stoppedSessionKeys, updatedSessions };
  } catch (error) {
    console.error(`Error polling server ${server.name}:`, error);
    return { newSessions: [], stoppedSessionKeys: [], updatedSessions: [] };
  }
}

/**
 * Poll all connected servers for active sessions
 */
async function pollServers(): Promise<void> {
  try {
    // Get all connected servers
    const allServers = await db.select().from(servers);

    if (allServers.length === 0) {
      return;
    }

    // Get cached session keys
    const cachedSessions = cacheService ? await cacheService.getActiveSessions() : null;
    const cachedSessionKeys = new Set(
      (cachedSessions ?? []).map((s) => `${s.serverId}:${s.sessionKey}`)
    );

    // Get active rules
    const activeRules = await getActiveRules();

    // Collect results from all servers
    const allNewSessions: ActiveSession[] = [];
    const allStoppedKeys: string[] = [];
    const allUpdatedSessions: ActiveSession[] = [];

    // Process each server
    for (const server of allServers) {
      const serverWithToken = server as ServerWithToken;
      const { newSessions, stoppedSessionKeys, updatedSessions } = await processServerSessions(
        serverWithToken,
        activeRules,
        cachedSessionKeys
      );

      allNewSessions.push(...newSessions);
      allStoppedKeys.push(...stoppedSessionKeys);
      allUpdatedSessions.push(...updatedSessions);
    }

    // Update cache with current active sessions
    if (cacheService) {
      const currentActiveSessions = [...allNewSessions, ...allUpdatedSessions];
      await cacheService.setActiveSessions(currentActiveSessions);

      // Update individual session cache
      for (const session of allNewSessions) {
        await cacheService.setSessionById(session.id, session);
        await cacheService.addUserSession(session.userId, session.id);
      }

      for (const session of allUpdatedSessions) {
        await cacheService.setSessionById(session.id, session);
      }

      // Remove stopped sessions from cache
      for (const key of allStoppedKeys) {
        const parts = key.split(':');
        if (parts.length >= 2) {
          const serverId = parts[0];
          const sessionKey = parts.slice(1).join(':');

          // Find the session to get its ID
          const stoppedSession = cachedSessions?.find(
            (s) => s.serverId === serverId && s.sessionKey === sessionKey
          );
          if (stoppedSession) {
            await cacheService.deleteSessionById(stoppedSession.id);
            await cacheService.removeUserSession(stoppedSession.userId, stoppedSession.id);
          }
        }
      }
    }

    // Publish events via pub/sub
    if (pubSubService) {
      for (const session of allNewSessions) {
        await pubSubService.publish('session:started', session);
      }

      for (const session of allUpdatedSessions) {
        await pubSubService.publish('session:updated', session);
      }

      for (const key of allStoppedKeys) {
        const parts = key.split(':');
        if (parts.length >= 2) {
          const serverId = parts[0];
          const sessionKey = parts.slice(1).join(':');
          const stoppedSession = cachedSessions?.find(
            (s) => s.serverId === serverId && s.sessionKey === sessionKey
          );
          if (stoppedSession) {
            await pubSubService.publish('session:stopped', stoppedSession.id);
          }
        }
      }
    }

    if (allNewSessions.length > 0 || allStoppedKeys.length > 0) {
      console.log(
        `Poll complete: ${allNewSessions.length} new, ${allUpdatedSessions.length} updated, ${allStoppedKeys.length} stopped`
      );
    }
  } catch (error) {
    console.error('Polling error:', error);
  }
}

/**
 * Initialize the poller with cache services
 */
export function initializePoller(cache: CacheService, pubSub: PubSubService): void {
  cacheService = cache;
  pubSubService = pubSub;
}

/**
 * Start the polling job
 */
export function startPoller(config: Partial<PollerConfig> = {}): void {
  const mergedConfig = { ...defaultConfig, ...config };

  if (!mergedConfig.enabled) {
    console.log('Session poller disabled');
    return;
  }

  if (pollingInterval) {
    console.log('Poller already running');
    return;
  }

  console.log(`Starting session poller with ${mergedConfig.intervalMs}ms interval`);

  // Run immediately on start
  pollServers();

  // Then run on interval
  pollingInterval = setInterval(pollServers, mergedConfig.intervalMs);
}

/**
 * Stop the polling job
 */
export function stopPoller(): void {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
    console.log('Session poller stopped');
  }
}

/**
 * Force an immediate poll
 */
export async function triggerPoll(): Promise<void> {
  await pollServers();
}
