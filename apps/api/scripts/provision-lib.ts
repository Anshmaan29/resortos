import { Client } from 'pg';
import { z } from 'zod';
import { createUserSchema, passwordSchema, pinSchema, propertySettingsSchema, zIsoDate } from '@resortos/shared';
import { hashSecret, passwordProblem, pinProblem } from '../src/auth/password';
import { AuditService } from '../src/common/audit.service';
import { OutboxService } from '../src/common/outbox.service';

export const provisioningSchema = z.object({
  property: propertySettingsSchema,
  businessDate: zIsoDate,
  owner: createUserSchema.pick({ fullName: true, username: true, mobile: true }).extend({ email: z.string().trim().email() }),
});

/** Restricted operator command for an empty, migrated database; no demo seed or pricing. */
export async function provisionFirstOwner(databaseUrl: string, configuration: unknown, password: string, pin: string) {
  const input = provisioningSchema.parse(configuration);
  passwordSchema.parse(password); pinSchema.parse(pin);
  const problem = passwordProblem(password, input.owner) ?? pinProblem(pin);
  if (problem) throw new Error(problem);
  if (input.property.gstin && input.property.gstin.slice(0, 2) !== input.property.stateCode) throw new Error('GSTIN state must match the property state.');
  const [passwordHash, pinHash] = await Promise.all([hashSecret(password), hashSecret(pin)]);
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('resortos:first_property'))`);
    const existing = await client.query<{ n: string }>('SELECT count(*) AS n FROM properties');
    if (Number(existing.rows[0]!.n)) throw new Error('Provisioning requires an empty database. Manage an existing property through Settings.');
    const p = input.property;
    const property = await client.query<{ id: string }>(
      `INSERT INTO properties (name,legal_name,address_line1,address_line2,city,state_code,pin_code,gstin,phone,email,check_in_time,check_out_time,current_business_date,data_origin,is_practice)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'live',false) RETURNING id`,
      [p.name,p.legalName,p.addressLine1,p.addressLine2 ?? null,p.city,p.stateCode,p.pinCode,p.gstin ?? null,p.phone,p.email ?? null,p.checkInTime,p.checkOutTime,input.businessDate],
    );
    const propertyId = property.rows[0]!.id;
    const owner = await client.query<{ id: string }>(
      `INSERT INTO users (property_id,full_name,username,mobile,email,role,password_hash,owner_pin_hash,must_change_password,is_demo)
       VALUES ($1,$2,$3,$4,$5,'owner',$6,$7,false,false) RETURNING id`,
      [propertyId,input.owner.fullName,input.owner.username,input.owner.mobile ?? null,input.owner.email,passwordHash,pinHash],
    );
    const ownerId = owner.rows[0]!.id;
    await new AuditService().recordSystem(client, propertyId, { userId: ownerId, action: 'property.provisioned', entityType: 'property', entityId: propertyId, after: { ownerId, businessDate: input.businessDate, dataOrigin: 'live' } });
    await new OutboxService().emit(client,propertyId,'property.provisioned',{type:'property',id:propertyId},{ownerId});
    await client.query('COMMIT');
    return { propertyId, ownerId, username: input.owner.username };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { await client.end(); }
}
