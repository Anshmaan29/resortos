'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/components/ui/toast';
import { api, ApiError, newIdempotencyKey } from '@/lib/api';
import type { HousekeepingStatus, TaskPriority } from './types';

interface TaskRef {
  id: string;
  roomNumber: string;
}

/**
 * Task lifecycle and assignment mutations, shared by the board and the my-tasks list (spec §37).
 * Every POST carries an idempotency key; both queries are refetched after each change.
 */
export function useTaskMutations() {
  const qc = useQueryClient();
  const toast = useToast();

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['housekeeping-board'] });
    void qc.invalidateQueries({ queryKey: ['housekeeping-my-tasks'] });
  };
  const fail = (err: unknown, fallback: string) => {
    refresh(); // a version conflict or stale board heals itself on refetch
    toast('error', err instanceof ApiError ? err.message : fallback);
  };

  const start = useMutation({
    mutationFn: (t: TaskRef) =>
      api<unknown>(`/housekeeping/tasks/${t.id}/start`, { method: 'POST', body: {}, idempotencyKey: newIdempotencyKey() }),
    onSuccess: (_d, t) => {
      refresh();
      toast('success', `Started room ${t.roomNumber}`);
    },
    onError: (err) => fail(err, 'Could not start the task'),
  });

  const complete = useMutation({
    mutationFn: (t: TaskRef) =>
      api<unknown>(`/housekeeping/tasks/${t.id}/complete`, { method: 'POST', body: {}, idempotencyKey: newIdempotencyKey() }),
    onSuccess: (_d, t) => {
      refresh(); // the task trigger sets the room status server-side (spec §37)
      toast('success', `Room ${t.roomNumber} cleaned`);
    },
    onError: (err) => fail(err, 'Could not complete the task'),
  });

  const stop = useMutation({
    mutationFn: (t: TaskRef) =>
      api<unknown>(`/housekeeping/tasks/${t.id}/stop`, { method: 'POST', body: {}, idempotencyKey: newIdempotencyKey() }),
    onSuccess: (_d, t) => {
      refresh();
      toast('success', `Room ${t.roomNumber} reopened`);
    },
    onError: (err) => fail(err, 'Could not stop the task'),
  });

  const skip = useMutation({
    mutationFn: (v: TaskRef & { reason: string; onDone?: () => void }) =>
      api<unknown>(`/housekeeping/tasks/${v.id}/skip`, { method: 'POST', body: { reason: v.reason }, idempotencyKey: newIdempotencyKey() }),
    onSuccess: (_d, v) => {
      refresh();
      toast('success', `Room ${v.roomNumber} skipped`);
      v.onDone?.();
    },
    onError: (err) => fail(err, 'Could not skip the task'),
  });

  const patch = useMutation({
    mutationFn: (v: {
      id: string;
      version: number;
      body: { priority?: TaskPriority; note?: string | null; assignedTo?: string | null };
      successMessage: string;
      onDone?: () => void;
    }) => api<unknown>(`/housekeeping/tasks/${v.id}`, { method: 'PATCH', body: { version: v.version, ...v.body } }),
    onSuccess: (_d, v) => {
      refresh();
      toast('success', v.successMessage);
      v.onDone?.();
    },
    onError: (err) => fail(err, 'Could not update the task'),
  });

  return { start, complete, stop, skip, patch };
}

/** Direct room status change — only for rooms with no open task; with a task, the task actions drive the status. */
export function useRoomHousekeeping() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (v: { roomId: string; number: string; to: Extract<HousekeepingStatus, 'clean' | 'inspected'> }) =>
      api<unknown>(`/rooms/${v.roomId}/status`, { method: 'POST', body: { housekeeping: v.to } }),
    onSuccess: (_d, v) => {
      void qc.invalidateQueries({ queryKey: ['housekeeping-board'] });
      void qc.invalidateQueries({ queryKey: ['rooms'] }); // the front-desk room board reads the same status
      toast('success', v.to === 'clean' ? `Room ${v.number} marked clean` : `Room ${v.number} marked inspected`);
    },
    onError: (err) => toast('error', err instanceof ApiError ? err.message : 'Could not update the room'),
  });
}
