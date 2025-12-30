import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Link2, Unlink, Loader2, XCircle, Server, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import type { PlexAccount } from '@/lib/api';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

// Plex OAuth configuration
const PLEX_OAUTH_URL = 'https://app.plex.tv/auth#';
const PLEX_CLIENT_ID = 'tracearr';

interface PlexAccountsManagerProps {
  compact?: boolean; // For inline display in server settings
  onAccountLinked?: () => void; // Callback after linking account
}

export function PlexAccountsManager({
  compact = false,
  onAccountLinked,
}: PlexAccountsManagerProps) {
  const queryClient = useQueryClient();
  const [showManageDialog, setShowManageDialog] = useState(false);
  const [showUnlinkConfirm, setShowUnlinkConfirm] = useState<string | null>(null);
  const [isLinking, setIsLinking] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);

  // Fetch plex accounts
  const {
    data: accountsData,
    isLoading,
    refetch,
  } = useQuery({
    queryKey: ['plex-accounts'],
    queryFn: () => api.auth.getPlexAccounts(),
  });

  const accounts = accountsData?.accounts ?? [];

  // Unlink mutation
  const unlinkMutation = useMutation({
    mutationFn: (id: string) => api.auth.unlinkPlexAccount(id),
    onSuccess: () => {
      toast.success('Plex Account Unlinked', {
        description: 'The Plex account has been removed.',
      });
      void refetch();
      setShowUnlinkConfirm(null);
    },
    onError: (error: Error) => {
      toast.error('Failed to Unlink', {
        description: error.message,
      });
    },
  });

  // Start Plex OAuth flow for linking
  const startPlexOAuth = async () => {
    setIsLinking(true);
    setLinkError(null);

    try {
      // Create Plex PIN
      const pinResponse = await fetch('https://plex.tv/api/v2/pins', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-Plex-Client-Identifier': PLEX_CLIENT_ID,
          'X-Plex-Product': 'Tracearr',
        },
        body: JSON.stringify({
          strong: true,
          'X-Plex-Product': 'Tracearr',
          'X-Plex-Client-Identifier': PLEX_CLIENT_ID,
        }),
      });

      if (!pinResponse.ok) {
        throw new Error('Failed to create Plex PIN');
      }

      const pinData = (await pinResponse.json()) as { id: number; code: string };

      // Open Plex OAuth window
      const oauthUrl = `${PLEX_OAUTH_URL}?clientID=${PLEX_CLIENT_ID}&code=${pinData.code}&context%5Bdevice%5D%5Bproduct%5D=Tracearr`;
      const oauthWindow = window.open(oauthUrl, 'plex_oauth', 'width=600,height=700');

      // Poll for PIN authorization
      const pollInterval = setInterval(() => {
        void (async () => {
          try {
            const checkResponse = await fetch(`https://plex.tv/api/v2/pins/${pinData.id}`, {
              headers: {
                Accept: 'application/json',
                'X-Plex-Client-Identifier': PLEX_CLIENT_ID,
              },
            });

            if (!checkResponse.ok) {
              clearInterval(pollInterval);
              setIsLinking(false);
              setLinkError('Failed to check PIN status');
              return;
            }

            const checkData = (await checkResponse.json()) as { authToken: string | null };

            if (checkData.authToken) {
              clearInterval(pollInterval);
              oauthWindow?.close();

              // Now link the account via our API
              try {
                await api.auth.linkPlexAccount(pinData.id.toString());
                toast.success('Plex Account Linked', {
                  description: 'You can now add servers from this Plex account.',
                });
                await refetch();
                await queryClient.invalidateQueries({ queryKey: ['plex-accounts'] });
                onAccountLinked?.();
                setIsLinking(false);
              } catch (error) {
                setLinkError(error instanceof Error ? error.message : 'Failed to link account');
                setIsLinking(false);
              }
            }
          } catch {
            // Continue polling
          }
        })();
      }, 2000);

      // Stop polling after 5 minutes
      setTimeout(
        () => {
          clearInterval(pollInterval);
          if (isLinking) {
            setIsLinking(false);
            setLinkError('OAuth timeout - please try again');
          }
        },
        5 * 60 * 1000
      );
    } catch (error) {
      setIsLinking(false);
      setLinkError(error instanceof Error ? error.message : 'Failed to start OAuth');
    }
  };

  // Compact view - just shows count and manage button
  if (compact) {
    if (isLoading) {
      return <Skeleton className="h-6 w-48" />;
    }

    return (
      <div className="flex items-center gap-3">
        <span className="text-muted-foreground text-sm">
          {accounts.length === 0
            ? 'No Plex accounts linked'
            : `${accounts.length} Plex account${accounts.length !== 1 ? 's' : ''} linked`}
        </span>
        <Button variant="outline" size="sm" onClick={() => setShowManageDialog(true)}>
          Manage
        </Button>
        <ManageDialog
          open={showManageDialog}
          onOpenChange={setShowManageDialog}
          accounts={accounts}
          isLoading={isLoading}
          isLinking={isLinking}
          linkError={linkError}
          onLink={startPlexOAuth}
          onUnlink={(id) => setShowUnlinkConfirm(id)}
        />
        <ConfirmDialog
          open={!!showUnlinkConfirm}
          onOpenChange={() => setShowUnlinkConfirm(null)}
          title="Unlink Plex Account"
          description="Are you sure you want to unlink this Plex account? You won't be able to add servers from this account until you link it again."
          confirmLabel="Unlink"
          onConfirm={() => showUnlinkConfirm && unlinkMutation.mutate(showUnlinkConfirm)}
          isLoading={unlinkMutation.isPending}
        />
      </div>
    );
  }

  // Full view - shows all accounts inline
  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {accounts.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-6 text-center">
          <Link2 className="text-muted-foreground h-8 w-8" />
          <div>
            <p className="font-medium">No Plex Accounts Linked</p>
            <p className="text-muted-foreground mt-1 text-sm">
              Link a Plex account to add Plex servers to Tracearr.
            </p>
          </div>
          <Button onClick={startPlexOAuth} disabled={isLinking}>
            {isLinking ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Linking...
              </>
            ) : (
              <>
                <Plus className="mr-2 h-4 w-4" />
                Link Plex Account
              </>
            )}
          </Button>
          {linkError && (
            <p className="text-destructive flex items-center gap-1 text-sm">
              <XCircle className="h-4 w-4" />
              {linkError}
            </p>
          )}
        </div>
      ) : (
        <>
          <div className="space-y-3">
            {accounts.map((account) => (
              <PlexAccountCard
                key={account.id}
                account={account}
                onUnlink={() => setShowUnlinkConfirm(account.id)}
              />
            ))}
          </div>
          <Button variant="outline" onClick={startPlexOAuth} disabled={isLinking}>
            {isLinking ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Linking...
              </>
            ) : (
              <>
                <Plus className="mr-2 h-4 w-4" />
                Link Another Plex Account
              </>
            )}
          </Button>
          {linkError && (
            <p className="text-destructive flex items-center gap-1 text-sm">
              <XCircle className="h-4 w-4" />
              {linkError}
            </p>
          )}
        </>
      )}

      <ConfirmDialog
        open={!!showUnlinkConfirm}
        onOpenChange={() => setShowUnlinkConfirm(null)}
        title="Unlink Plex Account"
        description="Are you sure you want to unlink this Plex account? You won't be able to add servers from this account until you link it again."
        confirmLabel="Unlink"
        onConfirm={() => showUnlinkConfirm && unlinkMutation.mutate(showUnlinkConfirm)}
        isLoading={unlinkMutation.isPending}
      />
    </div>
  );
}

function PlexAccountCard({ account, onUnlink }: { account: PlexAccount; onUnlink: () => void }) {
  const canUnlink = account.serverCount === 0;

  return (
    <div className="flex items-center justify-between rounded-lg border p-4">
      <div className="flex items-center gap-3">
        <Avatar className="h-10 w-10">
          <AvatarImage src={account.plexThumbnail ?? undefined} />
          <AvatarFallback>{account.plexUsername?.[0]?.toUpperCase() ?? 'P'}</AvatarFallback>
        </Avatar>
        <div>
          <div className="flex items-center gap-2">
            <span className="font-medium">
              {account.plexUsername ?? account.plexEmail ?? 'Plex Account'}
            </span>
            {account.allowLogin && (
              <Badge variant="secondary" className="text-xs">
                Login Enabled
              </Badge>
            )}
          </div>
          <div className="text-muted-foreground flex items-center gap-2 text-sm">
            <Server className="h-3 w-3" />
            <span>
              {account.serverCount} server{account.serverCount !== 1 ? 's' : ''} connected
            </span>
          </div>
        </div>
      </div>
      <Button
        variant="ghost"
        size="sm"
        onClick={onUnlink}
        disabled={!canUnlink}
        title={
          canUnlink
            ? 'Unlink this Plex account'
            : 'Delete connected servers first to unlink this account'
        }
      >
        <Unlink className="h-4 w-4" />
      </Button>
    </div>
  );
}

function ManageDialog({
  open,
  onOpenChange,
  accounts,
  isLoading,
  isLinking,
  linkError,
  onLink,
  onUnlink,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accounts: PlexAccount[];
  isLoading: boolean;
  isLinking: boolean;
  linkError: string | null;
  onLink: () => void;
  onUnlink: (id: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Linked Plex Accounts</DialogTitle>
          <DialogDescription>Manage the Plex accounts you can add servers from.</DialogDescription>
        </DialogHeader>
        <div className="max-h-[400px] space-y-3 overflow-y-auto py-4">
          {isLoading ? (
            <>
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </>
          ) : accounts.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed p-6 text-center">
              <Link2 className="text-muted-foreground h-8 w-8" />
              <p className="text-muted-foreground text-sm">No Plex accounts linked yet.</p>
            </div>
          ) : (
            accounts.map((account) => (
              <PlexAccountCard
                key={account.id}
                account={account}
                onUnlink={() => onUnlink(account.id)}
              />
            ))
          )}
        </div>
        {linkError && (
          <p className="text-destructive flex items-center gap-1 text-sm">
            <XCircle className="h-4 w-4" />
            {linkError}
          </p>
        )}
        <DialogFooter className="flex-col gap-2 sm:flex-row">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button onClick={onLink} disabled={isLinking}>
            {isLinking ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Linking...
              </>
            ) : (
              <>
                <Plus className="mr-2 h-4 w-4" />
                Link Plex Account
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
