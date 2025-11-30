import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DataTable } from '@/components/ui/data-table';
import { ActiveSessionBadge } from '@/components/sessions/ActiveSessionBadge';
import { User, Tv, Globe, Clock, Film, MonitorPlay, Layers } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import type { ColumnDef } from '@tanstack/react-table';
import type { SessionWithDetails, ActiveSession } from '@tracearr/shared';
import { useSessions, useActiveSessions } from '@/hooks/queries';
import { tokenStorage } from '@/lib/api';

/**
 * Format media title based on type
 * Movies: "Movie Title (2024)"
 * Episodes: "Show Name - S01E02 - Episode Title"
 * Tracks: "Track Title"
 */
function formatMediaTitle(session: ActiveSession | SessionWithDetails): {
  primary: string;
  secondary: string | null;
} {
  const { mediaType, mediaTitle, grandparentTitle, seasonNumber, episodeNumber, year } =
    session as ActiveSession;

  if (mediaType === 'episode' && grandparentTitle) {
    const seasonEp =
      seasonNumber && episodeNumber
        ? `S${String(seasonNumber).padStart(2, '0')}E${String(episodeNumber).padStart(2, '0')}`
        : null;

    return {
      primary: grandparentTitle,
      secondary: seasonEp ? `${seasonEp} · ${mediaTitle}` : mediaTitle,
    };
  }

  if (mediaType === 'movie') {
    return {
      primary: mediaTitle,
      secondary: year ? `${year}` : null,
    };
  }

  return {
    primary: mediaTitle,
    secondary: null,
  };
}

/**
 * Build image URL - handles both full URLs (Plex) and relative paths (Jellyfin)
 * Proxies relative paths through our image proxy with auth token
 */
function getImageUrl(url: string | null, serverId?: string): string | null {
  if (!url) return null;

  // Full URLs (e.g., Plex plex.tv avatars) - use directly
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return url;
  }

  // Relative paths (e.g., Jellyfin) - proxy through our server
  if (!serverId) return null;

  const token = tokenStorage.getAccessToken();
  if (!token) return null;

  const path = url.startsWith('/') ? url.slice(1) : url;
  const separator = path.includes('?') ? '&' : '?';
  return `/api/v1/servers/${serverId}/image/${path}${separator}token=${token}`;
}

/**
 * Build poster URL using the image proxy
 * Includes auth token in query param since <img> tags don't send headers
 */
function getPosterUrl(session: ActiveSession): string | null {
  return getImageUrl(session.thumbPath, session.serverId);
}

/**
 * Build user avatar URL - handles both Plex (full URL) and Jellyfin (relative path)
 */
function getUserAvatarUrl(session: ActiveSession): string | null {
  return getImageUrl(session.user.thumbUrl, session.serverId);
}

/**
 * Format duration in human readable format
 */
function formatDuration(ms: number | null): string {
  if (!ms) return '—';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

// Columns for session history table
const sessionColumns: ColumnDef<SessionWithDetails>[] = [
  {
    accessorKey: 'user',
    header: 'User',
    cell: ({ row }) => {
      const session = row.original;
      const avatarUrl = getImageUrl(session.userThumb, session.serverId);
      return (
        <Link
          to={`/users/${session.userId}`}
          className="flex items-center gap-2 hover:opacity-80 transition-opacity"
        >
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-muted overflow-hidden">
            {avatarUrl ? (
              <img
                src={avatarUrl}
                alt={session.username}
                className="h-8 w-8 object-cover"
              />
            ) : (
              <User className="h-4 w-4 text-muted-foreground" />
            )}
          </div>
          <span className="font-medium hover:underline">{session.username}</span>
        </Link>
      );
    },
  },
  {
    accessorKey: 'mediaTitle',
    header: 'Media',
    cell: ({ row }) => {
      const { primary, secondary } = formatMediaTitle(row.original as unknown as ActiveSession);
      return (
        <div className="max-w-[250px]">
          <p className="truncate font-medium">{primary}</p>
          {secondary && (
            <p className="text-xs text-muted-foreground truncate">{secondary}</p>
          )}
        </div>
      );
    },
  },
  {
    accessorKey: 'durationMs',
    header: 'Duration',
    cell: ({ row }) => {
      const session = row.original;
      const segmentCount = session.segmentCount ?? 1;
      return (
        <div className="flex items-center gap-2">
          <span className="text-sm">{formatDuration(session.durationMs)}</span>
          {segmentCount > 1 && (
            <span
              className="flex items-center gap-0.5 text-xs text-muted-foreground"
              title={`${segmentCount} viewing sessions`}
            >
              <Layers className="h-3 w-3" />
              {segmentCount}
            </span>
          )}
        </div>
      );
    },
  },
  {
    accessorKey: 'platform',
    header: 'Platform',
    cell: ({ row }) => (
      <div className="flex items-center gap-2 text-sm">
        <Tv className="h-4 w-4 text-muted-foreground" />
        <span>{row.original.platform ?? 'Unknown'}</span>
      </div>
    ),
  },
  {
    accessorKey: 'geoCity',
    header: 'Location',
    cell: ({ row }) => {
      const session = row.original;
      if (!session.geoCity && !session.geoCountry) {
        return <span className="text-muted-foreground">—</span>;
      }
      return (
        <div className="flex items-center gap-2 text-sm">
          <Globe className="h-4 w-4 text-muted-foreground" />
          <span>
            {session.geoCity && `${session.geoCity}, `}
            {session.geoCountry ?? ''}
          </span>
        </div>
      );
    },
  },
  {
    accessorKey: 'startedAt',
    header: 'Started',
    cell: ({ row }) => (
      <div className="flex items-center gap-2 text-sm">
        <Clock className="h-4 w-4 text-muted-foreground" />
        <span>
          {formatDistanceToNow(new Date(row.original.startedAt), { addSuffix: true })}
        </span>
      </div>
    ),
  },
];

export function Activity() {
  const [page, setPage] = useState(1);
  const pageSize = 10;

  const { data: sessionsData, isLoading: sessionsLoading } = useSessions({
    page,
    pageSize,
  });
  const { data: activeSessions } = useActiveSessions();

  const sessions = sessionsData?.data ?? [];
  const totalPages = sessionsData?.totalPages ?? 1;

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold">Activity</h1>

      {/* Active Streams */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <MonitorPlay className="h-5 w-5" />
            Active Streams
            {activeSessions && activeSessions.length > 0 && (
              <span className="rounded-full bg-green-500/10 px-2 py-0.5 text-sm font-normal text-green-500">
                {activeSessions.length} live
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!activeSessions || activeSessions.length === 0 ? (
            <div className="flex h-32 items-center justify-center rounded-lg border border-dashed">
              <p className="text-muted-foreground">No active streams</p>
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {activeSessions.map((session) => (
                <ActiveSessionCard key={session.id} session={session} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Session History */}
      <Card>
        <CardHeader>
          <CardTitle>Session History</CardTitle>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={sessionColumns}
            data={sessions}
            pageSize={pageSize}
            pageCount={totalPages}
            page={page}
            onPageChange={setPage}
            isLoading={sessionsLoading}
            emptyMessage="No session history yet."
          />
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * Active session card with poster, media info, and user details
 * Designed for a clean, focused display of what's currently streaming
 */
function ActiveSessionCard({ session }: { session: ActiveSession }) {
  const posterUrl = getPosterUrl(session);
  const userAvatarUrl = getUserAvatarUrl(session);
  const { primary: mediaTitle, secondary: mediaSubtitle } = formatMediaTitle(session);

  return (
    <div className="group relative overflow-hidden rounded-lg border bg-card transition-all hover:shadow-md">
      {/* Main content area */}
      <div className="flex gap-3 p-3">
        {/* Poster */}
        <div className="h-[100px] w-[68px] flex-shrink-0 overflow-hidden rounded-md bg-muted">
          {posterUrl ? (
            <img
              src={posterUrl}
              alt={mediaTitle}
              className="h-full w-full object-cover"
              onError={(e) => {
                // Hide broken images
                e.currentTarget.style.display = 'none';
              }}
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center">
              <Film className="h-6 w-6 text-muted-foreground/50" />
            </div>
          )}
        </div>

        {/* Content */}
        <div className="flex min-w-0 flex-1 flex-col justify-between py-0.5">
          {/* Media info */}
          <div className="min-w-0">
            <h3 className="truncate font-semibold leading-tight">{mediaTitle}</h3>
            {mediaSubtitle && (
              <p className="mt-0.5 truncate text-sm text-muted-foreground">{mediaSubtitle}</p>
            )}
          </div>

          {/* User */}
          <Link
            to={`/users/${session.user.id}`}
            className="mt-2 flex items-center gap-2 hover:opacity-80 transition-opacity"
          >
            <div className="flex h-6 w-6 items-center justify-center rounded-full bg-muted overflow-hidden">
              {userAvatarUrl ? (
                <img
                  src={userAvatarUrl}
                  alt={session.user.username}
                  className="h-6 w-6 object-cover"
                />
              ) : (
                <User className="h-3 w-3 text-muted-foreground" />
              )}
            </div>
            <span className="truncate text-sm font-medium hover:underline">
              {session.user.username}
            </span>
          </Link>

          {/* Meta info row */}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {session.product && (
              <span className="flex items-center gap-1">
                <Tv className="h-3 w-3" />
                {session.product}
              </span>
            )}
            {(session.geoCity || session.geoCountry) && (
              <span className="flex items-center gap-1">
                <Globe className="h-3 w-3" />
                {session.geoCity || session.geoCountry}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Footer with state, time, and quality */}
      <div className="flex items-center justify-between border-t bg-muted/30 px-3 py-1.5 text-xs">
        <div className="flex items-center gap-2">
          <ActiveSessionBadge state={session.state} />
          <span className="flex items-center gap-1 text-muted-foreground">
            <Clock className="h-3 w-3" />
            {formatDistanceToNow(new Date(session.startedAt), { addSuffix: true })}
          </span>
        </div>
        {session.quality && (
          <span className="text-muted-foreground">
            {session.quality}
            {session.isTranscode && ' · Transcode'}
          </span>
        )}
      </div>
    </div>
  );
}
