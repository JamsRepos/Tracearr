/**
 * Library Status Route
 *
 * GET /status - Check library sync and backfill status
 */

import type { FastifyPluginAsync } from 'fastify';
import { sql } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { isMaintenanceJobRunning } from '../../jobs/maintenanceQueue.js';
import { getLibrarySyncStatus } from '../../jobs/librarySyncQueue.js';
import { validLibraryItemCondition } from '../../utils/snapshotValidation.js';

/** Library status response shape */
interface LibraryStatusResponse {
  /** Whether the library has been synced (has items) */
  isSynced: boolean;
  /** Whether a library sync is currently running */
  isSyncRunning: boolean;
  /** Whether historical snapshots need backfilling */
  needsBackfill: boolean;
  /** Whether the backfill job is currently running or queued */
  isBackfillRunning: boolean;
  /** State of the backfill job if running */
  backfillState: 'active' | 'waiting' | 'delayed' | null;
  /** Total library items count */
  itemCount: number;
  /** Total snapshots count */
  snapshotCount: number;
  /** Earliest item date (when first content was added) */
  earliestItemDate: string | null;
  /** Earliest snapshot date */
  earliestSnapshotDate: string | null;
  /** Days of history that could be backfilled */
  backfillDays: number | null;
}

export const libraryStatusRoute: FastifyPluginAsync = async (app) => {
  /**
   * GET /status - Check library sync and backfill status
   *
   * Returns information about whether the library needs syncing or backfilling.
   * Used by frontend to show appropriate empty states and action buttons.
   */
  app.get<{ Querystring: { serverId?: string } }>(
    '/status',
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const { serverId } = request.query;

      // Build WHERE clause for server filtering
      const serverFilter = serverId ? sql`AND li.server_id = ${serverId}::uuid` : sql``;
      const serverFilterWhere = serverId ? sql`WHERE li.server_id = ${serverId}::uuid` : sql``;
      const snapshotServerFilter = serverId ? sql`WHERE ls.server_id = ${serverId}::uuid` : sql``;

      // Get library status in a single query
      // Note: earliest_item only considers items with valid file_size since items without
      // size data can't produce meaningful snapshots (see snapshotValidation.ts)
      const result = await db.execute(sql`
        SELECT
          (SELECT MIN(li.created_at)::date FROM library_items li
           WHERE ${validLibraryItemCondition('li')} ${serverFilter}) AS earliest_item,
          (SELECT MIN(ls.snapshot_time)::date FROM library_snapshots ls ${snapshotServerFilter}) AS earliest_snapshot,
          (SELECT COUNT(*)::int FROM library_items li ${serverFilterWhere}) AS item_count,
          (SELECT COUNT(*)::int FROM library_snapshots ls ${snapshotServerFilter}) AS snapshot_count
      `);

      const row = result.rows[0] as {
        earliest_item: string | null;
        earliest_snapshot: string | null;
        item_count: number;
        snapshot_count: number;
      };

      const itemCount = row.item_count ?? 0;
      const snapshotCount = row.snapshot_count ?? 0;
      const earliestItemDate = row.earliest_item;
      const earliestSnapshotDate = row.earliest_snapshot;

      // Library is synced if we have items
      const isSynced = itemCount > 0;

      // Needs backfill if:
      // 1. Has items but no snapshots, OR
      // 2. Snapshots start after items were added (missing historical data)
      let needsBackfill = false;
      let backfillDays: number | null = null;

      if (isSynced) {
        if (snapshotCount === 0) {
          needsBackfill = true;
          if (earliestItemDate) {
            const daysDiff = Math.floor(
              (Date.now() - new Date(earliestItemDate).getTime()) / (1000 * 60 * 60 * 24)
            );
            backfillDays = daysDiff;
          }
        } else if (earliestItemDate && earliestSnapshotDate) {
          const itemDate = new Date(earliestItemDate);
          const snapshotDate = new Date(earliestSnapshotDate);
          if (itemDate < snapshotDate) {
            needsBackfill = true;
            backfillDays = Math.floor(
              (snapshotDate.getTime() - itemDate.getTime()) / (1000 * 60 * 60 * 24)
            );
          }
        }
      }

      // Check if backfill job is running
      const backfillStatus = await isMaintenanceJobRunning('backfill_library_snapshots');

      // Check if library sync is running
      let isSyncRunning = false;
      if (serverId) {
        const syncStatus = await getLibrarySyncStatus(serverId);
        isSyncRunning = syncStatus?.isActive ?? false;
      }

      const response: LibraryStatusResponse = {
        isSynced,
        isSyncRunning,
        needsBackfill,
        isBackfillRunning: backfillStatus.isRunning,
        backfillState: backfillStatus.state,
        itemCount,
        snapshotCount,
        earliestItemDate,
        earliestSnapshotDate,
        backfillDays,
      };

      return reply.send(response);
    }
  );
};
