/** Zod schemas shared by frontend forms and backend request validation (spec §72). */
import { z } from 'zod';
import { isMoneyString, money } from './money';
import { isIsoDate, nightsBetween } from './dates';
import {
  isE164, isValidGstin, isValidIndianVehicleNumber, isValidPinCode, normalizeIndianMobile, normalizeVehicleNumber,
} from './validators';
import {
  BOOKING_SOURCES, CANCELLATION_MONEY_OPTIONS, CANCELLATION_REASONS, HOUSEKEEPING_STATUSES, MEAL_PLAN_CODES,
  OTA_SOURCES, ROLES, ROOM_VIEWS, SERVICE_STATUSES, UNIT_TYPES,
} from './domain';

export const zId = z.string().uuid();

export const zIsoDate = z.string().refine(isIsoDate, 'Enter a valid date');

export const zMoney = z
  .string()
  .refine(isMoneyString, 'Enter an amount like 4000 or 4000.50')
  .transform((v) => money(v).toFixed(2));

export const zNonNegativeMoney = zMoney.refine((v) => !money(v).isNegative(), 'Amount cannot be negative');

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
  maskedOnDevice: z.boolean().default(false),
  contentType: z.enum(DOCUMENT_CONTENT_TYPES),
  sizeBytes: z.number().int().min(1).max(MAX_DOCUMENT_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/, 'Checksum must be a SHA-256 hex digest'),
}).refine((d) => d.idType !== 'aadhaar' || !['id_front', 'id_back', 'id_extra'].includes(d.docType) || d.maskedOnDevice,
  { message: 'Aadhaar images must be masked on the device before upload', path: ['maskedOnDevice'] });
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
