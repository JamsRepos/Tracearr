import { useState, useEffect } from 'react';
import { NavLink, Routes, Route } from 'react-router';
import { QRCodeSVG } from 'qrcode.react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Server as ServerIcon,
  Trash2,
  RefreshCw,
  Bell,
  Shield,
  ExternalLink,
  Download,
  CheckCircle2,
  XCircle,
  Loader2,
  Smartphone,
  Copy,
  RotateCcw,
  LogOut,
} from 'lucide-react';
import { format, formatDistanceToNow } from 'date-fns';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';
import { useSocket } from '@/hooks/useSocket';
import type { Server, Settings as SettingsType, TautulliImportProgress, MobileSession, MobileQRPayload } from '@tracearr/shared';
import {
  useSettings,
  useUpdateSettings,
  useServers,
  useDeleteServer,
  useSyncServer,
  useMobileConfig,
  useEnableMobile,
  useDisableMobile,
  useRotateMobileToken,
  useRevokeMobileSessions,
} from '@/hooks/queries';

function SettingsNav() {
  const links = [
    { href: '/settings', label: 'General', end: true },
    { href: '/settings/servers', label: 'Servers' },
    { href: '/settings/notifications', label: 'Notifications' },
    { href: '/settings/access', label: 'Access Control' },
    { href: '/settings/mobile', label: 'Mobile' },
    { href: '/settings/import', label: 'Import' },
  ];

  return (
    <nav className="flex space-x-4 border-b pb-4">
      {links.map((link) => (
        <NavLink
          key={link.href}
          to={link.href}
          end={link.end}
          className={({ isActive }) =>
            cn(
              'text-sm font-medium transition-colors',
              isActive ? 'text-primary' : 'text-muted-foreground hover:text-primary'
            )
          }
        >
          {link.label}
        </NavLink>
      ))}
    </nav>
  );
}

function GeneralSettings() {
  const { data: settings, isLoading } = useSettings();
  const updateSettings = useUpdateSettings();

  const handleTogglePoller = (enabled: boolean) => {
    updateSettings.mutate({ pollerEnabled: enabled });
  };

  const handleIntervalChange = (seconds: number) => {
    const ms = Math.max(5, Math.min(300, seconds)) * 1000;
    updateSettings.mutate({ pollerIntervalMs: ms });
  };

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-32" />
          <Skeleton className="h-4 w-64" />
        </CardHeader>
        <CardContent className="space-y-4">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </CardContent>
      </Card>
    );
  }

  const intervalSeconds = Math.round((settings?.pollerIntervalMs ?? 15000) / 1000);

  return (
    <Card>
      <CardHeader>
        <CardTitle>General Settings</CardTitle>
        <CardDescription>Configure basic application settings</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <Label className="text-base">Session Polling</Label>
            <p className="text-sm text-muted-foreground">
              Enable automatic polling for active sessions from your media servers
            </p>
          </div>
          <Switch
            checked={settings?.pollerEnabled ?? true}
            onCheckedChange={handleTogglePoller}
          />
        </div>

        <div className="flex items-center justify-between">
          <div>
            <Label className="text-base">Polling Interval</Label>
            <p className="text-sm text-muted-foreground">
              How often to check for active sessions (5-300 seconds)
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={5}
              max={300}
              className="w-20"
              defaultValue={intervalSeconds}
              onBlur={(e) => { handleIntervalChange(parseInt(e.target.value, 10) || 15); }}
              disabled={!settings?.pollerEnabled}
            />
            <span className="text-sm text-muted-foreground">sec</span>
          </div>
        </div>

        <div className="rounded-lg bg-muted/50 p-4">
          <p className="text-sm text-muted-foreground">
            Changes take effect on the next poll cycle. Lower intervals provide more real-time
            updates but increase load on your media servers.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function ServerSettings() {
  const { data: serversData, isLoading } = useServers();
  const deleteServer = useDeleteServer();
  const syncServer = useSyncServer();
  const [deleteId, setDeleteId] = useState<string | null>(null);

  // Handle both array and wrapped response formats
  const servers = Array.isArray(serversData)
    ? serversData
    : (serversData as unknown as { data?: Server[] })?.data ?? [];

  const handleDelete = () => {
    if (deleteId) {
      deleteServer.mutate(deleteId, {
        onSuccess: () => { setDeleteId(null); },
      });
    }
  };

  const handleSync = (id: string) => {
    syncServer.mutate(id);
  };

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-32" />
        </CardHeader>
        <CardContent className="space-y-4">
          {[...Array(2)].map((_, i) => (
            <div key={i} className="flex items-center gap-4">
              <Skeleton className="h-10 w-10 rounded-lg" />
              <div className="space-y-2">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3 w-48" />
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Connected Servers</CardTitle>
          <CardDescription>
            Manage your connected Plex and Jellyfin servers
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!servers || servers.length === 0 ? (
            <div className="flex h-32 flex-col items-center justify-center gap-2 rounded-lg border border-dashed">
              <ServerIcon className="h-8 w-8 text-muted-foreground" />
              <p className="text-muted-foreground">No servers connected</p>
              <p className="text-xs text-muted-foreground">
                Log in with Plex or Jellyfin to add a server
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {servers.map((server) => (
                <ServerCard
                  key={server.id}
                  server={server}
                  onSync={() => { handleSync(server.id); }}
                  onDelete={() => { setDeleteId(server.id); }}
                  isSyncing={syncServer.isPending}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Delete Confirmation Dialog */}
      <Dialog open={!!deleteId} onOpenChange={() => { setDeleteId(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove Server</DialogTitle>
            <DialogDescription>
              Are you sure you want to remove this server? All associated session data will be
              retained, but you won't be able to monitor new sessions from this server.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setDeleteId(null); }}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleteServer.isPending}
            >
              {deleteServer.isPending ? 'Removing...' : 'Remove'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ServerCard({
  server,
  onSync,
  onDelete,
  isSyncing,
}: {
  server: Server;
  onSync: () => void;
  onDelete: () => void;
  isSyncing?: boolean;
}) {
  return (
    <div className="flex items-center justify-between rounded-lg border p-4">
      <div className="flex items-center gap-4">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
          <ServerIcon className="h-5 w-5" />
        </div>
        <div>
          <div className="flex items-center gap-2">
            <h3 className="font-semibold">{server.name}</h3>
            <span className="rounded bg-muted px-2 py-0.5 text-xs capitalize">
              {server.type}
            </span>
          </div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span>{server.url}</span>
            <a
              href={server.url}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-primary"
            >
              <ExternalLink className="h-3 w-3" />
            </a>
          </div>
          <p className="text-xs text-muted-foreground">
            Added {format(new Date(server.createdAt), 'MMM d, yyyy')}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={onSync}
          disabled={isSyncing}
        >
          <RefreshCw className={cn('mr-1 h-4 w-4', isSyncing && 'animate-spin')} />
          Sync
        </Button>
        <Button variant="ghost" size="sm" onClick={onDelete}>
          <Trash2 className="h-4 w-4 text-destructive" />
        </Button>
      </div>
    </div>
  );
}

function NotificationSettings() {
  const { data: settings, isLoading } = useSettings();
  const updateSettings = useUpdateSettings();

  const handleToggle = (key: keyof SettingsType, value: boolean) => {
    updateSettings.mutate({ [key]: value });
  };

  const handleUrlChange = (key: 'discordWebhookUrl' | 'customWebhookUrl', value: string) => {
    updateSettings.mutate({ [key]: value || null });
  };

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-32" />
        </CardHeader>
        <CardContent className="space-y-6">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="flex items-center justify-between">
              <Skeleton className="h-10 w-64" />
              <Skeleton className="h-6 w-11" />
            </div>
          ))}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Bell className="h-5 w-5" />
            Notification Settings
          </CardTitle>
          <CardDescription>
            Configure how and when you receive notifications
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <Label className="text-base">Violation Alerts</Label>
              <p className="text-sm text-muted-foreground">
                Send notification when a rule violation is detected
              </p>
            </div>
            <Switch
              checked={settings?.notifyOnViolation ?? true}
              onCheckedChange={(checked) => { handleToggle('notifyOnViolation', checked); }}
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label className="text-base">Session Start</Label>
              <p className="text-sm text-muted-foreground">
                Send notification when a new stream starts
              </p>
            </div>
            <Switch
              checked={settings?.notifyOnSessionStart ?? false}
              onCheckedChange={(checked) => { handleToggle('notifyOnSessionStart', checked); }}
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label className="text-base">Session Stop</Label>
              <p className="text-sm text-muted-foreground">
                Send notification when a stream ends
              </p>
            </div>
            <Switch
              checked={settings?.notifyOnSessionStop ?? false}
              onCheckedChange={(checked) => { handleToggle('notifyOnSessionStop', checked); }}
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label className="text-base">Server Down</Label>
              <p className="text-sm text-muted-foreground">
                Send notification when a server becomes unreachable
              </p>
            </div>
            <Switch
              checked={settings?.notifyOnServerDown ?? true}
              onCheckedChange={(checked) => { handleToggle('notifyOnServerDown', checked); }}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Webhook Configuration</CardTitle>
          <CardDescription>
            Configure webhook URLs for notifications
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="discordWebhook">Discord Webhook URL</Label>
            <Input
              id="discordWebhook"
              placeholder="https://discord.com/api/webhooks/..."
              defaultValue={settings?.discordWebhookUrl ?? ''}
              onBlur={(e) => { handleUrlChange('discordWebhookUrl', e.target.value); }}
            />
            <p className="text-xs text-muted-foreground">
              Paste your Discord webhook URL to receive notifications in a Discord channel
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="customWebhook">Custom Webhook URL</Label>
            <Input
              id="customWebhook"
              placeholder="https://your-service.com/webhook"
              defaultValue={settings?.customWebhookUrl ?? ''}
              onBlur={(e) => { handleUrlChange('customWebhookUrl', e.target.value); }}
            />
            <p className="text-xs text-muted-foreground">
              Send notifications to a custom endpoint via POST request
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function AccessSettings() {
  const { data: settings, isLoading } = useSettings();
  const updateSettings = useUpdateSettings();

  const handleToggle = (key: keyof SettingsType, value: boolean) => {
    updateSettings.mutate({ [key]: value });
  };

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
          Configure who can access Tracearr
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <Label className="text-base">Allow Guest Access</Label>
            <p className="text-sm text-muted-foreground">
              When disabled, only the server owner can log in to Tracearr
            </p>
          </div>
          <Switch
            checked={settings?.allowGuestAccess ?? false}
            onCheckedChange={(checked) => { handleToggle('allowGuestAccess', checked); }}
          />
        </div>
        <div className="rounded-lg bg-muted/50 p-4">
          <p className="text-sm text-muted-foreground">
            <strong>Note:</strong> In v1, Tracearr only supports single-owner access. Even with
            guest access enabled, guests can only view their own sessions and violations.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function MobileSettings() {
  const { data: config, isLoading } = useMobileConfig();
  const enableMobile = useEnableMobile();
  const disableMobile = useDisableMobile();
  const rotateMobileToken = useRotateMobileToken();
  const revokeMobileSessions = useRevokeMobileSessions();

  const [showDisableConfirm, setShowDisableConfirm] = useState(false);
  const [showRevokeConfirm, setShowRevokeConfirm] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCopyToken = async () => {
    if (config?.token) {
      await navigator.clipboard.writeText(config.token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const getQRData = (): string => {
    if (!config?.token) return '';
    // In dev, Vite runs on :5173 but mobile app needs the backend on :3000
    // In production, both are served from the same origin
    let serverUrl = window.location.origin;
    if (import.meta.env.DEV) {
      // Replace Vite's port with backend port for dev
      serverUrl = serverUrl.replace(':5173', ':3000');
    }
    const payload: MobileQRPayload = {
      url: serverUrl,
      token: config.token,
      name: config.serverName,
    };
    const encoded = btoa(JSON.stringify(payload));
    return `tracearr://pair?data=${encoded}`;
  };

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-32" />
        </CardHeader>
        <CardContent className="space-y-4">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-48 w-48" />
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Smartphone className="h-5 w-5" />
            Mobile App Access
          </CardTitle>
          <CardDescription>
            Connect the Tracearr mobile app to monitor your servers on the go
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {!config?.isEnabled ? (
            <div className="flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed p-8">
              <div className="rounded-full bg-muted p-4">
                <Smartphone className="h-8 w-8 text-muted-foreground" />
              </div>
              <div className="text-center">
                <h3 className="font-semibold">Mobile Access Disabled</h3>
                <p className="text-sm text-muted-foreground mt-1">
                  Enable mobile access to connect the Tracearr app to your server
                </p>
              </div>
              <Button onClick={() => enableMobile.mutate()} disabled={enableMobile.isPending}>
                {enableMobile.isPending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Enabling...
                  </>
                ) : (
                  'Enable Mobile Access'
                )}
              </Button>
            </div>
          ) : (
            <>
              {config.token && (
                <div className="space-y-4">
                  <div className="flex flex-col items-center gap-4">
                    <div className="rounded-lg border bg-white p-4">
                      <QRCodeSVG
                        value={getQRData()}
                        size={200}
                        level="M"
                        includeMargin={false}
                      />
                    </div>
                    <p className="text-sm text-muted-foreground text-center max-w-sm">
                      Scan this QR code with the Tracearr mobile app, or enter the token manually
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label>Mobile Access Token</Label>
                    <div className="flex gap-2">
                      <Input
                        readOnly
                        value={config.token}
                        className="font-mono text-xs"
                      />
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={handleCopyToken}
                        title="Copy token"
                      >
                        {copied ? (
                          <CheckCircle2 className="h-4 w-4 text-green-600" />
                        ) : (
                          <Copy className="h-4 w-4" />
                        )}
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Keep this token secure. Anyone with this token can access your server.
                    </p>
                  </div>
                </div>
              )}

              {!config.token && (
                <div className="rounded-lg bg-muted/50 p-4">
                  <p className="text-sm text-muted-foreground">
                    Mobile access is enabled. Use the Rotate Token button to generate a new QR code.
                  </p>
                </div>
              )}

              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  onClick={() => rotateMobileToken.mutate()}
                  disabled={rotateMobileToken.isPending}
                >
                  {rotateMobileToken.isPending ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <RotateCcw className="mr-2 h-4 w-4" />
                  )}
                  Rotate Token
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setShowDisableConfirm(true)}
                >
                  Disable Mobile Access
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {config?.isEnabled && config.sessions.length > 0 && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Connected Devices</CardTitle>
                <CardDescription>
                  {config.sessions.length} device{config.sessions.length !== 1 ? 's' : ''} connected
                </CardDescription>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowRevokeConfirm(true)}
              >
                <LogOut className="mr-2 h-4 w-4" />
                Revoke All
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {config.sessions.map((session) => (
                <MobileSessionCard key={session.id} session={session} />
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Disable Confirmation Dialog */}
      <Dialog open={showDisableConfirm} onOpenChange={setShowDisableConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disable Mobile Access</DialogTitle>
            <DialogDescription>
              Are you sure you want to disable mobile access? All connected devices will be
              disconnected and will need to be re-paired when you re-enable.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDisableConfirm(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                disableMobile.mutate();
                setShowDisableConfirm(false);
              }}
              disabled={disableMobile.isPending}
            >
              {disableMobile.isPending ? 'Disabling...' : 'Disable'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Revoke All Sessions Confirmation */}
      <Dialog open={showRevokeConfirm} onOpenChange={setShowRevokeConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke All Sessions</DialogTitle>
            <DialogDescription>
              Are you sure you want to disconnect all mobile devices? They will need to scan the
              QR code again to reconnect.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowRevokeConfirm(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                revokeMobileSessions.mutate();
                setShowRevokeConfirm(false);
              }}
              disabled={revokeMobileSessions.isPending}
            >
              {revokeMobileSessions.isPending ? 'Revoking...' : 'Revoke All'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function MobileSessionCard({ session }: { session: MobileSession }) {
  return (
    <div className="flex items-center justify-between rounded-lg border p-4">
      <div className="flex items-center gap-4">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
          <Smartphone className="h-5 w-5" />
        </div>
        <div>
          <div className="flex items-center gap-2">
            <h3 className="font-semibold">{session.deviceName}</h3>
            <span className="rounded bg-muted px-2 py-0.5 text-xs capitalize">
              {session.platform}
            </span>
          </div>
          <p className="text-sm text-muted-foreground">
            Last seen {formatDistanceToNow(new Date(session.lastSeenAt), { addSuffix: true })}
          </p>
          <p className="text-xs text-muted-foreground">
            Connected {format(new Date(session.createdAt), 'MMM d, yyyy')}
          </p>
        </div>
      </div>
    </div>
  );
}

function ImportSettings() {
  const { data: settings, isLoading: settingsLoading } = useSettings();
  const { data: serversData, isLoading: serversLoading } = useServers();
  const updateSettings = useUpdateSettings();
  const { socket } = useSocket();

  const [tautulliUrl, setTautulliUrl] = useState('');
  const [tautulliApiKey, setTautulliApiKey] = useState('');
  const [selectedServerId, setSelectedServerId] = useState<string>('');
  const [connectionStatus, setConnectionStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [connectionMessage, setConnectionMessage] = useState('');
  const [importProgress, setImportProgress] = useState<TautulliImportProgress | null>(null);
  const [isImporting, setIsImporting] = useState(false);

  // Handle both array and wrapped response formats
  const servers = Array.isArray(serversData)
    ? serversData
    : (serversData as unknown as { data?: Server[] })?.data ?? [];

  // Only show Plex servers (Tautulli is Plex-only)
  const plexServers = servers.filter((s) => s.type === 'plex');

  // Initialize form with saved settings
  useEffect(() => {
    if (settings) {
      setTautulliUrl(settings.tautulliUrl ?? '');
      setTautulliApiKey(settings.tautulliApiKey ?? '');
    }
  }, [settings]);

  // Listen for import progress via WebSocket
  useEffect(() => {
    if (!socket) return;

    const handleProgress = (progress: TautulliImportProgress) => {
      setImportProgress(progress);
      if (progress.status === 'complete' || progress.status === 'error') {
        setIsImporting(false);
      }
    };

    socket.on('import:progress', handleProgress);
    return () => {
      socket.off('import:progress', handleProgress);
    };
  }, [socket]);

  const handleSaveSettings = () => {
    updateSettings.mutate({
      tautulliUrl: tautulliUrl || null,
      tautulliApiKey: tautulliApiKey || null,
    });
  };

  const handleTestConnection = async () => {
    if (!tautulliUrl || !tautulliApiKey) {
      setConnectionStatus('error');
      setConnectionMessage('Please enter Tautulli URL and API key');
      return;
    }

    setConnectionStatus('testing');
    setConnectionMessage('Testing connection...');

    try {
      const result = await api.import.tautulli.test(tautulliUrl, tautulliApiKey);
      if (result.success) {
        setConnectionStatus('success');
        setConnectionMessage(
          `Connected! Found ${result.users ?? 0} users and ${result.historyRecords ?? 0} history records.`
        );
        // Save settings on successful connection
        handleSaveSettings();
      } else {
        setConnectionStatus('error');
        setConnectionMessage(result.message || 'Connection failed');
      }
    } catch (err) {
      setConnectionStatus('error');
      setConnectionMessage(err instanceof Error ? err.message : 'Connection failed');
    }
  };

  const handleStartImport = async () => {
    if (!selectedServerId) {
      return;
    }

    setIsImporting(true);
    setImportProgress({
      status: 'fetching',
      totalRecords: 0,
      processedRecords: 0,
      importedRecords: 0,
      skippedRecords: 0,
      errorRecords: 0,
      currentPage: 0,
      totalPages: 0,
      message: 'Starting import...',
    });

    try {
      await api.import.tautulli.start(selectedServerId);
      // Progress updates come via WebSocket
    } catch (err) {
      setIsImporting(false);
      setImportProgress({
        status: 'error',
        totalRecords: 0,
        processedRecords: 0,
        importedRecords: 0,
        skippedRecords: 0,
        errorRecords: 0,
        currentPage: 0,
        totalPages: 0,
        message: err instanceof Error ? err.message : 'Import failed',
      });
    }
  };

  if (settingsLoading || serversLoading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-32" />
        </CardHeader>
        <CardContent className="space-y-4">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Download className="h-5 w-5" />
            Tautulli Import
          </CardTitle>
          <CardDescription>
            Import historical watch data from Tautulli into Tracearr
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="tautulliUrl">Tautulli URL</Label>
              <Input
                id="tautulliUrl"
                placeholder="http://localhost:8181"
                value={tautulliUrl}
                onChange={(e) => { setTautulliUrl(e.target.value); }}
              />
              <p className="text-xs text-muted-foreground">
                The URL where Tautulli is accessible (include port if needed)
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="tautulliApiKey">API Key</Label>
              <Input
                id="tautulliApiKey"
                type="password"
                placeholder="Your Tautulli API key"
                value={tautulliApiKey}
                onChange={(e) => { setTautulliApiKey(e.target.value); }}
              />
              <p className="text-xs text-muted-foreground">
                Find this in Tautulli Settings → Web Interface → API Key
              </p>
            </div>

            <div className="flex items-center gap-4">
              <Button
                onClick={handleTestConnection}
                disabled={connectionStatus === 'testing' || !tautulliUrl || !tautulliApiKey}
              >
                {connectionStatus === 'testing' ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Testing...
                  </>
                ) : (
                  'Test Connection'
                )}
              </Button>

              {connectionStatus === 'success' && (
                <div className="flex items-center gap-2 text-sm text-green-600">
                  <CheckCircle2 className="h-4 w-4" />
                  {connectionMessage}
                </div>
              )}

              {connectionStatus === 'error' && (
                <div className="flex items-center gap-2 text-sm text-destructive">
                  <XCircle className="h-4 w-4" />
                  {connectionMessage}
                </div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {connectionStatus === 'success' && (
        <Card>
          <CardHeader>
            <CardTitle>Import History</CardTitle>
            <CardDescription>
              Select a Plex server to import Tautulli history into
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {plexServers.length === 0 ? (
              <div className="rounded-lg bg-muted/50 p-4">
                <p className="text-sm text-muted-foreground">
                  No Plex servers connected. Add a Plex server first to import Tautulli data.
                </p>
              </div>
            ) : (
              <>
                <div className="space-y-2">
                  <Label>Target Server</Label>
                  <Select value={selectedServerId} onValueChange={setSelectedServerId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select a Plex server" />
                    </SelectTrigger>
                    <SelectContent>
                      {plexServers.map((server) => (
                        <SelectItem key={server.id} value={server.id}>
                          {server.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    Sessions will be imported and matched to users from this server
                  </p>
                </div>

                <div className="space-y-4">
                  <Button
                    onClick={handleStartImport}
                    disabled={!selectedServerId || isImporting}
                  >
                    {isImporting ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Importing...
                      </>
                    ) : (
                      <>
                        <Download className="mr-2 h-4 w-4" />
                        Start Import
                      </>
                    )}
                  </Button>

                  {importProgress && (
                    <div className="space-y-3 rounded-lg border p-4">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium">
                          {importProgress.status === 'complete' ? 'Import Complete' :
                           importProgress.status === 'error' ? 'Import Failed' :
                           'Importing...'}
                        </span>
                        {importProgress.status === 'complete' && (
                          <CheckCircle2 className="h-5 w-5 text-green-600" />
                        )}
                        {importProgress.status === 'error' && (
                          <XCircle className="h-5 w-5 text-destructive" />
                        )}
                        {(importProgress.status === 'fetching' || importProgress.status === 'processing') && (
                          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                        )}
                      </div>

                      <p className="text-sm text-muted-foreground">{importProgress.message}</p>

                      {importProgress.totalRecords > 0 && (
                        <>
                          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                            <div
                              className="h-full bg-primary transition-all"
                              style={{
                                width: importProgress.status === 'complete'
                                  ? '100%'
                                  : `${Math.min(100, Math.round((importProgress.processedRecords / importProgress.totalRecords) * 100))}%`,
                              }}
                            />
                          </div>

                          <div className="grid grid-cols-2 gap-4 text-sm">
                            <div>
                              <span className="text-muted-foreground">Processed:</span>{' '}
                              <span className="font-medium">
                                {importProgress.processedRecords} / {importProgress.totalRecords}
                              </span>
                            </div>
                            <div>
                              <span className="text-muted-foreground">Page:</span>{' '}
                              <span className="font-medium">
                                {importProgress.currentPage} / {importProgress.totalPages}
                              </span>
                            </div>
                            <div>
                              <span className="text-muted-foreground">Imported:</span>{' '}
                              <span className="font-medium text-green-600">
                                {importProgress.importedRecords}
                              </span>
                            </div>
                            <div>
                              <span className="text-muted-foreground">Skipped:</span>{' '}
                              <span className="font-medium text-yellow-600">
                                {importProgress.skippedRecords}
                              </span>
                            </div>
                            {importProgress.errorRecords > 0 && (
                              <div>
                                <span className="text-muted-foreground">Errors:</span>{' '}
                                <span className="font-medium text-destructive">
                                  {importProgress.errorRecords}
                                </span>
                              </div>
                            )}
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>

                <div className="rounded-lg bg-muted/50 p-4">
                  <p className="text-sm text-muted-foreground">
                    <strong>Note:</strong> The import will match Tautulli users to existing Tracearr users
                    by their Plex user ID. Duplicate sessions are automatically detected and skipped.
                    This process may take several minutes depending on your history size.
                  </p>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export function Settings() {
  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold">Settings</h1>
      <SettingsNav />
      <Routes>
        <Route index element={<GeneralSettings />} />
        <Route path="servers" element={<ServerSettings />} />
        <Route path="notifications" element={<NotificationSettings />} />
        <Route path="access" element={<AccessSettings />} />
        <Route path="mobile" element={<MobileSettings />} />
        <Route path="import" element={<ImportSettings />} />
      </Routes>
    </div>
  );
}
