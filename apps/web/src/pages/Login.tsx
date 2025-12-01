import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { Loader2, Server, ExternalLink, Monitor, ChevronRight, Wifi, Globe, User, KeyRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { useToast } from '@/components/ui/use-toast';
import { useAuth } from '@/hooks/useAuth';
import { api, tokenStorage, type PlexServerInfo } from '@/lib/api';
import { LogoIcon } from '@/components/brand/Logo';

// Plex brand color
const PLEX_COLOR = 'bg-[#E5A00D] hover:bg-[#C88A0B]';

type AuthStep = 'initial' | 'plex-waiting' | 'server-select';

export function Login() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { toast } = useToast();
  const { isAuthenticated, isLoading: authLoading, refetch } = useAuth();

  // Setup status
  const [setupLoading, setSetupLoading] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [hasPasswordAuth, setHasPasswordAuth] = useState(false);

  // Auth flow state
  const [authStep, setAuthStep] = useState<AuthStep>('initial');
  const [plexAuthUrl, setPlexAuthUrl] = useState<string | null>(null);
  const [plexServers, setPlexServers] = useState<PlexServerInfo[]>([]);
  const [plexTempToken, setPlexTempToken] = useState<string | null>(null);
  const [connectingToServer, setConnectingToServer] = useState<string | null>(null);
  const [plexPopup, setPlexPopup] = useState<Window | null>(null);

  // Local auth state
  const [localLoading, setLocalLoading] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [email, setEmail] = useState('');

  // Check setup status on mount
  useEffect(() => {
    async function checkSetup() {
      try {
        const status = await api.setup.status();
        setNeedsSetup(status.needsSetup);
        setHasPasswordAuth(status.hasPasswordAuth);
      } catch {
        // If we can't reach the server, assume setup needed
        setNeedsSetup(true);
      } finally {
        setSetupLoading(false);
      }
    }
    void checkSetup();
  }, []);

  // Redirect if already authenticated
  useEffect(() => {
    if (!authLoading && isAuthenticated) {
      const redirectTo = searchParams.get('redirect') || '/';
      void navigate(redirectTo, { replace: true });
    }
  }, [isAuthenticated, authLoading, navigate, searchParams]);

  // Close Plex popup helper
  const closePlexPopup = () => {
    if (plexPopup && !plexPopup.closed) {
      plexPopup.close();
    }
    setPlexPopup(null);
  };

  // Poll for Plex PIN claim
  const pollPlexPin = async (pinId: string) => {
    try {
      const result = await api.auth.checkPlexPin(pinId);

      if (!result.authorized) {
        // Still waiting for PIN claim, continue polling
        setTimeout(() => void pollPlexPin(pinId), 2000);
        return;
      }

      // PIN claimed - close the popup
      closePlexPopup();

      // Check what we got back
      if (result.needsServerSelection && result.servers && result.tempToken) {
        // New user - needs to select a server
        setPlexServers(result.servers);
        setPlexTempToken(result.tempToken);
        setAuthStep('server-select');
      } else if (result.accessToken && result.refreshToken) {
        // User authenticated (returning or no servers)
        tokenStorage.setTokens(result.accessToken, result.refreshToken);
        void refetch();
        toast({ title: 'Success', description: 'Logged in successfully!' });
        void navigate('/');
      }
    } catch (error) {
      resetPlexAuth();
      toast({
        title: 'Authentication failed',
        description: error instanceof Error ? error.message : 'Plex authentication failed',
        variant: 'destructive',
      });
    }
  };

  // Start Plex OAuth flow
  const handlePlexLogin = async () => {
    setAuthStep('plex-waiting');
    try {
      const result = await api.auth.loginPlex();
      setPlexAuthUrl(result.authUrl);

      // Open Plex auth in popup and store reference
      const popup = window.open(result.authUrl, 'plex_auth', 'width=600,height=700,popup=yes');
      setPlexPopup(popup);

      // Start polling
      void pollPlexPin(result.pinId);
    } catch (error) {
      resetPlexAuth();
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to start Plex login',
        variant: 'destructive',
      });
    }
  };

  // Connect to selected Plex server
  const handlePlexServerSelect = async (serverUri: string, serverName: string) => {
    if (!plexTempToken) return;

    setConnectingToServer(serverName);

    try {
      const result = await api.auth.connectPlexServer({
        tempToken: plexTempToken,
        serverUri,
        serverName,
      });

      if (result.accessToken && result.refreshToken) {
        tokenStorage.setTokens(result.accessToken, result.refreshToken);
        void refetch();
        toast({ title: 'Success', description: `Connected to ${serverName}` });
        void navigate('/');
      }
    } catch (error) {
      setConnectingToServer(null);
      toast({
        title: 'Connection failed',
        description: error instanceof Error ? error.message : 'Failed to connect to server',
        variant: 'destructive',
      });
    }
  };

  // Reset Plex auth state
  const resetPlexAuth = () => {
    // Close popup if still open
    if (plexPopup && !plexPopup.closed) {
      plexPopup.close();
    }
    setPlexPopup(null);
    setAuthStep('initial');
    setPlexAuthUrl(null);
    setPlexServers([]);
    setPlexTempToken(null);
    setConnectingToServer(null);
  };

  // Handle local signup
  const handleLocalSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalLoading(true);

    try {
      const result = await api.auth.signup({
        username: username.trim(),
        password,
        email: email.trim() || undefined,
      });

      if (result.accessToken && result.refreshToken) {
        tokenStorage.setTokens(result.accessToken, result.refreshToken);
        void refetch();
        toast({ title: 'Success', description: 'Account created successfully!' });
        void navigate('/');
      }
    } catch (error) {
      toast({
        title: 'Signup failed',
        description: error instanceof Error ? error.message : 'Failed to create account',
        variant: 'destructive',
      });
    } finally {
      setLocalLoading(false);
    }
  };

  // Handle local login
  const handleLocalLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalLoading(true);

    try {
      const result = await api.auth.loginLocal({
        username: username.trim(),
        password,
      });

      if (result.accessToken && result.refreshToken) {
        tokenStorage.setTokens(result.accessToken, result.refreshToken);
        void refetch();
        toast({ title: 'Success', description: 'Logged in successfully!' });
        void navigate('/');
      }
    } catch (error) {
      toast({
        title: 'Login failed',
        description: error instanceof Error ? error.message : 'Invalid username or password',
        variant: 'destructive',
      });
    } finally {
      setLocalLoading(false);
    }
  };

  // Show loading while checking auth/setup status
  if (authLoading || setupLoading) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4">
        <LogoIcon className="h-16 w-16 animate-pulse" />
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Server selection step (only during Plex signup)
  if (authStep === 'server-select' && plexServers.length > 0) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-background p-4">
        <div className="mb-8 flex flex-col items-center text-center">
          <LogoIcon className="h-20 w-20 mb-4" />
          <h1 className="text-4xl font-bold tracking-tight">Tracearr</h1>
          <p className="mt-2 text-muted-foreground">Select your Plex server</p>
        </div>

        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>Select Server</CardTitle>
            <CardDescription>
              Choose which Plex Media Server to monitor
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {plexServers.map((server) => (
              <div key={server.name} className="space-y-2">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Monitor className="h-4 w-4" />
                  {server.name}
                  <span className="text-xs text-muted-foreground">
                    ({server.platform} • v{server.version})
                  </span>
                </div>
                <div className="space-y-1 pl-6">
                  {server.connections.map((conn) => (
                    <Button
                      key={conn.uri}
                      variant="outline"
                      className="w-full justify-between text-left h-auto py-2"
                      onClick={() => handlePlexServerSelect(conn.uri, server.name)}
                      disabled={connectingToServer !== null}
                    >
                      <div className="flex items-center gap-2">
                        {conn.local ? (
                          <Wifi className="h-3 w-3 text-green-500" />
                        ) : (
                          <Globe className="h-3 w-3 text-blue-500" />
                        )}
                        <span className="text-xs">
                          {conn.local ? 'Local' : 'Remote'}: {conn.address}:{conn.port}
                        </span>
                      </div>
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                  ))}
                </div>
              </div>
            ))}

            {connectingToServer && (
              <div className="flex items-center justify-center gap-2 pt-4 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Connecting to {connectingToServer}...
              </div>
            )}

            <Button variant="ghost" className="w-full mt-4" onClick={resetPlexAuth}>
              Cancel
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background p-4">
      <div className="mb-8 flex flex-col items-center text-center">
        <LogoIcon className="h-20 w-20 mb-4" />
        <h1 className="text-4xl font-bold tracking-tight">Tracearr</h1>
        <p className="mt-2 text-muted-foreground">
          {needsSetup
            ? 'Create your account to get started'
            : 'Sign in to your account'}
        </p>
      </div>

      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{needsSetup ? 'Create Account' : 'Sign In'}</CardTitle>
          <CardDescription>
            {needsSetup
              ? 'Create an account to manage your media servers'
              : 'Sign in to access your dashboard'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Plex OAuth Section */}
          {authStep === 'plex-waiting' ? (
            <div className="space-y-4">
              <div className="rounded-lg bg-muted/50 p-4 text-center">
                <Loader2 className="mx-auto h-8 w-8 animate-spin text-[#E5A00D] mb-3" />
                <p className="text-sm font-medium">Waiting for Plex authorization...</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Complete sign-in in the popup window
                </p>
                {plexAuthUrl && (
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    onClick={() => window.open(plexAuthUrl, '_blank')}
                    className="gap-1 h-auto p-0 mt-2"
                  >
                    <ExternalLink className="h-3 w-3" />
                    Reopen Plex Login
                  </Button>
                )}
              </div>
              <Button variant="ghost" className="w-full" onClick={resetPlexAuth}>
                Cancel
              </Button>
            </div>
          ) : (
            <>
              {/* Plex Login Button - Always Available */}
              <Button
                className={`w-full ${PLEX_COLOR} text-white`}
                onClick={handlePlexLogin}
              >
                <Server className="mr-2 h-4 w-4" />
                {needsSetup ? 'Sign up with Plex' : 'Sign in with Plex'}
              </Button>

              {/* Divider - Show if password auth is available OR during setup */}
              {(hasPasswordAuth || needsSetup) && (
                <div className="relative">
                  <div className="absolute inset-0 flex items-center">
                    <span className="w-full border-t" />
                  </div>
                  <div className="relative flex justify-center text-xs uppercase">
                    <span className="bg-card px-2 text-muted-foreground">or</span>
                  </div>
                </div>
              )}

              {/* Local Auth Form */}
              {/* Signup form - only shown during initial setup */}
              {needsSetup ? (
                <form onSubmit={handleLocalSignup} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="username">Username</Label>
                    <Input
                      id="username"
                      type="text"
                      placeholder="Choose a username"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      required
                      minLength={3}
                      maxLength={50}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="email">Email (optional)</Label>
                    <Input
                      id="email"
                      type="email"
                      placeholder="your@email.com"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="password">Password</Label>
                    <Input
                      id="password"
                      type="password"
                      placeholder="At least 8 characters"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                      minLength={8}
                    />
                  </div>
                  <Button type="submit" className="w-full" disabled={localLoading}>
                    {localLoading ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <User className="mr-2 h-4 w-4" />
                    )}
                    Create Account
                  </Button>
                </form>
              ) : hasPasswordAuth ? (
                <form onSubmit={handleLocalLogin} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="username">Username</Label>
                    <Input
                      id="username"
                      type="text"
                      placeholder="Your username"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="password">Password</Label>
                    <Input
                      id="password"
                      type="password"
                      placeholder="Your password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                    />
                  </div>
                  <Button type="submit" className="w-full" disabled={localLoading}>
                    {localLoading ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <KeyRound className="mr-2 h-4 w-4" />
                    )}
                    Sign In
                  </Button>
                </form>
              ) : null}

            </>
          )}
        </CardContent>
      </Card>

      <p className="mt-6 text-center text-xs text-muted-foreground">
        {needsSetup ? (
          <>
            After creating your account, you'll add your
            <br />
            Plex or Jellyfin servers from Settings.
          </>
        ) : (
          'Tracearr • Stream access management'
        )}
      </p>
    </div>
  );
}
