import { useEffect, useRef, useState } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { RefreshCw, HardDrive, Hash, Clock, Database, Film, BarChart3 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { LibraryGrowthChart, LibraryComparisonChart } from '@/components/charts';
import {
  LibraryStatCard,
  LibraryStatCardSkeleton,
  LibraryOverviewCard,
} from '@/components/ui/library-stat-card';
import { useLibraryStats, useRefreshLibraryStats } from '@/hooks/queries';
import { useServer } from '@/hooks/useServer';
import { useAuth } from '@/hooks/useAuth';
import { formatBytes, formatBitrate, formatDuration, cn } from '@/lib/utils';
import { toast } from 'sonner';
import type { MediaLibraryStats } from '@tracearr/shared';

export function StatsLibraryStats() {
  const { selectedServerId } = useServer();
  const { user } = useAuth();
  const libraryStats = useLibraryStats(selectedServerId);
  const refreshMutation = useRefreshLibraryStats();
  const [isPolling, setIsPolling] = useState(false);
  const lastUpdatedRef = useRef<string | null>(null);
  const pollingIntervalRef = useRef<number | null>(null);

  const isOwnerOrAdmin = user?.role === 'owner' || user?.role === 'admin';

  const { current, historical } = libraryStats.data ?? { current: null, historical: [] };
  const libraries = current?.libraries ?? [];
  const lastUpdated = current?.lastUpdated ? new Date(current.lastUpdated) : null;

  // Auto-refresh polling when job is running
  useEffect(() => {
    if (isPolling && current?.lastUpdated) {
      // Stop polling when data has been updated
      if (lastUpdatedRef.current && lastUpdatedRef.current !== current.lastUpdated) {
        setIsPolling(false);
        if (pollingIntervalRef.current) {
          clearInterval(pollingIntervalRef.current);
          pollingIntervalRef.current = null;
        }
        toast.success('Library statistics updated', {
          description: 'Fresh data has been loaded.',
        });
      }
    }
  }, [current?.lastUpdated, isPolling]);

  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
      }
    };
  }, []);

  const handleRefresh = () => {
    // Store current lastUpdated timestamp
    lastUpdatedRef.current = current?.lastUpdated ?? null;

    refreshMutation.mutate(selectedServerId ?? undefined, {
      onSuccess: () => {
        toast.success('Library statistics refresh queued', {
          description: 'Data will be updated in the background.',
        });

        // Start polling for updates every 3 seconds
        setIsPolling(true);
        pollingIntervalRef.current = setInterval(() => {
          void libraryStats.refetch();
        }, 3000);

        // Stop polling after 2 minutes (safety)
        setTimeout(() => {
          if (pollingIntervalRef.current) {
            clearInterval(pollingIntervalRef.current);
            pollingIntervalRef.current = null;
            setIsPolling(false);
          }
        }, 120000);
      },
      onError: () => {
        toast.error('Failed to refresh library statistics');
        setIsPolling(false);
      },
    });
  };

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Library Statistics</h1>
          <p className="text-muted-foreground text-sm">
            Storage, content breakdown, and library insights
            {lastUpdated && (
              <span className="ml-1">
                · Updated {formatDistanceToNow(lastUpdated, { addSuffix: true })}
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {isOwnerOrAdmin && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleRefresh}
              disabled={refreshMutation.isPending || isPolling}
            >
              <RefreshCw
                className={cn(
                  'mr-2 h-4 w-4',
                  (refreshMutation.isPending || isPolling) && 'animate-spin'
                )}
              />
              {isPolling ? 'Updating...' : 'Refresh'}
            </Button>
          )}
        </div>
      </div>

      {/* Overview Section */}
      <section>
        <div className="mb-4 flex items-center gap-2">
          <Database className="text-primary h-5 w-5" />
          <h2 className="text-lg font-semibold">Overview</h2>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {libraryStats.isLoading ? (
            <>
              <Skeleton className="h-24 rounded-lg" />
              <Skeleton className="h-24 rounded-lg" />
              <Skeleton className="h-24 rounded-lg" />
            </>
          ) : (
            <>
              <LibraryOverviewCard
                label="Total Size"
                value={formatBytes(current?.totalSize ?? 0)}
                icon={HardDrive}
              />
              <LibraryOverviewCard
                label="Items"
                value={(current?.totalItems ?? 0).toLocaleString()}
                icon={Hash}
              />
              <LibraryOverviewCard
                label="Hours"
                value={Math.round(current?.totalHours ?? 0).toLocaleString()}
                icon={Clock}
              />
            </>
          )}
        </div>
      </section>

      {/* Libraries Breakdown Section */}
      <section>
        <div className="mb-4 flex items-center gap-2">
          <Film className="text-primary h-5 w-5" />
          <h2 className="text-lg font-semibold">Libraries</h2>
        </div>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {libraryStats.isLoading ? (
            <LibraryStatCardSkeleton count={5} />
          ) : libraries.length > 0 ? (
            libraries.map((lib: MediaLibraryStats) => (
              <LibraryStatCard key={`${lib.serverId}-${lib.id}`} library={lib} />
            ))
          ) : (
            <div className="col-span-full rounded-xl border border-dashed p-12 text-center">
              <HardDrive className="text-muted-foreground/50 mx-auto h-16 w-16" />
              <h3 className="mt-4 text-lg font-semibold">No library data available</h3>
              <p className="text-muted-foreground mt-1">
                Library statistics update daily at 3:00 AM, or you can refresh manually.
              </p>
              {isOwnerOrAdmin && (
                <Button variant="outline" size="sm" className="mt-4" onClick={handleRefresh}>
                  <RefreshCw className="mr-2 h-4 w-4" />
                  Run Update Now
                </Button>
              )}
            </div>
          )}
        </div>
      </section>

      {/* Charts Section */}
      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base font-medium">Library Growth Over Time</CardTitle>
            <CardDescription>Historical storage size by library</CardDescription>
          </CardHeader>
          <CardContent>
            <LibraryGrowthChart data={historical} isLoading={libraryStats.isLoading} height={300} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base font-medium">Library Size Comparison</CardTitle>
            <CardDescription>Relative storage size of each library</CardDescription>
          </CardHeader>
          <CardContent>
            <LibraryComparisonChart
              libraries={libraries}
              isLoading={libraryStats.isLoading}
              height={300}
            />
          </CardContent>
        </Card>
      </div>

      {/* File Statistics Section */}
      {libraries.length > 0 && (
        <section>
          <div className="mb-4 flex items-center gap-2">
            <BarChart3 className="text-primary h-5 w-5" />
            <h2 className="text-lg font-semibold">File Statistics</h2>
          </div>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Average metrics across all items in each library</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b">
                      <th className="p-3 text-left font-medium">Library</th>
                      <th className="p-3 text-right font-medium">Avg File Size</th>
                      <th className="p-3 text-right font-medium">Avg Duration</th>
                      <th className="p-3 text-right font-medium">Avg Bitrate</th>
                      <th className="p-3 text-right font-medium">HDR %</th>
                    </tr>
                  </thead>
                  <tbody>
                    {libraries.map((lib: MediaLibraryStats) => (
                      <tr key={`${lib.serverId}-${lib.id}`} className="border-b last:border-b-0">
                        <td className="p-3 font-medium">{lib.name}</td>
                        <td className="text-muted-foreground p-3 text-right">
                          {formatBytes(lib.fileStats.avgFileSize)}
                        </td>
                        <td className="text-muted-foreground p-3 text-right">
                          {formatDuration(lib.fileStats.avgDuration)}
                        </td>
                        <td className="text-muted-foreground p-3 text-right">
                          {formatBitrate(lib.fileStats.avgBitrate)}
                        </td>
                        <td className="text-muted-foreground p-3 text-right">
                          {lib.fileStats.hdrPercentage.toFixed(1)}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </section>
      )}
    </div>
  );
}
