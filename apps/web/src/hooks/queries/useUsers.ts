import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useToast } from '@/components/ui/use-toast';

export function useUsers(params: { page?: number; pageSize?: number; serverId?: string } = {}) {
  return useQuery({
    queryKey: ['users', 'list', params],
    queryFn: () => api.users.list(params),
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

export function useUser(id: string) {
  return useQuery({
    queryKey: ['users', 'detail', id],
    queryFn: () => api.users.get(id),
    enabled: !!id,
    staleTime: 1000 * 60, // 1 minute
  });
}

/**
 * Aggregate endpoint that fetches all user data in one request.
 * Use this for the UserDetail page instead of multiple separate queries.
 * Reduces 6 API calls to 1, significantly improving load time.
 */
export function useUserFull(id: string) {
  return useQuery({
    queryKey: ['users', 'full', id],
    queryFn: () => api.users.getFull(id),
    enabled: !!id,
    staleTime: 1000 * 60, // 1 minute
  });
}

export function useUserSessions(id: string, params: { page?: number; pageSize?: number } = {}) {
  return useQuery({
    queryKey: ['users', 'sessions', id, params],
    queryFn: () => api.users.sessions(id, params),
    enabled: !!id,
    staleTime: 1000 * 60, // 1 minute
  });
}

export function useUpdateUser() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: { trustScore?: number } }) =>
      api.users.update(id, data),
    onSuccess: (data, variables) => {
      // Update user in cache
      queryClient.setQueryData(['users', 'detail', variables.id], data);
      // Invalidate users list
      void queryClient.invalidateQueries({ queryKey: ['users', 'list'] });
    },
  });
}

export function useUpdateUserIdentity() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string | null }) =>
      api.users.updateIdentity(id, { name }),
    onSuccess: (_, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['users', 'full', variables.id] });
      void queryClient.invalidateQueries({ queryKey: ['users', 'list'] });
      toast({ title: 'Display Name Updated' });
    },
    onError: (error: Error) => {
      toast({ title: 'Failed to Update', description: error.message, variant: 'destructive' });
    },
  });
}

export function useUserLocations(id: string) {
  return useQuery({
    queryKey: ['users', 'locations', id],
    queryFn: () => api.users.locations(id),
    enabled: !!id,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

export function useUserDevices(id: string) {
  return useQuery({
    queryKey: ['users', 'devices', id],
    queryFn: () => api.users.devices(id),
    enabled: !!id,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

export function useUserTerminations(id: string, params: { page?: number; pageSize?: number } = {}) {
  return useQuery({
    queryKey: ['users', 'terminations', id, params],
    queryFn: () => api.users.terminations(id, params),
    enabled: !!id,
    staleTime: 1000 * 60, // 1 minute
  });
}
