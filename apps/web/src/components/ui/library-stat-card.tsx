/**
 * Library statistics card component for displaying library metrics.
 * Shows size, item counts, and hours for a single media library.
 */

import { Film, Tv, Music, Clapperboard, Clock, Hash } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { cn, formatBytes, formatHours } from '@/lib/utils';
import type { MediaLibraryStats } from '@tracearr/shared';

// Color palette for library types
const LIBRARY_COLORS: Record<string, string> = {
  movie: 'bg-blue-500/10 text-blue-500 border-blue-500/20',
  movies: 'bg-blue-500/10 text-blue-500 border-blue-500/20',
  show: 'bg-green-500/10 text-green-500 border-green-500/20',
  tvshows: 'bg-green-500/10 text-green-500 border-green-500/20',
  music: 'bg-orange-500/10 text-orange-500 border-orange-500/20',
  artist: 'bg-orange-500/10 text-orange-500 border-orange-500/20',
  photo: 'bg-pink-500/10 text-pink-500 border-pink-500/20',
  photos: 'bg-pink-500/10 text-pink-500 border-pink-500/20',
  mixed: 'bg-purple-500/10 text-purple-500 border-purple-500/20',
  default: 'bg-primary/10 text-primary border-primary/20',
};

// Icons for library types
const LIBRARY_ICONS: Record<string, typeof Film> = {
  movie: Film,
  movies: Film,
  show: Tv,
  tvshows: Tv,
  music: Music,
  artist: Music,
  photo: Clapperboard,
  photos: Clapperboard,
  default: Film,
};

interface LibraryStatCardProps {
  library: MediaLibraryStats;
  isLoading?: boolean;
}

export function LibraryStatCard({ library, isLoading }: LibraryStatCardProps) {
  const colorClass =
    LIBRARY_COLORS[library.type.toLowerCase()] ??
    LIBRARY_COLORS.default ??
    'bg-primary/10 text-primary border-primary/20';
  const Icon = LIBRARY_ICONS[library.type.toLowerCase()] ?? LIBRARY_ICONS.default ?? Film;

  if (isLoading) {
    return (
      <div className="bg-card rounded-lg border p-4">
        <Skeleton className="mb-3 h-5 w-24" />
        <Skeleton className="mb-2 h-8 w-20" />
        <Skeleton className="h-4 w-32" />
      </div>
    );
  }

  const borderColor = colorClass.split(' ')[2] ?? 'border-primary/20';

  return (
    <div className={cn('bg-card rounded-lg border p-4', 'border-l-4', borderColor)}>
      {/* Header with library name and type badge */}
      <div className="mb-3 flex items-center gap-2">
        <div
          className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-md', colorClass)}
        >
          <Icon className="h-4 w-4" />
        </div>
        <span className="truncate text-sm font-medium">{library.name}</span>
      </div>

      {/* Size (primary metric) */}
      <div className="mb-2 text-2xl font-bold tabular-nums">{formatBytes(library.size)}</div>

      {/* Secondary metrics */}
      <div className="text-muted-foreground space-y-1 text-xs">
        <div className="flex items-center gap-1.5">
          <Hash className="h-3 w-3" />
          <span>
            {library.itemCount.toLocaleString()}{' '}
            {library.type === 'show' || library.type === 'tvshows' ? 'shows' : 'items'}
          </span>
          {library.episodeCount && (
            <span className="text-muted-foreground/70">
              ({library.episodeCount.toLocaleString()} eps)
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <Clock className="h-3 w-3" />
          <span>{formatHours(library.hours)}</span>
        </div>
      </div>
    </div>
  );
}

interface LibraryStatCardSkeletonProps {
  count?: number;
}

export function LibraryStatCardSkeleton({ count = 5 }: LibraryStatCardSkeletonProps) {
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="bg-card rounded-lg border p-4">
          <div className="mb-3 flex items-center gap-2">
            <Skeleton className="h-7 w-7 rounded-md" />
            <Skeleton className="h-4 w-20" />
          </div>
          <Skeleton className="mb-2 h-8 w-24" />
          <div className="space-y-1">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-3 w-12" />
          </div>
        </div>
      ))}
    </>
  );
}

/**
 * Large overview stat card for total library statistics
 */
interface LibraryOverviewCardProps {
  label: string;
  value: string | number;
  icon: LucideIcon;
  isLoading?: boolean;
}

export function LibraryOverviewCard({
  label,
  value,
  icon: Icon,
  isLoading,
}: LibraryOverviewCardProps) {
  if (isLoading) {
    return (
      <div className="bg-card rounded-lg border p-4 text-center">
        <Skeleton className="mx-auto mb-2 h-5 w-16" />
        <Skeleton className="mx-auto h-10 w-24" />
      </div>
    );
  }

  return (
    <div className="bg-card rounded-lg border p-4 text-center">
      <div className="mb-1 flex items-center justify-center gap-2">
        <Icon className="text-muted-foreground h-4 w-4" />
        <span className="text-muted-foreground text-sm">{label}</span>
      </div>
      <div className="text-3xl font-bold tabular-nums">{value}</div>
    </div>
  );
}
