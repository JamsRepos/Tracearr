import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { Checkbox } from '@/components/ui/checkbox';
import { BulkActionsToolbar, type BulkAction } from '@/components/ui/bulk-actions-toolbar';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Plus,
  Pencil,
  Trash2,
  Shield,
  MapPin,
  Zap,
  Users,
  Globe,
  Power,
  PowerOff,
} from 'lucide-react';
import { CountryMultiSelect } from '@/components/ui/country-multi-select';
import { getCountryName } from '@/lib/utils';
import type { Rule, RuleType, RuleParams, UnitSystem } from '@tracearr/shared';
import {
  getSpeedUnit,
  getDistanceUnit,
  fromMetricDistance,
  toMetricDistance,
} from '@tracearr/shared';
import {
  useRules,
  useCreateRule,
  useUpdateRule,
  useDeleteRule,
  useToggleRule,
  useBulkToggleRules,
  useBulkDeleteRules,
  useSettings,
} from '@/hooks/queries';
import { useRowSelection } from '@/hooks/useRowSelection';

const RULE_TYPES: { value: RuleType; label: string; icon: React.ReactNode; description: string }[] =
  [
    {
      value: 'impossible_travel',
      label: 'Impossible Travel',
      icon: <MapPin className="h-4 w-4" />,
      description: 'Detect when a user streams from locations too far apart in a short time',
    },
    {
      value: 'simultaneous_locations',
      label: 'Simultaneous Locations',
      icon: <Users className="h-4 w-4" />,
      description: 'Detect when a user streams from multiple distant locations at once',
    },
    {
      value: 'device_velocity',
      label: 'Device Velocity',
      icon: <Zap className="h-4 w-4" />,
      description: 'Detect when a user connects from too many IPs in a time window',
    },
    {
      value: 'concurrent_streams',
      label: 'Concurrent Streams',
      icon: <Shield className="h-4 w-4" />,
      description: 'Limit the number of simultaneous streams per user',
    },
    {
      value: 'geo_restriction',
      label: 'Geo Restriction',
      icon: <Globe className="h-4 w-4" />,
      description: 'Block streaming from specific countries',
    },
  ];

const DEFAULT_PARAMS: Record<RuleType, RuleParams> = {
  impossible_travel: { maxSpeedKmh: 500, excludePrivateIps: false },
  simultaneous_locations: { minDistanceKm: 100, excludePrivateIps: false },
  device_velocity: { maxIps: 5, windowHours: 24, excludePrivateIps: false, groupByDevice: false },
  concurrent_streams: { maxStreams: 3, excludePrivateIps: false },
  geo_restriction: { mode: 'blocklist', countries: [], excludePrivateIps: false },
};

interface RuleFormData {
  name: string;
  type: RuleType;
  params: RuleParams;
  isActive: boolean;
}

// Separate component for geo restriction to handle country selection
function GeoRestrictionInput({
  params,
  onChange,
}: {
  params: { mode?: 'blocklist' | 'allowlist'; countries?: string[]; blockedCountries?: string[] };
  onChange: (params: RuleParams) => void;
}) {
  // Handle backwards compatibility
  const mode = params.mode ?? 'blocklist';
  const countries = params.countries ?? params.blockedCountries ?? [];

  const handleModeChange = (newMode: 'blocklist' | 'allowlist') => {
    onChange({ mode: newMode, countries });
  };

  const handleCountriesChange = (newCountries: string[]) => {
    onChange({ mode, countries: newCountries });
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>Mode</Label>
        <Select
          value={mode}
          onValueChange={(v) => handleModeChange(v as 'blocklist' | 'allowlist')}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="blocklist">Blocklist (block these countries)</SelectItem>
            <SelectItem value="allowlist">Allowlist (only allow these countries)</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label>{mode === 'blocklist' ? 'Blocked' : 'Allowed'} Countries</Label>
        <CountryMultiSelect
          value={countries}
          onChange={handleCountriesChange}
          placeholder={
            mode === 'blocklist' ? 'Select countries to block...' : 'Select allowed countries...'
          }
        />
        <p className="text-muted-foreground text-xs">
          {mode === 'allowlist' && 'Streams from any other country will trigger a violation.'}
        </p>
      </div>
    </div>
  );
}

/** Shared toggle for excluding local/private network IPs from rule evaluation */
function ExcludePrivateIpsToggle({
  checked,
  onCheckedChange,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between rounded-lg border p-3">
      <div className="space-y-0.5">
        <Label htmlFor="excludePrivateIps" className="text-sm font-medium">
          Exclude Local Network
        </Label>
        <p className="text-muted-foreground text-xs">
          Ignore sessions from local/private IPs (e.g., 192.168.x.x, 10.x.x.x)
        </p>
      </div>
      <Switch id="excludePrivateIps" checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  );
}

function RuleParamsForm({
  type,
  params,
  onChange,
  unitSystem,
}: {
  type: RuleType;
  params: RuleParams;
  onChange: (params: RuleParams) => void;
  unitSystem: UnitSystem;
}) {
  const speedUnit = getSpeedUnit(unitSystem);
  const distanceUnit = getDistanceUnit(unitSystem);
  const excludePrivateIps = (params as { excludePrivateIps?: boolean }).excludePrivateIps ?? false;

  switch (type) {
    case 'impossible_travel': {
      // Convert metric value to display value
      const displayValue = Math.round(
        fromMetricDistance((params as { maxSpeedKmh: number }).maxSpeedKmh, unitSystem)
      );
      const defaultDisplay = Math.round(fromMetricDistance(500, unitSystem));
      return (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="maxSpeedKmh">Max Speed ({speedUnit})</Label>
            <Input
              id="maxSpeedKmh"
              type="number"
              value={displayValue}
              onChange={(e) => {
                // Convert display value back to metric for storage
                const inputValue = parseInt(e.target.value) || 0;
                const metricValue = Math.round(toMetricDistance(inputValue, unitSystem));
                onChange({ ...params, maxSpeedKmh: metricValue });
              }}
            />
            <p className="text-muted-foreground text-xs">
              Maximum realistic travel speed. Default: {defaultDisplay} {speedUnit} (airplane speed)
            </p>
          </div>
          <ExcludePrivateIpsToggle
            checked={excludePrivateIps}
            onCheckedChange={(checked) => onChange({ ...params, excludePrivateIps: checked })}
          />
        </div>
      );
    }
    case 'simultaneous_locations': {
      // Convert metric value to display value
      const displayValue = Math.round(
        fromMetricDistance((params as { minDistanceKm: number }).minDistanceKm, unitSystem)
      );
      const defaultDisplay = Math.round(fromMetricDistance(100, unitSystem));
      return (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="minDistanceKm">Min Distance ({distanceUnit})</Label>
            <Input
              id="minDistanceKm"
              type="number"
              value={displayValue}
              onChange={(e) => {
                // Convert display value back to metric for storage
                const inputValue = parseInt(e.target.value) || 0;
                const metricValue = Math.round(toMetricDistance(inputValue, unitSystem));
                onChange({ ...params, minDistanceKm: metricValue });
              }}
            />
            <p className="text-muted-foreground text-xs">
              Minimum distance between locations to trigger. Default: {defaultDisplay}{' '}
              {distanceUnit}
            </p>
          </div>
          <ExcludePrivateIpsToggle
            checked={excludePrivateIps}
            onCheckedChange={(checked) => onChange({ ...params, excludePrivateIps: checked })}
          />
        </div>
      );
    }
    case 'device_velocity': {
      const groupByDevice = (params as { groupByDevice?: boolean }).groupByDevice ?? false;
      return (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="maxIps">Max IPs</Label>
            <Input
              id="maxIps"
              type="number"
              value={(params as { maxIps: number; windowHours: number }).maxIps}
              onChange={(e) => {
                onChange({ ...params, maxIps: parseInt(e.target.value) || 0 });
              }}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="windowHours">Time Window (hours)</Label>
            <Input
              id="windowHours"
              type="number"
              value={(params as { maxIps: number; windowHours: number }).windowHours}
              onChange={(e) => {
                onChange({ ...params, windowHours: parseInt(e.target.value) || 0 });
              }}
            />
          </div>
          <p className="text-muted-foreground text-xs">
            Maximum unique IPs allowed within the time window. Default: 5 IPs in 24 hours
          </p>
          <div className="flex items-center justify-between rounded-lg border p-3">
            <div className="space-y-0.5">
              <Label htmlFor="groupByDevice" className="text-sm font-medium">
                Group by Device
              </Label>
              <p className="text-muted-foreground text-xs">
                Count by device instead of IP. Prevents false positives from VPN, DHCP, or Virtual
                Channels.
              </p>
            </div>
            <Switch
              id="groupByDevice"
              checked={groupByDevice}
              onCheckedChange={(checked) => onChange({ ...params, groupByDevice: checked })}
            />
          </div>
          <ExcludePrivateIpsToggle
            checked={excludePrivateIps}
            onCheckedChange={(checked) => onChange({ ...params, excludePrivateIps: checked })}
          />
        </div>
      );
    }
    case 'concurrent_streams':
      return (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="maxStreams">Max Streams</Label>
            <Input
              id="maxStreams"
              type="number"
              value={(params as { maxStreams: number }).maxStreams}
              onChange={(e) => {
                onChange({ ...params, maxStreams: parseInt(e.target.value) || 0 });
              }}
            />
            <p className="text-muted-foreground text-xs">
              Maximum simultaneous streams per user. Default: 3
            </p>
          </div>
          <ExcludePrivateIpsToggle
            checked={excludePrivateIps}
            onCheckedChange={(checked) => onChange({ ...params, excludePrivateIps: checked })}
          />
        </div>
      );
    case 'geo_restriction':
      return (
        <GeoRestrictionInput
          params={
            params as {
              mode?: 'blocklist' | 'allowlist';
              countries?: string[];
              blockedCountries?: string[];
            }
          }
          onChange={onChange}
        />
      );
    default:
      return null;
  }
}

function RuleDialog({
  rule,
  onSave,
  onClose,
  isLoading,
  unitSystem,
}: {
  rule?: Rule;
  onSave: (data: RuleFormData) => void;
  onClose: () => void;
  isLoading?: boolean;
  unitSystem: UnitSystem;
}) {
  const isEditing = !!rule;
  const [formData, setFormData] = useState<RuleFormData>({
    name: rule?.name ?? '',
    type: rule?.type ?? 'concurrent_streams',
    params: rule?.params ?? DEFAULT_PARAMS['concurrent_streams'],
    isActive: rule?.isActive ?? true,
  });

  const handleTypeChange = (type: RuleType) => {
    setFormData({
      ...formData,
      type,
      params: DEFAULT_PARAMS[type],
    });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave(formData);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="name">Rule Name</Label>
        <Input
          id="name"
          value={formData.name}
          onChange={(e) => {
            setFormData({ ...formData, name: e.target.value });
          }}
          placeholder="e.g., Concurrent Stream Limit"
          required
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="type">Rule Type</Label>
        <Select
          value={formData.type}
          onValueChange={(value) => {
            handleTypeChange(value as RuleType);
          }}
          disabled={isEditing}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RULE_TYPES.map((type) => (
              <SelectItem key={type.value} value={type.value}>
                <div className="flex items-center gap-2">
                  {type.icon}
                  {type.label}
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-muted-foreground text-xs">
          {RULE_TYPES.find((t) => t.value === formData.type)?.description}
        </p>
      </div>

      <RuleParamsForm
        type={formData.type}
        params={formData.params}
        onChange={(params) => {
          setFormData({ ...formData, params });
        }}
        unitSystem={unitSystem}
      />

      <div className="flex items-center justify-between">
        <Label htmlFor="isActive">Active</Label>
        <Switch
          id="isActive"
          checked={formData.isActive}
          onCheckedChange={(checked) => {
            setFormData({ ...formData, isActive: checked });
          }}
        />
      </div>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={isLoading || !formData.name}>
          {isLoading ? 'Saving...' : isEditing ? 'Update Rule' : 'Create Rule'}
        </Button>
      </DialogFooter>
    </form>
  );
}

function RuleCard({
  rule,
  onEdit,
  onDelete,
  onToggle,
  unitSystem,
  isSelected,
  onSelect,
}: {
  rule: Rule;
  onEdit: () => void;
  onDelete: () => void;
  onToggle: () => void;
  unitSystem: UnitSystem;
  isSelected?: boolean;
  onSelect?: () => void;
}) {
  const ruleType = RULE_TYPES.find((t) => t.value === rule.type);
  const speedUnit = getSpeedUnit(unitSystem);
  const distanceUnit = getDistanceUnit(unitSystem);

  return (
    <Card
      className={`${!rule.isActive ? 'opacity-60' : ''} ${isSelected ? 'ring-primary ring-2' : ''}`}
    >
      <CardContent className="pt-6">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-4">
            {onSelect && (
              <Checkbox
                checked={isSelected}
                onCheckedChange={onSelect}
                aria-label={`Select ${rule.name}`}
              />
            )}
            <div className="bg-muted flex h-10 w-10 items-center justify-center rounded-lg">
              {ruleType?.icon ?? <Shield className="h-5 w-5" />}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-semibold">{rule.name}</h3>
                {!rule.isActive && (
                  <span className="text-muted-foreground text-xs">(Disabled)</span>
                )}
              </div>
              <p className="text-muted-foreground text-sm capitalize">
                {rule.type.replace(/_/g, ' ')}
              </p>
              <div className="text-muted-foreground mt-2 text-xs">
                {rule.type === 'impossible_travel' && (
                  <span>
                    Max speed:{' '}
                    {Math.round(
                      fromMetricDistance(
                        (rule.params as { maxSpeedKmh: number }).maxSpeedKmh,
                        unitSystem
                      )
                    )}{' '}
                    {speedUnit}
                  </span>
                )}
                {rule.type === 'simultaneous_locations' && (
                  <span>
                    Min distance:{' '}
                    {Math.round(
                      fromMetricDistance(
                        (rule.params as { minDistanceKm: number }).minDistanceKm,
                        unitSystem
                      )
                    )}{' '}
                    {distanceUnit}
                  </span>
                )}
                {rule.type === 'device_velocity' && (
                  <span>
                    Max {(rule.params as { maxIps: number; windowHours: number }).maxIps} IPs in{' '}
                    {(rule.params as { maxIps: number; windowHours: number }).windowHours} hours
                  </span>
                )}
                {rule.type === 'concurrent_streams' && (
                  <span>Max streams: {(rule.params as { maxStreams: number }).maxStreams}</span>
                )}
                {rule.type === 'geo_restriction' &&
                  (() => {
                    const p = rule.params as {
                      mode?: string;
                      countries?: string[];
                      blockedCountries?: string[];
                    };
                    const mode = p.mode ?? 'blocklist';
                    const countries = p.countries ?? p.blockedCountries ?? [];
                    const countryNames = countries.map((c) => getCountryName(c) ?? c);
                    return (
                      <span>
                        {mode === 'allowlist' ? 'Allowed' : 'Blocked'}:{' '}
                        {countryNames.join(', ') || 'None'}
                      </span>
                    );
                  })()}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Switch checked={rule.isActive} onCheckedChange={onToggle} />
            <Button variant="ghost" size="icon" onClick={onEdit}>
              <Pencil className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" onClick={onDelete}>
              <Trash2 className="text-destructive h-4 w-4" />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function Rules() {
  const { data: rules, isLoading } = useRules();
  const { data: settings } = useSettings();
  const createRule = useCreateRule();
  const updateRule = useUpdateRule();
  const deleteRule = useDeleteRule();
  const toggleRule = useToggleRule();
  const bulkToggleRules = useBulkToggleRules();
  const bulkDeleteRules = useBulkDeleteRules();

  const unitSystem = settings?.unitSystem ?? 'metric';

  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<Rule | undefined>();
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [bulkDeleteConfirmOpen, setBulkDeleteConfirmOpen] = useState(false);

  // Row selection for bulk operations
  const { selectedIds, selectedCount, toggleRow, clearSelection, isSelected } = useRowSelection({
    getRowId: (rule: Rule) => rule.id,
    totalCount: rules?.length ?? 0,
  });

  const handleCreate = (data: RuleFormData) => {
    createRule.mutate(
      {
        name: data.name,
        type: data.type,
        params: data.params,
        isActive: data.isActive,
        serverUserId: null,
      },
      {
        onSuccess: () => {
          setIsDialogOpen(false);
          setEditingRule(undefined);
        },
      }
    );
  };

  const handleUpdate = (data: RuleFormData) => {
    if (!editingRule) return;
    updateRule.mutate(
      {
        id: editingRule.id,
        data: {
          name: data.name,
          params: data.params,
          isActive: data.isActive,
        },
      },
      {
        onSuccess: () => {
          setIsDialogOpen(false);
          setEditingRule(undefined);
        },
      }
    );
  };

  const handleDelete = (id: string) => {
    deleteRule.mutate(id, {
      onSuccess: () => {
        setDeleteConfirmId(null);
      },
    });
  };

  const handleToggle = (rule: Rule) => {
    toggleRule.mutate({ id: rule.id, isActive: !rule.isActive });
  };

  const handleBulkEnable = () => {
    bulkToggleRules.mutate(
      { ids: Array.from(selectedIds), isActive: true },
      { onSuccess: clearSelection }
    );
  };

  const handleBulkDisable = () => {
    bulkToggleRules.mutate(
      { ids: Array.from(selectedIds), isActive: false },
      { onSuccess: clearSelection }
    );
  };

  const handleBulkDelete = () => {
    bulkDeleteRules.mutate(Array.from(selectedIds), {
      onSuccess: () => {
        clearSelection();
        setBulkDeleteConfirmOpen(false);
      },
    });
  };

  const openCreateDialog = () => {
    setEditingRule(undefined);
    setIsDialogOpen(true);
  };

  const openEditDialog = (rule: Rule) => {
    setEditingRule(rule);
    setIsDialogOpen(true);
  };

  const bulkActions: BulkAction[] = [
    {
      key: 'enable',
      label: 'Enable',
      icon: <Power className="h-4 w-4" />,
      color: 'success',
      onClick: handleBulkEnable,
      isLoading: bulkToggleRules.isPending,
    },
    {
      key: 'disable',
      label: 'Disable',
      icon: <PowerOff className="h-4 w-4" />,
      color: 'warning',
      onClick: handleBulkDisable,
      isLoading: bulkToggleRules.isPending,
    },
    {
      key: 'delete',
      label: 'Delete',
      icon: <Trash2 className="h-4 w-4" />,
      color: 'destructive',
      onClick: () => setBulkDeleteConfirmOpen(true),
      isLoading: bulkDeleteRules.isPending,
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Rules</h1>
          <p className="text-muted-foreground">
            Configure detection rules for account sharing and policy violations
          </p>
        </div>
        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogTrigger asChild>
            <Button onClick={openCreateDialog}>
              <Plus className="mr-2 h-4 w-4" />
              Add Rule
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{editingRule ? 'Edit Rule' : 'Create Rule'}</DialogTitle>
              <DialogDescription>
                {editingRule
                  ? 'Update the rule configuration below.'
                  : 'Configure a new detection rule for your media servers.'}
              </DialogDescription>
            </DialogHeader>
            <RuleDialog
              rule={editingRule}
              onSave={editingRule ? handleUpdate : handleCreate}
              onClose={() => {
                setIsDialogOpen(false);
              }}
              isLoading={createRule.isPending || updateRule.isPending}
              unitSystem={unitSystem}
            />
          </DialogContent>
        </Dialog>
      </div>

      {isLoading ? (
        <div className="space-y-4">
          {[...Array(3)].map((_, i) => (
            <Card key={i}>
              <CardContent className="pt-6">
                <div className="flex items-start gap-4">
                  <Skeleton className="h-10 w-10 rounded-lg" />
                  <div className="space-y-2">
                    <Skeleton className="h-5 w-32" />
                    <Skeleton className="h-4 w-24" />
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : !rules || rules.length === 0 ? (
        <Card>
          <CardContent className="flex h-64 flex-col items-center justify-center gap-4">
            <Shield className="text-muted-foreground h-12 w-12" />
            <div className="text-center">
              <h3 className="font-semibold">No rules configured</h3>
              <p className="text-muted-foreground text-sm">
                Create your first detection rule to start monitoring for account sharing.
              </p>
            </div>
            <Button onClick={openCreateDialog}>
              <Plus className="mr-2 h-4 w-4" />
              Add Rule
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {rules.map((rule) => (
            <RuleCard
              key={rule.id}
              rule={rule}
              onEdit={() => {
                openEditDialog(rule);
              }}
              onDelete={() => {
                setDeleteConfirmId(rule.id);
              }}
              onToggle={() => {
                handleToggle(rule);
              }}
              unitSystem={unitSystem}
              isSelected={isSelected(rule)}
              onSelect={() => toggleRow(rule)}
            />
          ))}
        </div>
      )}

      {/* Bulk Actions Toolbar */}
      <BulkActionsToolbar
        selectedCount={selectedCount}
        actions={bulkActions}
        onClearSelection={clearSelection}
      />

      {/* Bulk Delete Confirmation */}
      <ConfirmDialog
        open={bulkDeleteConfirmOpen}
        onOpenChange={setBulkDeleteConfirmOpen}
        title={`Delete ${selectedCount} Rules`}
        description={`Are you sure you want to delete ${selectedCount} rule${selectedCount !== 1 ? 's' : ''}? This action cannot be undone.`}
        confirmLabel="Delete"
        onConfirm={handleBulkDelete}
        isLoading={bulkDeleteRules.isPending}
      />

      <ConfirmDialog
        open={!!deleteConfirmId}
        onOpenChange={() => {
          setDeleteConfirmId(null);
        }}
        title="Delete Rule"
        description="Are you sure you want to delete this rule? This action cannot be undone."
        confirmLabel="Delete"
        onConfirm={() => deleteConfirmId && handleDelete(deleteConfirmId)}
        isLoading={deleteRule.isPending}
      />
    </div>
  );
}
