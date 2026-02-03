import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { Settings } from '@tracearr/shared';
import { toast } from 'sonner';
import { api } from '@/lib/api';

// API Key queries and mutations
export function useApiKey() {
  return useQuery({
    queryKey: ['apiKey'],
    queryFn: api.settings.getApiKey,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

export function useRegenerateApiKey() {
  const { t } = useTranslation('notifications');
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: api.settings.regenerateApiKey,
    onSuccess: (data) => {
      queryClient.setQueryData(['apiKey'], data);
      toast.success(t('toast.success.apiKeyGenerated.title'), {
        description: t('toast.success.apiKeyGenerated.message'),
      });
    },
    onError: (err) => {
      toast.error(t('toast.error.apiKeyGenerateFailed'), { description: err.message });
    },
  });
}

export function useSettings() {
  return useQuery({
    queryKey: ['settings'],
    queryFn: api.settings.get,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

/** Jellyfin admins for owner dropdown (owner-only). Enable when primary auth is jellyfin. */
export function useJellyfinAdmins(enabled: boolean) {
  return useQuery({
    queryKey: ['jellyfinAdmins'],
    queryFn: api.auth.getJellyfinAdmins,
    staleTime: 1000 * 60 * 2, // 2 minutes
    enabled,
  });
}

interface UpdateSettingsOptions {
  silent?: boolean;
}

export function useUpdateSettings(options: UpdateSettingsOptions = {}) {
  const { silent = false } = options;
  const { t } = useTranslation('notifications');
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: Partial<Settings>) => api.settings.update(data),
    onMutate: async (newSettings) => {
      await queryClient.cancelQueries({ queryKey: ['settings'] });

      // Snapshot the previous value
      const previousSettings = queryClient.getQueryData<Settings>(['settings']);

      // Optimistically update to the new value
      queryClient.setQueryData<Settings>(['settings'], (old) => {
        if (!old) return old;
        return { ...old, ...newSettings };
      });

      return { previousSettings };
    },
    onError: (err, newSettings, context) => {
      // Rollback on error
      if (context?.previousSettings) {
        queryClient.setQueryData(['settings'], context.previousSettings);
      }
      if (!silent) {
        toast.error(t('toast.error.settingsUpdateFailed'), { description: err.message });
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings'] });
      if (!silent) {
        toast.success(t('toast.success.settingsUpdated.title'), {
          description: t('toast.success.settingsUpdated.message'),
        });
      }
    },
  });
}
