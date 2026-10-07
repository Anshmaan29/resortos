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

/** Bill line types (spec §23). Staff see the labels, never these codes. */
export const FOLIO_LINE_TYPES = [
  'room_night', 'extra_person', 'meal', 'food', 'beverage', 'activity',
  'laundry', 'transport', 'early_checkin', 'late_checkout', 'damage', 'other', 'discount',
] as const;
export type FolioLineType = (typeof FOLIO_LINE_TYPES)[number];

export const FOLIO_LINE_TYPE_LABELS: Record<FolioLineType, string> = {
  room_night: 'Room', extra_person: 'Extra person', meal: 'Meal plan', food: 'Food',
  beverage: 'Beverage', activity: 'Activity', laundry: 'Laundry', transport: 'Transport',
  early_checkin: 'Early check-in', late_checkout: 'Late checkout', damage: 'Damage',
  other: 'Other', discount: 'Discount',
};

/** The types a receptionist can add by hand. Room nights are posted by night audit (§35.1). */
export const ADDABLE_LINE_TYPES = [
  'extra_person', 'food', 'beverage', 'activity', 'laundry', 'transport', 'early_checkin', 'late_checkout', 'damage', 'other',
] as const;
export type AddableLineType = (typeof ADDABLE_LINE_TYPES)[number];

export const TAX_CATEGORIES = ['accommodation', 'food', 'activity', 'laundry', 'transport', 'other'] as const;

/** The tax category a charge type falls into unless the saved item says otherwise (§24.3). */
export const DEFAULT_TAX_CATEGORY: Record<AddableLineType, (typeof TAX_CATEGORIES)[number]> = {
  extra_person: 'accommodation', food: 'food', beverage: 'food', activity: 'activity', laundry: 'laundry', transport: 'transport',
  early_checkin: 'accommodation', late_checkout: 'accommodation', damage: 'other', other: 'other',
};

/** How money was taken (spec §25.1). ResortOS records payments; it never processes them. */
export const PAYMENT_METHODS = [
  'cash', 'upi', 'card', 'bank_transfer', 'cheque', 'ota_prepaid', 'company_account', 'guest_credit', 'deposit',
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** What the desk can pick. `deposit` is only ever written by the checkout deposit decision. */
export const DESK_PAYMENT_METHODS = [
  'cash', 'upi', 'card', 'bank_transfer', 'cheque', 'ota_prepaid', 'company_account', 'guest_credit',
] as const satisfies readonly PaymentMethod[];

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: 'Cash', upi: 'UPI', card: 'Card (POS machine)', bank_transfer: 'Bank transfer',
  cheque: 'Cheque', ota_prepaid: 'Prepaid via OTA', company_account: 'Company account',
  guest_credit: 'Guest credit', deposit: 'From security deposit',
};

/** What reference the desk must capture for each method (§25.1). */
export const PAYMENT_REFERENCE_LABEL: Record<PaymentMethod, string | null> = {
  cash: null,
  upi: 'UTR or transaction ID',
  card: 'Approval code or last 4 digits',
  bank_transfer: 'UTR or reference',
  cheque: 'Cheque number and bank',
  ota_prepaid: 'OTA reference',
  company_account: null,
  guest_credit: null,
  deposit: null,
};

export const PAYMENT_ACCOUNT_KINDS = ['cash', 'bank', 'upi', 'card_pos', 'other'] as const;
export type PaymentAccountKind = (typeof PAYMENT_ACCOUNT_KINDS)[number];

export const PAYMENT_ACCOUNT_KIND_LABELS: Record<PaymentAccountKind, string> = {
  cash: 'Cash counter', bank: 'Bank account', upi: 'UPI', card_pos: 'Card machine', other: 'Other',
};

/**
 * Which account kinds a method may be posted to, mirroring the database CHECK exactly so the form
 * can only offer what the database will accept. Null means the method moves no money at the desk
 * and takes no account: it settles the bill against a company, an OTA, a guest credit or a deposit.
 */
export const ACCOUNT_KINDS_FOR_METHOD: Record<PaymentMethod, readonly PaymentAccountKind[] | null> = {
  cash: ['cash'],
  upi: ['upi'],
  card: ['card_pos'],
  bank_transfer: ['bank'],
  cheque: ['bank'],
  ota_prepaid: null,
  company_account: null,
  guest_credit: null,
  deposit: null,
};

export const PAYMENT_ENTRY_TYPES = ['payment', 'advance', 'deposit', 'refund', 'deposit_refund', 'deposit_adjustment'] as const;
export type PaymentEntryType = (typeof PAYMENT_ENTRY_TYPES)[number];

/** What the desk records directly; deposit refunds and adjustments come from the deposit decision. */
export const DESK_ENTRY_TYPES = ['payment', 'advance', 'deposit', 'refund'] as const;

export const PAYMENT_ENTRY_TYPE_LABELS: Record<PaymentEntryType, string> = {
  payment: 'Payment', advance: 'Advance', deposit: 'Security deposit', refund: 'Refund',
  deposit_refund: 'Deposit returned', deposit_adjustment: 'Deposit applied to bill',
};

/** Why a discount was given (spec §28): a short list plus a note, so the review list can group them. */
export const DISCOUNT_REASONS = [
  'regular_guest', 'complaint', 'corporate_rate', 'long_stay', 'owner_guest', 'promotion', 'rounding', 'other',
] as const;
export type DiscountReason = (typeof DISCOUNT_REASONS)[number];
export const DISCOUNT_REASON_LABELS: Record<DiscountReason, string> = {
  regular_guest: 'Regular guest', complaint: 'Complaint', corporate_rate: 'Corporate rate', long_stay: 'Long stay',
  owner_guest: "Owner's guest", promotion: 'Offer / promotion', rounding: 'Rounding off the bill', other: 'Other',
};

/**
 * Columns the police / guest register can show (spec §58.2), in the words printed on it. The owner
 * picks which and in what order, to match the local police station's format.
 */
export const POLICE_REGISTER_COLUMNS = [
  'serial', 'arrival', 'name', 'age', 'nationality', 'address', 'mobile', 'id_type', 'id_last4',
  'room', 'persons', 'purpose', 'vehicle', 'departure', 'signature',
] as const;
export type PoliceRegisterColumn = (typeof POLICE_REGISTER_COLUMNS)[number];
export const POLICE_REGISTER_LABELS: Record<PoliceRegisterColumn, string> = {
  serial: 'S. No.', arrival: 'Arrival', name: 'Name', age: 'Age', nationality: 'Nationality', address: 'Address',
  mobile: 'Mobile', id_type: 'ID type', id_last4: 'ID (last 4)', room: 'Room', persons: 'Persons',
  purpose: 'Purpose of visit', vehicle: 'Vehicle', departure: 'Departure', signature: 'Signature',
};

/** Expense categories every new property starts with (spec §39). */
export const DEFAULT_EXPENSE_CATEGORIES = ['Electricity', 'Salaries', 'Groceries', 'Repairs', 'Diesel', 'Marketing', 'Other'] as const;
