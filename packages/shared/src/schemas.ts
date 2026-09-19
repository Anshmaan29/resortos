/** Zod schemas shared by frontend forms and backend request validation (spec §72). */
import { z } from 'zod';
import { isMoneyString, money } from './money';
import { isIsoDate, nightsBetween } from './dates';
import {
  isE164, isValidGstin, isValidIndianVehicleNumber, isValidPinCode, normalizeIndianMobile, normalizeVehicleNumber,
} from './validators';
import {
  ACCOUNT_KINDS_FOR_METHOD, ADDABLE_LINE_TYPES, DESK_ENTRY_TYPES, DISCOUNT_REASONS, DESK_PAYMENT_METHODS, PAYMENT_ACCOUNT_KINDS,
  PAYMENT_REFERENCE_LABEL, TAX_CATEGORIES,
  BOOKING_SOURCES, CANCELLATION_MONEY_OPTIONS, CANCELLATION_REASONS, HOUSEKEEPING_STATUSES, MEAL_PLAN_CODES,
  OTA_SOURCES, ROLES, ROOM_VIEWS, SERVICE_STATUSES, UNIT_TYPES, VISIT_PURPOSES,
} from './domain';

export const zId = z.string().uuid();

export const zIsoDate = z.string().refine(isIsoDate, 'Enter a valid date');

export const zMoney = z
  .string()
  .refine(isMoneyString, 'Enter an amount like 4000 or 4000.50')
  .transform((v) => money(v).toFixed(2));

export const zNonNegativeMoney = zMoney.refine((v) => !money(v).isNegative(), 'Amount cannot be negative');
export const zPositiveMoney = zMoney.refine((v) => money(v).gt(0), 'Amount must be more than zero');

export const zMobile = z
  .string()
  .trim()
  .transform((v, ctx) => {
    if (v.startsWith('+') && !v.startsWith('+91')) {
      const compact = v.replace(/[\s\-()]/g, '');
      if (isE164(compact)) return compact;
    }
    const indian = normalizeIndianMobile(v);
    if (!indian) {
      ctx.addIssue({ code: 'custom', message: 'Enter a 10-digit mobile number' });
      return z.NEVER;
    }
    return indian;
  });

export const zGstin = z
  .string()
  .trim()
  .toUpperCase()
  .refine(isValidGstin, 'This GSTIN is not valid — check for typing mistakes');

export const zPinCode = z.string().trim().refine(isValidPinCode, 'Enter a 6-digit PIN code');

export const zVehicleNumber = z
  .object({ number: z.string().min(4).max(20), allowNonStandard: z.boolean().default(false) })
  .transform((v, ctx) => {
    const n = normalizeVehicleNumber(v.number);
    if (!v.allowNonStandard && !isValidIndianVehicleNumber(n)) {
      ctx.addIssue({ code: 'custom', message: 'Vehicle number looks wrong (e.g. RJ14CX1234)' });
      return z.NEVER;
    }
    return n;
  });

const optionalText = (max: number) => z.string().trim().max(max).optional().or(z.literal('').transform(() => undefined));

// ---------- auth ----------
export const loginSchema = z.object({
  login: z.string().trim().min(3, 'Enter your username or phone number').max(64),
  password: z.string().min(1, 'Enter your password').max(128),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const passwordSchema = z
  .string()
  .min(10, 'Use at least 10 characters')
  .max(128);

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: passwordSchema,
});

export const pinSchema = z.string().regex(/^\d{6}$/, 'PIN must be 6 digits');
export const staffPinSchema = z.string().regex(/^\d{4,6}$/, 'PIN must be 4–6 digits');


export const recoverAccountSchema = z.object({
  login: z.string().trim().min(3).max(64),
  recoveryCode: z.string().trim().toUpperCase().regex(/^[A-Z2-7]{4}-?[A-Z2-7]{4}-?[A-Z2-7]{4}$/, 'Enter the recovery code exactly as printed'),
  newPassword: passwordSchema,
});

export const createUserSchema = z.object({
  fullName: z.string().trim().min(2).max(80),
  username: z.string().trim().toLowerCase().regex(/^[a-z0-9._]{3,32}$/, '3–32 letters, numbers, dot or underscore'),
  mobile: zMobile.optional(),
  role: z.enum(ROLES),
  temporaryPassword: passwordSchema,
  discountLimitPercent: zNonNegativeMoney.optional(),
});
export type CreateUserInput = z.infer<typeof createUserSchema>;

// ---------- property & rooms ----------
export const propertySettingsSchema = z.object({
  name: z.string().trim().min(2).max(120),
  legalName: z.string().trim().min(2).max(160),
  addressLine1: z.string().trim().min(3).max(160),
  addressLine2: optionalText(160),
  city: z.string().trim().min(2).max(80),
  stateCode: z.string().regex(/^\d{2}$/),
  pinCode: zPinCode,
  gstin: zGstin.optional().or(z.literal('').transform(() => undefined)),
  phone: zMobile,
  email: z.string().trim().email().optional().or(z.literal('').transform(() => undefined)),
  checkInTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  checkOutTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
});
export type PropertySettingsInput = z.infer<typeof propertySettingsSchema>;

export const roomTypeSchema = z.object({
  name: z.string().trim().min(2).max(60),
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,8}$/),
  baseOccupancy: z.number().int().min(1).max(20),
  maxOccupancy: z.number().int().min(1).max(30),
  baseRate: zNonNegativeMoney,
  minRate: zNonNegativeMoney,
  extraAdultRate: zNonNegativeMoney,
  extraChildRate: zNonNegativeMoney,
  description: optionalText(500),
}).refine((v) => v.maxOccupancy >= v.baseOccupancy, { message: 'Max occupancy must be at least base occupancy', path: ['maxOccupancy'] })
  .refine((v) => money(v.baseRate).gte(money(v.minRate)), { message: 'Base rate cannot be below minimum rate', path: ['minRate'] });
export type RoomTypeInput = z.infer<typeof roomTypeSchema>;

export const roomSchema = z.object({
  number: z.string().trim().min(1).max(10),
  roomTypeId: zId,
  unitType: z.enum(UNIT_TYPES).default('room'),
  view: z.enum(ROOM_VIEWS).optional(),
  building: optionalText(40),
  floor: optionalText(10),
  notes: optionalText(500),
});
export type RoomInput = z.infer<typeof roomSchema>;

export const roomStatusChangeSchema = z.object({
  housekeeping: z.enum(HOUSEKEEPING_STATUSES).optional(),
  service: z.enum(SERVICE_STATUSES).optional(),
  reason: optionalText(200),
}).refine((v) => v.housekeeping || v.service, 'Choose a status');

// ---------- guests ----------
export const guestSchema = z.object({
  firstName: z.string().trim().min(1, 'Enter first name').max(60),
  lastName: z.string().trim().max(60).default(''),
  mobile: zMobile,
  email: z.string().trim().email('Enter a valid email').optional().or(z.literal('').transform(() => undefined)),
  addressLine: optionalText(200),
  city: optionalText(80),
  state: optionalText(80),
  pinCode: zPinCode.optional().or(z.literal('').transform(() => undefined)),
  country: z.string().trim().length(2).toUpperCase().default('IN'),
  nationality: z.string().trim().length(2).toUpperCase().default('IN'),
  companyName: optionalText(120),
  companyGstin: zGstin.optional().or(z.literal('').transform(() => undefined)),
  preferences: optionalText(500),
});
export type GuestInput = z.infer<typeof guestSchema>;

// ---------- reservations ----------
export const reservationRoomSchema = z.object({
  /** Present when editing: an unchanged line keeps its agreed nightly rates. */
  reservationRoomId: zId.optional(),
  roomTypeId: zId,
  roomId: zId.optional(),
  adults: z.number().int().min(1).max(20),
  childAges: z.array(z.number().int().min(0).max(17)).max(10).default([]),
  /** Manual room rate applied to every night. Omit to use rate plan / calendar prices. */
  nightlyRate: zNonNegativeMoney.optional(),
  ratePlanId: zId.optional(),
  mealPlan: z.enum(MEAL_PLAN_CODES).default('EP'),
});

const reservationFields = z.object({
  guestId: zId.optional(),
  guest: guestSchema.optional(),
  source: z.enum(BOOKING_SOURCES),
  otaReference: optionalText(60),
  arrival: zIsoDate,
  departure: zIsoDate,
  rooms: z.array(reservationRoomSchema).min(1).max(100),
  status: z.enum(['tentative', 'confirmed']).default('confirmed'),
  groupName: optionalText(120),
  /** Why the guest is visiting. Optional: staff should not be forced to guess. */
  purpose: z.enum(VISIT_PURPOSES).optional(),
  specialRequests: optionalText(1000),
  internalNotes: optionalText(1000),
  /** Id of an owner authorisation approved with the Owner PIN for exactly these values. */
  ownerAuthorisationId: zId.optional(),
});

type ReservationFields = z.infer<typeof reservationFields>;
function reservationRules<T extends z.ZodType<ReservationFields>>(schema: T) {
  return schema
    .refine((v) => v.guestId || v.guest, { message: 'Choose or add a guest', path: ['guest'] })
    .refine((v) => nightsBetween(v.arrival, v.departure) >= 1, { message: 'Departure must be after arrival', path: ['departure'] })
    .refine((v) => nightsBetween(v.arrival, v.departure) <= 90, { message: 'A booking can be at most 90 nights', path: ['departure'] })
    .refine((v) => !OTA_SOURCES.includes(v.source) || !!v.otaReference, { message: 'OTA booking reference is required', path: ['otaReference'] })
    .refine((v) => v.rooms.length === 1 || !!v.groupName, { message: 'Give the group a name', path: ['groupName'] })
    .refine((v) => new Set(v.rooms.map((r) => r.roomId).filter(Boolean)).size === v.rooms.filter((r) => r.roomId).length,
      { message: 'The same room is selected twice', path: ['rooms'] });
}

export const createReservationSchema = reservationRules(reservationFields.extend({ rebookedFromId: zId.optional() }));
export type CreateReservationInput = z.infer<typeof createReservationSchema>;

export const updateReservationSchema = reservationRules(reservationFields.extend({ version: z.number().int().min(1) }));
export type UpdateReservationInput = z.infer<typeof updateReservationSchema>;

/** Read-only price + GST estimate for the booking form. */
export const reservationEstimateSchema = z
  .object({
    reservationId: zId.optional(),
    arrival: zIsoDate,
    departure: zIsoDate,
    rooms: z.array(reservationRoomSchema).min(1).max(100),
  })
  .refine((v) => nightsBetween(v.arrival, v.departure) >= 1 && nightsBetween(v.arrival, v.departure) <= 90, { message: 'Check the dates', path: ['departure'] });
export type ReservationEstimateInput = z.infer<typeof reservationEstimateSchema>;

export const approveOwnerAuthorisationSchema = z.object({ ownerUserId: zId, pin: pinSchema });

export const cancelReservationSchema = z.object({
  reason: z.enum(CANCELLATION_REASONS),
  note: optionalText(500),
  moneyOption: z.enum(CANCELLATION_MONEY_OPTIONS).optional(),
  refundAmount: zNonNegativeMoney.optional(),
  ownerAuthorisationId: zId.optional(),
});
export type CancelReservationInput = z.infer<typeof cancelReservationSchema>;

/**
 * Marking a booking a no-show (spec §15.2). The money options are the same as cancellation's,
 * because the guest not arriving leaves the advance in exactly the same position.
 */
export const noShowSchema = z.object({
  note: optionalText(500),
  moneyOption: z.enum(CANCELLATION_MONEY_OPTIONS).optional(),
  refundAmount: zNonNegativeMoney.optional(),
  ownerAuthorisationId: zId.optional(),
});
export type NoShowInput = z.infer<typeof noShowSchema>;

/**
 * Extending a stay that is already in house — the other resolution night audit's departures step
 * offers. The new nights are quoted at current rates unless a rate is given, and a rate below the
 * room type's floor needs Owner PIN, exactly as it does on a booking.
 */
export const extendStaySchema = z.object({
  newDeparture: zIsoDate,
  reason: z.string().trim().min(3, 'Say why the stay is being extended').max(300),
  nightlyRate: zNonNegativeMoney.optional(),
  ownerAuthorisationId: zId.optional(),
});
export type ExtendStayInput = z.infer<typeof extendStaySchema>;

/**
 * Completing a night audit names the business date the screen was showing (spec §35).
 *
 * This is optimistic concurrency, like `expectedVersion` elsewhere: without it, two people pressing
 * Complete a moment apart would close two consecutive days — the second request would acquire the
 * lock, read the date the first one had just advanced to, and close that as well.
 */
export const completeNightAuditSchema = z.object({ businessDate: zIsoDate });
export type CompleteNightAuditInput = z.infer<typeof completeNightAuditSchema>;

/**
 * Adding a charge to a bill (spec §24.1). The item name is what appears on the invoice, so it is
 * taken as typed rather than looked up — a saved item only fills the form in.
 */
export const addChargeSchema = z.object({
  lineType: z.enum(ADDABLE_LINE_TYPES),
  name: z.string().trim().min(1, 'Enter what the charge is for').max(120),
  quantity: z.coerce.number().positive('Quantity must be more than zero').max(9999).default(1),
  unitRate: zNonNegativeMoney,
  chargeItemId: zId.optional(),
  /** Defaults to the current business date; a past date needs the date to still be open. */
  businessDate: zIsoDate.optional(),
  note: optionalText(300),
});
export type AddChargeInput = z.infer<typeof addChargeSchema>;

/** Voiding a line (spec §23, §4.5). A reason is always required; there is no silent removal. */
export const voidLineSchema = z.object({
  reason: z.string().trim().min(3, 'Say why this line is being removed').max(300),
  ownerAuthorisationId: zId.optional(),
});
export type VoidLineInput = z.infer<typeof voidLineSchema>;

/** A saved charge item — the quick-pick list, not a menu system (spec §24.2). */
export const chargeItemSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(80),
  lineType: z.enum(ADDABLE_LINE_TYPES),
  defaultRate: zNonNegativeMoney,
  taxCategory: z.enum(TAX_CATEGORIES).optional(),
  sortOrder: z.coerce.number().int().min(0).max(9999).default(0),
  isActive: z.boolean().optional(),
});
export type ChargeItemInput = z.infer<typeof chargeItemSchema>;

/**
 * Recording money taken (spec §25). The account is where it landed; the method is how it was taken,
 * and drives which reference the desk must capture. The pair is checked again in the database, so a
 * form that gets it wrong is refused rather than stored.
 */
export const recordPaymentSchema = z
  .object({
    entryType: z.enum(DESK_ENTRY_TYPES).default('payment'),
    method: z.enum(DESK_PAYMENT_METHODS),
    paymentAccountId: zId.optional(),
    amount: zPositiveMoney,
    reference: optionalText(80),
    note: optionalText(300),
    businessDate: zIsoDate.optional(),
    ownerAuthorisationId: zId.optional(),
  })
  .superRefine((v, ctx) => {
    const needsAccount = ACCOUNT_KINDS_FOR_METHOD[v.method] !== null;
    if (needsAccount && !v.paymentAccountId) {
      ctx.addIssue({ code: 'custom', path: ['paymentAccountId'], message: 'Choose where the money went' });
    }
    if (!needsAccount && v.paymentAccountId) {
      ctx.addIssue({ code: 'custom', path: ['paymentAccountId'], message: 'This settlement moves no money, so it has no account' });
    }
    if (v.entryType === 'deposit' && !needsAccount) {
      ctx.addIssue({ code: 'custom', path: ['method'], message: 'A security deposit is real money — take it by cash, UPI, card or bank' });
    }
    if (PAYMENT_REFERENCE_LABEL[v.method] && !v.reference) {
      ctx.addIssue({ code: 'custom', path: ['reference'], message: `Enter the ${PAYMENT_REFERENCE_LABEL[v.method]!.toLowerCase()}` });
    }
  });
export type RecordPaymentInput = z.infer<typeof recordPaymentSchema>;

/**
 * The security deposit decision at checkout (spec §27): some of it applied to the bill, the rest
 * given back. The two must account for all of it; the server decides whether the split needs the
 * owner.
 */
export const depositDecisionSchema = z
  .object({
    adjust: zNonNegativeMoney.default('0.00'),
    refund: zNonNegativeMoney.default('0.00'),
    refundMethod: z.enum(['cash', 'upi', 'card', 'bank_transfer', 'cheque']).optional(),
    refundAccountId: zId.optional(),
    reference: optionalText(80),
    ownerAuthorisationId: zId.optional(),
  })
  .superRefine((v, ctx) => {
    if (money(v.refund).gt(0) && (!v.refundMethod || !v.refundAccountId)) {
      ctx.addIssue({ code: 'custom', path: ['refundAccountId'], message: 'Choose how the deposit goes back' });
    }
  });
export type DepositDecisionInput = z.infer<typeof depositDecisionSchema>;

/** Reversing a payment (spec §25.4). A new record; nothing is overwritten. */
export const reversePaymentSchema = z.object({
  reason: z.string().trim().min(3, 'Say why this payment is being reversed').max(300),
  ownerAuthorisationId: zId.optional(),
});
export type ReversePaymentInput = z.infer<typeof reversePaymentSchema>;

/** A place money lands (spec §25.1). Owner settings. */
export const paymentAccountSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(60),
  kind: z.enum(PAYMENT_ACCOUNT_KINDS),
  bankName: optionalText(80),
  accountLast4: z.string().regex(/^\d{4}$/, 'Enter the last 4 digits').optional().or(z.literal('').transform(() => undefined)),
  upiHandle: optionalText(80),
  posTerminal: optionalText(40),
  openingBalance: zMoney.default('0.00'),
  sortOrder: z.coerce.number().int().min(0).max(9999).default(0),
  isActive: z.boolean().optional(),
});
export type PaymentAccountInput = z.infer<typeof paymentAccountSchema>;

export const rateQuoteQuerySchema = z
  .object({
    roomTypeId: zId,
    arrival: zIsoDate,
    departure: zIsoDate,
    adults: z.coerce.number().int().min(1).max(20),
    childAges: z.string().optional().transform((v) => (v ? v.split(',').map((n) => Number(n)) : [])),
    ratePlanId: zId.optional(),
    mealPlan: z.enum(MEAL_PLAN_CODES).default('EP'),
  })
  .refine((v) => nightsBetween(v.arrival, v.departure) >= 1, { message: 'Departure must be after arrival', path: ['departure'] });

/** Shared by the in-house list and the room-change log. */
export const stayListQuerySchema = z.object({
  from: zIsoDate.optional(),
  to: zIsoDate.optional(),
  status: z.enum(['in_house', 'checked_out', 'all']).default('in_house'),
  q: z.string().trim().max(60).optional(),
});
export type StayListQuery = z.infer<typeof stayListQuerySchema>;

export const availabilityQuerySchema = z
  .object({ arrival: zIsoDate, departure: zIsoDate, roomTypeId: zId.optional() })
  .refine((v) => nightsBetween(v.arrival, v.departure) >= 1, { message: 'Departure must be after arrival', path: ['departure'] });

// ---------- check-in (spec §17–§20) ----------
export const ID_TYPES = ['aadhaar', 'passport', 'driving_licence', 'voter_id', 'pan', 'other', 'none'] as const;
export type IdType = (typeof ID_TYPES)[number];
/** ID types whose back side carries required details. */
export const ID_TYPES_WITH_BACK: readonly IdType[] = ['aadhaar', 'driving_licence', 'voter_id'];

/** Staff-facing ID names, shared by the check-in screens, the phone page and the registration card. */
export const ID_TYPE_LABELS: Record<IdType, string> = {
  aadhaar: 'Aadhaar', passport: 'Passport', driving_licence: 'Driving licence', voter_id: 'Voter ID',
  pan: 'PAN card', other: 'Other ID', none: 'Not recorded',
};

export const DOCUMENT_TYPES = ['guest_photo', 'id_front', 'id_back', 'id_extra', 'signature', 'grc', 'other'] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];
export const DOCUMENT_CONTENT_TYPES = ['image/jpeg', 'image/webp', 'image/png', 'application/pdf'] as const;
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

export const occupantSchema = z.object({
  key: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
  /** May be blank while the check-in is in progress; required at confirmation. */
  fullName: z.string().trim().max(120).default(''),
  isPrimary: z.boolean().default(false),
  isChild: z.boolean().default(false),
  age: z.number().int().min(0).max(120).optional(),
  relation: optionalText(40),
  nationality: z.string().trim().length(2).toUpperCase().default('IN'),
  idType: z.enum(ID_TYPES).default('none'),
  /** Last 4 characters only — a full ID number is never accepted (spec §58.3). */
  idLast4: z.string().trim().regex(/^[A-Za-z0-9]{4}$/, 'Enter only the last 4 characters of the ID').optional().or(z.literal('').transform(() => undefined)),
}).refine((o) => !o.isChild || o.age !== undefined, { message: 'Enter the child’s age', path: ['age'] });
export type OccupantInput = z.infer<typeof occupantSchema>;

export const vehicleSchema = z.object({
  registration: z.string().trim().min(4).max(20),
  vehicleType: z.enum(['car', 'bike', 'bus', 'other']).default('car'),
  parkingSlot: optionalText(20),
  nonStandard: z.boolean().default(false),
}).refine((v) => v.nonStandard || isValidIndianVehicleNumber(v.registration), { message: 'Vehicle number looks wrong (e.g. RJ14CX1234)', path: ['registration'] });

export const checkInDraftDataSchema = z.object({
  rooms: z.array(z.object({
    reservationRoomId: zId,
    roomId: zId.optional(),
    occupants: z.array(occupantSchema).max(30).default([]),
    vehicles: z.array(vehicleSchema).max(10).default([]),
  })).default([]),
  consents: z.object({ stayAndCompliance: z.boolean().default(false), marketing: z.boolean().default(false) }).default({ stayAndCompliance: false, marketing: false }),
});
export type CheckInDraftData = z.infer<typeof checkInDraftDataSchema>;

export const createCheckInDraftSchema = z.object({
  reservationId: zId,
  reservationRoomIds: z.array(zId).min(1).max(100).optional(),
});

export const updateCheckInDraftSchema = z.object({
  version: z.number().int().min(1),
  step: z.number().int().min(1).max(7),
  data: checkInDraftDataSchema,
});

export const documentUploadRequestSchema = z.object({
  /** Generated on the device per captured photo; makes retries return the same document. */
  clientUploadId: zId.optional(),
  docType: z.enum(DOCUMENT_TYPES),
  idType: z.enum(ID_TYPES).exclude(['none']).optional(),
  occupantKey: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/).optional(),
  contentType: z.enum(DOCUMENT_CONTENT_TYPES),
  sizeBytes: z.number().int().min(1).max(MAX_DOCUMENT_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/, 'Checksum must be a SHA-256 hex digest'),
});
export type DocumentUploadRequest = z.infer<typeof documentUploadRequestSchema>;

export const roomShiftSchema = z.object({
  toRoomId: zId,
  reason: z.string().trim().min(3, 'Enter a reason').max(300),
  rateDecision: z.enum(['keep_rate', 'new_room_type_rate']).default('keep_rate'),
  ownerAuthorisationId: zId.optional(),
});
export type RoomShiftInput = z.infer<typeof roomShiftSchema>;

/** A new version of the registration card; the old one and its file are kept (spec §20). */
export const regenerateGrcSchema = z.object({
  reason: z.string().trim().min(3, 'Say why a new registration card is needed').max(300),
});
export type RegenerateGrcInput = z.infer<typeof regenerateGrcSchema>;

export const checkoutSchema = z.object({
  /** Reserved for Phase 2 steps (settlement, invoice). */
  steps: z.record(z.string(), z.unknown()).default({}),
});

/** Opening a cashier shift (spec §34.1): the cash in the drawer when it starts. */
export const openShiftSchema = z.object({
  openingCash: zNonNegativeMoney,
});
export type OpenShiftInput = z.infer<typeof openShiftSchema>;

/**
 * Closing a shift (spec §34.3): what was actually counted, and the card machine's settlement slip.
 * Whether a difference needs a reason depends on the owner's threshold, so the server decides that.
 */
export const closeShiftSchema = z.object({
  countedCash: zNonNegativeMoney,
  posBatchTotal: zNonNegativeMoney.optional(),
  differenceReason: optionalText(300),
  handoverNote: optionalText(500),
  version: z.coerce.number().int().min(1),
});
export type CloseShiftInput = z.infer<typeof closeShiftSchema>;

/**
 * A discount (spec §28): a percentage or an amount, on one charge or on the whole bill. The server
 * spreads a bill discount across the charges, because GST is decided per charge after discount.
 */
export const discountSchema = z
  .object({
    scope: z.enum(['line', 'bill']),
    lineId: zId.optional(),
    kind: z.enum(['percent', 'amount']),
    value: zPositiveMoney,
    reason: z.enum(DISCOUNT_REASONS),
    note: optionalText(200),
    ownerAuthorisationId: zId.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.scope === 'line' && !v.lineId) ctx.addIssue({ code: 'custom', path: ['lineId'], message: 'Choose the charge to discount' });
    if (v.kind === 'percent' && money(v.value).gt(100)) ctx.addIssue({ code: 'custom', path: ['value'], message: 'Cannot be more than 100%' });
    if (v.reason === 'other' && !v.note) ctx.addIssue({ code: 'custom', path: ['note'], message: 'Say what the discount is for' });
  });
export type DiscountInput = z.infer<typeof discountSchema>;

/**
 * Who the invoice is made out to (spec §29.2). Left out, it is the guest. A business guest's GSTIN
 * makes it a B2B invoice; the GSTIN is checked here and again by the database.
 */
export const invoiceBuyerSchema = z.object({
  name: z.string().trim().min(2, 'Enter the name to bill').max(120),
  gstin: z.string().trim().toUpperCase().refine(isValidGstin, 'This GSTIN is not valid').optional()
    .or(z.literal('').transform(() => undefined)),
  address: optionalText(300),
});
export type InvoiceBuyerInput = z.infer<typeof invoiceBuyerSchema>;

/** A credit note (spec §29.4): the whole invoice, or chosen lines by amount. Owner only. */
export const creditNoteSchema = z.object({
  reason: z.string().trim().min(3, 'Say why this invoice is being credited').max(300),
  lines: z.array(z.object({ invoiceLineId: zId, amount: zPositiveMoney.optional() })).min(1).max(200).optional(),
});
export type CreditNoteInput = z.infer<typeof creditNoteSchema>;

/** A debit note for charges added after the invoice (spec §22). */
export const debitNoteSchema = z.object({
  reason: z.string().trim().min(3, 'Say what the late charges are for').max(300),
});
export type DebitNoteInput = z.infer<typeof debitNoteSchema>;

/** Checkout step input: leave with a balance still owed, which only the owner can allow (§22). */
export const checkoutSettlementSchema = z.object({
  pendingBalance: z.boolean().default(false),
  ownerAuthorisationId: zId.optional(),
}).default({ pendingBalance: false });

/** Checkout step input: who the invoice is made out to, when it is not simply the guest. */
export const checkoutInvoiceSchema = z.object({
  buyer: invoiceBuyerSchema.optional(),
}).default({});
