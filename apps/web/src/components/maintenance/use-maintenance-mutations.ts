'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/components/ui/toast';
import { api, ApiError, newIdempotencyKey } from '@/lib/api';
import type { MaintenanceSchedule, MaintenanceTicket, TicketPriority, TicketStatus } from './types';

/** Every ticket or schedule change refreshes both maintenance queries. */
export function useInvalidateMaintenance() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['maintenance-tickets'] });
    void qc.invalidateQueries({ queryKey: ['maintenance-schedules'] });
  };
}

/** A room's service status shows on the ticket, the room board, the front desk and the housekeeping board. */
function useInvalidateRoomBoards() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['rooms'] });
    void qc.invalidateQueries({ queryKey: ['front-desk'] });
    void qc.invalidateQueries({ queryKey: ['housekeeping-board'] });
  };
}

export interface TicketPatchBody {
  description?: string;
  priority?: TicketPriority;
  assignedTo?: string | null;
  cost?: string;
  resolutionNote?: string;
  status?: TicketStatus;
}

/** The one way a ticket changes: start work, resolve (with what was done and what it cost), assign, priority, close. */
export function usePatchTicket() {
  const qc = useQueryClient();
  const toast = useToast();
  const invalidate = useInvalidateMaintenance();
  return useMutation({
    mutationFn: (v: { id: string; version: number; body: TicketPatchBody; success: string }) =>
      api<MaintenanceTicket>(`/maintenance/tickets/${v.id}`, {
        method: 'PATCH',
        idempotencyKey: newIdempotencyKey(),
        body: { version: v.version, ...v.body },
      }),
    onSuccess: (_ticket, v) => {
      invalidate();
      toast('success', v.success);
    },
    onError: (err) => {
      invalidate(); // a version conflict or a stale list heals itself once the fresh tickets are back
      toast('error', err instanceof ApiError ? err.message : 'Could not update the ticket');
    },
  });
}

/** Mark the ticket's room under maintenance, or put it back in service (spec §10). */
export function useRoomServiceStatus() {
  const toast = useToast();
  const invalidateMaintenance = useInvalidateMaintenance();
  const invalidateBoards = useInvalidateRoomBoards();
  return useMutation({
    mutationFn: (v: { roomId: string; roomNumber: string; service: 'maintenance' | 'in_service' }) =>
      api<unknown>(`/rooms/${v.roomId}/status`, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey(),
        body: { service: v.service, reason: v.service === 'maintenance' ? 'Marked for maintenance' : 'Back in service' },
      }),
    onSuccess: (_d, v) => {
      invalidateMaintenance();
      invalidateBoards();
      toast('success', v.service === 'maintenance' ? `Room ${v.roomNumber} marked under maintenance` : `Room ${v.roomNumber} back in service`);
    },
    onError: (err) => toast('error', err instanceof ApiError ? err.message : 'Could not update the room'),
  });
}

/** Take a room out of sellable inventory for a stretch of nights (owner only, spec §10). */
export function useOutOfOrder() {
  const toast = useToast();
  const invalidateMaintenance = useInvalidateMaintenance();
  const invalidateBoards = useInvalidateRoomBoards();
  return useMutation({
    mutationFn: (v: { roomId: string; roomNumber: string; startDate: string; endDate: string; reason: string }) =>
      api<unknown>(`/rooms/${v.roomId}/out-of-order`, {
        method: 'POST',
        idempotencyKey: newIdempotencyKey(),
        body: { startDate: v.startDate, endDate: v.endDate, reason: v.reason },
      }),
    onSuccess: (_d, v) => {
      invalidateMaintenance();
      invalidateBoards();
      toast('success', `Room ${v.roomNumber} marked out of order`);
    },
    onError: (err) => toast('error', err instanceof ApiError ? err.message : 'Could not mark the room out of order'),
  });
}

export function useCreateSchedule() {
  const toast = useToast();
  const invalidate = useInvalidateMaintenance();
  return useMutation({
    mutationFn: (v: { name: string; roomId?: string; area?: string; everyDays: number; nextDue?: string }) =>
      api<{ id: string }>('/maintenance/schedules', { method: 'POST', idempotencyKey: newIdempotencyKey(), body: v }),
    onSuccess: () => {
      invalidate();
      toast('success', 'Schedule added');
    },
    onError: (err) => toast('error', err instanceof ApiError ? err.message : 'Could not add the schedule'),
  });
}

export function usePatchSchedule() {
  const toast = useToast();
  const invalidate = useInvalidateMaintenance();
  return useMutation({
    mutationFn: (v: { id: string; version: number; body: { name?: string; area?: string; everyDays?: number; nextDue?: string; isActive?: boolean }; success: string }) =>
      api<{ id: string }>(`/maintenance/schedules/${v.id}`, {
        method: 'PATCH',
        idempotencyKey: newIdempotencyKey(),
        body: { version: v.version, ...v.body },
      }),
    onSuccess: (_d, v) => {
      invalidate();
      toast('success', v.success);
    },
    onError: (err) => {
      invalidate(); // a version conflict heals itself once the fresh schedules are back
      toast('error', err instanceof ApiError ? err.message : 'Could not update the schedule');
    },
  });
}
