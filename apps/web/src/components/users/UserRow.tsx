import { Link } from 'react-router';
import { User, Trophy, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getAvatarUrl, getTrustScoreColor } from './utils';

interface UserRowProps {
  userId: string;
  username: string;
  identityName?: string | null;
  thumbUrl?: string | null;
  serverId?: string | null;
  trustScore: number;
  playCount: number;
  watchTimeHours: number;
  topContent?: string | null;
  rank: number;
  className?: string;
  style?: React.CSSProperties;
}

export function UserRow({
  userId,
  username,
  identityName,
  thumbUrl,
  serverId,
  trustScore,
  playCount,
  watchTimeHours,
  topContent,
  rank,
  className,
  style,
}: UserRowProps) {
  const displayName = identityName ?? username;
  const avatarUrl = getAvatarUrl(serverId, thumbUrl, 40);

  return (
    <Link
      to={`/users/${userId}`}
      className={cn(
        'group flex animate-fade-in-up items-center gap-4 rounded-lg border bg-card p-3 transition-all duration-200 hover:border-primary/50 hover:bg-accent hover:shadow-md',
        className
      )}
      style={style}
    >
      {/* Rank */}
      <div className="w-8 text-center text-lg font-bold text-muted-foreground">#{rank}</div>

      {/* Avatar */}
      <div className="h-10 w-10 shrink-0 overflow-hidden rounded-full bg-muted ring-2 ring-background">
        {avatarUrl ? (
          <img
            src={avatarUrl}
            alt={displayName}
            className="h-full w-full object-cover"
            loading="lazy"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <User className="h-5 w-5 text-muted-foreground" />
          </div>
        )}
      </div>

      {/* Name & Top Content */}
      <div className="flex-1 min-w-0">
        <p className="truncate font-medium">{displayName}</p>
        {topContent && (
          <p className="truncate text-xs text-muted-foreground">
            Loves: <span className="font-medium">{topContent}</span>
          </p>
        )}
      </div>

      {/* Stats */}
      <div className="hidden sm:flex items-center gap-6 text-sm">
        <div className="text-right">
          <span className="font-semibold">{playCount.toLocaleString()}</span>
          <span className="ml-1 text-muted-foreground">plays</span>
        </div>
        <div className="w-16 text-right text-muted-foreground">{watchTimeHours.toLocaleString()}h</div>
        <div className={cn('flex w-20 items-center gap-1 text-right', getTrustScoreColor(trustScore))}>
          <Trophy className="h-3.5 w-3.5" />
          <span className="font-medium">{trustScore}%</span>
        </div>
      </div>

      {/* Mobile Stats */}
      <div className="flex sm:hidden items-center gap-3 text-xs">
        <span className="font-semibold">{playCount}</span>
        <span className={cn('font-medium', getTrustScoreColor(trustScore))}>{trustScore}%</span>
      </div>

      {/* Arrow */}
      <ChevronRight className="h-5 w-5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
    </Link>
  );
}
