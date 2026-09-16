import { ERROR_CODES, type ErrorCode } from '@resortos/shared';

const STATUS: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  FORBIDDEN: 403,
  OWNER_PIN_REQUIRED: 403,
  OWNER_PIN_INVALID: 403,
  OWNER_AUTHORISATION_INVALID: 403,
  ACCOUNT_LOCKED: 423,
  NOT_FOUND: 404,
  CONFLICT: 409,
  STALE_VERSION: 409,
  ROOM_UNAVAILABLE: 409,
  IDEMPOTENCY_MISMATCH: 422,
  INVALID_TRANSITION: 409,
  RATE_LIMITED: 429,
  INTERNAL_ERROR: 500,
};

/** Business error with a stable code and a plain-language message safe to show staff. */
export class AppError extends Error {
  readonly status: number;
  constructor(readonly code: ErrorCode, message: string, readonly details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.status = STATUS[code];
  }
}

export const notFound = (what: string) => new AppError(ERROR_CODES.NOT_FOUND, `${what} was not found.`);
export const forbidden = (message = 'You do not have permission to do this.') => new AppError(ERROR_CODES.FORBIDDEN, message);
export const staleVersion = () =>
  new AppError(ERROR_CODES.STALE_VERSION, 'This was changed by someone else. Reload to see the latest version.');

interface PgError { code?: string; constraint?: string; message?: string }

/** Translates database guard failures into messages staff can act on. */
export function fromPgError(err: unknown): AppError | null {
  const e = err as PgError;
  if (!e || typeof e.code !== 'string') return null;
  switch (e.code) {
    case '23P01': // exclusion_violation
      if (e.constraint === 'no_overlapping_room_allocations') {
        return new AppError(ERROR_CODES.ROOM_UNAVAILABLE, 'This room was just booked by someone else for these dates. Please choose another room.');
      }
      if (e.constraint === 'no_overlapping_tax_rules') {
        return new AppError(ERROR_CODES.CONFLICT, 'This tax rule overlaps an existing rule for the same dates and value range.');
      }
      if (e.constraint === 'no_overlapping_out_of_order') {
        return new AppError(ERROR_CODES.CONFLICT, 'This room is already out of order for part of these dates.');
      }
      return new AppError(ERROR_CODES.CONFLICT, 'This overlaps an existing record.');
    case '23505': // unique_violation
      if (e.constraint === 'reservations_ota_ref_unique') {
        return new AppError(ERROR_CODES.CONFLICT, 'A booking with this OTA reference already exists.');
      }
      if (e.constraint === 'rooms_property_id_number_key') {
        return new AppError(ERROR_CODES.CONFLICT, 'A room with this number already exists.');
      }
      if (e.constraint === 'room_types_property_id_code_key') {
        return new AppError(ERROR_CODES.CONFLICT, 'A room type with this code already exists.');
      }
      if (e.constraint === 'users_username_key' || e.constraint === 'users_mobile_key') {
        return new AppError(ERROR_CODES.CONFLICT, 'This username or mobile number is already used by another account.');
      }
      return new AppError(ERROR_CODES.CONFLICT, 'This record already exists.');
    case '23514': // check_violation (incl. status-machine trigger)
      if (e.message?.includes('reservation cannot move')) {
        return new AppError(ERROR_CODES.INVALID_TRANSITION, 'This booking cannot be changed to that status.');
      }
      return new AppError(ERROR_CODES.VALIDATION, 'Some values are not allowed. Please check the form.');
    case '23503': // foreign_key_violation
      return new AppError(ERROR_CODES.VALIDATION, 'A linked record does not exist or belongs to another property.');
    case '23000': // integrity_constraint_violation (protection triggers)
      return new AppError(ERROR_CODES.FORBIDDEN, 'This record is protected and cannot be changed this way.');
    default:
      return null;
  }
}
