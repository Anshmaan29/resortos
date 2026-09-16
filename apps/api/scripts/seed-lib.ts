import { Client } from 'pg';
import { addDays, eachNight, gstinCheckChar, todayIn } from '@resortos/shared';
import { hashSecret } from '../src/auth/password';

export const DEMO_CREDENTIALS = {
  owner: { username: 'owner', password: 'Aravali#Hills26', pin: '482916', recoveryCodes: ['DEMO-AAAA-2222', 'DEMO-BBBB-3333', 'DEMO-CCCC-4444'] },
  receptionist: { username: 'priya', password: 'Aravali#Desk26' },
};

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', 'postgres']);

/**
 * Demo data (known passwords and Owner PIN) may only ever be loaded into a local development
 * or test database. Throws otherwise. The production API additionally refuses to boot if any
 * demo data is present (src/safety/production-guard.ts).
 */
export function assertSeedAllowed(connectionString: string, env: NodeJS.ProcessEnv = process.env) {
  if (env.NODE_ENV === 'production') throw new Error('Demo seed is forbidden when NODE_ENV=production');
  if (!['development', 'test'].includes(env.RESORTOS_ENV ?? '')) {
    throw new Error('Demo seed requires RESORTOS_ENV=development or RESORTOS_ENV=test');
  }
  const host = new URL(connectionString).hostname;
  if (!LOCAL_HOSTS.has(host)) throw new Error(`Demo seed is only allowed on a local database, not "${host}"`);
}

/** Fake demo data only — never real guests (spec §77.1). Idempotent: skips if a property exists. */
export async function seed(connectionString: string, opts: { businessDate?: string; log?: (m: string) => void; withBookings?: boolean } = {}) {
  assertSeedAllowed(connectionString);
  const log = opts.log ?? console.log;
  const today = opts.businessDate ?? todayIn();
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const { rows: existing } = await client.query(`SELECT id FROM properties LIMIT 1`);
    if (existing[0]) {
      log('• property already exists — seed skipped');
      return { propertyId: existing[0].id as string };
    }
    await client.query('BEGIN');
    const gstBody = '08AAKCA1234R1Z';
    const { rows: p } = await client.query(
      `INSERT INTO properties (name, legal_name, address_line1, city, state_code, pin_code, gstin, phone, email, check_in_time, check_out_time, current_business_date, data_origin)
       VALUES ('Aravali Hills Resort', 'Aravali Hills Hospitality Pvt Ltd', 'Kumbhalgarh Road, Village Kelwara', 'Rajsamand', '08', '313325',
               $1, '+919829012345', 'stay@aravalihills.example', '12:00', '11:00', $2, 'demo') RETURNING id`,
      [gstBody + gstinCheckChar(gstBody), today],
    );
    const propertyId = p[0].id as string;

    const ownerHash = await hashSecret(DEMO_CREDENTIALS.owner.password);
    const pinHash = await hashSecret(DEMO_CREDENTIALS.owner.pin);
    const { rows: owner } = await client.query(
      `INSERT INTO users (property_id, full_name, username, mobile, role, password_hash, must_change_password, owner_pin_hash, can_run_night_audit, is_demo)
       VALUES ($1, 'Vikram Rathore', $2, '+919829000001', 'owner', $3, false, $4, true, true) RETURNING id`,
      [propertyId, DEMO_CREDENTIALS.owner.username, ownerHash, pinHash],
    );
    const ownerId = owner[0].id as string;
    for (const code of DEMO_CREDENTIALS.owner.recoveryCodes) {
      await client.query(`INSERT INTO recovery_codes (user_id, code_hash) VALUES ($1, $2)`, [ownerId, await hashSecret(code.replace(/-/g, ''))]);
    }
    await client.query(
      `INSERT INTO users (property_id, full_name, username, mobile, role, password_hash, must_change_password, discount_limit_percent, created_by, is_demo)
       VALUES ($1, 'Priya Sharma', $2, '+919829000002', 'receptionist', $3, false, 10, $4, true)`,
      [propertyId, DEMO_CREDENTIALS.receptionist.username, await hashSecret(DEMO_CREDENTIALS.receptionist.password), ownerId],
    );

    const types = [
      { code: 'STD', name: 'Standard', base: 2, max: 3, rate: '3200.00', min: '2600.00', ea: '800.00', ec: '500.00', rooms: ['101', '102', '103', '104'] },
      { code: 'DLX', name: 'Deluxe', base: 2, max: 3, rate: '4000.00', min: '3200.00', ea: '1000.00', ec: '600.00', rooms: ['201', '202', '203', '204', '205'] },
      { code: 'PCOT', name: 'Premium Cottage', base: 2, max: 4, rate: '6500.00', min: '5200.00', ea: '1200.00', ec: '800.00', rooms: ['C1', 'C2', 'C3'] },
      { code: 'VILLA', name: 'Pool Villa', base: 4, max: 6, rate: '12500.00', min: '10000.00', ea: '1500.00', ec: '1000.00', rooms: ['V1', 'V2'] },
    ];
    const roomTypeIds: Record<string, string> = {};
    const roomIds: Record<string, string> = {};
    for (const [i, t] of types.entries()) {
      const { rows } = await client.query(
        `INSERT INTO room_types (property_id, code, name, base_occupancy, max_occupancy, base_rate, min_rate, extra_adult_rate, extra_child_rate, sort_order, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [propertyId, t.code, t.name, t.base, t.max, t.rate, t.min, t.ea, t.ec, i, ownerId],
      );
      roomTypeIds[t.code] = rows[0].id;
      for (const [j, number] of t.rooms.entries()) {
        const unit = t.code === 'PCOT' ? 'cottage' : t.code === 'VILLA' ? 'villa' : 'room';
        const view = t.code === 'VILLA' ? 'pool' : t.code === 'PCOT' ? 'hill' : j % 2 ? 'garden' : 'pool';
        const floor = /^\d/.test(number) ? number[0] : null;
        const { rows: r } = await client.query(
          `INSERT INTO rooms (property_id, room_type_id, number, unit_type, view, building, floor, sort_order, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [propertyId, rows[0].id, number, unit, view, unit === 'room' ? 'Main block' : 'Cottages', floor, j, ownerId],
        );
        roomIds[number] = r[0].id;
      }
    }

    await client.query(
      `INSERT INTO meal_plans (property_id, code, name, adult_rate, child_rate) VALUES
         ($1,'EP','Room only',0,0), ($1,'CP','Room + breakfast',400,250), ($1,'MAP','Breakfast + one main meal',900,550), ($1,'AP','All meals',1400,800)`,
      [propertyId],
    );
    const { rows: rp } = await client.query(
      `INSERT INTO rate_plans (property_id, code, name, kind, is_default) VALUES ($1, 'BAR', 'Best available rate', 'standard', true) RETURNING id`,
      [propertyId],
    );
    const weekendRates: Record<string, string> = { STD: '3800.00', DLX: '4800.00', PCOT: '7800.00', VILLA: '14500.00' };
    for (const [code, rate] of Object.entries(weekendRates)) {
      await client.query(
        `INSERT INTO rate_calendar (property_id, rate_plan_id, room_type_id, label, start_date, end_date, days_of_week, rate, priority, created_by)
         VALUES ($1,$2,$3,'Weekend',$4,$5,'{5,6}',$6,10,$7)`,
        [propertyId, rp[0].id, roomTypeIds[code], addDays(today, -30), addDays(today, 365), rate, ownerId],
      );
    }

    // Illustrative GST configuration — MUST be confirmed by the resort's CA before go-live (spec §30).
    await client.query(
      `INSERT INTO tax_rules (property_id, tax_category, unit_value_above, unit_value_up_to, rate_percent, sac, effective_from, note, origin) VALUES
         ($1,'accommodation',NULL,7500.00,5.00,'996311','2025-09-22','Room value up to ₹7,500 per room per night — confirm with CA','demo_placeholder'),
         ($1,'accommodation',7500.00,NULL,18.00,'996311','2025-09-22','Room value above ₹7,500 per room per night — confirm with CA','demo_placeholder'),
         ($1,'food',NULL,NULL,5.00,'996331','2025-09-22','Food at resort — property-level setting, confirm with CA','demo_placeholder'),
         ($1,'activity',NULL,NULL,18.00,'999692','2025-09-22','Illustrative — confirm SAC and rate with CA','demo_placeholder'),
         ($1,'laundry',NULL,NULL,18.00,'999712','2025-09-22','Illustrative — confirm with CA','demo_placeholder'),
         ($1,'transport',NULL,NULL,18.00,'996601','2025-09-22','Illustrative — confirm with CA','demo_placeholder'),
         ($1,'other',NULL,NULL,18.00,'999799','2025-09-22','Illustrative — confirm with CA','demo_placeholder')`,
      [propertyId],
    );
    await client.query(`INSERT INTO settings (property_id, key, value) VALUES ($1, 'child_policy', '{"freeBelowAge":6,"childMaxAge":12}')`, [propertyId]);

    if (opts.withBookings !== false) {
      const guests = [
        ['Rahul', 'Sharma', '+919876543210', 'Jaipur'], ['Amit', 'Kulkarni', '+919820011223', 'Pune'],
        ['Neha', 'Verma', '+919811122334', 'Delhi'], ['Sanjay', 'Mehta', '+919825544332', 'Ahmedabad'],
        ['Ananya', 'Iyer', '+919840012345', 'Chennai'], ['Karan', 'Singh', '+919814077889', 'Chandigarh'],
      ] as const;
      const guestIds: string[] = [];
      for (const g of guests) {
        const { rows } = await client.query(
          `INSERT INTO guests (property_id, first_name, last_name, mobile, city, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [propertyId, g[0], g[1], g[2], g[3], ownerId],
        );
        guestIds.push(rows[0].id);
      }
      await client.query(`UPDATE guests SET is_vip = true, special_note = 'Anniversary — arrange cake' WHERE id = $1`, [guestIds[2]]);

      const bookings: { guest: number; room: string; type: string; from: number; nights: number; status: 'confirmed' | 'checked_in' | 'tentative'; source: string; ota?: string; adults: number }[] = [
        { guest: 0, room: '204', type: 'DLX', from: 0, nights: 2, status: 'confirmed', source: 'phone', adults: 2 },
        { guest: 1, room: '102', type: 'STD', from: -2, nights: 2, status: 'checked_in', source: 'walk_in', adults: 2 },
        { guest: 2, room: 'C1', type: 'PCOT', from: -1, nights: 3, status: 'checked_in', source: 'direct', adults: 2 },
        { guest: 3, room: '201', type: 'DLX', from: 1, nights: 3, status: 'confirmed', source: 'booking_com', ota: '4471829301', adults: 2 },
        { guest: 4, room: 'V1', type: 'VILLA', from: 3, nights: 2, status: 'tentative', source: 'whatsapp', adults: 4 },
        { guest: 5, room: '101', type: 'STD', from: -1, nights: 4, status: 'checked_in', source: 'makemytrip', ota: 'NH71029384', adults: 1 },
      ];
      let n = 0;
      for (const b of bookings) {
        n += 1;
        const arrival = addDays(today, b.from);
        const departure = addDays(arrival, b.nights);
        const typeRate = types.find((t) => t.code === b.type)!.rate;
        const { rows: res } = await client.query(
          `INSERT INTO reservations (property_id, number, primary_guest_id, source, ota_reference, arrival, departure, status, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [propertyId, `BK-${String(n).padStart(6, '0')}`, guestIds[b.guest], b.source, b.ota ?? null, arrival, departure, b.status, ownerId],
        );
        const rrStatus = b.status === 'checked_in' ? 'checked_in' : 'reserved';
        const { rows: rr } = await client.query(
          `INSERT INTO reservation_rooms (property_id, reservation_id, room_type_id, room_id, arrival, departure, adults, meal_plan, nightly_rate, status, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'CP',$8,$9,$10) RETURNING id`,
          [propertyId, res[0].id, roomTypeIds[b.type], roomIds[b.room], arrival, departure, b.adults, typeRate, rrStatus, ownerId],
        );
        for (const night of eachNight(arrival, departure)) {
          await client.query(
            `INSERT INTO reservation_room_nights (reservation_room_id, night_date, property_id, room_rate, meal_amount, rate_source)
             VALUES ($1,$2,$3,$4,$5,'base')`,
            [rr[0].id, night, propertyId, typeRate, String(400 * b.adults)],
          );
        }
        await client.query(
          `INSERT INTO room_allocations (property_id, reservation_room_id, room_id, start_date, end_date, status, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [propertyId, rr[0].id, roomIds[b.room], arrival, departure, rrStatus, ownerId],
        );
      }
      await client.query(`INSERT INTO reference_counters (property_id, name, last_number) VALUES ($1, 'reservation', $2)`, [propertyId, n]);
      // A realistic room board
      await client.query(`UPDATE rooms SET housekeeping_status = 'dirty' WHERE number IN ('102', '203')`);
      await client.query(`UPDATE rooms SET housekeeping_status = 'cleaning' WHERE number = '103'`);
      await client.query(`UPDATE rooms SET housekeeping_status = 'inspected' WHERE number IN ('204', 'C2')`);
      await client.query(`UPDATE rooms SET service_status = 'out_of_order' WHERE number = '104'`);
      await client.query(
        `INSERT INTO room_out_of_order (property_id, room_id, start_date, end_date, reason, created_by) VALUES ($1,$2,$3,$4,'AC compressor replacement',$5)`,
        [propertyId, roomIds['104'], today, addDays(today, 3), ownerId],
      );
    }

    await client.query('COMMIT');
    log(`✓ seeded demo property ${propertyId} (business date ${today})`);
    return { propertyId };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
}
