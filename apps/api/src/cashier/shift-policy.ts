import { ERROR_CODES } from '@resortos/shared';
import { AppError } from '../common/errors';
import type { Queryable } from '../db/db.service';

/** Villa Sol records money in its account ledger without opening/closing cashier shifts. */
export async function paymentShift(
  q: Queryable,
  propertyId: string,
  userId: string,
  method: string,
): Promise<string | null> {
  const { rows } = await q.query<{ without_shifts: boolean; id: string | null }>(
    `SELECT p.booking_model='private_villa' AS without_shifts,
      (SELECT s.id FROM cashier_shifts s WHERE s.property_id=p.id AND s.opened_by=$2 AND s.closed_at IS NULL) AS id
      FROM properties p WHERE p.id=$1`,
    [propertyId, userId],
  );
  if (rows[0]?.without_shifts) return null;
  const id = rows[0]?.id ?? null;
  if (!id && method === 'cash')
    throw new AppError(
      ERROR_CODES.INVALID_TRANSITION,
      'Open your shift before taking or giving back cash — cash is counted when the shift closes.',
      { action: 'open_shift' },
    );
  return id;
}
