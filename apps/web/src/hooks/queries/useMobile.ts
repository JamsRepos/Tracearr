import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { MobileConfig } from '@tracearr/shared';
import { toast } from 'sonner';
import { api } from '@/lib/api';

export function useMobileConfig() {
  return useQuery({
    queryKey: ['mobile', 'config'],
    queryFn: api.mobile.get,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

export function useEnableMobile() {
  const { t } = useTranslation('notifications');
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: api.mobile.enable,
    onSuccess: (data) => {
      queryClient.setQueryData<MobileConfig>(['mobile', 'config'], data);
      toast.success(t('toast.success.mobileAccessEnabled.title'), {
        description: t('toast.success.mobileAccessEnabled.message'),
      });
    },
    onError: (err) => {
      toast.error(t('toast.error.mobileAccessEnableFailed'), { description: err.message });
    },
  });
}

export function useDisableMobile() {
  const { t } = useTranslation('notifications');
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: api.mobile.disable,
    onSuccess: () => {
      queryClient.setQueryData<MobileConfig>(['mobile', 'config'], (old) => {
        if (!old) return old;
        return { ...old, isEnabled: false, token: null, sessions: [] };
      });
      toast.success(t('toast.success.mobileAccessDisabled.title'), {
        description: t('toast.success.mobileAccessDisabled.message'),
      });
    },
    onError: (err) => {
      toast.error(t('toast.error.mobileAccessDisableFailed'), { description: err.message });
    },
  });
}

export function useGeneratePairToken() {
  const { t } = useTranslation('notifications');
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: api.mobile.generatePairToken,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['mobile', 'config'] });
      toast.success(t('toast.success.pairTokenGenerated.title'), {
        description: t('toast.success.pairTokenGenerated.message'),
      });
    },
    onError: (err) => {
      toast.error(t('toast.error.pairTokenGenerateFailed'), { description: err.message });
    },
  });
}

export function useUpdateMobileSession() {
  const { t } = useTranslation('notifications');
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, deviceName }: { id: string; deviceName: string }) =>
      api.mobile.updateSession(id, { deviceName }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['mobile', 'config'] });
      toast.success(t('toast.success.deviceRenamed.title'), {
        description: t('toast.success.deviceRenamed.message'),
      });
    },
    onError: (err) => {
      toast.error(t('toast.error.deviceRenameFailed'), { description: err.message });
    },
  });
}

export function useRevokeSession() {
  const { t } = useTranslation('notifications');
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (sessionId: string) => api.mobile.revokeSession(sessionId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['mobile', 'config'] });
      toast.success(t('toast.success.deviceRemoved.title'), {
        description: t('toast.success.deviceRemoved.message'),
      });
    },
    onError: (err) => {
      toast.error(t('toast.error.deviceRemoveFailed'), { description: err.message });
    },
  });
}

export function useRevokeMobileSessions() {
  const { t } = useTranslation(['notifications', 'common']);
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: api.mobile.revokeSessions,
    onSuccess: (data) => {
      queryClient.setQueryData<MobileConfig>(['mobile', 'config'], (old) => {
        if (!old) return old;
        return { ...old, sessions: [] };
      });
      toast.success(t('notifications:toast.success.sessionsRevoked.title'), {
        description: t('common:count.session', { count: data.revokedCount }),
      });
    },
    onError: (err) => {
      toast.error(t('notifications:toast.error.sessionsRevokeFailed'), {
        description: err.message,
      });
    },
  });
}
