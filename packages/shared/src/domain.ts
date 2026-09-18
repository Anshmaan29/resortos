/** Domain enums shared by DB, API and UI. Values match PostgreSQL enum/check values. */

export const ROLES = ['owner', 'receptionist', 'cleaner'] as const;
export type Role = (typeof ROLES)[number];

export const UNIT_TYPES = ['room', 'cottage', 'villa', 'tent', 'suite'] as const;
export type UnitType = (typeof UNIT_TYPES)[number];

export const ROOM_VIEWS = ['pool', 'garden', 'lake', 'hill', 'other'] as const;
export type RoomView = (typeof ROOM_VIEWS)[number];

/** Room status has three independent dimensions (spec §10). Occupancy is derived from stays/bookings. */
export const HOUSEKEEPING_STATUSES = ['dirty', 'cleaning', 'clean', 'inspected'] as const;
export type HousekeepingStatus = (typeof HOUSEKEEPING_STATUSES)[number];

export const SERVICE_STATUSES = ['in_service', 'maintenance', 'out_of_order'] as const;
export type ServiceStatus = (typeof SERVICE_STATUSES)[number];

export const OCCUPANCY_STATUSES = ['vacant', 'occupied', 'arriving', 'due_out'] as const;
export type OccupancyStatus = (typeof OCCUPANCY_STATUSES)[number];

export function isSellable(occupancy: OccupancyStatus, hk: HousekeepingStatus, service: ServiceStatus): boolean {
  return occupancy === 'vacant' && (hk === 'clean' || hk === 'inspected') && service === 'in_service';
}

export type RoomDisplayState =
  | 'ready' | 'occupied' | 'dirty' | 'cleaning' | 'arriving' | 'due_out' | 'maintenance' | 'out_of_order';

/** Single visual state for room cards; order of precedence matters. */
export function roomDisplayState(
  occupancy: OccupancyStatus,
  hk: HousekeepingStatus,
  service: ServiceStatus,
): RoomDisplayState {
  if (service === 'out_of_order') return 'out_of_order';
  if (service === 'maintenance') return 'maintenance';
  if (occupancy === 'due_out') return 'due_out';
  if (occupancy === 'occupied') return 'occupied';
  if (occupancy === 'arriving') return 'arriving';
  if (hk === 'cleaning') return 'cleaning';
  if (hk === 'dirty') return 'dirty';
  return 'ready';
}

export const MEAL_PLAN_CODES = ['EP', 'CP', 'MAP', 'AP'] as const;
export type MealPlanCode = (typeof MEAL_PLAN_CODES)[number];

export const MEAL_PLAN_LABELS: Record<MealPlanCode, string> = {
  EP: 'EP · Room only', CP: 'CP · Breakfast', MAP: 'MAP · Breakfast + 1 meal', AP: 'AP · All meals',
};

export const BOOKING_SOURCES = [
  'walk_in', 'phone', 'whatsapp', 'direct', 'website', 'makemytrip', 'goibibo',
  'booking_com', 'agoda', 'airbnb', 'corporate', 'travel_agent', 'other',
] as const;
export type BookingSource = (typeof BOOKING_SOURCES)[number];

export const OTA_SOURCES: readonly BookingSource[] = ['makemytrip', 'goibibo', 'booking_com', 'agoda', 'airbnb'];

export const BOOKING_SOURCE_LABELS: Record<BookingSource, string> = {
  walk_in: 'Walk-in', phone: 'Phone', whatsapp: 'WhatsApp', direct: 'Direct', website: 'Website',
  makemytrip: 'MakeMyTrip', goibibo: 'Goibibo', booking_com: 'Booking.com', agoda: 'Agoda',
  airbnb: 'Airbnb', corporate: 'Corporate', travel_agent: 'Travel agent', other: 'Other',
};

/** Why the guest is visiting (parity with the old software; feeds Form C and revenue breakdowns). */
export const VISIT_PURPOSES = [
  'business', 'leisure', 'family_function', 'medical', 'pilgrimage', 'conference', 'other',
] as const;
export type VisitPurpose = (typeof VISIT_PURPOSES)[number];

export const VISIT_PURPOSE_LABELS: Record<VisitPurpose, string> = {
  business: 'Business', leisure: 'Leisure', family_function: 'Family function', medical: 'Medical',
  pilgrimage: 'Pilgrimage', conference: 'Conference', other: 'Other',
};

export const RESERVATION_STATUSES = [
  'tentative', 'confirmed', 'checked_in', 'checked_out', 'cancelled', 'no_show',
] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

/** Allowed transitions (spec §12.3). Enforced in the API and by a DB trigger. */
export const RESERVATION_TRANSITIONS: Record<ReservationStatus, readonly ReservationStatus[]> = {
  tentative: ['confirmed', 'cancelled'],
  confirmed: ['checked_in', 'cancelled', 'no_show'],
  checked_in: ['checked_out'],
  checked_out: [],
  cancelled: [],
  no_show: [],
};

export function canTransition(from: ReservationStatus, to: ReservationStatus): boolean {
  return RESERVATION_TRANSITIONS[from].includes(to);
}

export const CANCELLATION_MONEY_OPTIONS = ['refund', 'cancellation_charge', 'guest_credit', 'partial_refund'] as const;
export type CancellationMoneyOption = (typeof CANCELLATION_MONEY_OPTIONS)[number];

export const CANCELLATION_REASONS = [
  'guest_request', 'change_of_plans', 'duplicate_booking', 'booked_elsewhere',
  'payment_not_received', 'resort_request', 'other',
] as const;
export type CancellationReason = (typeof CANCELLATION_REASONS)[number];

/** Actions a receptionist can only exceed with an Owner PIN (spec §4.5). */
export const OWNER_PIN_ACTIONS = [
  'discount_above_limit', 'rate_below_floor', 'refund', 'partial_refund',
  'pending_balance_checkout', 'credit_limit_exceeded', 'deposit_part_refund', 'min_stay_override',
] as const;
export type OwnerPinAction = (typeof OWNER_PIN_ACTIONS)[number];

/** Stable machine-readable API error codes; UI maps these to plain-language text. */
export const ERROR_CODES = {
  VALIDATION: 'VALIDATION_FAILED',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  STALE_VERSION: 'STALE_VERSION',
  ROOM_UNAVAILABLE: 'ROOM_UNAVAILABLE',
  OWNER_PIN_REQUIRED: 'OWNER_PIN_REQUIRED',
  OWNER_PIN_INVALID: 'OWNER_PIN_INVALID',
  OWNER_AUTHORISATION_INVALID: 'OWNER_AUTHORISATION_INVALID',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  IDEMPOTENCY_MISMATCH: 'IDEMPOTENCY_MISMATCH',
  INVALID_TRANSITION: 'INVALID_TRANSITION',
  RATE_LIMITED: 'RATE_LIMITED',
  SERVICE_BUSY: 'SERVICE_BUSY',
  INTERNAL: 'INTERNAL_ERROR',
} as const;
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export interface ApiError {
  code: ErrorCode;
  message: string;
  details?: unknown;
  requestId?: string;
}
