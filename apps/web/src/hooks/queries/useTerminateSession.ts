import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { api } from '@/lib/api';

/**
 * Mutation hook for terminating an active streaming session
 * Invalidates active sessions cache on success
 */
export function useTerminateSession() {
  const { t } = useTranslation('notifications');
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ sessionId, reason }: { sessionId: string; reason?: string }) =>
      api.sessions.terminate(sessionId, reason),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sessions', 'active'] });
      toast.success(t('toast.success.streamTerminated.title'), {
        description: t('toast.success.streamTerminated.message'),
      });
    },
    onError: (error: Error) => {
      toast.error(t('toast.error.streamTerminateFailed'), { description: error.message });
    },
  });
}
