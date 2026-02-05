import { useMemo, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Field, FieldGroup, FieldLabel, FieldDescription, FieldError } from '@/components/ui/field';
import { AutosaveSwitchField, SaveStatusIndicator } from '@/components/ui/autosave-field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Shield } from 'lucide-react';
import { useDebouncedSave } from '@/hooks/useDebouncedSave';
import { useSettings, useServers, useJellyfinAdmins } from '@/hooks/queries';
import type { Server } from '@tracearr/shared';
import type { LoginMethod } from '@tracearr/shared';
import { LoginMethodsMultiSelect, LOGIN_METHODS, reorderByIndex } from './LoginMethodsMultiSelect';

export function AccessSettings() {
  const { t } = useTranslation(['pages', 'common']);
  const { data: settings, isLoading: settingsLoading } = useSettings();
  const { data: serversData, isLoading: serversLoading } = useServers();

  const allowGuestAccessField = useDebouncedSave('allowGuestAccess', settings?.allowGuestAccess);
  const enabledLoginMethodsField = useDebouncedSave(
    'enabledLoginMethods',
    settings?.enabledLoginMethods ?? null,
    { delay: 300 }
  );
  const jellyfinOwnerIdField = useDebouncedSave(
    'jellyfinOwnerId',
    settings?.jellyfinOwnerId ?? null
  );

  // Handle both array and wrapped response formats
  const servers = Array.isArray(serversData)
    ? serversData
    : ((serversData as unknown as { data?: Server[] })?.data ?? []);
  const hasPlexServer = servers.some((s) => s.type === 'plex');
  const hasJellyfinServer = servers.some((s) => s.type === 'jellyfin');
  // From GET /settings (owner-only): whether any user has a password (so Local can stay in enabled methods)
  const hasPasswordAuth = settings?.hasPasswordAuth ?? false;

  const isUsable = useCallback(
    (m: LoginMethod) =>
      (m === 'plex' && hasPlexServer) ||
      (m === 'jellyfin' && hasJellyfinServer) ||
      (m === 'local' && hasPasswordAuth),
    [hasPlexServer, hasJellyfinServer, hasPasswordAuth]
  );

  const availableMethods = useMemo(() => LOGIN_METHODS.filter(isUsable), [isUsable]);

  const rawEnabled = enabledLoginMethodsField.value ?? settings?.enabledLoginMethods ?? null;
  const selection = useMemo<LoginMethod[]>(
    () => (rawEnabled?.length ? rawEnabled : [...availableMethods]),
    [rawEnabled, availableMethods]
  );

  const canUncheck = useCallback(
    (method: LoginMethod) => {
      const wouldRemain = selection.filter((m) => m !== method);
      return wouldRemain.length > 0 && wouldRemain.some(isUsable);
    },
    [selection, isUsable]
  );

  const toggleMethod = useCallback(
    (method: LoginMethod) => {
      if (selection.includes(method)) {
        if (!canUncheck(method)) return;
        enabledLoginMethodsField.setValue(selection.filter((m) => m !== method));
      } else {
        enabledLoginMethodsField.setValue([...selection, method]);
      }
    },
    [selection, canUncheck, enabledLoginMethodsField]
  );

  const handleReorder = useCallback(
    (method: LoginMethod, delta: -1 | 1) => {
      const i = selection.indexOf(method);
      const next = reorderByIndex(selection, i, delta);
      if (next) {
        enabledLoginMethodsField.setValue(next, { saveImmediately: true });
      }
    },
    [selection, enabledLoginMethodsField]
  );

  // When a server is removed, drop any enabled login methods that are no longer available
  useEffect(() => {
    const hasUnavailable = selection.some((m) => !availableMethods.includes(m));
    if (!hasUnavailable) return;
    const filtered = selection.filter((m) => availableMethods.includes(m));
    if (filtered.length === 0) return;
    enabledLoginMethodsField.setValue(filtered, { saveImmediately: true });
  }, [availableMethods, selection, enabledLoginMethodsField]);

  const jellyfinEnabled = selection.includes('jellyfin');
  const { data: jellyfinAdmins = [], isLoading: jellyfinAdminsLoading } =
    useJellyfinAdmins(jellyfinEnabled);

  // Default Jellyfin owner to first admin when none is set and admins exist
  useEffect(() => {
    if (!jellyfinEnabled || jellyfinAdmins.length === 0 || settings?.jellyfinOwnerId != null) {
      return;
    }
    const firstId = jellyfinAdmins[0]?.id;
    if (firstId) {
      jellyfinOwnerIdField.setValue(firstId);
    }
  }, [jellyfinEnabled, jellyfinAdmins, settings?.jellyfinOwnerId, jellyfinOwnerIdField]);

  const isLoading = settingsLoading || serversLoading;

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-32" />
        </CardHeader>
        <CardContent>
          <Skeleton className="h-20 w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Shield className="h-5 w-5" />
          {t('pages:settings.access.title')}
        </CardTitle>
        <CardDescription>{t('pages:settings.access.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-8">
        <FieldGroup>
          <AutosaveSwitchField
            id="allowGuestAccess"
            label={t('pages:settings.access.allowGuestAccess')}
            description={t('pages:settings.access.allowGuestAccessDescription')}
            checked={allowGuestAccessField.value ?? false}
            onChange={allowGuestAccessField.setValue}
            status={allowGuestAccessField.status}
            errorMessage={allowGuestAccessField.errorMessage}
            onRetry={allowGuestAccessField.retry}
            onReset={allowGuestAccessField.reset}
          />
        </FieldGroup>

        {/* Enabled login methods - only show options that are available (have server or password) */}
        {availableMethods.length > 0 && (
          <FieldGroup>
            <Field>
              <div className="flex items-center justify-between">
                <FieldLabel htmlFor="enabledLoginMethods">
                  {t('pages:settings.access.enabledLoginMethods')}
                </FieldLabel>
                <SaveStatusIndicator status={enabledLoginMethodsField.status} />
              </div>
              <LoginMethodsMultiSelect
                selection={selection}
                availableMethods={availableMethods}
                canUncheck={canUncheck}
                onToggle={toggleMethod}
                onReorder={handleReorder}
                ariaInvalid={enabledLoginMethodsField.status === 'error'}
              />
              <FieldDescription>
                {t('pages:settings.access.enabledLoginMethodsDescription')}
              </FieldDescription>
              {enabledLoginMethodsField.status === 'error' &&
                enabledLoginMethodsField.errorMessage && (
                  <div className="flex items-center justify-between">
                    <FieldError>{enabledLoginMethodsField.errorMessage}</FieldError>
                    <div className="flex gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={enabledLoginMethodsField.retry}
                        className="h-6 px-2 text-xs"
                      >
                        {t('common:actions.retry')}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={enabledLoginMethodsField.reset}
                        className="h-6 px-2 text-xs"
                      >
                        {t('common:actions.reset')}
                      </Button>
                    </div>
                  </div>
                )}
            </Field>

            {jellyfinEnabled && (
              <Field>
                <div className="flex items-center justify-between">
                  <FieldLabel htmlFor="jellyfinOwnerId">
                    {t('pages:settings.access.jellyfinOwnerAccount')}
                  </FieldLabel>
                  <SaveStatusIndicator status={jellyfinOwnerIdField.status} />
                </div>
                {jellyfinAdmins.length === 0 && !jellyfinAdminsLoading ? (
                  <p className="text-muted-foreground text-sm">
                    {t('pages:settings.access.noJellyfinAdminsFound')}
                  </p>
                ) : (
                  <Select
                    value={jellyfinOwnerIdField.value ?? jellyfinAdmins[0]?.id ?? ''}
                    onValueChange={(value: string) => jellyfinOwnerIdField.setValue(value)}
                    disabled={jellyfinAdminsLoading}
                  >
                    <SelectTrigger
                      id="jellyfinOwnerId"
                      className="w-full"
                      aria-invalid={jellyfinOwnerIdField.status === 'error'}
                    >
                      <SelectValue placeholder={t('pages:settings.access.selectAccount')} />
                    </SelectTrigger>
                    <SelectContent>
                      {jellyfinAdmins.map(
                        (admin) =>
                          admin?.id != null && (
                            <SelectItem key={admin.id} value={admin.id}>
                              {admin.username ?? admin.id}
                            </SelectItem>
                          )
                      )}
                    </SelectContent>
                  </Select>
                )}
                <FieldDescription>
                  {t('pages:settings.access.jellyfinOwnerDescription')}
                </FieldDescription>
                {jellyfinOwnerIdField.status === 'error' && jellyfinOwnerIdField.errorMessage && (
                  <div className="flex items-center justify-between">
                    <FieldError>{jellyfinOwnerIdField.errorMessage}</FieldError>
                    <div className="flex gap-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={jellyfinOwnerIdField.retry}
                        className="h-6 px-2 text-xs"
                      >
                        {t('common:actions.retry')}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={jellyfinOwnerIdField.reset}
                        className="h-6 px-2 text-xs"
                      >
                        {t('common:actions.reset')}
                      </Button>
                    </div>
                  </div>
                )}
              </Field>
            )}
          </FieldGroup>
        )}

        <div className="bg-muted/50 rounded-lg p-4">
          <p className="text-muted-foreground text-sm">
            {t('pages:settings.access.singleOwnerNote')}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
