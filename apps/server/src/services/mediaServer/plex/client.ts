/**
 * Plex Media Server Client
 *
 * Implements IMediaServerClient for Plex servers.
 * Provides a unified interface for session tracking, user management, and library access.
 */

import { decrypt } from '../../../utils/crypto.js';
import { fetchJson, fetchText, plexHeaders } from '../../../utils/http.js';
import type {
  IMediaServerClient,
  IMediaServerClientWithHistory,
  MediaSession,
  MediaUser,
  MediaLibrary,
  MediaWatchHistoryItem,
  MediaServerConfig,
} from '../types.js';
import {
  parseSessionsResponse,
  parseUsersResponse,
  parseLibrariesResponse,
  parseWatchHistoryResponse,
  parseServerResourcesResponse,
  parsePlexTvUser,
  parseXmlUsersResponse,
  parseSharedServersXml,
  parseStatisticsResourcesResponse,
  type PlexServerResource,
  type PlexStatisticsDataPoint,
} from './parser.js';

const PLEX_TV_BASE = 'https://plex.tv';

/**
 * Plex Media Server client implementation
 *
 * @example
 * const client = new PlexClient({ url: 'http://plex.local:32400', token: 'xxx' });
 * const sessions = await client.getSessions();
 */
export class PlexClient implements IMediaServerClient, IMediaServerClientWithHistory {
  public readonly serverType = 'plex' as const;

  private readonly baseUrl: string;
  private readonly token: string;

  constructor(config: MediaServerConfig) {
    this.baseUrl = config.url.replace(/\/$/, '');
    this.token = decrypt(config.token);
  }

  /**
   * Build headers for Plex API requests
   */
  private buildHeaders(): Record<string, string> {
    return plexHeaders(this.token);
  }

  // ==========================================================================
  // IMediaServerClient Implementation
  // ==========================================================================

  /**
   * Get all active playback sessions
   */
  async getSessions(): Promise<MediaSession[]> {
    const data = await fetchJson<unknown>(`${this.baseUrl}/status/sessions`, {
      headers: this.buildHeaders(),
      service: 'plex',
      timeout: 10000, // 10s timeout to prevent polling hangs
    });

    return parseSessionsResponse(data);
  }

  /**
   * Get all local users (accounts from /accounts endpoint)
   *
   * Note: For complete user lists including shared users,
   * use PlexClient.getAllUsersWithLibraries() static method.
   */
  async getUsers(): Promise<MediaUser[]> {
    const data = await fetchJson<unknown>(`${this.baseUrl}/accounts`, {
      headers: this.buildHeaders(),
      service: 'plex',
    });

    return parseUsersResponse(data);
  }

  /**
   * Get all libraries on this server
   */
  async getLibraries(): Promise<MediaLibrary[]> {
    const data = await fetchJson<unknown>(`${this.baseUrl}/library/sections`, {
      headers: this.buildHeaders(),
      service: 'plex',
    });

    return parseLibrariesResponse(data);
  }

  /**
   * Test connection to the server
   */
  async testConnection(): Promise<boolean> {
    try {
      await fetchJson<unknown>(`${this.baseUrl}/`, {
        headers: this.buildHeaders(),
        service: 'plex',
        timeout: 10000,
      });
      return true;
    } catch {
      return false;
    }
  }

  // ==========================================================================
  // IMediaServerClientWithHistory Implementation
  // ==========================================================================

  /**
   * Get watch history from server
   */
  async getWatchHistory(options?: {
    userId?: string;
    limit?: number;
  }): Promise<MediaWatchHistoryItem[]> {
    const limit = options?.limit ?? 100;
    const uri = `/status/sessions/history/all?X-Plex-Container-Start=0&X-Plex-Container-Size=${limit}`;

    const data = await fetchJson<unknown>(`${this.baseUrl}${uri}`, {
      headers: this.buildHeaders(),
      service: 'plex',
    });

    return parseWatchHistoryResponse(data);
  }

  // ==========================================================================
  // Server Resource Statistics (Undocumented Endpoint)
  // ==========================================================================

  /**
   * Get server resource statistics (CPU, RAM utilization)
   *
   * Uses the undocumented /statistics/resources endpoint.
   * Returns ~27 data points covering ~2.5 minutes of history at 6-second intervals.
   *
   * @param timespan - Interval between data points in seconds (default: 6)
   * @returns Array of resource data points, sorted newest first
   */
  async getServerStatistics(timespan: number = 6): Promise<PlexStatisticsDataPoint[]> {
    const url = `${this.baseUrl}/statistics/resources?timespan=${timespan}`;

    const data = await fetchJson<unknown>(url, {
      headers: this.buildHeaders(),
      service: 'plex',
      timeout: 10000,
    });

    return parseStatisticsResourcesResponse(data);
  }

  // ==========================================================================
  // Static Methods - Plex.tv API Operations
  // ==========================================================================

  /**
   * Initiate OAuth flow for Plex authentication
   * Returns a PIN ID and auth URL for user to authorize
   * @param forwardUrl - URL to redirect to after auth (for popup auto-close)
   */
  static async initiateOAuth(forwardUrl?: string): Promise<{ pinId: string; authUrl: string }> {
    const headers = plexHeaders();

    const data = await fetchJson<{ id: number; code: string }>(
      `${PLEX_TV_BASE}/api/v2/pins`,
      {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ strong: 'true' }),
        service: 'plex.tv',
      }
    );

    const params = new URLSearchParams({
      clientID: 'tracearr',
      code: data.code,
      'context[device][product]': 'Tracearr',
    });

    if (forwardUrl) {
      params.set('forwardUrl', forwardUrl);
    }

    const authUrl = `https://app.plex.tv/auth#?${params.toString()}`;

    return {
      pinId: String(data.id),
      authUrl,
    };
  }

  /**
   * Check if OAuth PIN has been authorized
   * Returns auth result if authorized, null if still pending
   */
  static async checkOAuthPin(pinId: string): Promise<{
    id: string;
    username: string;
    email: string;
    thumb: string;
    token: string;
  } | null> {
    const headers = plexHeaders();

    const pin = await fetchJson<{ authToken: string | null }>(
      `${PLEX_TV_BASE}/api/v2/pins/${pinId}`,
      { headers, service: 'plex.tv' }
    );

    if (!pin.authToken) {
      return null;
    }

    // Fetch user info with the token
    const user = await fetchJson<Record<string, unknown>>(
      `${PLEX_TV_BASE}/api/v2/user`,
      {
        headers: plexHeaders(pin.authToken),
        service: 'plex.tv',
      }
    );

    return {
      id: String(user.id ?? ''),
      username: String(user.username ?? ''),
      email: String(user.email ?? ''),
      thumb: String(user.thumb ?? ''),
      token: pin.authToken,
    };
  }

  /**
   * Verify if token has admin access to a Plex server
   */
  static async verifyServerAdmin(token: string, serverUrl: string): Promise<boolean> {
    const url = serverUrl.replace(/\/$/, '');
    const headers = plexHeaders(token);

    try {
      // First verify basic server access
      await fetchJson<unknown>(`${url}/`, {
        headers,
        service: 'plex',
        timeout: 10000,
      });

      // Then verify admin access by fetching accounts
      await fetchJson<unknown>(`${url}/accounts`, {
        headers,
        service: 'plex',
        timeout: 10000,
      });

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get user's owned Plex servers from plex.tv
   */
  static async getServers(token: string): Promise<PlexServerResource[]> {
    const data = await fetchJson<unknown>(`${PLEX_TV_BASE}/api/v2/resources`, {
      headers: plexHeaders(token),
      service: 'plex.tv',
    });

    return parseServerResourcesResponse(data, token);
  }

  /**
   * Get owner account info from plex.tv
   */
  static async getAccountInfo(token: string): Promise<MediaUser> {
    const user = await fetchJson<Record<string, unknown>>(
      `${PLEX_TV_BASE}/api/v2/user`,
      {
        headers: plexHeaders(token),
        service: 'plex.tv',
      }
    );

    return parsePlexTvUser(
      {
        ...user,
        isAdmin: true,
      },
      [] // Owner has access to all libraries
    );
  }

  /**
   * Get all shared users from plex.tv (XML endpoint)
   */
  static async getFriends(token: string): Promise<MediaUser[]> {
    const headers = {
      ...plexHeaders(token),
      Accept: 'application/xml',
    };

    const xml = await fetchText(`${PLEX_TV_BASE}/api/users`, {
      headers,
      service: 'plex.tv',
    });

    return parseXmlUsersResponse(xml);
  }

  /**
   * Get shared server info (server_token and shared_libraries per user)
   */
  static async getSharedServerUsers(
    token: string,
    machineIdentifier: string
  ): Promise<Map<string, { serverToken: string; sharedLibraries: string[] }>> {
    const headers = {
      ...plexHeaders(token),
      Accept: 'application/xml',
    };

    try {
      const xml = await fetchText(
        `${PLEX_TV_BASE}/api/servers/${machineIdentifier}/shared_servers`,
        { headers, service: 'plex.tv' }
      );

      return parseSharedServersXml(xml);
    } catch {
      // Return empty map if endpoint fails
      return new Map();
    }
  }

  /**
   * Get all users with access to a specific server
   * Combines /api/users + /api/servers/{id}/shared_servers
   */
  static async getAllUsersWithLibraries(
    token: string,
    machineIdentifier: string
  ): Promise<MediaUser[]> {
    const [owner, allFriends, sharedServerMap] = await Promise.all([
      PlexClient.getAccountInfo(token),
      PlexClient.getFriends(token),
      PlexClient.getSharedServerUsers(token, machineIdentifier),
    ]);

    // Enrich friends with shared_libraries from shared_servers
    // Only include users who have access to THIS server
    const usersWithAccess = allFriends
      .filter((friend) => sharedServerMap.has(friend.id))
      .map((friend) => ({
        ...friend,
        sharedLibraries: sharedServerMap.get(friend.id)?.sharedLibraries ?? [],
      }));

    // Owner always has access to all libraries
    return [owner, ...usersWithAccess];
  }
}
