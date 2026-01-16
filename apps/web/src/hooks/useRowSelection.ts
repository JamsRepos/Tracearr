import { useState, useCallback, useMemo } from 'react';

export type SelectionMode = 'none' | 'partial' | 'page' | 'all';

export interface UseRowSelectionOptions<TData> {
  /** Function to get unique ID from a row */
  getRowId: (row: TData) => string;
  /** Total count of items matching current filters (for "select all" mode) */
  totalCount?: number;
}

export interface UseRowSelectionReturn<TData> {
  /** Set of currently selected row IDs */
  selectedIds: Set<string>;
  /** Whether "select all matching" mode is active */
  selectAllMode: boolean;
  /** Current selection mode for UI indication */
  selectionMode: SelectionMode;
  /** Count of selected items (or total if selectAll) */
  selectedCount: number;
  /** Check if a specific row is selected */
  isSelected: (row: TData) => boolean;
  /** Toggle selection of a single row */
  toggleRow: (row: TData) => void;
  /** Toggle all rows on current page */
  togglePage: (pageRows: TData[]) => void;
  /** Select all items matching current filters */
  selectAll: () => void;
  /** Clear all selection */
  clearSelection: () => void;
  /** Check if all rows on current page are selected */
  isPageSelected: (pageRows: TData[]) => boolean;
  /** Check if some (but not all) rows on current page are selected */
  isPageIndeterminate: (pageRows: TData[]) => boolean;
}

export function useRowSelection<TData>({
  getRowId,
  totalCount = 0,
}: UseRowSelectionOptions<TData>): UseRowSelectionReturn<TData> {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectAllMode, setSelectAllMode] = useState(false);

  const selectedCount = useMemo(() => {
    if (selectAllMode) {
      return totalCount;
    }
    return selectedIds.size;
  }, [selectAllMode, totalCount, selectedIds.size]);

  const selectionMode = useMemo((): SelectionMode => {
    if (selectAllMode) return 'all';
    if (selectedIds.size === 0) return 'none';
    return 'partial';
  }, [selectAllMode, selectedIds.size]);

  const isSelected = useCallback(
    (row: TData): boolean => {
      if (selectAllMode) return true;
      return selectedIds.has(getRowId(row));
    },
    [selectAllMode, selectedIds, getRowId]
  );

  const toggleRow = useCallback(
    (row: TData) => {
      const id = getRowId(row);
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) {
          next.delete(id);
        } else {
          next.add(id);
        }
        return next;
      });
      // Exit selectAll mode when individual row is toggled
      setSelectAllMode(false);
    },
    [getRowId]
  );

  const togglePage = useCallback(
    (pageRows: TData[]) => {
      const pageIds = pageRows.map(getRowId);
      const allSelected = pageIds.every((id) => selectedIds.has(id));

      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (allSelected) {
          // Deselect all on page
          pageIds.forEach((id) => next.delete(id));
        } else {
          // Select all on page
          pageIds.forEach((id) => next.add(id));
        }
        return next;
      });
      // Exit selectAll mode when toggling page
      setSelectAllMode(false);
    },
    [getRowId, selectedIds]
  );

  const selectAll = useCallback(() => {
    setSelectAllMode(true);
    setSelectedIds(new Set());
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
    setSelectAllMode(false);
  }, []);

  const isPageSelected = useCallback(
    (pageRows: TData[]): boolean => {
      if (selectAllMode) return true;
      if (pageRows.length === 0) return false;
      return pageRows.every((row) => selectedIds.has(getRowId(row)));
    },
    [selectAllMode, selectedIds, getRowId]
  );

  const isPageIndeterminate = useCallback(
    (pageRows: TData[]): boolean => {
      if (selectAllMode) return false;
      if (pageRows.length === 0) return false;
      const selectedOnPage = pageRows.filter((row) => selectedIds.has(getRowId(row)));
      return selectedOnPage.length > 0 && selectedOnPage.length < pageRows.length;
    },
    [selectAllMode, selectedIds, getRowId]
  );

  return {
    selectedIds,
    selectAllMode,
    selectionMode,
    selectedCount,
    isSelected,
    toggleRow,
    togglePage,
    selectAll,
    clearSelection,
    isPageSelected,
    isPageIndeterminate,
  };
}
