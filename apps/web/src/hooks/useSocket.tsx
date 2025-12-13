import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useMemo,
  type ReactNode,
} from 'react';
import { io, type Socket } from 'socket.io-client';
import { useQueryClient } from '@tanstack/react-query';
import type {
  ServerToClientEvents,
  ClientToServerEvents,
  ActiveSession,
  ViolationWithDetails,
  DashboardStats,
} from '@tracearr/shared';
import { WS_EVENTS } from '@tracearr/shared';
import { useAuth } from './useAuth';
import { useToast } from './use-toast';
import { tokenStorage } from '@/lib/api';

type TypedSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

interface SocketContextValue {
  socket: TypedSocket | null;
  isConnected: boolean;
  subscribeSessions: () => void;
  unsubscribeSessions: () => void;
}

const SocketContext = createContext<SocketContextValue | null>(null);

export function SocketProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [socket, setSocket] = useState<TypedSocket | null>(null);
  const [isConnected, setIsConnected] = useState(false);

  useEffect(() => {
    if (!isAuthenticated) {
      if (socket) {
        socket.disconnect();
        setSocket(null);
        setIsConnected(false);
      }
      return;
    }

    // Get JWT token for authentication
    const token = tokenStorage.getAccessToken();
    if (!token) {
      return;
    }

    // Create socket connection with auth token
    const newSocket: TypedSocket = io({
      path: '/socket.io',
      withCredentials: true,
      autoConnect: true,
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
      auth: {
        token,
      },
    });

    newSocket.on('connect', () => {
      setIsConnected(true);
    });

    newSocket.on('disconnect', () => {
      setIsConnected(false);
    });

    newSocket.on('connect_error', (error) => {
      console.error('[Socket] Connection error:', error);
    });

    // Handle real-time events
    // Note: Since users can filter by server, we invalidate all matching query patterns
    // and let react-query refetch with the appropriate server filter
    newSocket.on(WS_EVENTS.SESSION_STARTED as 'session:started', (session: ActiveSession) => {
      // Invalidate all active sessions queries (regardless of server filter)
      void queryClient.invalidateQueries({ queryKey: ['sessions', 'active'] });
      // Invalidate dashboard stats and session history
      void queryClient.invalidateQueries({ queryKey: ['stats', 'dashboard'] });
      void queryClient.invalidateQueries({ queryKey: ['sessions', 'list'] });

      toast({
        title: 'New Stream Started',
        description: `${session.user.identityName ?? session.user.username} is watching ${session.mediaTitle}`,
      });
    });

    newSocket.on(WS_EVENTS.SESSION_STOPPED as 'session:stopped', (_sessionId: string) => {
      // Invalidate all active sessions queries (regardless of server filter)
      void queryClient.invalidateQueries({ queryKey: ['sessions', 'active'] });
      // Invalidate dashboard stats and session history (stopped session now has duration)
      void queryClient.invalidateQueries({ queryKey: ['stats', 'dashboard'] });
      void queryClient.invalidateQueries({ queryKey: ['sessions', 'list'] });
    });

    newSocket.on(WS_EVENTS.SESSION_UPDATED as 'session:updated', (_session: ActiveSession) => {
      // Invalidate all active sessions queries (regardless of server filter)
      void queryClient.invalidateQueries({ queryKey: ['sessions', 'active'] });
    });

    newSocket.on(WS_EVENTS.VIOLATION_NEW as 'violation:new', (violation: ViolationWithDetails) => {
      // Invalidate violations query
      void queryClient.invalidateQueries({ queryKey: ['violations'] });
      void queryClient.invalidateQueries({ queryKey: ['stats', 'dashboard'] });

      // Show toast notification
      const severityColors = {
        low: 'default',
        warning: 'default',
        high: 'destructive',
      } as const;

      toast({
        title: `New Violation: ${violation.rule.name}`,
        description: `${violation.user.identityName ?? violation.user.username} triggered ${violation.rule.type}`,
        variant: severityColors[violation.severity],
      });
    });

    newSocket.on(WS_EVENTS.STATS_UPDATED as 'stats:updated', (_stats: DashboardStats) => {
      // Invalidate all dashboard stats queries (they now have server-specific cache keys)
      void queryClient.invalidateQueries({ queryKey: ['stats', 'dashboard'] });
    });

    setSocket(newSocket);

    return () => {
      newSocket.disconnect();
    };
  }, [isAuthenticated, queryClient, toast]);

  const subscribeSessions = useCallback(() => {
    if (socket && isConnected) {
      socket.emit('subscribe:sessions');
    }
  }, [socket, isConnected]);

  const unsubscribeSessions = useCallback(() => {
    if (socket && isConnected) {
      socket.emit('unsubscribe:sessions');
    }
  }, [socket, isConnected]);

  const value = useMemo<SocketContextValue>(
    () => ({
      socket,
      isConnected,
      subscribeSessions,
      unsubscribeSessions,
    }),
    [socket, isConnected, subscribeSessions, unsubscribeSessions]
  );

  return (
    <SocketContext.Provider value={value}>{children}</SocketContext.Provider>
  );
}

export function useSocket(): SocketContextValue {
  const context = useContext(SocketContext);
  if (!context) {
    throw new Error('useSocket must be used within a SocketProvider');
  }
  return context;
}
