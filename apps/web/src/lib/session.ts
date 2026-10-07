'use client';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import type { Me, Property } from './types';

export const useMe = () => useQuery({ queryKey: ['me'], queryFn: () => api<{ user: Me }>('/auth/me').then((r) => r.user), staleTime: 60_000, retry: false });
export const useProperty = () => useQuery({ queryKey: ['property'], queryFn: () => api<Property>('/property'), staleTime: 60_000, refetchInterval: 60_000 });
