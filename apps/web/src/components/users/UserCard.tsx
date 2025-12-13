import { Link } from 'react-router';
import { User, Trophy } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getAvatarUrl, getTrustScoreColor, getTrustScoreBg, MEDALS } from './utils';

interface UserCardProps {
  userId: string;
  username: string;
  identityName?: string | null;
  thumbUrl?: string | null;
  serverId?: string | null;
  trustScore: number;
  playCount: number;
  watchTimeHours: number;
  topMediaType?: string | null;
  topContent?: string | null;
  rank: 1 | 2 | 3;
  className?: string;
  style?: React.CSSProperties;
}

export function UserCard({
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
}: UserCardProps) {
  const displayName = identityName ?? username;
  const avatarUrl = getAvatarUrl(serverId, thumbUrl);
  const medal = MEDALS[rank];

  return (
    <Link
      to={`/users/${userId}`}
      className={cn(
        'group relative flex flex-col items-center rounded-xl border bg-card p-6 text-center transition-all duration-300 hover:scale-[1.02] hover:border-primary/50 hover:shadow-lg hover:shadow-primary/10',
        'animate-fade-in-up',
        className
      )}
      style={{
        ...style,
        animationDelay: rank === 1 ? '0ms' : rank === 2 ? '100ms' : '200ms',
      }}
    >
      {/* Subtle gradient background based on medal */}
      <div
        className={cn(
          'pointer-events-none absolute inset-0 rounded-xl bg-gradient-to-b opacity-50 transition-opacity group-hover:opacity-70',
          medal.bgColor
        )}
      />

      {/* Medal */}
      <div className="relative z-10 absolute -top-3 text-3xl drop-shadow-md">{medal.emoji}</div>

      {/* Avatar */}
      <div
        className={cn(
          'relative z-10 mt-4 overflow-hidden rounded-full bg-gradient-to-br shadow-lg ring-2 ring-background',
          medal.color,
          medal.size
        )}
      >
        <div className="absolute inset-0.5 overflow-hidden rounded-full bg-card">
          {avatarUrl ? (
            <img
              src={avatarUrl}
              alt={displayName}
              className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-110"
              loading="lazy"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-muted">
              <User className="h-8 w-8 text-muted-foreground" />
            </div>
          )}
        </div>
      </div>

      {/* Name */}
      <h3 className="relative z-10 mt-4 w-full px-2 text-center text-base font-semibold line-clamp-2 break-words">{displayName}</h3>

      {/* Stats */}
      <div className="relative z-10 mt-2 flex items-center gap-4 text-sm">
        <div>
          <span className="font-semibold text-primary">{playCount.toLocaleString()}</span>
          <span className="ml-1 text-muted-foreground">plays</span>
        </div>
        <div className="text-muted-foreground">{watchTimeHours.toLocaleString()}h</div>
      </div>

      {/* Trust Score */}
      <div
        className={cn(
          'relative z-10 mt-3 flex w-24 items-center justify-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium',
          getTrustScoreBg(trustScore),
          getTrustScoreColor(trustScore)
        )}
      >
        <Trophy className="h-3 w-3 shrink-0" />
        <span>Trust: {trustScore}%</span>
      </div>

      {/* Top Content */}
      {topContent && (
        <p className="relative z-10 mt-2 w-full px-2 text-center text-xs text-muted-foreground truncate">
          Loves: <span className="font-medium">{topContent}</span>
        </p>
      )}
    </Link>
  );
}
