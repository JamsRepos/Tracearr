import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DataTable } from '@/components/ui/data-table';
import { TrustScoreBadge } from '@/components/users/TrustScoreBadge';
import { UserLocationsCard } from '@/components/users/UserLocationsCard';
import { UserDevicesCard } from '@/components/users/UserDevicesCard';
import { SeverityBadge } from '@/components/violations/SeverityBadge';
import { ActiveSessionBadge } from '@/components/sessions/ActiveSessionBadge';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import {
  User as UserIcon,
  Crown,
  ArrowLeft,
  Play,
  Clock,
  AlertTriangle,
  Tv,
  Globe,
} from 'lucide-react';
import { formatDistanceToNow, format } from 'date-fns';
import type { ColumnDef } from '@tanstack/react-table';
import type { Session, ViolationWithDetails } from '@tracearr/shared';
import {
  useUser,
  useUserSessions,
  useViolations,
  useUserLocations,
  useUserDevices,
} from '@/hooks/queries';

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

const sessionColumns: ColumnDef<Session>[] = [
  {
    accessorKey: 'mediaTitle',
    header: 'Media',
    cell: ({ row }) => (
      <div className="max-w-[200px]">
        <p className="truncate font-medium">{row.original.mediaTitle}</p>
        <p className="text-xs text-muted-foreground capitalize">{row.original.mediaType}</p>
      </div>
    ),
  },
  {
    accessorKey: 'state',
    header: 'Status',
    cell: ({ row }) => <ActiveSessionBadge state={row.original.state} />,
  },
  {
    accessorKey: 'durationMs',
    header: 'Duration',
    cell: ({ row }) => (
      <span className="text-sm">{formatDuration(row.original.durationMs)}</span>
    ),
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

const violationColumns: ColumnDef<ViolationWithDetails>[] = [
  {
    accessorKey: 'rule.name',
    header: 'Rule',
    cell: ({ row }) => (
      <div>
        <p className="font-medium">{row.original.rule.name}</p>
        <p className="text-xs text-muted-foreground capitalize">
          {row.original.rule.type.replace(/_/g, ' ')}
        </p>
      </div>
    ),
  },
  {
    accessorKey: 'severity',
    header: 'Severity',
    cell: ({ row }) => <SeverityBadge severity={row.original.severity} />,
  },
  {
    accessorKey: 'createdAt',
    header: 'When',
    cell: ({ row }) => (
      <span className="text-sm text-muted-foreground">
        {formatDistanceToNow(new Date(row.original.createdAt), { addSuffix: true })}
      </span>
    ),
  },
  {
    accessorKey: 'acknowledgedAt',
    header: 'Status',
    cell: ({ row }) => (
      <span
        className={
          row.original.acknowledgedAt
            ? 'text-muted-foreground'
            : 'text-yellow-500 font-medium'
        }
      >
        {row.original.acknowledgedAt ? 'Acknowledged' : 'Pending'}
      </span>
    ),
  },
];

export function UserDetail() {
  const { id } = useParams<{ id: string }>();
  const [sessionsPage, setSessionsPage] = useState(1);
  const [violationsPage, setViolationsPage] = useState(1);
  const pageSize = 10;

  const { data: user, isLoading: userLoading } = useUser(id!);
  const { data: sessionsData, isLoading: sessionsLoading } = useUserSessions(id!, {
    page: sessionsPage,
    pageSize,
  });
  const { data: violationsData, isLoading: violationsLoading } = useViolations({
    userId: id,
    page: violationsPage,
    pageSize,
  });
  const { data: locations, isLoading: locationsLoading } = useUserLocations(id!);
  const { data: devices, isLoading: devicesLoading } = useUserDevices(id!);

  const sessions = sessionsData?.data ?? [];
  const sessionsTotalPages = sessionsData?.totalPages ?? 1;
  const violations = violationsData?.data ?? [];
  const violationsTotalPages = violationsData?.totalPages ?? 1;
  const totalSessions = sessionsData?.total ?? 0;

  if (userLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-4">
                <Skeleton className="h-16 w-16 rounded-full" />
                <div className="space-y-2">
                  <Skeleton className="h-6 w-32" />
                  <Skeleton className="h-4 w-24" />
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="grid grid-cols-2 gap-4">
                {[...Array(4)].map((_, i) => (
                  <Skeleton key={i} className="h-16" />
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="space-y-6">
        <Link to="/users">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Users
          </Button>
        </Link>
        <Card>
          <CardContent className="flex h-32 items-center justify-center">
            <p className="text-muted-foreground">User not found</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link to="/users">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back
          </Button>
        </Link>
        <h1 className="text-3xl font-bold">{user.username}</h1>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* User Info Card */}
        <Card>
          <CardHeader>
            <CardTitle>User Info</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-start gap-4">
              <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted">
                {user.thumbUrl ? (
                  <img
                    src={user.thumbUrl}
                    alt={user.username}
                    className="h-16 w-16 rounded-full object-cover"
                  />
                ) : (
                  <UserIcon className="h-8 w-8 text-muted-foreground" />
                )}
              </div>
              <div className="flex-1 space-y-2">
                <div className="flex items-center gap-2">
                  <h2 className="text-xl font-semibold">{user.username}</h2>
                  {user.isOwner && (
                    <span title="Server Owner">
                      <Crown className="h-5 w-5 text-yellow-500" />
                    </span>
                  )}
                </div>
                {user.email && (
                  <p className="text-sm text-muted-foreground">{user.email}</p>
                )}
                <div className="flex items-center gap-4 pt-2">
                  <TrustScoreBadge score={user.trustScore} showLabel />
                  <span
                    className={`text-sm ${
                      user.allowGuest ? 'text-green-500' : 'text-muted-foreground'
                    }`}
                  >
                    Guest: {user.allowGuest ? 'Allowed' : 'Disabled'}
                  </span>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Stats Card */}
        <Card>
          <CardHeader>
            <CardTitle>Statistics</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4">
              <div className="rounded-lg border p-4">
                <div className="flex items-center gap-2">
                  <Play className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm text-muted-foreground">Sessions</span>
                </div>
                <p className="mt-1 text-2xl font-bold">{sessionsData?.total ?? 0}</p>
              </div>
              <div className="rounded-lg border p-4">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm text-muted-foreground">Violations</span>
                </div>
                <p className="mt-1 text-2xl font-bold">{violationsData?.total ?? 0}</p>
              </div>
              <div className="rounded-lg border p-4">
                <div className="flex items-center gap-2">
                  <Clock className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm text-muted-foreground">Joined</span>
                </div>
                <p className="mt-1 text-sm font-medium">
                  {format(new Date(user.createdAt), 'MMM d, yyyy')}
                </p>
              </div>
              <div className="rounded-lg border p-4">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">Trust Score</span>
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <span className="text-2xl font-bold">{user.trustScore}</span>
                  <span className="text-sm text-muted-foreground">/ 100</span>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Locations and Devices */}
      <div className="grid gap-6 lg:grid-cols-2">
        <UserLocationsCard
          locations={locations ?? []}
          isLoading={locationsLoading}
          totalSessions={totalSessions}
        />
        <UserDevicesCard
          devices={devices ?? []}
          isLoading={devicesLoading}
          totalSessions={totalSessions}
        />
      </div>

      {/* Recent Sessions */}
      <Card>
        <CardHeader>
          <CardTitle>Recent Sessions</CardTitle>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={sessionColumns}
            data={sessions}
            pageSize={pageSize}
            pageCount={sessionsTotalPages}
            page={sessionsPage}
            onPageChange={setSessionsPage}
            isLoading={sessionsLoading}
            emptyMessage="No sessions found for this user."
          />
        </CardContent>
      </Card>

      {/* Violations */}
      <Card>
        <CardHeader>
          <CardTitle>Violations</CardTitle>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={violationColumns}
            data={violations}
            pageSize={pageSize}
            pageCount={violationsTotalPages}
            page={violationsPage}
            onPageChange={setViolationsPage}
            isLoading={violationsLoading}
            emptyMessage="No violations for this user."
          />
        </CardContent>
      </Card>
    </div>
  );
}
