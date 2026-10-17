import type { Queryable } from '../src/db/db.service';
import { AuditService } from '../src/common/audit.service';
import { OutboxService } from '../src/common/outbox.service';

/** Add only physical room configuration. Historical Villa inventory and bookings are retained. */
export async function ensureVillaRooms(q: Queryable, propertyId: string, ownerId: string) {
  const { rows } = await q.query<{ id: string }>(
    `SELECT p.id FROM properties p
    JOIN property_owner_access a ON a.property_id=p.id AND a.user_id=$2 AND a.is_active
    JOIN users u ON u.id=a.user_id AND u.role='owner' AND u.is_active
    WHERE p.id=$1 AND p.booking_model='private_villa' AND p.name='Villa Sol by Voitto' FOR NO KEY UPDATE OF p`,
    [propertyId, ownerId],
  );
  if (!rows[0]) throw new Error('Villa Sol and its authorized owner must match.');
  const { rows: types } = await q.query<{ id: string }>(
    `SELECT id FROM room_types WHERE property_id=$1 AND is_active ORDER BY sort_order,id LIMIT 1`,
    [propertyId],
  );
  if (!types[0]) throw new Error('Villa pricing setup is missing.');
  const { rows: created } = await q.query<{ id: string; number: string }>(
    `INSERT INTO rooms(property_id,room_type_id,number,unit_type,created_by)
    SELECT $1,$2,n,'room',$3 FROM unnest(ARRAY['1','2']) n ON CONFLICT(property_id,number) DO NOTHING RETURNING id,number`,
    [propertyId, types[0].id, ownerId],
  );
  if (created.length) {
    await new AuditService().recordSystem(q, propertyId, {
      userId: ownerId,
      action: 'villa.rooms_configured',
      entityType: 'property',
      entityId: propertyId,
      after: { roomIds: created.map((r) => r.id) },
    });
    await new OutboxService().emit(q, propertyId, 'inventory.changed', {
      type: 'property',
      id: propertyId,
    });
  }
  return { created: created.map((r) => r.number).sort() };
}
