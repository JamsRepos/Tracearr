/**
 * Settings routes - Application configuration
 */

import type { FastifyPluginAsync } from 'fastify';
import type { InferSelectModel } from 'drizzle-orm';
import { eq, sql, isNotNull } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import {
  updateSettingsSchema,
  getPrimaryAuthMethod,
  type Settings,
  type WebhookFormat,
} from '@tracearr/shared';
import { db } from '../db/client.js';
import { settings, users, sessions, servers } from '../db/schema.js';
import { geoipService } from '../services/geoip.js';

// API token format: trr_pub_<32 random bytes as base64url>
const API_TOKEN_PREFIX = 'trr_pub_';

function generateApiToken(): string {
  const randomPart = randomBytes(32).toString('base64url');
  return `${API_TOKEN_PREFIX}${randomPart}`;
}

import { notificationManager } from '../services/notifications/index.js';

// Default settings row ID (singleton pattern)
const SETTINGS_ID = 1;

type SettingsRow = InferSelectModel<typeof settings>;

const maskIfSet = (value: string | null | undefined): string | null => (value ? '********' : null);

/** Build Settings API response from a DB row (masks secrets, derives primary from order when present). */
function rowToSettingsResponse(row: SettingsRow): Settings {
  const enabledLoginMethods = row.enabledLoginMethods ?? null;
  const primaryAuthMethod =
    row.primaryAuthMethod === 'jellyfin' || row.primaryAuthMethod === 'local'
      ? row.primaryAuthMethod
      : enabledLoginMethods
        ? getPrimaryAuthMethod(enabledLoginMethods)
        : 'local';

  return {
    allowGuestAccess: row.allowGuestAccess,
    unitSystem: row.unitSystem,
    discordWebhookUrl: row.discordWebhookUrl ?? null,
    customWebhookUrl: row.customWebhookUrl ?? null,
    webhookFormat: row.webhookFormat ?? null,
    ntfyTopic: row.ntfyTopic ?? null,
    ntfyAuthToken: maskIfSet(row.ntfyAuthToken),
    pushoverUserKey: row.pushoverUserKey ?? null,
    pushoverApiToken: maskIfSet(row.pushoverApiToken),
    pollerEnabled: row.pollerEnabled,
    pollerIntervalMs: row.pollerIntervalMs,
    usePlexGeoip: row.usePlexGeoip,
    tautulliUrl: row.tautulliUrl ?? null,
    tautulliApiKey: maskIfSet(row.tautulliApiKey),
    externalUrl: row.externalUrl ?? null,
    basePath: row.basePath ?? '',
    trustProxy: row.trustProxy,
    mobileEnabled: row.mobileEnabled,
    primaryAuthMethod,
    jellyfinOwnerId: row.jellyfinOwnerId ?? null,
    enabledLoginMethods,
  };
}

export const settingsRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /settings - Get application settings
   */
  app.get('/', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authUser = request.user;

    if (authUser.role !== 'owner') {
      return reply.forbidden('Only server owners can view settings');
    }

    let row: SettingsRow | undefined;
    try {
      const rows = await db.select().from(settings).where(eq(settings.id, SETTINGS_ID)).limit(1);
      row = rows[0];
    } catch {
      const fallback = await db
        .select({
          id: settings.id,
          allowGuestAccess: settings.allowGuestAccess,
          unitSystem: settings.unitSystem,
          discordWebhookUrl: settings.discordWebhookUrl,
          customWebhookUrl: settings.customWebhookUrl,
          webhookFormat: settings.webhookFormat,
          ntfyTopic: settings.ntfyTopic,
          ntfyAuthToken: settings.ntfyAuthToken,
          pushoverUserKey: settings.pushoverUserKey,
          pushoverApiToken: settings.pushoverApiToken,
          pollerEnabled: settings.pollerEnabled,
          pollerIntervalMs: settings.pollerIntervalMs,
          tautulliUrl: settings.tautulliUrl,
          tautulliApiKey: settings.tautulliApiKey,
          externalUrl: settings.externalUrl,
          basePath: settings.basePath,
          trustProxy: settings.trustProxy,
          mobileEnabled: settings.mobileEnabled,
          updatedAt: settings.updatedAt,
        })
        .from(settings)
        .where(eq(settings.id, SETTINGS_ID))
        .limit(1);
      row = fallback[0] as SettingsRow;
    }

    if (!row) {
      try {
        const inserted = await db
          .insert(settings)
          .values({ id: SETTINGS_ID, allowGuestAccess: false, primaryAuthMethod: 'local' })
          .returning();
        row = inserted[0];
      } catch {
        const inserted = await db
          .insert(settings)
          .values({ id: SETTINGS_ID, allowGuestAccess: false })
          .returning();
        row = inserted[0] as SettingsRow;
      }
    }

    if (!row) {
      return reply.internalServerError('Failed to load settings');
    }

    const result = rowToSettingsResponse(row);
    const hasPasswordAuth =
      (await db.select({ id: users.id }).from(users).where(isNotNull(users.passwordHash)).limit(1))
        .length > 0;
    return { ...result, hasPasswordAuth };
  });

  /**
   * PATCH /settings - Update application settings
   */
  app.patch('/', { preHandler: [app.authenticate] }, async (request, reply) => {
    const body = updateSettingsSchema.safeParse(request.body);
    if (!body.success) {
      return reply.badRequest('Invalid request body');
    }

    const authUser = request.user;

    // Only owners can update settings
    if (authUser.role !== 'owner') {
      return reply.forbidden('Only server owners can update settings');
    }

    // Build update object
    const updateData: Partial<{
      allowGuestAccess: boolean;
      unitSystem: 'metric' | 'imperial';
      discordWebhookUrl: string | null;
      customWebhookUrl: string | null;
      webhookFormat: WebhookFormat | null;
      ntfyTopic: string | null;
      ntfyAuthToken: string | null;
      pushoverUserKey: string | null;
      pushoverApiToken: string | null;
      pollerEnabled: boolean;
      pollerIntervalMs: number;
      usePlexGeoip: boolean;
      tautulliUrl: string | null;
      tautulliApiKey: string | null;
      externalUrl: string | null;
      basePath: string;
      trustProxy: boolean;
      primaryAuthMethod: 'jellyfin' | 'local';
      jellyfinOwnerId: string | null;
      enabledLoginMethods: ('plex' | 'jellyfin' | 'local')[] | null;
      updatedAt: Date;
    }> = {
      updatedAt: new Date(),
    };

    if (body.data.allowGuestAccess !== undefined) {
      updateData.allowGuestAccess = body.data.allowGuestAccess;
    }

    if (body.data.unitSystem !== undefined) {
      updateData.unitSystem = body.data.unitSystem;
    }

    if (body.data.discordWebhookUrl !== undefined) {
      updateData.discordWebhookUrl = body.data.discordWebhookUrl;
    }

    if (body.data.customWebhookUrl !== undefined) {
      updateData.customWebhookUrl = body.data.customWebhookUrl;
    }

    if (body.data.webhookFormat !== undefined) {
      updateData.webhookFormat = body.data.webhookFormat;
    }

    if (body.data.ntfyTopic !== undefined) {
      updateData.ntfyTopic = body.data.ntfyTopic;
    }

    if (body.data.ntfyAuthToken !== undefined) {
      updateData.ntfyAuthToken = body.data.ntfyAuthToken;
    }

    if (body.data.pushoverUserKey !== undefined) {
      updateData.pushoverUserKey = body.data.pushoverUserKey;
    }

    if (body.data.pushoverApiToken !== undefined) {
      updateData.pushoverApiToken = body.data.pushoverApiToken;
    }

    if (body.data.pollerEnabled !== undefined) {
      updateData.pollerEnabled = body.data.pollerEnabled;
    }

    if (body.data.pollerIntervalMs !== undefined) {
      updateData.pollerIntervalMs = body.data.pollerIntervalMs;
    }

    if (body.data.usePlexGeoip !== undefined) {
      updateData.usePlexGeoip = body.data.usePlexGeoip;
    }

    if (body.data.tautulliUrl !== undefined) {
      updateData.tautulliUrl = body.data.tautulliUrl;
    }

    if (body.data.tautulliApiKey !== undefined) {
      // Store API key as-is (could encrypt if needed)
      updateData.tautulliApiKey = body.data.tautulliApiKey;
    }

    if (body.data.externalUrl !== undefined) {
      // Strip trailing slash for consistency
      updateData.externalUrl = body.data.externalUrl?.replace(/\/+$/, '') ?? null;
    }

    if (body.data.basePath !== undefined) {
      // Normalize base path: ensure leading slash, no trailing slash
      let path = body.data.basePath.trim();
      if (path && !path.startsWith('/')) {
        path = '/' + path;
      }
      path = path.replace(/\/+$/, '');
      updateData.basePath = path;
    }

    if (body.data.trustProxy !== undefined) {
      updateData.trustProxy = body.data.trustProxy;
    }

    if (body.data.primaryAuthMethod !== undefined) {
      updateData.primaryAuthMethod = body.data.primaryAuthMethod;
    }

    if (body.data.jellyfinOwnerId !== undefined) {
      updateData.jellyfinOwnerId = body.data.jellyfinOwnerId;
    }

    if (body.data.enabledLoginMethods !== undefined) {
      const newEnabled = body.data.enabledLoginMethods;
      // Ensure at least one *usable* login method remains (user must be able to log in)
      const [plexServerRow, jellyfinServerRow, passwordUserRow] = await Promise.all([
        db.select({ id: servers.id }).from(servers).where(eq(servers.type, 'plex')).limit(1),
        db.select({ id: servers.id }).from(servers).where(eq(servers.type, 'jellyfin')).limit(1),
        db.select({ id: users.id }).from(users).where(isNotNull(users.passwordHash)).limit(1),
      ]);
      const hasPlexServers = plexServerRow.length > 0;
      const hasJellyfinServers = jellyfinServerRow.length > 0;
      const hasPasswordAuth = passwordUserRow.length > 0;
      const hasUsablePlex = newEnabled?.includes('plex') && hasPlexServers;
      const hasUsableJellyfin = newEnabled?.includes('jellyfin') && hasJellyfinServers;
      const hasUsableLocal = newEnabled?.includes('local') && hasPasswordAuth;
      const atLeastOneUsable = hasUsablePlex || hasUsableJellyfin || hasUsableLocal;
      if (!newEnabled || newEnabled.length === 0 || !atLeastOneUsable) {
        return reply.badRequest(
          'At least one enabled login method must be available (e.g. Plex requires a Plex server, Jellyfin requires a Jellyfin server, Local requires a password set).'
        );
      }
      updateData.enabledLoginMethods = newEnabled;
      updateData.primaryAuthMethod = getPrimaryAuthMethod(newEnabled);
    }

    // Ensure settings row exists
    const existing = await db.select().from(settings).where(eq(settings.id, SETTINGS_ID)).limit(1);

    if (existing.length === 0) {
      // Create with provided values - use full updateData with defaults for required fields
      // Note: mobileEnabled is not in updateData, so it will use the database default (false)
      await db.insert(settings).values({
        id: SETTINGS_ID,
        allowGuestAccess: updateData.allowGuestAccess ?? false,
        discordWebhookUrl: updateData.discordWebhookUrl ?? null,
        customWebhookUrl: updateData.customWebhookUrl ?? null,
        webhookFormat: updateData.webhookFormat ?? null,
        ntfyTopic: updateData.ntfyTopic ?? null,
        ntfyAuthToken: updateData.ntfyAuthToken ?? null,
        pushoverUserKey: updateData.pushoverUserKey ?? null,
        pushoverApiToken: updateData.pushoverApiToken ?? null,
        pollerEnabled: updateData.pollerEnabled ?? true,
        pollerIntervalMs: updateData.pollerIntervalMs ?? 15000,
        usePlexGeoip: updateData.usePlexGeoip ?? false,
        tautulliUrl: updateData.tautulliUrl ?? null,
        tautulliApiKey: updateData.tautulliApiKey ?? null,
        externalUrl: updateData.externalUrl ?? null,
        basePath: updateData.basePath ?? '',
        trustProxy: updateData.trustProxy ?? false,
        primaryAuthMethod: updateData.primaryAuthMethod ?? 'local',
        jellyfinOwnerId: updateData.jellyfinOwnerId ?? null,
        enabledLoginMethods: updateData.enabledLoginMethods ?? null,
      });
    } else {
      await db.update(settings).set(updateData).where(eq(settings.id, SETTINGS_ID));
    }

    // Return updated settings (full select; fallback if migration not run)
    let row: SettingsRow | undefined;
    try {
      const full = await db.select().from(settings).where(eq(settings.id, SETTINGS_ID)).limit(1);
      row = full[0];
    } catch {
      const fallback = await db
        .select({
          allowGuestAccess: settings.allowGuestAccess,
          unitSystem: settings.unitSystem,
          discordWebhookUrl: settings.discordWebhookUrl,
          customWebhookUrl: settings.customWebhookUrl,
          webhookFormat: settings.webhookFormat,
          ntfyTopic: settings.ntfyTopic,
          ntfyAuthToken: settings.ntfyAuthToken,
          pushoverUserKey: settings.pushoverUserKey,
          pushoverApiToken: settings.pushoverApiToken,
          pollerEnabled: settings.pollerEnabled,
          pollerIntervalMs: settings.pollerIntervalMs,
          usePlexGeoip: settings.usePlexGeoip,
          tautulliUrl: settings.tautulliUrl,
          tautulliApiKey: settings.tautulliApiKey,
          externalUrl: settings.externalUrl,
          basePath: settings.basePath,
          trustProxy: settings.trustProxy,
          mobileEnabled: settings.mobileEnabled,
          primaryAuthMethod: settings.primaryAuthMethod,
          jellyfinOwnerId: settings.jellyfinOwnerId,
          updatedAt: settings.updatedAt,
        })
        .from(settings)
        .where(eq(settings.id, SETTINGS_ID))
        .limit(1);
      row = fallback[0] as SettingsRow;
    }

    if (!row) {
      return reply.internalServerError('Failed to update settings');
    }

    const result = rowToSettingsResponse(row);
    const hasPasswordAuth =
      (await db.select({ id: users.id }).from(users).where(isNotNull(users.passwordHash)).limit(1))
        .length > 0;
    return { ...result, hasPasswordAuth };
  });

  /**
   * POST /settings/test-webhook - Send a test notification to verify webhook configuration
   */
  app.post<{
    Body: {
      type: 'discord' | 'custom';
      url?: string;
      format?: WebhookFormat;
      ntfyTopic?: string;
      ntfyAuthToken?: string;
      pushoverUserKey?: string;
      pushoverApiToken?: string;
    };
  }>('/test-webhook', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authUser = request.user;

    // Only owners can test webhooks
    if (authUser.role !== 'owner') {
      return reply.forbidden('Only server owners can test webhooks');
    }

    const { type, url, format } = request.body;

    if (!type) {
      return reply.badRequest('Missing webhook type');
    }

    // Get current settings to find the URL if not provided
    const settingsRow = await db
      .select()
      .from(settings)
      .where(eq(settings.id, SETTINGS_ID))
      .limit(1);

    const currentSettings = settingsRow[0];

    let webhookUrl: string | null = null;
    let webhookFormat: WebhookFormat = 'json';
    let ntfyTopic: string | null = null;
    let ntfyAuthToken: string | null = null;
    let pushoverUserKey: string | null = null;
    let pushoverApiToken: string | null = null;

    if (type === 'discord') {
      webhookUrl = url ?? currentSettings?.discordWebhookUrl ?? null;
    } else {
      webhookUrl = url ?? currentSettings?.customWebhookUrl ?? null;
      webhookFormat = format ?? currentSettings?.webhookFormat ?? 'json';
      ntfyTopic = currentSettings?.ntfyTopic ?? null;
      ntfyAuthToken = currentSettings?.ntfyAuthToken ?? null;
      pushoverUserKey = currentSettings?.pushoverUserKey ?? null;
      pushoverApiToken = currentSettings?.pushoverApiToken ?? null;
    }

    if (webhookFormat === 'pushover') {
      if (!pushoverUserKey || !pushoverApiToken) {
        return reply.badRequest('Pushover requires User Key and API Token');
      }
    } else if (!webhookUrl) {
      return reply.badRequest(`No ${type} webhook URL configured`);
    }

    // Build notification settings for testing
    const testSettings = {
      discordWebhookUrl: type === 'discord' ? webhookUrl : null,
      customWebhookUrl: type === 'custom' ? webhookUrl : null,
      webhookFormat,
      ntfyTopic,
      ntfyAuthToken,
      pushoverUserKey,
      pushoverApiToken,
    };

    // Determine which agent to test based on type and format
    let agentName: string;
    if (type === 'discord') {
      agentName = 'discord';
    } else {
      // Custom webhook - determine agent based on format
      switch (webhookFormat) {
        case 'ntfy':
          agentName = 'ntfy';
          break;
        case 'apprise':
          agentName = 'apprise';
          break;
        case 'pushover':
          agentName = 'pushover';
          break;
        default:
          agentName = 'json-webhook';
      }
    }

    const result = await notificationManager.testAgent(agentName, testSettings);

    if (!result.success) {
      return reply.code(502).send({
        success: false,
        error: result.error ?? 'Webhook test failed',
      });
    }

    return { success: true };
  });

  /**
   * GET /settings/api-key - Get current API key
   * Returns the full API key (retrievable anytime like Sonarr/Radarr)
   */
  app.get('/api-key', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authUser = request.user;

    // Only owners can manage API keys
    if (authUser.role !== 'owner') {
      return reply.forbidden('Only server owners can manage API keys');
    }

    const [user] = await db
      .select({ apiToken: users.apiToken })
      .from(users)
      .where(eq(users.id, authUser.userId))
      .limit(1);

    return { token: user?.apiToken ?? null };
  });

  /**
   * POST /settings/api-key/regenerate - Generate or regenerate API key
   * Creates a new API key, invalidating any previous key
   */
  app.post('/api-key/regenerate', { preHandler: [app.authenticate] }, async (request, reply) => {
    const authUser = request.user;

    // Only owners can manage API keys
    if (authUser.role !== 'owner') {
      return reply.forbidden('Only server owners can manage API keys');
    }

    const newToken = generateApiToken();

    await db
      .update(users)
      .set({ apiToken: newToken, updatedAt: new Date() })
      .where(eq(users.id, authUser.userId));

    return { token: newToken };
  });

  /**
   * GET /settings/ip-warning - Check if IP configuration warning should be shown
   * Returns whether all users have the same IP or all have local/private IPs
   */
  app.get('/ip-warning', { preHandler: [app.authenticate] }, async (_request, _reply) => {
    // Get distinct IPs from recent sessions (last 30 days)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const distinctIps = await db
      .selectDistinct({
        ipAddress: sessions.ipAddress,
      })
      .from(sessions)
      .where(sql`${sessions.startedAt} >= ${thirtyDaysAgo}`);

    // If no sessions, don't show warning
    if (distinctIps.length === 0) {
      return { showWarning: false, stateHash: 'no-sessions' };
    }

    // Check if all IPs are the same
    const uniqueIps = distinctIps
      .map((row) => row.ipAddress)
      .filter((ip): ip is string => ip !== null);
    const allSameIp = uniqueIps.length === 1;

    // Check if all IPs are private/local
    const allPrivate = uniqueIps.every((ip) => geoipService.isPrivateIP(ip));

    const showWarning = allSameIp || allPrivate;

    // Generate stateHash based on the situation
    let stateHash: string;
    if (allSameIp && allPrivate) {
      stateHash = 'single-private-ip';
    } else if (allSameIp) {
      stateHash = 'single-ip';
    } else if (allPrivate) {
      stateHash = 'all-private';
    } else {
      stateHash = 'normal';
    }

    return { showWarning, stateHash };
  });
};

/**
 * Get poller settings from database (for internal use by poller)
 */
export async function getPollerSettings(): Promise<{ enabled: boolean; intervalMs: number }> {
  const row = await db
    .select({
      pollerEnabled: settings.pollerEnabled,
      pollerIntervalMs: settings.pollerIntervalMs,
    })
    .from(settings)
    .where(eq(settings.id, SETTINGS_ID))
    .limit(1);

  const settingsRow = row[0];
  if (!settingsRow) {
    // Return defaults if settings don't exist yet
    return { enabled: true, intervalMs: 15000 };
  }

  return {
    enabled: settingsRow.pollerEnabled,
    intervalMs: settingsRow.pollerIntervalMs,
  };
}

/**
 * Get GeoIP settings from database (for internal use by poller/SSE processor)
 */
export async function getGeoIPSettings(): Promise<{ usePlexGeoip: boolean }> {
  try {
    const row = await db
      .select({
        usePlexGeoip: settings.usePlexGeoip,
      })
      .from(settings)
      .where(eq(settings.id, SETTINGS_ID))
      .limit(1);

    const settingsRow = row[0];
    if (!settingsRow) {
      // Return defaults if settings don't exist yet
      return { usePlexGeoip: false };
    }

    return {
      usePlexGeoip: settingsRow.usePlexGeoip,
    };
  } catch {
    // Column doesn't exist yet (before migration) - use default
    return { usePlexGeoip: false };
  }
}

/**
 * Get network settings from database (for internal use)
 */
export async function getNetworkSettings(): Promise<{
  externalUrl: string | null;
  basePath: string;
  trustProxy: boolean;
}> {
  const row = await db
    .select({
      externalUrl: settings.externalUrl,
      basePath: settings.basePath,
      trustProxy: settings.trustProxy,
    })
    .from(settings)
    .where(eq(settings.id, SETTINGS_ID))
    .limit(1);

  const settingsRow = row[0];
  if (!settingsRow) {
    // Return defaults if settings don't exist yet
    return { externalUrl: null, basePath: '', trustProxy: false };
  }

  return {
    externalUrl: settingsRow.externalUrl,
    basePath: settingsRow.basePath,
    trustProxy: settingsRow.trustProxy,
  };
}

/**
 * Notification settings for internal use by NotificationDispatcher
 */
export interface NotificationSettings {
  discordWebhookUrl: string | null;
  customWebhookUrl: string | null;
  webhookFormat: WebhookFormat | null;
  ntfyTopic: string | null;
  ntfyAuthToken: string | null;
  pushoverUserKey: string | null;
  pushoverApiToken: string | null;
  webhookSecret: string | null;
  mobileEnabled: boolean;
  unitSystem: 'metric' | 'imperial';
}

/**
 * Get notification settings from database (for internal use by notification dispatcher)
 */
export async function getNotificationSettings(): Promise<NotificationSettings> {
  const row = await db
    .select({
      discordWebhookUrl: settings.discordWebhookUrl,
      customWebhookUrl: settings.customWebhookUrl,
      webhookFormat: settings.webhookFormat,
      ntfyTopic: settings.ntfyTopic,
      ntfyAuthToken: settings.ntfyAuthToken,
      pushoverUserKey: settings.pushoverUserKey,
      pushoverApiToken: settings.pushoverApiToken,
      mobileEnabled: settings.mobileEnabled,
      unitSystem: settings.unitSystem,
    })
    .from(settings)
    .where(eq(settings.id, SETTINGS_ID))
    .limit(1);

  const settingsRow = row[0];
  if (!settingsRow) {
    // Return defaults if settings don't exist yet
    return {
      discordWebhookUrl: null,
      customWebhookUrl: null,
      webhookFormat: null,
      ntfyTopic: null,
      ntfyAuthToken: null,
      pushoverUserKey: null,
      pushoverApiToken: null,
      webhookSecret: null,
      mobileEnabled: false,
      unitSystem: 'metric',
    };
  }

  return {
    discordWebhookUrl: settingsRow.discordWebhookUrl,
    customWebhookUrl: settingsRow.customWebhookUrl,
    webhookFormat: settingsRow.webhookFormat,
    ntfyTopic: settingsRow.ntfyTopic,
    ntfyAuthToken: settingsRow.ntfyAuthToken,
    pushoverUserKey: settingsRow.pushoverUserKey,
    pushoverApiToken: settingsRow.pushoverApiToken,
    webhookSecret: null, // TODO: Add webhookSecret column to settings table in Phase 4
    mobileEnabled: settingsRow.mobileEnabled,
    unitSystem: settingsRow.unitSystem,
  };
}
