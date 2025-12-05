import { useQuery } from '@tanstack/react-query';
import '@tracearr/shared';
import { api } from '@/lib/api';

export type StatsPeriod = 'day' | 'week' | 'month' | 'year';

export function useDashboardStats() {
  return useQuery({
    queryKey: ['stats', 'dashboard'],
    queryFn: api.stats.dashboard,
    staleTime: 1000 * 30, // 30 seconds
    refetchInterval: 1000 * 60, // 1 minute
  });
}

export function usePlaysStats(period: StatsPeriod = 'week') {
  return useQuery({
    queryKey: ['stats', 'plays', period],
    queryFn: () => api.stats.plays(period),
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

export function useUserStats() {
  return useQuery({
    queryKey: ['stats', 'users'],
    queryFn: api.stats.users,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

export interface LocationStatsFilters {
  days?: number;
  serverUserId?: string;
  serverId?: string;
  mediaType?: 'movie' | 'episode' | 'track';
}

export function useLocationStats(filters?: LocationStatsFilters) {
  return useQuery({
    queryKey: ['stats', 'locations', filters],
    queryFn: () => api.stats.locations(filters),
    staleTime: 1000 * 60, // 1 minute
  });
}

export function usePlaysByDayOfWeek(period: StatsPeriod = 'month') {
  return useQuery({
    queryKey: ['stats', 'plays-by-dayofweek', period],
    queryFn: () => api.stats.playsByDayOfWeek(period),
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

export function usePlaysByHourOfDay(period: StatsPeriod = 'month') {
  return useQuery({
    queryKey: ['stats', 'plays-by-hourofday', period],
    queryFn: () => api.stats.playsByHourOfDay(period),
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

export function usePlatformStats(period: StatsPeriod = 'month') {
  return useQuery({
    queryKey: ['stats', 'platforms', period],
    queryFn: () => api.stats.platforms(period),
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

export function useQualityStats(period: StatsPeriod = 'month') {
  return useQuery({
    queryKey: ['stats', 'quality', period],
    queryFn: () => api.stats.quality(period),
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

export function useTopUsers(period: StatsPeriod = 'month') {
  return useQuery({
    queryKey: ['stats', 'top-users', period],
    queryFn: () => api.stats.topUsers(period),
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

export function useTopContent(period: StatsPeriod = 'month') {
  return useQuery({
    queryKey: ['stats', 'top-content', period],
    queryFn: () => api.stats.topContent(period),
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}

export function useConcurrentStats(period: StatsPeriod = 'month') {
  return useQuery({
    queryKey: ['stats', 'concurrent', period],
    queryFn: () => api.stats.concurrent(period),
    staleTime: 1000 * 60 * 5, // 5 minutes
  });
}
