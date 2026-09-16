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
