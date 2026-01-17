import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { getName as getCountryNameFromCode } from 'country-list';
import type { MediaType } from '@tracearr/shared';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Convert ISO 3166-1 alpha-2 country code to full country name.
 * Returns the original value if not a recognized code (e.g., "Local Network").
 */
export function getCountryName(code: string | null | undefined): string | null {
  if (!code) return null;
  const name = getCountryNameFromCode(code) ?? code;
  // Strip ISO 3166-1 article suffixes like "(the)", "(The)"
  return name.replace(/\s*\([Tt]he\)$/, '');
}

/**
 * Media display fields interface for formatting media titles
 */
interface MediaDisplayFields {
  mediaType: MediaType | null;
  mediaTitle: string | null;
  grandparentTitle?: string | null;
  seasonNumber?: number | null;
  episodeNumber?: number | null;
  year?: number | null;
  artistName?: string | null;
  albumName?: string | null;
}

/**
 * Get display title for media (handles TV shows vs movies vs music)
 * Formats media information consistently across the application.
 *
 * @param media - Media object with display fields
 * @returns Object with title and subtitle for display
 */
export function getMediaDisplay(media: MediaDisplayFields): {
  title: string;
  subtitle: string | null;
} {
  if (media.mediaType === 'episode' && media.grandparentTitle) {
    // TV Show episode
    const episodeInfo =
      media.seasonNumber && media.episodeNumber
        ? `S${media.seasonNumber.toString().padStart(2, '0')} E${media.episodeNumber.toString().padStart(2, '0')}`
        : '';
    return {
      title: media.grandparentTitle,
      subtitle: episodeInfo
        ? `${episodeInfo} · ${media.mediaTitle ?? ''}`
        : (media.mediaTitle ?? null),
    };
  }
  if (media.mediaType === 'track') {
    // Music track - show track name as title, artist/album as subtitle
    const parts: string[] = [];
    if (media.artistName) parts.push(media.artistName);
    if (media.albumName) parts.push(media.albumName);
    return {
      title: media.mediaTitle ?? '',
      subtitle: parts.length > 0 ? parts.join(' · ') : null,
    };
  }
  // Movie or other
  return {
    title: media.mediaTitle ?? '',
    subtitle: media.year ? `${media.year}` : null,
  };
}

/**
 * Format bytes to human-readable size
 *
 * @param bytes - Size in bytes
 * @param decimals - Number of decimal places (default: 1)
 * @returns Formatted string like "47.1 TB", "2.5 GB", "890 MB"
 */
export function formatBytes(bytes: number, decimals = 1): string {
  if (bytes === 0) return '0 B';
  if (bytes < 0) return '-' + formatBytes(-bytes, decimals);

  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const index = Math.min(i, sizes.length - 1);

  return `${(bytes / Math.pow(k, index)).toFixed(decimals)} ${sizes[index]}`;
}

/**
 * Format bitrate to human-readable format
 *
 * @param kbps - Bitrate in kilobits per second
 * @returns Formatted string like "25.3 Mbps", "850 kbps"
 */
export function formatBitrate(kbps: number): string {
  if (kbps === 0) return '0 kbps';
  if (kbps < 0) return '-' + formatBitrate(-kbps);

  if (kbps >= 1000) {
    return `${(kbps / 1000).toFixed(1)} Mbps`;
  }
  return `${Math.round(kbps)} kbps`;
}

/**
 * Format duration from milliseconds to human-readable format
 *
 * @param ms - Duration in milliseconds
 * @returns Formatted string like "2h 30m", "45m", "1d 5h"
 */
export function formatDuration(ms: number): string {
  if (ms === 0) return '0m';
  if (ms < 0) return '-' + formatDuration(-ms);

  const minutes = Math.floor(ms / 60000);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    const remainingHours = hours % 24;
    return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
  }
  if (hours > 0) {
    const remainingMinutes = minutes % 60;
    return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  }
  return `${minutes}m`;
}

/**
 * Format hours to human-readable format
 *
 * @param hours - Duration in hours
 * @returns Formatted string like "1,234 hrs", "45 hrs"
 */
export function formatHours(hours: number): string {
  const rounded = Math.round(hours);
  return `${rounded.toLocaleString()} hrs`;
}
