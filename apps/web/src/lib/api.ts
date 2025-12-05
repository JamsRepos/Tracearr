import type {
  Server,
  User,
  UserRole,
  ServerUserWithIdentity,
  ServerUserDetail,
  Session,
  SessionWithDetails,
  ActiveSession,
  Rule,
  Violation,
  ViolationWithDetails,
  DashboardStats,
  PlayStats,
  UserStats,
  TopUserStats,
  LocationStatsResponse,
  UserLocation,
  UserDevice,
  Settings,
  PaginatedResponse,
  MobileConfig,
} from '@tracearr/shared';
import { API_BASE_PATH } from '@tracearr/shared';

// Types for Plex server selection
export interface PlexServerConnection {
  uri: string;
  local: boolean;
  address: string;
  port: number;
}

export interface PlexServerInfo {
  name: string;
  platform: string;
  version: string;
  connections: PlexServerConnection[];
}

export interface PlexCheckPinResponse {
  authorized: boolean;
  message?: string;
  // If returning user (auto-connect)
  accessToken?: string;
  refreshToken?: string;
  user?: User;
  // If new user (needs server selection)
  needsServerSelection?: boolean;
  servers?: PlexServerInfo[];
  tempToken?: string;
}

// Token storage keys
const ACCESS_TOKEN_KEY = 'tracearr_access_token';
const REFRESH_TOKEN_KEY = 'tracearr_refresh_token';

// Event for auth state changes (logout, token cleared, etc.)
export const AUTH_STATE_CHANGE_EVENT = 'tracearr:auth-state-change';

// Token management utilities
export const tokenStorage = {
  getAccessToken: (): string | null => localStorage.getItem(ACCESS_TOKEN_KEY),
  getRefreshToken: (): string | null => localStorage.getItem(REFRESH_TOKEN_KEY),
  setTokens: (accessToken: string, refreshToken: string) => {
    localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
    localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
  },
  /**
   * Clear tokens from storage
   * @param silent - If true, don't dispatch auth change event (used for intentional logout)
   */
  clearTokens: (silent = false) => {
    localStorage.removeItem(ACCESS_TOKEN_KEY);
    localStorage.removeItem(REFRESH_TOKEN_KEY);
    // Dispatch event so auth context can react immediately (unless silent)
    if (!silent) {
      window.dispatchEvent(new CustomEvent(AUTH_STATE_CHANGE_EVENT, { detail: { type: 'logout' } }));
    }
  },
};

class ApiClient {
  private baseUrl: string;
  private isRefreshing = false;
  private refreshPromise: Promise<boolean> | null = null;

  constructor(baseUrl: string = API_BASE_PATH) {
    this.baseUrl = baseUrl;
  }

  /**
   * Attempt to refresh the access token using the refresh token
   * Returns true if refresh succeeded, false otherwise
   */
  private async refreshAccessToken(): Promise<boolean> {
    const refreshToken = tokenStorage.getRefreshToken();
    if (!refreshToken) {
      return false;
    }

    try {
      const response = await fetch(`${this.baseUrl}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });

      if (!response.ok) {
        // Only clear tokens on explicit auth rejection (401/403)
        // Don't clear on server errors (500, 502, 503) - server might be restarting
        if (response.status === 401 || response.status === 403) {
          tokenStorage.clearTokens();
        }
        return false;
      }

      const data = await response.json();
      if (data.accessToken && data.refreshToken) {
        tokenStorage.setTokens(data.accessToken, data.refreshToken);
        return true;
      }

      return false;
    } catch {
      // Network error (server down, timeout, etc.)
      // DON'T clear tokens - they might still be valid when server comes back
      return false;
    }
  }

  /**
   * Handle token refresh with deduplication
   * Multiple concurrent 401s will share the same refresh attempt
   */
  private async handleTokenRefresh(): Promise<boolean> {
    if (this.isRefreshing) {
      return this.refreshPromise!;
    }

    this.isRefreshing = true;
    this.refreshPromise = this.refreshAccessToken().finally(() => {
      this.isRefreshing = false;
      this.refreshPromise = null;
    });

    return this.refreshPromise;
  }

  private async request<T>(
    path: string,
    options: RequestInit = {},
    isRetry = false
  ): Promise<T> {
    const headers: Record<string, string> = {
      ...(options.headers as Record<string, string>),
    };

    // Only set Content-Type for requests with a body
    if (options.body) {
      headers['Content-Type'] = 'application/json';
    }

    // Add Authorization header if we have a token
    const token = tokenStorage.getAccessToken();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const response = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      credentials: 'include',
      headers,
    });

    // Handle 401 with automatic token refresh (skip for auth endpoints to avoid loops)
    // Note: /auth/me is NOT in this list - it SHOULD trigger token refresh on 401
    const noRetryPaths = ['/auth/login', '/auth/signup', '/auth/refresh', '/auth/logout', '/auth/plex/check-pin', '/auth/callback'];
    const shouldRetry = !noRetryPaths.some(p => path.startsWith(p));
    if (response.status === 401 && !isRetry && shouldRetry) {
      const refreshed = await this.handleTokenRefresh();
      if (refreshed) {
        // Retry the original request with new token
        return this.request<T>(path, options, true);
      }
      // Refresh failed - tokens already cleared by refreshAccessToken() if it was a real auth failure
      // Don't clear here - might just be a network error (server restarting)
    }

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.message ?? `Request failed: ${response.status}`);
    }

    // Handle empty responses (204 No Content) or responses without JSON
    const contentType = response.headers.get('content-type');
    if (response.status === 204 || !contentType?.includes('application/json')) {
      return undefined as T;
    }

    return response.json();
  }

  // Setup - check if Tracearr needs initial configuration
  setup = {
    status: () => this.request<{
      needsSetup: boolean;
      hasServers: boolean;
      hasPasswordAuth: boolean;
    }>('/setup/status'),
  };

  // Auth
  auth = {
    me: () => this.request<{
      userId: string;
      username: string;
      email: string | null;
      thumbnail: string | null;
      role: UserRole;
      aggregateTrustScore: number;
      serverIds: string[];
      hasPassword?: boolean;
      hasPlexLinked?: boolean;
      // Fallback fields for backwards compatibility
      id?: string;
      serverId?: string;
      thumbUrl?: string | null;
      trustScore?: number;
    }>('/auth/me'),
    logout: () => this.request<void>('/auth/logout', { method: 'POST' }),

    // Local account signup (email for login, username for display)
    signup: (data: { email: string; username: string; password: string }) =>
      this.request<{ accessToken: string; refreshToken: string; user: User }>('/auth/signup', {
        method: 'POST',
        body: JSON.stringify(data),
      }),

    // Local account login (uses email)
    loginLocal: (data: { email: string; password: string }) =>
      this.request<{ accessToken: string; refreshToken: string; user: User }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ type: 'local', ...data }),
      }),

    // Plex OAuth - Step 1: Get PIN
    loginPlex: (forwardUrl?: string) =>
      this.request<{ pinId: string; authUrl: string }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ type: 'plex', forwardUrl }),
      }),

    // Plex OAuth - Step 2: Check PIN and get servers
    checkPlexPin: (pinId: string) =>
      this.request<PlexCheckPinResponse>('/auth/plex/check-pin', {
        method: 'POST',
        body: JSON.stringify({ pinId }),
      }),

    // Plex OAuth - Step 3: Connect with selected server (only for setup)
    connectPlexServer: (data: { tempToken: string; serverUri: string; serverName: string }) =>
      this.request<{ accessToken: string; refreshToken: string; user: User }>('/auth/plex/connect', {
        method: 'POST',
        body: JSON.stringify(data),
      }),

    // Jellyfin server connection with API key (requires auth)
    connectJellyfinWithApiKey: (data: {
      serverUrl: string;
      serverName: string;
      apiKey: string;
    }) =>
      this.request<{
        accessToken: string;
        refreshToken: string;
        user: User;
      }>('/auth/jellyfin/connect-api-key', {
        method: 'POST',
        body: JSON.stringify(data),
      }),

    // Emby server connection with API key (requires auth)
    connectEmbyWithApiKey: (data: {
      serverUrl: string;
      serverName: string;
      apiKey: string;
    }) =>
      this.request<{
        accessToken: string;
        refreshToken: string;
        user: User;
      }>('/auth/emby/connect-api-key', {
        method: 'POST',
        body: JSON.stringify(data),
      }),

    // Legacy callback (deprecated, kept for compatibility)
    checkPlexCallback: (data: {
      pinId: string;
      serverUrl: string;
      serverName: string;
    }) =>
      this.request<{
        authorized: boolean;
        message?: string;
        accessToken?: string;
        refreshToken?: string;
        user?: User;
      }>('/auth/callback', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
  };

  // Servers
  servers = {
    list: async () => {
      const response = await this.request<{ data: Server[] }>('/servers');
      return response.data;
    },
    create: (data: { name: string; type: string; url: string; token: string }) =>
      this.request<Server>('/servers', { method: 'POST', body: JSON.stringify(data) }),
    delete: (id: string) => this.request<void>(`/servers/${id}`, { method: 'DELETE' }),
    sync: (id: string) =>
      this.request<{
        success: boolean;
        usersAdded: number;
        usersUpdated: number;
        librariesSynced: number;
        errors: string[];
        syncedAt: string;
      }>(`/servers/${id}/sync`, { method: 'POST', body: JSON.stringify({}) }),
  };

  // Users
  users = {
    list: (params?: { page?: number; pageSize?: number }) => {
      const searchParams = new URLSearchParams();
      if (params?.page) searchParams.set('page', String(params.page));
      if (params?.pageSize) searchParams.set('pageSize', String(params.pageSize));
      return this.request<PaginatedResponse<ServerUserWithIdentity>>(`/users?${searchParams.toString()}`);
    },
    get: (id: string) => this.request<ServerUserDetail>(`/users/${id}`),
    update: (id: string, data: { trustScore?: number }) =>
      this.request<ServerUserWithIdentity>(`/users/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    sessions: (id: string, params?: { page?: number; pageSize?: number }) => {
      const query = new URLSearchParams(params as Record<string, string>).toString();
      return this.request<PaginatedResponse<Session>>(`/users/${id}/sessions?${query}`);
    },
    locations: async (id: string) => {
      const response = await this.request<{ data: UserLocation[] }>(`/users/${id}/locations`);
      return response.data;
    },
    devices: async (id: string) => {
      const response = await this.request<{ data: UserDevice[] }>(`/users/${id}/devices`);
      return response.data;
    },
  };

  // Sessions
  sessions = {
    list: (params?: { page?: number; pageSize?: number; userId?: string }) => {
      const query = new URLSearchParams(params as Record<string, string>).toString();
      return this.request<PaginatedResponse<SessionWithDetails>>(`/sessions?${query}`);
    },
    getActive: async () => {
      const response = await this.request<{ data: ActiveSession[] }>('/sessions/active');
      return response.data;
    },
    get: (id: string) => this.request<Session>(`/sessions/${id}`),
  };

  // Rules
  rules = {
    list: async () => {
      const response = await this.request<{ data: Rule[] }>('/rules');
      return response.data;
    },
    create: (data: Omit<Rule, 'id' | 'createdAt' | 'updatedAt'>) =>
      this.request<Rule>('/rules', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: Partial<Rule>) =>
      this.request<Rule>(`/rules/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    delete: (id: string) => this.request<void>(`/rules/${id}`, { method: 'DELETE' }),
  };

  // Violations
  violations = {
    list: (params?: {
      page?: number;
      pageSize?: number;
      userId?: string;
      severity?: string;
      acknowledged?: boolean;
    }) => {
      const searchParams = new URLSearchParams();
      if (params?.page) searchParams.set('page', String(params.page));
      if (params?.pageSize) searchParams.set('pageSize', String(params.pageSize));
      if (params?.userId) searchParams.set('userId', params.userId);
      if (params?.severity) searchParams.set('severity', params.severity);
      if (params?.acknowledged !== undefined) searchParams.set('acknowledged', String(params.acknowledged));
      return this.request<PaginatedResponse<ViolationWithDetails>>(`/violations?${searchParams.toString()}`);
    },
    acknowledge: (id: string) =>
      this.request<Violation>(`/violations/${id}`, { method: 'PATCH' }),
    dismiss: (id: string) => this.request<void>(`/violations/${id}`, { method: 'DELETE' }),
  };

  // Stats
  stats = {
    dashboard: () => this.request<DashboardStats>('/stats/dashboard'),
    plays: async (period?: string) => {
      const response = await this.request<{ data: PlayStats[] }>(`/stats/plays?period=${period ?? 'week'}`);
      return response.data;
    },
    users: async () => {
      const response = await this.request<{ data: UserStats[] }>('/stats/users');
      return response.data;
    },
    locations: async (params?: {
      days?: number;
      serverUserId?: string;
      serverId?: string;
      mediaType?: 'movie' | 'episode' | 'track';
    }) => {
      const searchParams = new URLSearchParams();
      if (params?.days) searchParams.set('days', String(params.days));
      if (params?.serverUserId) searchParams.set('serverUserId', params.serverUserId);
      if (params?.serverId) searchParams.set('serverId', params.serverId);
      if (params?.mediaType) searchParams.set('mediaType', params.mediaType);
      const query = searchParams.toString();
      return this.request<LocationStatsResponse>(`/stats/locations${query ? `?${query}` : ''}`);
    },
    playsByDayOfWeek: async (period?: string) => {
      const response = await this.request<{ data: { day: number; name: string; count: number }[] }>(
        `/stats/plays-by-dayofweek?period=${period ?? 'month'}`
      );
      return response.data;
    },
    playsByHourOfDay: async (period?: string) => {
      const response = await this.request<{ data: { hour: number; count: number }[] }>(
        `/stats/plays-by-hourofday?period=${period ?? 'month'}`
      );
      return response.data;
    },
    platforms: async (period?: string) => {
      const response = await this.request<{ data: { platform: string | null; count: number }[] }>(
        `/stats/platforms?period=${period ?? 'month'}`
      );
      return response.data;
    },
    quality: async (period?: string) => {
      return this.request<{
        directPlay: number;
        transcode: number;
        total: number;
        directPlayPercent: number;
        transcodePercent: number;
      }>(`/stats/quality?period=${period ?? 'month'}`);
    },
    topUsers: async (period?: string) => {
      const response = await this.request<{ data: TopUserStats[] }>(`/stats/top-users?period=${period ?? 'month'}`);
      return response.data;
    },
    topContent: async (period?: string) => {
      const response = await this.request<{
        movies: {
          title: string;
          type: 'movie';
          year: number | null;
          playCount: number;
          watchTimeHours: number;
          thumbPath: string | null;
          serverId: string | null;
          ratingKey: string | null;
        }[];
        shows: {
          title: string;
          type: 'episode';
          year: number | null;
          playCount: number;
          episodeCount: number;
          watchTimeHours: number;
          thumbPath: string | null;
          serverId: string | null;
          ratingKey: string | null;
        }[];
      }>(`/stats/top-content?period=${period ?? 'month'}`);
      return response;
    },
    concurrent: async (period?: string) => {
      const response = await this.request<{
        data: { hour: string; total: number; direct: number; transcode: number }[];
      }>(`/stats/concurrent?period=${period ?? 'month'}`);
      return response.data;
    },
  };

  // Settings
  settings = {
    get: () => this.request<Settings>('/settings'),
    update: (data: Partial<Settings>) =>
      this.request<Settings>('/settings', { method: 'PATCH', body: JSON.stringify(data) }),
  };

  // Import
  import = {
    tautulli: {
      test: (url: string, apiKey: string) =>
        this.request<{ success: boolean; message: string; users?: number; historyRecords?: number }>(
          '/import/tautulli/test',
          { method: 'POST', body: JSON.stringify({ url, apiKey }) }
        ),
      start: (serverId: string) =>
        this.request<{ status: string; message: string }>(
          '/import/tautulli',
          { method: 'POST', body: JSON.stringify({ serverId }) }
        ),
    },
  };

  // Mobile access
  mobile = {
    get: () => this.request<MobileConfig>('/mobile'),
    enable: () => this.request<MobileConfig>('/mobile/enable', { method: 'POST', body: '{}' }),
    disable: () => this.request<{ success: boolean }>('/mobile/disable', { method: 'POST', body: '{}' }),
    generatePairToken: () =>
      this.request<{ token: string; expiresAt: string }>('/mobile/pair-token', { method: 'POST', body: '{}' }),
    revokeSession: (id: string) =>
      this.request<{ success: boolean }>(`/mobile/sessions/${id}`, { method: 'DELETE' }),
    revokeSessions: () =>
      this.request<{ success: boolean; revokedCount: number }>('/mobile/sessions', { method: 'DELETE' }),
  };
}

export const api = new ApiClient();
