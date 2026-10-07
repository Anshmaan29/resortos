import { Client } from 'pg';
import { addDays, DEFAULT_EXPENSE_CATEGORIES, eachNight, gstinCheckChar, todayIn } from '@resortos/shared';
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
/**
 * `demoStays` (the development seed only): the bookings already in house also get their check-in and
 * stay rows, and the demo guests get example email addresses, so a fresh demo can open a bill, take
 * a payment and show a message straight away. Tests leave it off: their fixtures assert exact counts.
 */
export async function seed(connectionString: string, opts: { businessDate?: string; log?: (m: string) => void; withBookings?: boolean; demoStays?: boolean } = {}) {
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

    // The hotel's own price list (single occupancy = base rate at base_occupancy 1, double = base +
    // extra adult; the booking quote shows both from these two numbers). Min rates are the discount
    // floor the owner sets in settings — 80% of single here, editable.
    const types = [
      { code: 'EXE', name: 'Executive', base: 1, max: 2, rate: '4000.00', min: '3200.00', ea: '1000.00', ec: '1000.00', rooms: ['101', '107'] },
      { code: 'PRE', name: 'Premium', base: 1, max: 3, rate: '2500.00', min: '2000.00', ea: '500.00', ec: '600.00', rooms: ['102', '104', '106', '108', '204', '206', '208', '209', '210'] },
      { code: 'DLX', name: 'Delux', base: 1, max: 3, rate: '2000.00', min: '1600.00', ea: '500.00', ec: '500.00', rooms: ['103', '105', '201', '202', '203', '205', '207'] },
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
        const floor = number[0]!;
        const { rows: r } = await client.query(
          `INSERT INTO rooms (property_id, room_type_id, number, unit_type, building, floor, sort_order, created_by)
           VALUES ($1,$2,$3,'room','Main block',$4,$5,$6) RETURNING id`,
          [propertyId, rows[0].id, number, floor, j, ownerId],
        );
        roomIds[number] = r[0].id;
      }
    }

    await client.query(
      `INSERT INTO meal_plans (property_id, code, name, adult_rate, child_rate) VALUES
         ($1,'EP','Room only',0,0), ($1,'CP','Room + breakfast',400,250), ($1,'MAP','Breakfast + one main meal',900,550), ($1,'AP','All meals',1400,800)`,
      [propertyId],
    );
    await client.query(
      `INSERT INTO rate_plans (property_id, code, name, kind, is_default) VALUES ($1, 'BAR', 'Best available rate', 'standard', true)`,
      [propertyId],
    );
    // No rate-calendar rows: the price list is flat, and the owner adds seasons/weekends in settings.

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

    // Where money lands (spec §25.1) and the desk's quick-pick charges (§24.2), so a fresh demo can
    // take a payment and add dinner without a trip to settings first.
    await client.query(
      `INSERT INTO payment_accounts (property_id, name, kind, bank_name, account_last4, upi_handle, pos_terminal, sort_order, created_by) VALUES
         ($1,'Front desk cash','cash',NULL,NULL,NULL,NULL,1,$2),
         ($1,'UPI QR at desk','upi',NULL,NULL,'aravalihills@okbank',NULL,2,$2),
         ($1,'Card machine (POS)','card_pos',NULL,NULL,NULL,'POS-01',3,$2),
         ($1,'Current account','bank','Demo Bank','4821',NULL,NULL,4,$2)`,
      [propertyId, ownerId],
    );
    await client.query(
      `INSERT INTO companies (property_id, name, billing_address, contact_person, credit_limit, payment_terms_days, created_by)
       VALUES ($1,'Demo Corporate Travels','Tonk Road, Jaipur','Accounts desk',50000,30,$2)`,
      [propertyId, ownerId],
    );
    // The expense categories every property starts with (spec §39); the owner edits them in settings.
    await client.query(
      `INSERT INTO expense_categories (property_id, name, sort_order)
       SELECT $1, name, ord FROM unnest($2::text[]) WITH ORDINALITY AS c(name, ord)`,
      [propertyId, [...DEFAULT_EXPENSE_CATEGORIES]],
    );
    await client.query(
      `INSERT INTO charge_items (property_id, name, line_type, default_rate, tax_category, sort_order, created_by) VALUES
         ($1,'Paneer Tikka','food',280.00,'food',1,$2),
         ($1,'Masala Chai','beverage',60.00,'food',2,$2),
         ($1,'Bonfire','activity',800.00,'activity',3,$2),
         ($1,'Laundry (per piece)','laundry',60.00,'laundry',4,$2)`,
      [propertyId, ownerId],
    );

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

      // Demo bookings sit on rooms the API/e2e suites never check into (101, 105, 201, 204, 207, 210),
      // so their fixtures always find the rooms they book free.
      const bookings: { guest: number; room: string; type: string; from: number; nights: number; status: 'confirmed' | 'checked_in' | 'tentative'; source: string; ota?: string; adults: number }[] = [
        { guest: 0, room: '204', type: 'PRE', from: 0, nights: 2, status: 'confirmed', source: 'phone', adults: 2 },
        { guest: 1, room: '105', type: 'PRE', from: -2, nights: 2, status: 'checked_in', source: 'walk_in', adults: 2 },
        { guest: 2, room: '201', type: 'DLX', from: -1, nights: 3, status: 'checked_in', source: 'direct', adults: 2 },
        { guest: 3, room: '207', type: 'DLX', from: 1, nights: 3, status: 'confirmed', source: 'booking_com', ota: '4471829301', adults: 2 },
        { guest: 4, room: '210', type: 'PRE', from: 3, nights: 2, status: 'tentative', source: 'whatsapp', adults: 2 },
        { guest: 5, room: '101', type: 'EXE', from: -1, nights: 4, status: 'checked_in', source: 'makemytrip', ota: 'NH71029384', adults: 1 },
      ];
      let n = 0;
      for (const b of bookings) {
        n += 1;
        const arrival = addDays(today, b.from);
        const departure = addDays(arrival, b.nights);
        const t = types.find((x) => x.code === b.type)!;
        const extraAdultNights = (b.adults - t.base) * Number(t.ea);
        const { rows: res } = await client.query(
          `INSERT INTO reservations (property_id, number, primary_guest_id, source, ota_reference, arrival, departure, status, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [propertyId, `BK-${String(n).padStart(6, '0')}`, guestIds[b.guest], b.source, b.ota ?? null, arrival, departure, b.status, ownerId],
        );
        const rrStatus = b.status === 'checked_in' ? 'checked_in' : 'reserved';
        const { rows: rr } = await client.query(
          `INSERT INTO reservation_rooms (property_id, reservation_id, room_type_id, room_id, arrival, departure, adults, meal_plan, nightly_rate, status, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'CP',$8,$9,$10) RETURNING id`,
          [propertyId, res[0].id, roomTypeIds[b.type], roomIds[b.room], arrival, departure, b.adults, t.rate, rrStatus, ownerId],
        );
        for (const night of eachNight(arrival, departure)) {
          await client.query(
            `INSERT INTO reservation_room_nights (reservation_room_id, night_date, property_id, room_rate, extra_person_amount, meal_amount, rate_source)
             VALUES ($1,$2,$3,$4,$5,$6,'base')`,
            [rr[0].id, night, propertyId, t.rate, String(extraAdultNights), String(400 * b.adults)],
          );
        }
        await client.query(
          `INSERT INTO room_allocations (property_id, reservation_room_id, room_id, start_date, end_date, status, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [propertyId, rr[0].id, roomIds[b.room], arrival, departure, rrStatus, ownerId],
        );
        if (opts.demoStays && b.status === 'checked_in') {
          const { rows: draft } = await client.query(
            `INSERT INTO check_in_drafts (property_id, reservation_id, reservation_room_ids, status, confirmed_at, created_by)
             VALUES ($1,$2,$3,'confirmed',now(),$4) RETURNING id`,
            [propertyId, res[0].id, [rr[0].id], ownerId],
          );
          await client.query(
            `INSERT INTO stays (property_id, reservation_id, reservation_room_id, room_id, primary_guest_id, check_in_draft_id,
                                business_date_in, expected_departure, checked_in_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [propertyId, res[0].id, rr[0].id, roomIds[b.room], guestIds[b.guest], draft[0].id, arrival, departure, ownerId],
          );
        }
      }
      if (opts.demoStays) {
        await client.query(
          `UPDATE guests SET email = lower(first_name || '.' || last_name) || '@example.com' WHERE property_id = $1`, [propertyId],
        );
      }
      await client.query(`INSERT INTO reference_counters (property_id, name, last_number) VALUES ($1, 'reservation', $2)`, [propertyId, n]);
      // A realistic room board. The dirty/cleaning rooms are the demo guests' own (a task with an
      // open status would otherwise sit on a room the test fixtures pick as their first free room,
      // and swallow the checkout task they assert on).
      await client.query(`UPDATE rooms SET housekeeping_status = 'dirty' WHERE number IN ('105', '201')`);
      await client.query(`UPDATE rooms SET housekeeping_status = 'cleaning' WHERE number = '101'`);
      await client.query(`UPDATE rooms SET housekeeping_status = 'inspected' WHERE number = '204'`);
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
