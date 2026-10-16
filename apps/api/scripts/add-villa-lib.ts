import type { Queryable } from '../src/db/db.service';
import { AuditService } from '../src/common/audit.service';
import { OutboxService } from '../src/common/outbox.service';
/** Called within a transaction by the controlled setup command or an isolated test. No operational rows are copied. */
export async function addVilla(q: Queryable, sourcePropertyId: string, ownerId: string, pinCode: string) {
  if (!/^[1-9]\d{5}$/.test(pinCode)) throw new Error('A valid Villa Sol PIN code is required.');
  await q.query(`SELECT pg_advisory_xact_lock(hashtext('resortos:villa-sol-provision'))`);
  const { rows: owner } = await q.query<{ id: string }>(
    `SELECT id FROM users WHERE id=$1 AND property_id=$2 AND role='owner' AND is_active`,
    [ownerId, sourcePropertyId],
  );
  if (!owner[0]) throw new Error('The source property owner must authorize this setup.');
  const { rows: existing } = await q.query<{ id: string }>(
    `SELECT p.id FROM properties p JOIN property_owner_access a ON a.property_id=p.id WHERE p.booking_model='private_villa' AND p.name='Villa Sol by Voitto' AND a.user_id=$1 AND a.is_active`,
    [ownerId],
  );
  if (existing[0]) return { propertyId: existing[0].id, created: false };
  const { rows } = await q.query<{ id: string }>(
    `INSERT INTO properties(name,legal_name,address_line1,city,state_code,pin_code,gstin,phone,email,
    check_in_time,check_out_time,current_business_date,data_origin,booking_model,reception_phone,email_enabled,email_from_name,email_from_address,email_reply_to,location_link)
    SELECT 'Villa Sol by Voitto',legal_name,'Kaithun','Kota',state_code,$2,gstin,'+919352204825','reception@voittoventures.com',
    '13:00','11:00',CASE WHEN data_origin='demo' THEN current_business_date ELSE (now() AT TIME ZONE 'Asia/Kolkata')::date END,data_origin,'private_villa','+919352204825',true,'Villa Sol by Voitto',
    'reception@voittoventures.com','reception@voittoventures.com','https://maps.google.com/?q=Villa+Sol+Kaithun+Kota'
    FROM properties WHERE id=$1 RETURNING id`,
    [sourcePropertyId, pinCode],
  );
  const id = rows[0]!.id;
  await q.query(
    `INSERT INTO property_owner_access(property_id,user_id) SELECT $1,id FROM users WHERE property_id=$2 AND role='owner' AND is_active`,
    [id, sourcePropertyId],
  );
  const { rows: types } = await q.query<{ id: string }>(
    `INSERT INTO room_types(property_id,code,name,base_occupancy,max_occupancy,base_rate,min_rate,extra_adult_rate,extra_child_rate,created_by)
    VALUES($1,'VILLA','Private villa',20,20,0,0,0,0,$2) RETURNING id`,
    [id, ownerId],
  );
  await q.query(
    `INSERT INTO rooms(property_id,room_type_id,number,unit_type,created_by) VALUES($1,$2,'Villa','villa',$3)`,
    [id, types[0]!.id, ownerId],
  );
  await q.query(
    `INSERT INTO meal_plans(property_id,code,name,adult_rate,child_rate) SELECT $1,code,name,adult_rate,child_rate FROM meal_plans WHERE property_id=$2`,
    [id, sourcePropertyId],
  );
  await q.query(
    `INSERT INTO tax_rules(property_id,tax_category,sac,rate_percent,unit_value_above,unit_value_up_to,effective_from,effective_to,origin,created_by)
    SELECT $1,tax_category,sac,rate_percent,unit_value_above,unit_value_up_to,effective_from,effective_to,origin,$3 FROM tax_rules WHERE property_id=$2`,
    [id, sourcePropertyId, ownerId],
  );
  await q.query(
    `INSERT INTO payment_accounts(property_id,name,kind,opening_balance,created_by) VALUES($1,'Villa Sol cash counter','cash',0,$2)`,
    [id, ownerId],
  );
  for (const key of ['booking_confirmation', 'check_in_welcome', 'checkout_reminder']) {
    const title =
      key === 'booking_confirmation'
        ? 'Booking confirmed'
        : key === 'check_in_welcome'
          ? 'Welcome to Villa Sol'
          : 'Your departure reminder';
    const body =
      title +
      '\n\nHello {{guest_name}},\n\nProperty: {{resort_name}}\nBooking: {{booking_number}}\nBooked for: {{booking_use}}\nGuests: {{guest_count}}\nFrom: {{booking_start}}\nUntil: {{booking_end}}\n\nAddress: Kaithun, Kota\nReception: {{reception_phone}}\nFind us: {{location_link}}\n\nThank you,\n{{resort_name}}';
    for (const language of ['en', 'hi'])
      await q.query(
        `INSERT INTO message_templates(property_id,template_key,channel,language,subject,body,updated_by)
      VALUES($1,$2,'email',$3,$4,$5,$6)`,
        [id, key, language, title + ' · {{resort_name}}', body, ownerId],
      );
  }
  await new AuditService().recordSystem(q, id, {
    userId: ownerId,
    action: 'property.villa_provisioned',
    entityType: 'property',
    entityId: id,
    after: { sourcePropertyId, ownerAccessOnly: true },
  });
  await new OutboxService().emit(
    q,
    id,
    'property.provisioned',
    { type: 'property', id },
    { sourcePropertyId },
  );
  return { propertyId: id, created: true };
}
