/** Local shapes for the housekeeping API responses (spec §37, §70.3).
 *  Client-side only on purpose — the server's types are not imported. */

export type HousekeepingStatus = 'dirty' | 'cleaning' | 'clean' | 'inspected';
export type TaskKind = 'checkout' | 'stayover' | 'manual';
export type TaskStatus = 'open' | 'in_progress';
export type TaskPriority = 'normal' | 'high';
export type HousekeepingService = 'in_service' | 'maintenance' | 'out_of_order';
export type HousekeepingStaffRole = 'cleaner' | 'receptionist' | 'owner';

export interface HousekeepingStaff {
  id: string;
  name: string;
  role: HousekeepingStaffRole;
}

export interface HousekeepingTask {
  id: string;
  kind: TaskKind;
  status: TaskStatus;
  priority: TaskPriority;
  note: string | null;
  version: number;
  startedAt: string | null;
  createdAt: string;
  assignedTo: { id: string; name: string } | null;
}

export interface HousekeepingRoom {
  roomId: string;
  number: string;
  roomTypeName: string;
  building: string | null;
  floor: string | null;
  housekeeping: HousekeepingStatus;
  service: HousekeepingService;
  occupied: boolean;
  departsToday: boolean;
  arrivesToday: boolean;
  task: HousekeepingTask | null;
}

/** GET /housekeeping/board */
export interface HousekeepingBoardData {
  businessDate: string;
  inspection: boolean;
  stayovers: boolean;
  doneToday: number;
  staff: HousekeepingStaff[];
  rooms: HousekeepingRoom[];
}

/** GET /housekeeping/my-tasks — only the caller's own tasks. No guest names, no money (spec §70.3). */
export interface MyTask {
  id: string;
  roomId: string;
  roomNumber: string;
  roomTypeName: string;
  kind: TaskKind;
  status: TaskStatus;
  priority: TaskPriority;
  note: string | null;
  version: number;
  startedAt: string | null;
  arrivesToday: boolean;
}

export const KIND_LABEL: Record<TaskKind, string> = {
  checkout: 'Departure clean',
  stayover: 'Stayover',
  manual: 'Manual',
};

export const HK_STATUS_LABEL: Record<HousekeepingStatus, string> = {
  dirty: 'Dirty',
  cleaning: 'Cleaning',
  clean: 'Clean',
  inspected: 'Inspected',
};
