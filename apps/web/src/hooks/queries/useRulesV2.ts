import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { CreateRuleV2Input, UpdateRuleV2Input, Rule } from '@tracearr/shared';
import { toast } from 'sonner';
import { api } from '@/lib/api';

/**
 * Create a V2 rule with conditions and actions
 */
export function useCreateRuleV2() {
  const { t } = useTranslation('notifications');
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: CreateRuleV2Input) => api.rules.createV2(data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['rules', 'list'] });
      toast.success(t('toast.success.ruleCreated.title'), {
        description: t('toast.success.ruleCreated.message'),
      });
    },
    onError: (error: Error) => {
      toast.error(t('toast.error.ruleCreateFailed'), { description: error.message });
    },
  });
}

/**
 * Update a rule with V2 format
 */
export function useUpdateRuleV2() {
  const { t } = useTranslation('notifications');
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: UpdateRuleV2Input }) =>
      api.rules.updateV2(id, data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['rules', 'list'] });
      toast.success(t('toast.success.ruleUpdated.title'), {
        description: t('toast.success.ruleUpdated.message'),
      });
    },
    onError: (error: Error) => {
      toast.error(t('toast.error.ruleUpdateFailed'), { description: error.message });
    },
  });
}

/**
 * Preview migration of legacy rules to V2
 */
export function useMigrationPreview() {
  return useQuery({
    queryKey: ['rules', 'migration', 'preview'],
    queryFn: api.rules.migratePreview,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

/**
 * Migrate rules to V2 format
 */
export function useMigrateRules() {
  const { t } = useTranslation('notifications');
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (ids?: string[]) => api.rules.migrate(ids),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({ queryKey: ['rules'] });
      if (data.summary.migrated > 0) {
        toast.success(t('toast.success.ruleUpdated.title'), {
          description: `Migrated ${data.summary.migrated} rule${data.summary.migrated === 1 ? '' : 's'}`,
        });
      }
      if (data.summary.failed > 0) {
        toast.warning('Migration partially completed', {
          description: `${data.summary.failed} rule${data.summary.failed === 1 ? '' : 's'} failed to migrate`,
        });
      }
    },
    onError: (error: Error) => {
      toast.error(t('toast.error.ruleUpdateFailed'), {
        description: error.message,
      });
    },
  });
}

/**
 * Migrate a single rule to V2 format
 */
export function useMigrateOneRule() {
  const { t } = useTranslation('notifications');
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => api.rules.migrateOne(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['rules', 'list'] });
      toast.success(t('toast.success.ruleUpdated.title'));
    },
    onError: (error: Error) => {
      toast.error(t('toast.error.ruleUpdateFailed'), { description: error.message });
    },
  });
}

/**
 * Helper to determine if a rule is V2 format
 */
export function isRuleV2(rule: Rule): boolean {
  return (
    rule.conditions !== null &&
    rule.conditions !== undefined &&
    Array.isArray(rule.conditions.groups)
  );
}
