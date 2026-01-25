/**
 * Snapshot Validation Utilities
 *
 * Centralized definitions for what constitutes valid library items and snapshots.
 * Used by CTA logic, backfill triggers, cleanup jobs, and chart queries.
 */

import { sql, type SQL } from 'drizzle-orm';

/**
 * SQL fragment for filtering library items that can produce valid snapshots.
 * Items without file_size can't contribute to storage trends.
 *
 * Usage (no alias): WHERE ${VALID_LIBRARY_ITEM_CONDITION}
 * Usage (with alias): WHERE ${validLibraryItemCondition('li')}
 */
export const VALID_LIBRARY_ITEM_CONDITION: SQL = sql`file_size IS NOT NULL AND file_size > 0`;

/**
 * Returns SQL condition for valid library items with table alias prefix.
 */
export function validLibraryItemCondition(alias: string): SQL {
  return sql.raw(`${alias}.file_size IS NOT NULL AND ${alias}.file_size > 0`);
}

/**
 * SQL fragment for filtering valid snapshots.
 * A snapshot is valid if it has at least one item AND has storage size.
 * Both are required for meaningful trend data.
 *
 * Usage (no alias): WHERE ${VALID_SNAPSHOT_CONDITION}
 * Usage (with alias): WHERE ${validSnapshotCondition('ls')}
 */
export const VALID_SNAPSHOT_CONDITION: SQL = sql`(
  (
    item_count > 0
    OR movie_count > 0
    OR episode_count > 0
    OR show_count > 0
    OR music_count > 0
  )
  AND total_size > 0
)`;

/**
 * Returns SQL condition for valid snapshots with table alias prefix.
 */
export function validSnapshotCondition(alias: string): SQL {
  return sql.raw(`(
    (
      ${alias}.item_count > 0
      OR ${alias}.movie_count > 0
      OR ${alias}.episode_count > 0
      OR ${alias}.show_count > 0
      OR ${alias}.music_count > 0
    )
    AND ${alias}.total_size > 0
  )`);
}

/**
 * SQL fragment for identifying invalid snapshots (for cleanup).
 * A snapshot is invalid if it has NO items OR NO storage size.
 * Both are required for meaningful trend data.
 *
 * Usage: DELETE FROM library_snapshots WHERE ${INVALID_SNAPSHOT_CONDITION}
 */
export const INVALID_SNAPSHOT_CONDITION: SQL = sql`(
  (
    item_count = 0
    AND movie_count = 0
    AND episode_count = 0
    AND show_count = 0
    AND music_count = 0
  )
  OR total_size = 0
)`;
