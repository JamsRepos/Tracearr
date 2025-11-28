/**
 * Plex API integration service
 */

import type { Server } from '@tracearr/shared';
import { decrypt } from '../utils/crypto.js';

const PLEX_TV_BASE = 'https://plex.tv';
const CLIENT_IDENTIFIER = 'tracearr';

const PLEX_HEADERS = {
  'X-Plex-Client-Identifier': CLIENT_IDENTIFIER,
  'X-Plex-Product': 'Tracearr',
  'X-Plex-Version': '1.0.0',
  'X-Plex-Platform': 'Node.js',
  Accept: 'application/json',
} as const;

export interface PlexAuthResult {
  id: string;
  username: string;
  email: string;
  thumb: string;
  token: string;
}

export interface PlexServerResource {
  name: string;
  product: string;
  productVersion: string;
  platform: string;
  clientIdentifier: string;
  owned: boolean;
  accessToken: string;
  publicAddress: string;
  connections: Array<{
    protocol: string;
    address: string;
    port: number;
    uri: string;
    local: boolean;
  }>;
}

export interface PlexSession {
  sessionKey: string;
  ratingKey: string; // Plex media identifier
  title: string; // Episode title or movie title
  type: string; // movie, episode, track
  duration: number;
  viewOffset: number;
  // Episode-specific fields
  grandparentTitle: string; // Show name (for episodes)
  parentTitle: string; // Season name (e.g., "Season 1")
  grandparentRatingKey: string; // Show rating key (for episodes)
  parentIndex: number; // Season number
  index: number; // Episode number
  year: number; // Release year (for movies)
  // Poster/art fields - these are Plex paths like /library/metadata/123/thumb/456
  thumb: string; // Episode/movie poster
  grandparentThumb: string; // Show poster (for episodes)
  art: string; // Background art
  user: { id: string; title: string; thumb: string };
  player: {
    title: string; // Player friendly name
    machineIdentifier: string; // Unique device UUID
    product: string; // Product name (e.g., "Plex for iOS")
    device: string; // Device type (e.g., "iPhone")
    platform: string; // Platform (e.g., "iOS")
    address: string; // Local IP address
    remotePublicAddress: string; // Public IP (better for geo)
    state: string;
    local: boolean; // Is the client on the local network
  };
  media: { bitrate: number; videoDecision: string };
}

export interface PlexLibrary {
  key: string;
  type: string;
  title: string;
  agent: string;
  scanner: string;
  uuid: string;
}

export interface PlexUser {
  id: number;
  title: string;
  username: string;
  email: string;
  thumb: string;
  admin: boolean;
  guest: boolean;
}

export interface PlexTvUser {
  id: string;
  username: string;
  title: string;
  email: string;
  thumb: string;
  isAdmin: boolean;
  isHomeUser: boolean;
  sharedLibraries: string[];
}

export interface PlexWatchHistory {
  ratingKey: string;
  title: string;
  type: string;
  viewedAt: number;
  accountId: number;
}

interface PlexPinResponse {
  id: number;
  code: string;
  authToken: string | null;
}

export class PlexService {
  private baseUrl: string;
  private token: string;

  constructor(server: Server & { token: string }) {
    this.baseUrl = server.url.replace(/\/$/, '');
    this.token = decrypt(server.token);
  }

  private buildHeaders(token?: string): Record<string, string> {
    return {
      ...PLEX_HEADERS,
      'X-Plex-Token': token ?? this.token,
    };
  }

  async getSessions(): Promise<PlexSession[]> {
    const response = await fetch(`${this.baseUrl}/status/sessions`, {
      headers: this.buildHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Plex sessions request failed: ${response.status}`);
    }

    const data = (await response.json()) as {
      MediaContainer?: { Metadata?: Record<string, unknown>[] };
    };
    const metadata = data.MediaContainer?.Metadata ?? [];

    return metadata.map((item) => {
      const player = item.Player as Record<string, unknown>;
      const user = item.User as Record<string, unknown>;
      return {
        sessionKey: String(item.sessionKey ?? ''),
        ratingKey: String(item.ratingKey ?? ''),
        title: String(item.title ?? ''),
        type: String(item.type ?? ''),
        duration: Number(item.duration ?? 0),
        viewOffset: Number(item.viewOffset ?? 0),
        // Episode-specific fields
        grandparentTitle: String(item.grandparentTitle ?? ''),
        parentTitle: String(item.parentTitle ?? ''),
        grandparentRatingKey: String(item.grandparentRatingKey ?? ''),
        parentIndex: Number(item.parentIndex ?? 0),
        index: Number(item.index ?? 0),
        year: Number(item.year ?? 0),
        // Poster/art fields
        thumb: String(item.thumb ?? ''),
        grandparentThumb: String(item.grandparentThumb ?? ''),
        art: String(item.art ?? ''),
        user: {
          id: String(user?.id ?? ''),
          title: String(user?.title ?? ''),
          thumb: String(user?.thumb ?? ''),
        },
        player: {
          title: String(player?.title ?? ''),
          machineIdentifier: String(player?.machineIdentifier ?? ''),
          product: String(player?.product ?? ''),
          device: String(player?.device ?? ''),
          platform: String(player?.platform ?? ''),
          address: String(player?.address ?? ''),
          remotePublicAddress: String(player?.remotePublicAddress ?? ''),
          state: String(player?.state ?? 'playing'),
          local: Boolean(player?.local ?? false),
        },
        media: {
          bitrate: Number((item.Media as Record<string, unknown>[])?.[0]?.bitrate ?? 0),
          videoDecision: String(
            (item.TranscodeSession as Record<string, unknown>)?.videoDecision ?? 'directplay'
          ),
        },
      };
    });
  }

  async getUsers(): Promise<PlexUser[]> {
    const response = await fetch(`${this.baseUrl}/accounts`, {
      headers: this.buildHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Plex users request failed: ${response.status}`);
    }

    const data = (await response.json()) as {
      MediaContainer?: { Account?: Record<string, unknown>[] };
    };
    const users = data.MediaContainer?.Account ?? [];

    return users.map((user) => ({
      id: Number(user.id ?? 0),
      title: String(user.name ?? ''),
      username: String(user.name ?? ''),
      email: '', // Local accounts don't have email
      thumb: String(user.thumb ?? ''),
      admin: user.id === 1, // Account ID 1 is typically the owner
      guest: false,
    }));
  }

  async getLibraries(): Promise<PlexLibrary[]> {
    const response = await fetch(`${this.baseUrl}/library/sections`, {
      headers: this.buildHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Plex libraries request failed: ${response.status}`);
    }

    const data = (await response.json()) as {
      MediaContainer?: { Directory?: Record<string, unknown>[] };
    };
    const directories = data.MediaContainer?.Directory ?? [];

    return directories.map((dir) => ({
      key: String(dir.key ?? ''),
      type: String(dir.type ?? ''),
      title: String(dir.title ?? ''),
      agent: String(dir.agent ?? ''),
      scanner: String(dir.scanner ?? ''),
      uuid: String(dir.uuid ?? ''),
    }));
  }

  static async initiateOAuth(): Promise<{ pinId: string; authUrl: string }> {
    const response = await fetch(`${PLEX_TV_BASE}/api/v2/pins`, {
      method: 'POST',
      headers: {
        ...PLEX_HEADERS,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ strong: 'true' }),
    });

    if (!response.ok) {
      throw new Error(`Failed to create Plex PIN: ${response.status}`);
    }

    const pin = (await response.json()) as PlexPinResponse;
    const authUrl = `https://app.plex.tv/auth#?clientID=${CLIENT_IDENTIFIER}&code=${pin.code}&context%5Bdevice%5D%5Bproduct%5D=Tracearr`;

    return {
      pinId: String(pin.id),
      authUrl,
    };
  }

  static async checkOAuthPin(pinId: string): Promise<PlexAuthResult | null> {
    const response = await fetch(`${PLEX_TV_BASE}/api/v2/pins/${pinId}`, {
      headers: PLEX_HEADERS,
    });

    if (!response.ok) {
      throw new Error(`Failed to check Plex PIN: ${response.status}`);
    }

    const pin = (await response.json()) as PlexPinResponse;

    if (!pin.authToken) {
      return null;
    }

    // Fetch user info with the token
    const userResponse = await fetch(`${PLEX_TV_BASE}/api/v2/user`, {
      headers: {
        ...PLEX_HEADERS,
        'X-Plex-Token': pin.authToken,
      },
    });

    if (!userResponse.ok) {
      throw new Error(`Failed to fetch Plex user: ${userResponse.status}`);
    }

    const user = (await userResponse.json()) as Record<string, unknown>;

    return {
      id: String(user.id ?? ''),
      username: String(user.username ?? ''),
      email: String(user.email ?? ''),
      thumb: String(user.thumb ?? ''),
      token: pin.authToken,
    };
  }

  static async verifyServerAdmin(token: string, serverUrl: string): Promise<boolean> {
    const url = serverUrl.replace(/\/$/, '');

    // First get server identity
    const response = await fetch(`${url}/`, {
      headers: {
        ...PLEX_HEADERS,
        'X-Plex-Token': token,
      },
    });

    if (!response.ok) {
      return false;
    }

    // Also verify by fetching accounts - only admin can do this
    const accountsResponse = await fetch(`${url}/accounts`, {
      headers: {
        ...PLEX_HEADERS,
        'X-Plex-Token': token,
      },
    });

    return accountsResponse.ok;
  }

  /**
   * Get watch history from server
   */
  async getWatchHistory(sectionId?: string, limit = 100): Promise<PlexWatchHistory[]> {
    const uri = sectionId
      ? `/library/sections/${sectionId}/allLeaves?type=1&unwatched=0&X-Plex-Container-Start=0&X-Plex-Container-Size=${limit}`
      : `/status/sessions/history/all?X-Plex-Container-Start=0&X-Plex-Container-Size=${limit}`;

    const response = await fetch(`${this.baseUrl}${uri}`, {
      headers: this.buildHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Plex history request failed: ${response.status}`);
    }

    const data = (await response.json()) as {
      MediaContainer?: { Metadata?: Record<string, unknown>[] };
    };
    const metadata = data.MediaContainer?.Metadata ?? [];

    return metadata.map((item) => ({
      ratingKey: String(item.ratingKey ?? ''),
      title: String(item.title ?? ''),
      type: String(item.type ?? ''),
      viewedAt: Number(item.lastViewedAt ?? item.viewedAt ?? 0),
      accountId: Number(item.accountID ?? 0),
    }));
  }

  /**
   * Get user's Plex servers from plex.tv
   * Returns only owned PMS (Plex Media Server) instances
   */
  static async getServers(token: string): Promise<PlexServerResource[]> {
    const response = await fetch(`${PLEX_TV_BASE}/api/v2/resources`, {
      headers: {
        ...PLEX_HEADERS,
        'X-Plex-Token': token,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch Plex resources: ${response.status}`);
    }

    const resources = (await response.json()) as Array<Record<string, unknown>>;

    // Filter for owned Plex Media Server instances only
    return resources
      .filter(
        (r) =>
          r.provides === 'server' &&
          r.owned === true &&
          r.product === 'Plex Media Server'
      )
      .map((r) => ({
        name: String(r.name ?? 'Plex Server'),
        product: String(r.product ?? ''),
        productVersion: String(r.productVersion ?? ''),
        platform: String(r.platform ?? ''),
        clientIdentifier: String(r.clientIdentifier ?? ''),
        owned: Boolean(r.owned),
        accessToken: String(r.accessToken ?? token),
        publicAddress: String(r.publicAddress ?? ''),
        connections: ((r.connections as Array<Record<string, unknown>>) ?? []).map((c) => ({
          protocol: String(c.protocol ?? 'http'),
          address: String(c.address ?? ''),
          port: Number(c.port ?? 32400),
          uri: String(c.uri ?? ''),
          local: Boolean(c.local),
        })),
      }));
  }

  /**
   * Get owner account info from plex.tv
   */
  static async getAccountInfo(token: string): Promise<PlexTvUser> {
    const response = await fetch(`${PLEX_TV_BASE}/api/v2/user`, {
      headers: {
        ...PLEX_HEADERS,
        'X-Plex-Token': token,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch Plex account: ${response.status}`);
    }

    const user = (await response.json()) as Record<string, unknown>;

    return {
      id: String(user.id ?? ''),
      username: String(user.username ?? ''),
      title: String(user.title ?? user.username ?? ''),
      email: String(user.email ?? ''),
      thumb: String(user.thumb ?? ''),
      isAdmin: true,
      isHomeUser: Boolean(user.home),
      sharedLibraries: [], // Owner has access to all
    };
  }

  /**
   * Get ALL shared users from plex.tv /api/users (XML endpoint like Tautulli)
   */
  static async getFriends(token: string): Promise<PlexTvUser[]> {
    const response = await fetch(`${PLEX_TV_BASE}/api/users`, {
      headers: {
        ...PLEX_HEADERS,
        'X-Plex-Token': token,
        Accept: 'application/xml',
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch Plex users: ${response.status}`);
    }

    const xml = await response.text();
    const users: PlexTvUser[] = [];

    // Parse XML - look for <User> elements
    const userMatches = xml.matchAll(/<User[^>]*(?:\/>|>[\s\S]*?<\/User>)/g);

    for (const match of userMatches) {
      const userXml = match[0];

      const getId = (s: string) => s.match(/(?:^|\s)id="([^"]+)"/)?.[1] ?? '';
      const getAttr = (attr: string) => userXml.match(new RegExp(`${attr}="([^"]+)"`))?.[1] ?? '';

      users.push({
        id: getId(userXml),
        username: getAttr('username') || getAttr('title'),
        title: getAttr('title') || getAttr('username'),
        email: getAttr('email'),
        thumb: getAttr('thumb'),
        isAdmin: false,
        isHomeUser: getAttr('home') === '1',
        sharedLibraries: [],
      });
    }

    console.log(`getFriends: found ${users.length} users from /api/users`);
    return users;
  }

  /**
   * Get shared server info (server_token and shared_libraries per user)
   * Uses XML endpoint like Tautulli: /api/servers/{machine_id}/shared_servers
   */
  static async getSharedServerUsers(
    token: string,
    machineIdentifier: string
  ): Promise<Map<string, { serverToken: string; sharedLibraries: string[] }>> {
    const response = await fetch(
      `${PLEX_TV_BASE}/api/servers/${machineIdentifier}/shared_servers`,
      {
        headers: {
          ...PLEX_HEADERS,
          'X-Plex-Token': token,
          Accept: 'application/xml',
        },
      }
    );

    if (!response.ok) {
      console.log(`shared_servers response: ${response.status}`);
      return new Map();
    }

    const xml = await response.text();
    const userMap = new Map<string, { serverToken: string; sharedLibraries: string[] }>();

    // Parse XML - look for <SharedServer> elements
    const serverMatches = xml.matchAll(/<SharedServer[^>]*>[\s\S]*?<\/SharedServer>/g);

    for (const match of serverMatches) {
      const serverXml = match[0];

      const userId = serverXml.match(/userID="([^"]+)"/)?.[1] ?? '';
      const serverToken = serverXml.match(/accessToken="([^"]+)"/)?.[1] ?? '';

      // Get shared libraries - sections with shared="1"
      const sharedLibraries: string[] = [];
      const sectionMatches = serverXml.matchAll(/<Section[^>]*shared="1"[^>]*>/g);
      for (const sectionMatch of sectionMatches) {
        const key = sectionMatch[0].match(/key="([^"]+)"/)?.[1];
        if (key) sharedLibraries.push(key);
      }

      if (userId) {
        userMap.set(userId, { serverToken, sharedLibraries });
      }
    }

    console.log(`getSharedServerUsers: found ${userMap.size} users with server access`);
    return userMap;
  }

  /**
   * Get all users with access to this specific server
   * Combines /api/users + /api/servers/{id}/shared_servers like Tautulli
   */
  static async getAllUsersWithLibraries(
    token: string,
    machineIdentifier: string
  ): Promise<PlexTvUser[]> {
    const [owner, allFriends, sharedServerMap] = await Promise.all([
      PlexService.getAccountInfo(token),
      PlexService.getFriends(token),
      PlexService.getSharedServerUsers(token, machineIdentifier),
    ]);

    // Enrich friends with shared_libraries from shared_servers
    // Only include users who have access to THIS server (appear in sharedServerMap)
    const usersWithAccess = allFriends
      .filter((friend) => sharedServerMap.has(friend.id))
      .map((friend) => ({
        ...friend,
        sharedLibraries: sharedServerMap.get(friend.id)?.sharedLibraries ?? [],
      }));

    console.log(`getAllUsersWithLibraries: owner=${owner.username}, friends=${allFriends.length}, withAccess=${usersWithAccess.length}`);

    // Owner always has access to all libraries
    return [owner, ...usersWithAccess];
  }
}
