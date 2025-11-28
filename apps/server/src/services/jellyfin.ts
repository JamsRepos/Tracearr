/**
 * Jellyfin API integration service
 */

import type { Server } from '@tracearr/shared';
import { decrypt } from '../utils/crypto.js';

const CLIENT_NAME = 'Tracearr';
const CLIENT_VERSION = '1.0.0';
const DEVICE_ID = 'tracearr-server';
const DEVICE_NAME = 'Tracearr Server';

export interface JellyfinAuthResult {
  id: string;
  username: string;
  token: string;
  serverId: string;
  isAdmin: boolean;
}

export interface JellyfinSession {
  id: string;
  userId: string;
  userName: string;
  userPrimaryImageTag?: string; // User avatar
  client: string;
  deviceName: string;
  deviceId: string;
  deviceType?: string;
  remoteEndPoint: string;
  nowPlayingItem?: {
    id: string; // Jellyfin item ID (equivalent to Plex ratingKey)
    name: string; // Episode title or movie title
    type: string; // Movie, Episode, Audio
    runTimeTicks: number;
    // Episode-specific fields
    seriesName?: string; // Show name (for episodes)
    seasonName?: string; // Season name (e.g., "Season 1")
    seriesId?: string; // Show ID (for episodes)
    parentIndexNumber?: number; // Season number
    indexNumber?: number; // Episode number
    productionYear?: number; // Release year
    // Poster fields - Jellyfin uses ImageTags
    imageTags?: {
      Primary?: string;
    };
    seriesPrimaryImageTag?: string; // Show poster tag (for episodes)
  };
  playState?: {
    positionTicks: number;
    isPaused: boolean;
  };
  transcodingInfo?: {
    isVideoDirect: boolean;
    bitrate: number;
  };
}

export interface JellyfinLibrary {
  id: string;
  name: string;
  collectionType: string;
  locations: string[];
}

export interface JellyfinUser {
  id: string;
  name: string;
  hasPassword: boolean;
  isAdministrator: boolean;
  isDisabled: boolean;
  lastLoginDate: string | null;
  lastActivityDate: string | null;
}

interface JellyfinAuthResponse {
  User: {
    Id: string;
    Name: string;
    ServerId: string;
    Policy: {
      IsAdministrator: boolean;
    };
  };
  AccessToken: string;
  ServerId: string;
}

export class JellyfinService {
  private baseUrl: string;
  private apiKey: string;

  constructor(server: Server & { token: string }) {
    this.baseUrl = server.url.replace(/\/$/, '');
    this.apiKey = decrypt(server.token);
  }

  private buildAuthHeader(): string {
    return `MediaBrowser Client="${CLIENT_NAME}", Device="${DEVICE_NAME}", DeviceId="${DEVICE_ID}", Version="${CLIENT_VERSION}", Token="${this.apiKey}"`;
  }

  private buildHeaders(): Record<string, string> {
    return {
      'X-Emby-Authorization': this.buildAuthHeader(),
      Accept: 'application/json',
    };
  }

  async getSessions(): Promise<JellyfinSession[]> {
    const response = await fetch(`${this.baseUrl}/Sessions`, {
      headers: this.buildHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Jellyfin sessions request failed: ${response.status}`);
    }

    const sessions = (await response.json()) as Record<string, unknown>[];

    // Filter to sessions with active playback
    return sessions
      .filter((session) => session.NowPlayingItem)
      .map((session) => {
        const nowPlaying = session.NowPlayingItem as Record<string, unknown>;
        const imageTags = nowPlaying?.ImageTags as Record<string, string> | undefined;

        return {
          id: String(session.Id ?? ''),
          userId: String(session.UserId ?? ''),
          userName: String(session.UserName ?? ''),
          userPrimaryImageTag: session.UserPrimaryImageTag ? String(session.UserPrimaryImageTag) : undefined,
          client: String(session.Client ?? ''),
          deviceName: String(session.DeviceName ?? ''),
          deviceId: String(session.DeviceId ?? ''),
          deviceType: session.DeviceType ? String(session.DeviceType) : undefined,
          remoteEndPoint: String(session.RemoteEndPoint ?? ''),
          nowPlayingItem: nowPlaying
            ? {
                id: String(nowPlaying.Id ?? ''),
                name: String(nowPlaying.Name ?? ''),
                type: String(nowPlaying.Type ?? ''),
                runTimeTicks: Number(nowPlaying.RunTimeTicks ?? 0),
                // Episode-specific fields
                seriesName: nowPlaying.SeriesName ? String(nowPlaying.SeriesName) : undefined,
                seasonName: nowPlaying.SeasonName ? String(nowPlaying.SeasonName) : undefined,
                seriesId: nowPlaying.SeriesId ? String(nowPlaying.SeriesId) : undefined,
                parentIndexNumber: nowPlaying.ParentIndexNumber ? Number(nowPlaying.ParentIndexNumber) : undefined,
                indexNumber: nowPlaying.IndexNumber ? Number(nowPlaying.IndexNumber) : undefined,
                productionYear: nowPlaying.ProductionYear ? Number(nowPlaying.ProductionYear) : undefined,
                // Poster fields
                imageTags: imageTags ? { Primary: imageTags.Primary } : undefined,
                seriesPrimaryImageTag: nowPlaying.SeriesPrimaryImageTag ? String(nowPlaying.SeriesPrimaryImageTag) : undefined,
              }
            : undefined,
          playState: session.PlayState
            ? {
                positionTicks: Number(
                  (session.PlayState as Record<string, unknown>).PositionTicks ?? 0
                ),
                isPaused: Boolean(
                  (session.PlayState as Record<string, unknown>).IsPaused ?? false
                ),
              }
            : undefined,
          transcodingInfo: session.TranscodingInfo
            ? {
                isVideoDirect: Boolean(
                  (session.TranscodingInfo as Record<string, unknown>).IsVideoDirect ??
                    true
                ),
                bitrate: Number(
                  (session.TranscodingInfo as Record<string, unknown>).Bitrate ?? 0
                ),
              }
            : undefined,
        };
      });
  }

  async getUsers(): Promise<JellyfinUser[]> {
    const response = await fetch(`${this.baseUrl}/Users`, {
      headers: this.buildHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Jellyfin users request failed: ${response.status}`);
    }

    const users = (await response.json()) as Record<string, unknown>[];

    return users.map((user) => ({
      id: String(user.Id ?? ''),
      name: String(user.Name ?? ''),
      hasPassword: Boolean(user.HasPassword ?? false),
      isAdministrator: Boolean(
        (user.Policy as Record<string, unknown>)?.IsAdministrator ?? false
      ),
      isDisabled: Boolean(
        (user.Policy as Record<string, unknown>)?.IsDisabled ?? false
      ),
      lastLoginDate: user.LastLoginDate ? String(user.LastLoginDate) : null,
      lastActivityDate: user.LastActivityDate ? String(user.LastActivityDate) : null,
    }));
  }

  async getLibraries(): Promise<JellyfinLibrary[]> {
    const response = await fetch(`${this.baseUrl}/Library/VirtualFolders`, {
      headers: this.buildHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Jellyfin libraries request failed: ${response.status}`);
    }

    const folders = (await response.json()) as Record<string, unknown>[];

    return folders.map((folder) => ({
      id: String(folder.ItemId ?? ''),
      name: String(folder.Name ?? ''),
      collectionType: String(folder.CollectionType ?? 'unknown'),
      locations: Array.isArray(folder.Locations)
        ? (folder.Locations as string[])
        : [],
    }));
  }

  static async authenticate(
    serverUrl: string,
    username: string,
    password: string
  ): Promise<JellyfinAuthResult | null> {
    const url = serverUrl.replace(/\/$/, '');
    const authHeader = `MediaBrowser Client="${CLIENT_NAME}", Device="${DEVICE_NAME}", DeviceId="${DEVICE_ID}", Version="${CLIENT_VERSION}"`;

    const response = await fetch(`${url}/Users/AuthenticateByName`, {
      method: 'POST',
      headers: {
        'X-Emby-Authorization': authHeader,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        Username: username,
        Pw: password,
      }),
    });

    if (!response.ok) {
      if (response.status === 401) {
        return null; // Invalid credentials
      }
      throw new Error(`Jellyfin authentication failed: ${response.status}`);
    }

    const data = (await response.json()) as JellyfinAuthResponse;

    return {
      id: data.User.Id,
      username: data.User.Name,
      token: data.AccessToken,
      serverId: data.ServerId,
      isAdmin: data.User.Policy.IsAdministrator,
    };
  }

  static async verifyServerAdmin(apiKey: string, serverUrl: string): Promise<boolean> {
    const url = serverUrl.replace(/\/$/, '');
    const authHeader = `MediaBrowser Client="${CLIENT_NAME}", Device="${DEVICE_NAME}", DeviceId="${DEVICE_ID}", Version="${CLIENT_VERSION}", Token="${apiKey}"`;

    const response = await fetch(`${url}/Users/Me`, {
      headers: {
        'X-Emby-Authorization': authHeader,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      return false;
    }

    const user = (await response.json()) as Record<string, unknown>;
    const policy = user.Policy as Record<string, unknown> | undefined;

    return Boolean(policy?.IsAdministrator ?? false);
  }
}
