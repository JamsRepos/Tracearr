import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import '@tracearr/shared';
import { api } from '@/lib/api';

interface SessionsParams {
  page?: number;
  pageSize?: number;
  userId?: string;
  serverId?: string;
  state?: string;
}

export function useSessions(params: SessionsParams = {}) {
  return useQuery({
    queryKey: ['sessions', 'list', params],
    queryFn: () => api.sessions.list(params),
    staleTime: 1000 * 30, // 30 seconds
  });
}

export function useActiveSessions(serverId?: string | null) {
  return useQuery({
    queryKey: ['sessions', 'active', serverId],
    queryFn: () => api.sessions.getActive(serverId ?? undefined),
    staleTime: 1000 * 15, // 15 seconds
    refetchInterval: 1000 * 30, // 30 seconds
  });
}

export function useSession(id: string) {
  return useQuery({
    queryKey: ['sessions', 'detail', id],
    queryFn: () => api.sessions.get(id),
    enabled: !!id,
    staleTime: 1000 * 60, // 1 minute
  });
}

export function useBulkDeleteSessions() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (ids: string[]) => api.sessions.bulkDelete(ids),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ['sessions'] });
      void queryClient.invalidateQueries({ queryKey: ['history'] });
      toast.success('Sessions Deleted', {
        description: `${data.deleted} session${data.deleted !== 1 ? 's' : ''} deleted.`,
      });
    },
    onError: (error: Error) => {
      toast.error('Failed to Delete Sessions', { description: error.message });
    },
  });
}
