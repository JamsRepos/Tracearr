/**
 * Ordered multi-select for login methods (Plex, Jellyfin, Local).
 * Order determines default on the login page (first Jellyfin or Local).
 */

import { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { KeyRound, ChevronsUpDown, ChevronUp, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { MediaServerIcon } from '@/components/icons/MediaServerIcon';
import type { LoginMethod } from '@tracearr/shared';

// -----------------------------------------------------------------------------
// Config & util
// -----------------------------------------------------------------------------

export const LOGIN_METHODS: LoginMethod[] = ['plex', 'jellyfin', 'local'];

const ICON_CLASS = 'h-4 w-4 shrink-0';

const LOGIN_METHOD_ICONS: Record<LoginMethod, React.ComponentType<{ className?: string }>> = {
  plex: (p) => <MediaServerIcon type="plex" className={ICON_CLASS} {...p} />,
  jellyfin: (p) => <MediaServerIcon type="jellyfin" className={ICON_CLASS} {...p} />,
  local: (p) => <KeyRound className={ICON_CLASS} {...p} />,
};

/** Keys for translated labels (pages:settings.access.loginMethod*) */
const LOGIN_METHOD_LABEL_KEYS: Record<LoginMethod, string> = {
  plex: 'loginMethodPlex',
  jellyfin: 'loginMethodJellyfinAdmin',
  local: 'loginMethodLocalAccount',
};

/** Legacy export: label is only used when translations not yet available (e.g. tests). */
export const LOGIN_METHOD_CONFIG: Record<
  LoginMethod,
  { label: string; Icon: React.ComponentType<{ className?: string }> }
> = {
  plex: { label: 'Plex', Icon: LOGIN_METHOD_ICONS.plex },
  jellyfin: { label: 'Jellyfin Admin', Icon: LOGIN_METHOD_ICONS.jellyfin },
  local: { label: 'Local Account', Icon: LOGIN_METHOD_ICONS.local },
};

/** Swap item at index i with i + delta. Returns new array or null if move invalid. */
export function reorderByIndex<T>(arr: T[], index: number, delta: number): T[] | null {
  const next = index + delta;
  if (next < 0 || next >= arr.length) return null;
  const out = [...arr];
  const a = out[index];
  const b = out[next];
  if (a === undefined || b === undefined) return null;
  out[index] = b;
  out[next] = a;
  return out;
}

// -----------------------------------------------------------------------------
// Row (selected with reorder, or unselected)
// -----------------------------------------------------------------------------

interface RowProps {
  method: LoginMethod;
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
  selected: boolean;
  canUncheck: boolean;
  onToggle: () => void;
  reorder?: {
    canUp: boolean;
    canDown: boolean;
    onUp: () => void;
    onDown: () => void;
    ariaLabelUp: string;
    ariaLabelDown: string;
  };
}

function Row({ method: _method, label, Icon, selected, canUncheck, onToggle, reorder }: RowProps) {
  const borderClass = selected
    ? 'rounded-md border bg-muted/30 px-2 py-1.5'
    : 'rounded-md px-2 py-1.5 hover:bg-muted/50';

  return (
    <div className={`flex items-center gap-2 ${borderClass}`}>
      <Checkbox
        checked={selected}
        disabled={selected && !canUncheck}
        onCheckedChange={() => (selected ? canUncheck && onToggle() : onToggle())}
      />
      <Icon />
      <span className={selected ? 'min-w-0 flex-1 text-sm' : ''}>{label}</span>
      {reorder && (
        <div className="flex shrink-0 gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            disabled={!reorder.canUp}
            onClick={reorder.onUp}
            aria-label={reorder.ariaLabelUp}
          >
            <ChevronUp className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            disabled={!reorder.canDown}
            onClick={reorder.onDown}
            aria-label={reorder.ariaLabelDown}
          >
            <ChevronDown className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Main component
// -----------------------------------------------------------------------------

export interface LoginMethodsMultiSelectProps {
  selection: LoginMethod[];
  availableMethods: LoginMethod[];
  canUncheck: (method: LoginMethod) => boolean;
  onToggle: (method: LoginMethod) => void;
  onReorder: (method: LoginMethod, delta: -1 | 1) => void;
  ariaInvalid?: boolean;
  orderHint?: string;
  addLabel?: string;
}

export function LoginMethodsMultiSelect({
  selection,
  availableMethods,
  canUncheck,
  onToggle,
  onReorder,
  ariaInvalid,
  orderHint,
  addLabel,
}: LoginMethodsMultiSelectProps) {
  const { t } = useTranslation('pages');
  const [open, setOpen] = useState(false);

  const methodLabels = useMemo(
    () =>
      Object.fromEntries(
        LOGIN_METHODS.map((m) => [
          m,
          t(`settings.access.${LOGIN_METHOD_LABEL_KEYS[m]}` as 'settings.access.loginMethodPlex'),
        ])
      ) as Record<LoginMethod, string>,
    [t]
  );

  const availableOptions = useMemo(
    () => LOGIN_METHODS.filter((m) => availableMethods.includes(m)),
    [availableMethods]
  );
  const unselectedOptions = useMemo(
    () => availableOptions.filter((m) => !selection.includes(m)),
    [availableOptions, selection]
  );
  const summary =
    selection.length === 0
      ? t('settings.access.selectMethods' as const)
      : selection.map((m) => methodLabels[m]).join(' → ');

  const resolvedOrderHint = orderHint ?? t('settings.access.orderHint' as const);
  const resolvedAddLabel = addLabel ?? t('settings.access.addMethod' as const);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-invalid={ariaInvalid}
          className="h-auto min-h-10 w-full justify-between"
        >
          <span className="text-muted-foreground truncate">{summary}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-2" align="start">
        <p className="text-muted-foreground mb-2 text-xs">{resolvedOrderHint}</p>
        <div className="space-y-1">
          {selection.map((method, idx) => (
            <Row
              key={method}
              method={method}
              label={methodLabels[method]}
              Icon={LOGIN_METHOD_ICONS[method]}
              selected
              canUncheck={canUncheck(method)}
              onToggle={() => onToggle(method)}
              reorder={{
                canUp: idx > 0,
                canDown: idx < selection.length - 1,
                onUp: () => onReorder(method, -1),
                onDown: () => onReorder(method, 1),
                ariaLabelUp: t('settings.access.moveUp' as const, {
                  label: methodLabels[method],
                }),
                ariaLabelDown: t('settings.access.moveDown' as const, {
                  label: methodLabels[method],
                }),
              }}
            />
          ))}
        </div>
        {unselectedOptions.length > 0 && (
          <>
            <div className="my-2 border-t" />
            <p className="text-muted-foreground mb-1 text-xs">{resolvedAddLabel}</p>
            <div className="space-y-1">
              {unselectedOptions.map((method) => (
                <label key={method} className="flex cursor-pointer items-center">
                  <Row
                    method={method}
                    label={methodLabels[method]}
                    Icon={LOGIN_METHOD_ICONS[method]}
                    selected={false}
                    canUncheck={true}
                    onToggle={() => onToggle(method)}
                  />
                </label>
              ))}
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
