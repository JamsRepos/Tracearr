/**
 * Library Statistics Service
 *
 * Fetches, aggregates, and persists library statistics from media servers.
 * Data is stored in the database and updated via background jobs.
 *
 * Performance optimizations:
 * - Sampling for large libraries (threshold: 3000 items, sample size: 1500)
 * - Fast count queries before fetching full data
 * - Batch processing with 2000 items per API request
 * - Extrapolation of sampled data for accurate totals
 */

import { eq, and, desc, gte, inArray } from 'drizzle-orm';
import { db } from '../db/client.js';
import { servers, libraryStatistics, librarySnapshots } from '../db/schema.js';
import { createMediaServerClient, type MediaLibrary } from './mediaServer/index.js';
import { fetchJson } from '../utils/http.js';
import { plexHeaders } from '../utils/http.js';
import type {
  MediaLibraryStats,
  MediaLibraryFileStats,
  MediaLibraryStatsResponse,
  MediaLibrarySnapshot,
  MediaLibraryHistoricalDataPoint,
} from '@tracearr/shared';

// ============================================================================
// Configuration
// ============================================================================

const LIBRARY_STATS_CONFIG = {
  // Maximum items to process per library (prevents timeouts)
  MAX_ITEMS_TO_PROCESS: 50000,

  // Use sampling when library exceeds this size
  SAMPLING_THRESHOLD: 3000,

  // Sample size for large libraries (process every Nth item)
  SAMPLE_SIZE: 1500,

  // Pagination batch size (larger = fewer API calls)
  PAGE_SIZE: 2000,

  // Request timeout
  TIMEOUT_MS: 60000,
} as const;

// ============================================================================
// Types
// ============================================================================

interface LibraryItemStats {
  totalItems: number;
  totalEpisodes?: number;
  totalSeasons?: number;
  totalShows?: number;
  totalSizeBytes: number;
  totalDurationMs: number;
  avgFileSizeBytes: number;
  avgDurationMs: number;
  avgBitrateKbps: number;
  hdrItemCount: number;
}

interface PlexLibraryItem {
  ratingKey?: string;
  type?: string;
  title?: string;
  duration?: number;
  grandparentRatingKey?: string; // Show ID (for episodes)
  parentRatingKey?: string; // Season ID (for episodes)
  Media?: Array<{
    bitrate?: number;
    videoCodec?: string;
    audioCodec?: string;
    width?: number;
    height?: number;
    Part?: Array<{
      size?: number;
      Stream?: Array<{
        streamType?: number;
        codec?: string;
        colorPrimaries?: string;
        DOVIProfile?: number;
      }>;
    }>;
  }>;
  leafCount?: number; // Episode count for shows (when fetching shows)
  childCount?: number; // Season count for shows (when fetching shows)
}

interface JellyfinLibraryItem {
  Id?: string;
  Type?: string;
  Name?: string;
  RunTimeTicks?: number;
  VideoType?: string;
  SeriesId?: string; // For episodes: parent series ID
  SeasonId?: string; // For episodes: parent season ID
  MediaSources?: Array<{
    Size?: number;
    Bitrate?: number;
    MediaStreams?: Array<{
      Type?: string;
      Codec?: string;
      Width?: number;
      Height?: number;
      VideoRange?: string;
      VideoRangeType?: string;
    }>;
  }>;
  ChildCount?: number; // For series: season count
  RecursiveItemCount?: number; // For series: episode count
}

// ============================================================================
// Plex Library Item Fetching
// ============================================================================

/**
 * Get total count of items in a Plex library without fetching all data
 */
async function getPlexLibraryCount(
  serverUrl: string,
  token: string,
  libraryId: string,
  libraryType: string
): Promise<number> {
  const params = new URLSearchParams({
    'X-Plex-Container-Start': '0',
    'X-Plex-Container-Size': '0', // Request 0 items to get just the count
  });

  if (libraryType === 'show') {
    params.set('type', '4'); // Episodes for TV shows
  }

  const url = `${serverUrl}/library/sections/${libraryId}/all?${params}`;

  try {
    const response = await fetchJson<{
      MediaContainer?: {
        totalSize?: number;
      };
    }>(url, {
      headers: plexHeaders(token),
      service: 'plex',
      timeout: 10000,
    });

    return response?.MediaContainer?.totalSize ?? 0;
  } catch (error) {
    console.error(`[LibraryStats] Failed to get Plex library count:`, error);
    return 0;
  }
}

/**
 * Fetch items from a Plex library with pagination and optional sampling
 */
async function fetchPlexLibraryItems(
  serverUrl: string,
  token: string,
  libraryId: string,
  libraryType: string,
  totalCount?: number
): Promise<{ items: PlexLibraryItem[]; totalCount: number; sampled: boolean }> {
  // Get total count if not provided
  if (totalCount === undefined) {
    totalCount = await getPlexLibraryCount(serverUrl, token, libraryId, libraryType);
  }

  console.log(`[LibraryStats] Plex library ${libraryId} has ${totalCount} items`);

  // Determine if we should sample
  const shouldSample = totalCount > LIBRARY_STATS_CONFIG.SAMPLING_THRESHOLD;
  const maxItems = Math.min(
    totalCount,
    shouldSample ? LIBRARY_STATS_CONFIG.SAMPLE_SIZE : LIBRARY_STATS_CONFIG.MAX_ITEMS_TO_PROCESS
  );

  console.log(
    `[LibraryStats] Processing ${maxItems} items${shouldSample ? ' (sampling)' : ''} from Plex library ${libraryId}`
  );

  const items: PlexLibraryItem[] = [];
  const pageSize = LIBRARY_STATS_CONFIG.PAGE_SIZE;
  let itemsFetched = 0;

  // Calculate sampling interval
  const samplingInterval = shouldSample
    ? Math.floor(totalCount / LIBRARY_STATS_CONFIG.SAMPLE_SIZE)
    : 1;

  while (itemsFetched < maxItems) {
    const offset = shouldSample ? itemsFetched * samplingInterval : itemsFetched;
    const batchSize = Math.min(pageSize, maxItems - itemsFetched);

    const params = new URLSearchParams({
      'X-Plex-Container-Start': offset.toString(),
      'X-Plex-Container-Size': batchSize.toString(),
    });

    if (libraryType === 'show') {
      params.set('type', '4'); // Episodes for TV shows
    }

    const url = `${serverUrl}/library/sections/${libraryId}/all?${params}`;

    try {
      const response = await fetchJson<{
        MediaContainer?: {
          Metadata?: PlexLibraryItem[];
          size?: number;
        };
      }>(url, {
        headers: plexHeaders(token),
        service: 'plex',
        timeout: LIBRARY_STATS_CONFIG.TIMEOUT_MS,
      });

      const responseItems = response?.MediaContainer?.Metadata ?? [];
      items.push(...responseItems);
      itemsFetched += responseItems.length;

      if (responseItems.length === 0) break;

      // Log progress for large operations
      if (itemsFetched % 5000 === 0) {
        console.log(
          `[LibraryStats] Progress: ${itemsFetched}/${maxItems} items (${Math.round((itemsFetched / maxItems) * 100)}%)`
        );
      }
    } catch (error) {
      console.error(`[LibraryStats] Failed to fetch Plex items at offset ${offset}:`, error);
      break;
    }
  }

  console.log(
    `[LibraryStats] Fetched ${items.length} items from Plex library ${libraryId}${shouldSample ? ' (sampled)' : ''}`
  );
  return { items, totalCount, sampled: shouldSample };
}

/**
 * Calculate statistics from Plex library items
 * Extrapolates totals if sampling was used
 */
function calculatePlexLibraryStats(
  items: PlexLibraryItem[],
  libraryType: string,
  actualTotalCount: number,
  sampled: boolean
): LibraryItemStats {
  let totalSizeBytes = 0;
  let totalDurationMs = 0;
  let hdrItemCount = 0;
  let totalBitrate = 0;
  let itemsWithBitrate = 0;
  let totalEpisodes = 0;
  let totalSeasons = 0;
  let totalShows = 0;

  // Track unique shows and seasons for TV libraries (episodes are fetched, not shows)
  const uniqueShows = new Set<string>();
  const uniqueSeasons = new Set<string>();

  for (const item of items) {
    if (libraryType === 'show') {
      totalEpisodes++;
      // grandparentRatingKey is the show ID, parentRatingKey is the season ID
      if (item.grandparentRatingKey) {
        uniqueShows.add(item.grandparentRatingKey);
      }
      if (item.parentRatingKey) {
        uniqueSeasons.add(item.parentRatingKey);
      }
    }

    // Process media information
    const media = item.Media?.[0];
    if (media) {
      // File size from parts
      const part = media.Part?.[0];
      if (part?.size) {
        totalSizeBytes += part.size;
      }

      // Duration
      if (item.duration) {
        totalDurationMs += item.duration;
      }

      // Bitrate
      if (media.bitrate) {
        totalBitrate += media.bitrate;
        itemsWithBitrate++;
      }

      // HDR detection from streams
      if (part?.Stream) {
        const isHdr = part.Stream.some(
          (stream) =>
            stream.streamType === 1 && // Video stream
            (stream.colorPrimaries === 'bt2020' ||
              stream.DOVIProfile !== undefined ||
              stream.codec?.toLowerCase().includes('hevc'))
        );
        if (isHdr) {
          hdrItemCount++;
        }
      }
    }
  }

  // For TV shows, count unique shows and seasons
  if (libraryType === 'show') {
    totalShows = uniqueShows.size;
    totalSeasons = uniqueSeasons.size;
  }

  // If sampling was used, extrapolate totals based on the sample
  let extrapolatedTotalSize = totalSizeBytes;
  let extrapolatedTotalDuration = totalDurationMs;
  let extrapolatedHdrCount = hdrItemCount;
  let extrapolatedEpisodes = totalEpisodes;
  let extrapolatedShows = totalShows;
  let extrapolatedSeasons = totalSeasons;

  if (sampled && items.length > 0) {
    const samplingRatio = actualTotalCount / items.length;
    extrapolatedTotalSize = Math.round(totalSizeBytes * samplingRatio);
    extrapolatedTotalDuration = Math.round(totalDurationMs * samplingRatio);
    extrapolatedHdrCount = Math.round(hdrItemCount * samplingRatio);

    if (libraryType === 'show') {
      // For TV shows, use actual count for episodes, extrapolate shows/seasons
      extrapolatedEpisodes = actualTotalCount;
      extrapolatedShows = Math.round(totalShows * samplingRatio);
      extrapolatedSeasons = Math.round(totalSeasons * samplingRatio);
    }

    console.log(
      `[LibraryStats] Extrapolated from ${items.length} sampled items to ${actualTotalCount} total items (ratio: ${samplingRatio.toFixed(2)})`
    );
  }

  const finalTotalItems = libraryType === 'show' ? extrapolatedShows : actualTotalCount;

  return {
    totalItems: finalTotalItems,
    totalEpisodes: libraryType === 'show' ? extrapolatedEpisodes : undefined,
    totalSeasons: libraryType === 'show' ? extrapolatedSeasons : undefined,
    totalShows: libraryType === 'show' ? extrapolatedShows : undefined,
    totalSizeBytes: extrapolatedTotalSize,
    totalDurationMs: extrapolatedTotalDuration,
    avgFileSizeBytes: finalTotalItems > 0 ? Math.round(extrapolatedTotalSize / finalTotalItems) : 0,
    avgDurationMs:
      finalTotalItems > 0 ? Math.round(extrapolatedTotalDuration / finalTotalItems) : 0,
    avgBitrateKbps: itemsWithBitrate > 0 ? Math.round(totalBitrate / itemsWithBitrate) : 0,
    hdrItemCount: extrapolatedHdrCount,
  };
}

// ============================================================================
// Jellyfin/Emby Library Item Fetching
// ============================================================================

/**
 * Get total count of items in a Jellyfin/Emby library without fetching all data
 */
async function getJellyfinLibraryCount(
  serverUrl: string,
  apiKey: string,
  libraryId: string,
  libraryType: string,
  serverType: 'jellyfin' | 'emby'
): Promise<number> {
  const itemTypes = libraryType === 'movies' ? 'Movie' : libraryType === 'tvshows' ? 'Episode' : '';

  const params = new URLSearchParams({
    ParentId: libraryId,
    Recursive: 'true',
    StartIndex: '0',
    Limit: '1', // Request just 1 item to get TotalRecordCount
  });

  if (itemTypes) {
    params.set('IncludeItemTypes', itemTypes);
  }

  const url = `${serverUrl}/Items?${params}`;

  try {
    const response = await fetchJson<{
      TotalRecordCount?: number;
    }>(url, {
      headers: {
        'X-Emby-Token': apiKey,
        Accept: 'application/json',
      },
      service: serverType,
      timeout: 10000,
    });

    return response?.TotalRecordCount ?? 0;
  } catch (error) {
    console.error(`[LibraryStats] Failed to get ${serverType} library count:`, error);
    return 0;
  }
}

/**
 * Fetch items from a Jellyfin/Emby library with pagination and optional sampling
 */
async function fetchJellyfinLibraryItems(
  serverUrl: string,
  apiKey: string,
  libraryId: string,
  libraryType: string,
  serverType: 'jellyfin' | 'emby',
  totalCount?: number
): Promise<{ items: JellyfinLibraryItem[]; totalCount: number; sampled: boolean }> {
  // Get total count if not provided
  if (totalCount === undefined) {
    totalCount = await getJellyfinLibraryCount(
      serverUrl,
      apiKey,
      libraryId,
      libraryType,
      serverType
    );
  }

  console.log(`[LibraryStats] ${serverType} library ${libraryId} has ${totalCount} items`);

  // Determine if we should sample
  const shouldSample = totalCount > LIBRARY_STATS_CONFIG.SAMPLING_THRESHOLD;
  const maxItems = Math.min(
    totalCount,
    shouldSample ? LIBRARY_STATS_CONFIG.SAMPLE_SIZE : LIBRARY_STATS_CONFIG.MAX_ITEMS_TO_PROCESS
  );

  console.log(
    `[LibraryStats] Processing ${maxItems} items${shouldSample ? ' (sampling)' : ''} from ${serverType} library ${libraryId}`
  );

  const items: JellyfinLibraryItem[] = [];
  const pageSize = LIBRARY_STATS_CONFIG.PAGE_SIZE;
  let itemsFetched = 0;

  // Map library type to Jellyfin/Emby item types
  // For TV shows, fetch episodes to get accurate file stats (like with Plex)
  const itemTypes = libraryType === 'movies' ? 'Movie' : libraryType === 'tvshows' ? 'Episode' : '';

  // Calculate sampling interval
  const samplingInterval = shouldSample
    ? Math.floor(totalCount / LIBRARY_STATS_CONFIG.SAMPLE_SIZE)
    : 1;

  while (itemsFetched < maxItems) {
    const offset = shouldSample ? itemsFetched * samplingInterval : itemsFetched;
    const batchSize = Math.min(pageSize, maxItems - itemsFetched);

    const params = new URLSearchParams({
      ParentId: libraryId,
      Recursive: 'true',
      Fields: 'MediaSources,Path,ChildCount,RecursiveItemCount,SeriesId,SeasonId',
      StartIndex: offset.toString(),
      Limit: batchSize.toString(),
    });

    if (itemTypes) {
      params.set('IncludeItemTypes', itemTypes);
    }

    const url = `${serverUrl}/Items?${params}`;

    try {
      const response = await fetchJson<{
        Items?: JellyfinLibraryItem[];
      }>(url, {
        headers: {
          'X-Emby-Token': apiKey,
          Accept: 'application/json',
        },
        service: serverType,
        timeout: LIBRARY_STATS_CONFIG.TIMEOUT_MS,
      });

      const responseItems = response?.Items ?? [];

      items.push(...responseItems);
      itemsFetched += responseItems.length;

      if (responseItems.length === 0) break;

      // Log progress for large operations
      if (itemsFetched % 5000 === 0) {
        console.log(
          `[LibraryStats] Progress: ${itemsFetched}/${maxItems} items (${Math.round((itemsFetched / maxItems) * 100)}%)`
        );
      }
    } catch (error) {
      console.error(
        `[LibraryStats] Failed to fetch ${serverType} items at offset ${offset}:`,
        error
      );
      break;
    }
  }

  console.log(
    `[LibraryStats] Fetched ${items.length} items from ${serverType} library ${libraryId}${shouldSample ? ' (sampled)' : ''}`
  );
  return { items, totalCount, sampled: shouldSample };
}

/**
 * Calculate statistics from Jellyfin/Emby library items
 * Extrapolates totals if sampling was used
 */
function calculateJellyfinLibraryStats(
  items: JellyfinLibraryItem[],
  libraryType: string,
  actualTotalCount: number,
  sampled: boolean
): LibraryItemStats {
  let totalSizeBytes = 0;
  let totalDurationMs = 0;
  let hdrItemCount = 0;
  let totalBitrate = 0;
  let itemsWithBitrate = 0;
  let totalEpisodes = 0;
  let totalSeasons = 0;
  let totalShows = 0;

  // Track unique series and seasons for TV libraries (episodes are fetched, not series)
  const uniqueShows = new Set<string>();
  const uniqueSeasons = new Set<string>();

  for (const item of items) {
    if (libraryType === 'tvshows') {
      totalEpisodes++;
      if (item.SeriesId) {
        uniqueShows.add(item.SeriesId);
      }
      if (item.SeasonId) {
        uniqueSeasons.add(item.SeasonId);
      }
    }

    // Process media sources
    const mediaSource = item.MediaSources?.[0];
    if (mediaSource) {
      // File size
      if (mediaSource.Size) {
        totalSizeBytes += mediaSource.Size;
      }

      // Duration (RunTimeTicks is in 100ns units)
      if (item.RunTimeTicks) {
        totalDurationMs += Math.round(item.RunTimeTicks / 10000);
      }

      // Bitrate
      if (mediaSource.Bitrate) {
        totalBitrate += Math.round(mediaSource.Bitrate / 1000); // Convert to kbps
        itemsWithBitrate++;
      }

      // HDR detection from media streams
      if (mediaSource.MediaStreams) {
        const videoStream = mediaSource.MediaStreams.find((s) => s.Type === 'Video');

        if (videoStream) {
          const isHdr =
            videoStream.VideoRange === 'HDR' ||
            videoStream.VideoRangeType === 'HDR10' ||
            videoStream.VideoRangeType === 'HDR10Plus' ||
            videoStream.VideoRangeType === 'DolbyVision';
          if (isHdr) {
            hdrItemCount++;
          }
        }
      }
    }
  }

  // For TV shows, count unique shows and seasons
  if (libraryType === 'tvshows') {
    totalShows = uniqueShows.size;
    totalSeasons = uniqueSeasons.size;
  }

  const isTvLibrary = libraryType === 'tvshows';

  // If sampling was used, extrapolate totals based on the sample
  let extrapolatedTotalSize = totalSizeBytes;
  let extrapolatedTotalDuration = totalDurationMs;
  let extrapolatedHdrCount = hdrItemCount;
  let extrapolatedEpisodes = totalEpisodes;
  let extrapolatedShows = totalShows;
  let extrapolatedSeasons = totalSeasons;

  if (sampled && items.length > 0) {
    const samplingRatio = actualTotalCount / items.length;
    extrapolatedTotalSize = Math.round(totalSizeBytes * samplingRatio);
    extrapolatedTotalDuration = Math.round(totalDurationMs * samplingRatio);
    extrapolatedHdrCount = Math.round(hdrItemCount * samplingRatio);

    if (isTvLibrary) {
      // For TV shows, use actual count for episodes, extrapolate shows/seasons
      extrapolatedEpisodes = actualTotalCount;
      extrapolatedShows = Math.round(totalShows * samplingRatio);
      extrapolatedSeasons = Math.round(totalSeasons * samplingRatio);
    }

    console.log(
      `[LibraryStats] Extrapolated from ${items.length} sampled items to ${actualTotalCount} total items (ratio: ${samplingRatio.toFixed(2)})`
    );
  }

  const finalTotalItems = isTvLibrary ? extrapolatedShows : actualTotalCount;

  return {
    totalItems: finalTotalItems,
    totalEpisodes: isTvLibrary ? extrapolatedEpisodes : undefined,
    totalSeasons: isTvLibrary ? extrapolatedSeasons : undefined,
    totalShows: isTvLibrary ? extrapolatedShows : undefined,
    totalSizeBytes: extrapolatedTotalSize,
    totalDurationMs: extrapolatedTotalDuration,
    avgFileSizeBytes: finalTotalItems > 0 ? Math.round(extrapolatedTotalSize / finalTotalItems) : 0,
    avgDurationMs:
      finalTotalItems > 0 ? Math.round(extrapolatedTotalDuration / finalTotalItems) : 0,
    avgBitrateKbps: itemsWithBitrate > 0 ? Math.round(totalBitrate / itemsWithBitrate) : 0,
    hdrItemCount: extrapolatedHdrCount,
  };
}

// ============================================================================
// Main Service Functions
// ============================================================================

/**
 * Update library statistics for a specific server
 */
export async function updateServerLibraryStats(serverId: string): Promise<void> {
  console.log(`[LibraryStats] Starting library stats update for server ${serverId}`);

  // Get server details
  const server = await db.query.servers.findFirst({
    where: eq(servers.id, serverId),
  });

  if (!server) {
    console.error(`[LibraryStats] Server ${serverId} not found`);
    return;
  }

  // Create media server client
  const client = createMediaServerClient({
    type: server.type,
    url: server.url,
    token: server.token,
    id: server.id,
    name: server.name,
  });

  // Fetch all libraries
  let libraries: MediaLibrary[];
  try {
    libraries = await client.getLibraries();
  } catch (error) {
    console.error(`[LibraryStats] Failed to fetch libraries for server ${serverId}:`, error);
    return;
  }

  console.log(`[LibraryStats] Found ${libraries.length} libraries for server ${server.name}`);

  // Filter out unsupported library types
  const filteredLibraries = libraries.filter((lib) => {
    // Skip collections/boxsets for Jellyfin/Emby (they're not real media libraries)
    if (server.type === 'jellyfin' || server.type === 'emby') {
      if (lib.type === 'boxsets' || lib.type === 'collections') {
        console.log(
          `[LibraryStats] Skipping ${lib.name} (${lib.type}) - collections not supported`
        );
        return false;
      }
    }
    // Skip Plex collections as well
    if (server.type === 'plex' && lib.type === 'collection') {
      console.log(`[LibraryStats] Skipping ${lib.name} (${lib.type}) - collections not supported`);
      return false;
    }
    return true;
  });

  console.log(
    `[LibraryStats] Processing ${filteredLibraries.length} libraries (${libraries.length - filteredLibraries.length} skipped)`
  );

  const processedLibraryIds: string[] = [];

  // Process each library
  for (const library of filteredLibraries) {
    try {
      console.log(`[LibraryStats] Processing library: ${library.name} (${library.type})`);

      let stats: LibraryItemStats;

      if (server.type === 'plex') {
        const { items, totalCount, sampled } = await fetchPlexLibraryItems(
          server.url,
          server.token,
          library.id,
          library.type
        );
        stats = calculatePlexLibraryStats(items, library.type, totalCount, sampled);
      } else {
        // Jellyfin or Emby
        const { items, totalCount, sampled } = await fetchJellyfinLibraryItems(
          server.url,
          server.token,
          library.id,
          library.type,
          server.type
        );
        stats = calculateJellyfinLibraryStats(items, library.type, totalCount, sampled);
      }

      // Upsert library statistics
      await db
        .insert(libraryStatistics)
        .values({
          serverId: server.id,
          libraryId: library.id,
          libraryName: library.name,
          libraryType: library.type,
          totalItems: stats.totalItems,
          totalEpisodes: stats.totalEpisodes ?? null,
          totalSeasons: stats.totalSeasons ?? null,
          totalShows: stats.totalShows ?? null,
          totalSizeBytes: stats.totalSizeBytes,
          totalDurationMs: stats.totalDurationMs,
          avgFileSizeBytes: stats.avgFileSizeBytes,
          avgDurationMs: stats.avgDurationMs,
          avgBitrateKbps: stats.avgBitrateKbps,
          hdrItemCount: stats.hdrItemCount,
          lastUpdatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [libraryStatistics.serverId, libraryStatistics.libraryId],
          set: {
            libraryName: library.name,
            libraryType: library.type,
            totalItems: stats.totalItems,
            totalEpisodes: stats.totalEpisodes ?? null,
            totalSeasons: stats.totalSeasons ?? null,
            totalShows: stats.totalShows ?? null,
            totalSizeBytes: stats.totalSizeBytes,
            totalDurationMs: stats.totalDurationMs,
            avgFileSizeBytes: stats.avgFileSizeBytes,
            avgDurationMs: stats.avgDurationMs,
            avgBitrateKbps: stats.avgBitrateKbps,
            hdrItemCount: stats.hdrItemCount,
          },
        });

      processedLibraryIds.push(library.id);

      console.log(
        `[LibraryStats] Updated stats for ${library.name}: ${stats.totalItems} items, ${Math.round(stats.totalSizeBytes / 1e9)}GB`
      );
    } catch (error) {
      console.error(`[LibraryStats] Failed to process library ${library.name}:`, error);
    }
  }

  // Update lastUpdatedAt for all processed libraries at once after all are done
  if (processedLibraryIds.length > 0) {
    const updateTime = new Date();
    await db
      .update(libraryStatistics)
      .set({ lastUpdatedAt: updateTime })
      .where(
        and(
          eq(libraryStatistics.serverId, server.id),
          inArray(libraryStatistics.libraryId, processedLibraryIds)
        )
      );
  }

  console.log(`[LibraryStats] Completed library stats update for server ${server.name}`);
}

/**
 * Create daily snapshot for a server's libraries
 */
export async function createDailySnapshot(serverId: string): Promise<void> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Get current statistics for this server
  const currentStats = await db.query.libraryStatistics.findMany({
    where: eq(libraryStatistics.serverId, serverId),
  });

  for (const stat of currentStats) {
    try {
      await db
        .insert(librarySnapshots)
        .values({
          serverId: stat.serverId,
          libraryId: stat.libraryId,
          libraryName: stat.libraryName,
          libraryType: stat.libraryType,
          snapshotDate: today,
          totalItems: stat.totalItems,
          totalSizeBytes: stat.totalSizeBytes,
          totalDurationMs: stat.totalDurationMs,
        })
        .onConflictDoNothing(); // Skip if snapshot already exists for today
    } catch (error) {
      console.error(
        `[LibraryStats] Failed to create snapshot for library ${stat.libraryId}:`,
        error
      );
    }
  }
}

/**
 * Update all servers' library statistics
 */
export async function updateAllLibraryStats(): Promise<void> {
  console.log('[LibraryStats] Starting update for all servers');

  const allServers = await db.query.servers.findMany();

  for (const server of allServers) {
    try {
      await updateServerLibraryStats(server.id);
      await createDailySnapshot(server.id);
    } catch (error) {
      console.error(`[LibraryStats] Failed to update server ${server.name}:`, error);
    }
  }

  console.log('[LibraryStats] Completed update for all servers');
}

/**
 * Get library statistics from the database
 */
export async function getLibraryStatistics(
  serverId?: string,
  daysOfHistory = 90
): Promise<MediaLibraryStatsResponse> {
  // Build query for current statistics
  const whereClause = serverId ? eq(libraryStatistics.serverId, serverId) : undefined;

  const currentStats = await db.query.libraryStatistics.findMany({
    where: whereClause,
    with: {
      server: true,
    },
  });

  // Calculate totals and find most recent update
  let totalSize = 0;
  let totalItems = 0;
  let totalDurationMs = 0;
  let lastUpdated: Date | null = null;

  for (const stat of currentStats) {
    totalSize += stat.totalSizeBytes;
    totalItems += stat.totalItems;
    totalDurationMs += stat.totalDurationMs;

    if (stat.lastUpdatedAt && (!lastUpdated || stat.lastUpdatedAt > lastUpdated)) {
      lastUpdated = stat.lastUpdatedAt;
    }
  }

  const libraries: MediaLibraryStats[] = currentStats.map((stat) => {
    const hdrPercentage =
      stat.totalItems > 0 ? ((stat.hdrItemCount ?? 0) / stat.totalItems) * 100 : 0;

    const fileStats: MediaLibraryFileStats = {
      avgFileSize: stat.avgFileSizeBytes ?? 0,
      avgDuration: stat.avgDurationMs ?? 0,
      avgBitrate: stat.avgBitrateKbps ?? 0,
      hdrPercentage,
    };

    return {
      id: stat.libraryId,
      serverId: stat.serverId,
      name: stat.libraryName,
      type: stat.libraryType,
      size: stat.totalSizeBytes,
      itemCount: stat.totalItems,
      episodeCount: stat.totalEpisodes ?? undefined,
      seasonCount: stat.totalSeasons ?? undefined,
      showCount: stat.totalShows ?? undefined,
      hours: stat.totalDurationMs / (1000 * 60 * 60), // Convert ms to hours
      fileStats,
      lastUpdatedAt: stat.lastUpdatedAt.toISOString(),
    };
  });

  // Fetch historical data
  const historyStartDate = new Date();
  historyStartDate.setDate(historyStartDate.getDate() - daysOfHistory);

  const historyWhereClause = serverId
    ? and(
        eq(librarySnapshots.serverId, serverId),
        gte(librarySnapshots.snapshotDate, historyStartDate)
      )
    : gte(librarySnapshots.snapshotDate, historyStartDate);

  const snapshots = await db.query.librarySnapshots.findMany({
    where: historyWhereClause,
    orderBy: [desc(librarySnapshots.snapshotDate)],
  });

  // Group snapshots by date
  const snapshotsByDate = new Map<string, MediaLibrarySnapshot[]>();
  for (const snapshot of snapshots) {
    const dateStr = snapshot.snapshotDate.toISOString().split('T')[0] as string;
    const existing = snapshotsByDate.get(dateStr) ?? [];
    existing.push({
      libraryId: snapshot.libraryId,
      libraryName: snapshot.libraryName,
      libraryType: snapshot.libraryType,
      size: snapshot.totalSizeBytes,
      items: snapshot.totalItems,
      durationMs: snapshot.totalDurationMs,
    });
    snapshotsByDate.set(dateStr, existing);
  }

  const historical: MediaLibraryHistoricalDataPoint[] = Array.from(snapshotsByDate.entries())
    .map(([date, libs]) => ({
      date,
      libraries: libs,
    }))
    .sort((a, b) => a.date.localeCompare(b.date)); // Sort ascending by date

  return {
    current: {
      totalSize,
      totalItems,
      totalHours: totalDurationMs / (1000 * 60 * 60),
      lastUpdated: lastUpdated?.toISOString() ?? null,
      libraries,
    },
    historical,
  };
}
