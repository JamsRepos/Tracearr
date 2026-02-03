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
import { Shield, KeyRound } from 'lucide-react';
import { MediaServerIcon } from '@/components/icons/MediaServerIcon';
import { useAuth } from '@/hooks/useAuth';
import { useDebouncedSave } from '@/hooks/useDebouncedSave';
import { useSettings, useServers, useJellyfinAdmins } from '@/hooks/queries';
import type { Server } from '@tracearr/shared';

const JELLYFIN_OWNER_NONE = '__none__';

export function AccessSettings() {
  const { data: settings, isLoading: settingsLoading } = useSettings();
  const { data: serversData, isLoading: serversLoading } = useServers();
  const { user } = useAuth();

  const allowGuestAccessField = useDebouncedSave('allowGuestAccess', settings?.allowGuestAccess);
  const primaryAuthMethodField = useDebouncedSave('primaryAuthMethod', settings?.primaryAuthMethod);
  const jellyfinOwnerIdField = useDebouncedSave(
    'jellyfinOwnerId',
    settings?.jellyfinOwnerId ?? null
  );

  // Handle both array and wrapped response formats
  const servers = Array.isArray(serversData)
    ? serversData
    : ((serversData as unknown as { data?: Server[] })?.data ?? []);
  const hasJellyfinServer = servers.some((s) => s.type === 'jellyfin');
  const hasLocalCredentials = user?.hasPassword ?? false;
  const showAuthMethodSelector = hasLocalCredentials && hasJellyfinServer;
  const primaryIsJellyfin = primaryAuthMethodField.value === 'jellyfin';

  const { data: jellyfinAdmins = [], isLoading: jellyfinAdminsLoading } = useJellyfinAdmins(
    showAuthMethodSelector && primaryIsJellyfin
  );

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
          Access Control
        </CardTitle>
        <CardDescription>
          Configure who can access Tracearr and who has owner rights
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-8">
        <FieldGroup>
          <AutosaveSwitchField
            id="allowGuestAccess"
            label="Allow Guest Access"
            description="When disabled, only the server owner can log in to Tracearr"
            checked={allowGuestAccessField.value ?? false}
            onChange={allowGuestAccessField.setValue}
            status={allowGuestAccessField.status}
            errorMessage={allowGuestAccessField.errorMessage}
            onRetry={allowGuestAccessField.retry}
            onReset={allowGuestAccessField.reset}
          />
        </FieldGroup>

        {showAuthMethodSelector && (
          <div className="bg-muted/30 space-y-5 rounded-lg border p-5">
            {primaryIsJellyfin && (
              <div>
                <h3 className="text-sm font-medium">Owner account</h3>
                <p className="text-muted-foreground mt-1 text-sm">
                  Choose which Jellyfin admin has full owner access when signing in.
                </p>
              </div>
            )}
            <div
              className={
                primaryIsJellyfin
                  ? 'grid gap-5 sm:grid-cols-1 md:grid-cols-2'
                  : 'grid grid-cols-1 gap-5'
              }
            >
              <Field>
                <div className="flex items-center justify-between">
                  <FieldLabel htmlFor="primaryAuthMethod">Default login method</FieldLabel>
                  <SaveStatusIndicator status={primaryAuthMethodField.status} />
                </div>
                <Select
                  value={primaryAuthMethodField.value ?? 'local'}
                  onValueChange={(value: 'jellyfin' | 'local') => {
                    primaryAuthMethodField.setValue(value);
                  }}
                >
                  <SelectTrigger
                    id="primaryAuthMethod"
                    className="w-full"
                    aria-invalid={primaryAuthMethodField.status === 'error'}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="local">
                      <div className="flex items-center gap-2">
                        <KeyRound className="h-4 w-4" />
                        <span>Local Account</span>
                      </div>
                    </SelectItem>
                    <SelectItem value="jellyfin">
                      <div className="flex items-center gap-2">
                        <MediaServerIcon type="jellyfin" className="h-4 w-4" />
                        <span>Jellyfin Admin</span>
                      </div>
                    </SelectItem>
                  </SelectContent>
                </Select>
                <FieldDescription>
                  Which sign-in option is shown first on the login page
                </FieldDescription>
                {primaryAuthMethodField.status === 'error' &&
                  primaryAuthMethodField.errorMessage && (
                    <div className="flex items-center justify-between">
                      <FieldError>{primaryAuthMethodField.errorMessage}</FieldError>
                      <div className="flex gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={primaryAuthMethodField.retry}
                          className="h-6 px-2 text-xs"
                        >
                          Retry
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={primaryAuthMethodField.reset}
                          className="h-6 px-2 text-xs"
                        >
                          Reset
                        </Button>
                      </div>
                    </div>
                  )}
              </Field>

              {primaryIsJellyfin && (
                <Field>
                  <div className="flex items-center justify-between">
                    <FieldLabel htmlFor="jellyfinOwnerId">Owner account</FieldLabel>
                    <SaveStatusIndicator status={jellyfinOwnerIdField.status} />
                  </div>
                  <Select
                    value={
                      jellyfinOwnerIdField.value === null ||
                      jellyfinOwnerIdField.value === undefined
                        ? JELLYFIN_OWNER_NONE
                        : jellyfinOwnerIdField.value
                    }
                    onValueChange={(value: string) => {
                      jellyfinOwnerIdField.setValue(value === JELLYFIN_OWNER_NONE ? null : value);
                    }}
                    disabled={jellyfinAdminsLoading}
                  >
                    <SelectTrigger
                      id="jellyfinOwnerId"
                      className="w-full"
                      aria-invalid={jellyfinOwnerIdField.status === 'error'}
                    >
                      <SelectValue placeholder="Select account" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={JELLYFIN_OWNER_NONE}>
                        <span className="text-muted-foreground">No owner selected</span>
                      </SelectItem>
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
                  <FieldDescription>
                    This Jellyfin admin gets full owner access when they sign in
                  </FieldDescription>
                  {jellyfinAdmins.length === 0 && !jellyfinAdminsLoading && (
                    <p className="text-muted-foreground text-xs">
                      No Jellyfin admins found. Add a Jellyfin server (Settings → Servers) and
                      connect with an API key.
                    </p>
                  )}
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
                          Retry
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={jellyfinOwnerIdField.reset}
                          className="h-6 px-2 text-xs"
                        >
                          Reset
                        </Button>
                      </div>
                    </div>
                  )}
                </Field>
              )}
            </div>
          </div>
        )}

        <div className="bg-muted/50 rounded-lg p-4">
          <p className="text-muted-foreground text-sm">
            <strong>Note:</strong> In v1, Tracearr only supports single-owner access. Even with
            guest access enabled, guests can only view their own sessions and violations.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
