/** Local shapes for the maintenance API responses (spec §38).
 *  Client-side only on purpose — the server's types are not imported. */

export type TicketStatus = 'open' | 'in_progress' | 'resolved' | 'closed';
export type TicketPriority = 'low' | 'normal' | 'high';

/** The people a ticket can be assigned to — the same staff as the housekeeping board (spec §37). */
export interface MaintenanceStaff {
  id: string;
  name: string;
  role: string;
}

export interface MaintenanceTicket {
  id: string;
  roomId: string | null;
  roomNumber: string | null;
  area: string | null;
  title: string;
  description: string | null;
  priority: TicketPriority;
  status: TicketStatus;
  assignedTo: { id: string; name: string } | null;
  cost: string | null;
  resolutionNote: string | null;
  createdAt: string;
  createdBy: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  roomServiceStatus: string | null;
  version: number;
}

export interface MaintenanceSchedule {
  id: string;
  name: string;
  area: string | null;
  roomId: string | null;
  roomNumber: string | null;
  everyDays: number;
  nextDue: string;
  lastTicketId: string | null;
  isActive: boolean;
  version: number;
}

export const STATUS_LABEL: Record<TicketStatus, string> = {
  open: 'Open',
  in_progress: 'In progress',
  resolved: 'Resolved',
  closed: 'Closed',
};

export const STATUS_TONE: Record<TicketStatus, 'warning' | 'info' | 'brand' | 'neutral'> = {
  open: 'warning',
  in_progress: 'info',
  resolved: 'brand',
  closed: 'neutral',
};

export const PRIORITY_LABEL: Record<TicketPriority, string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
};

export const SERVICE_LABEL: Record<string, string> = {
  in_service: 'In service',
  maintenance: 'Under maintenance',
  out_of_order: 'Out of order',
};
