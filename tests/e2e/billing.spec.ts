import { expect, test, type Page } from '@playwright/test';
import { Client } from 'pg';

const DB = 'postgres://resortos_migrator:migrator_dev_password@localhost:5433/resortos_test';

async function loginAs(page: Page, username: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Username or phone number').fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await page.waitForURL('/');
}

/**
 * The seeded in-house bookings predate stay rows, so the stay for room C1 is created here the same
 * way the API suites create theirs: a confirmed draft and a stay for the booking already in the room.
 */
async function stayInRoom(number: string): Promise<string> {
  const c = new Client({ connectionString: DB });
  await c.connect();
  try {
    const { rows: res } = await c.query<{ reservation_id: string }>(
      `SELECT rr.reservation_id FROM reservation_rooms rr JOIN rooms r ON r.id = rr.room_id
        WHERE r.number = $1 AND rr.status = 'checked_in'`, [number],
    );
    const reservationId = res[0]!.reservation_id;
    const { rows: draft } = await c.query<{ id: string }>(
      `INSERT INTO check_in_drafts (property_id, reservation_id, reservation_room_ids, status, confirmed_at, created_by)
       SELECT r.property_id, r.id, array_agg(rr.id), 'confirmed', now(), r.created_by
         FROM reservations r JOIN reservation_rooms rr ON rr.reservation_id = r.id
        WHERE r.id = $1 GROUP BY r.property_id, r.id, r.created_by RETURNING id`, [reservationId],
    );
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO stays (property_id, reservation_id, reservation_room_id, room_id, primary_guest_id, check_in_draft_id,
                          business_date_in, expected_departure, checked_in_by)
       SELECT rr.property_id, rr.reservation_id, rr.id, rr.room_id, r.primary_guest_id, $2, rr.arrival, rr.departure, r.created_by
         FROM reservation_rooms rr JOIN reservations r ON r.id = rr.reservation_id WHERE rr.reservation_id = $1 RETURNING id`,
      [reservationId, draft[0]!.id],
    );
    return rows[0]!.id;
  } finally {
    await c.end();
  }
}

/**
 * Phase 2's exit criterion (docs/PHASES.md): a stay with food and an activity, paid by a card and
 * UPI split, checked out with a GST invoice — through the screens the desk actually uses.
 */
test('a stay with food and an activity, paid card + UPI, checks out with a tax invoice', async ({ page }) => {
  await loginAs(page, 'priya', 'Aravali#Desk26');

  // Every payment belongs to a shift (spec §34).
  await page.goto('/shifts');
  await page.getByLabel('Cash in the drawer now').fill('500');
  await page.getByRole('button', { name: 'Open shift' }).click();
  await expect(page.getByText('Shift opened')).toBeVisible();

  const stayId = await stayInRoom('C1');
  await page.goto(`/stays/${stayId}`);

  const addCharge = async (type: string, name: string, quantity: string, rate: string) => {
    await page.getByRole('button', { name: 'Add charge' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add charge' });
    await dialog.getByLabel('Type').selectOption({ label: type });
    await dialog.getByLabel('What it is for').fill(name);
    await dialog.getByLabel('Quantity').fill(quantity);
    await dialog.getByLabel('Rate').fill(rate);
    await dialog.getByRole('button', { name: /Add .* to bill/ }).click();
    await expect(page.getByText(`${name} added to the bill`)).toBeVisible();
  };
  await addCharge('Food', 'Paneer Tikka', '2', '280');
  await addCharge('Activity', 'Jeep Safari', '2', '1500');

  // ₹560 food at 5% and ₹3,000 activity at 18% (demo rates): ₹588 + ₹3,540 = ₹4,128.
  await expect(page.getByRole('definition').filter({ hasText: '₹4,128' })).toBeVisible();

  const pay = async (method: string, account: string, amount: string, shown: string, reference: string) => {
    await page.getByRole('button', { name: 'Record payment' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Record a payment' });
    await dialog.getByLabel('How was it paid').selectOption({ label: method });
    await dialog.getByLabel('Where did it go').selectOption({ label: account });
    await dialog.getByLabel('Amount').fill(amount);
    await dialog.getByLabel(/Approval code|UTR/).fill(reference);
    await dialog.getByRole('button', { name: /^Record ₹/ }).click();
    // By amount: the previous payment's toast can still be on screen.
    await expect(page.getByText(`Payment of ${shown} recorded`)).toBeVisible();
  };
  await pay('Card (POS machine)', 'Card machine (POS)', '2000', '₹2,000', '4417');
  await pay('UPI', 'UPI QR at desk', '2128', '₹2,128', 'UTR-771203');

  await expect(page.getByRole('definition').filter({ hasText: /^₹0$/ })).toBeVisible();

  await page.getByRole('button', { name: 'Check out' }).click();
  const checkout = page.getByRole('dialog', { name: 'Check out room C1?' });
  await expect(checkout.getByText('Tax invoice to be issued')).toBeVisible();
  await expect(checkout.getByText('Nothing is blocking this checkout.')).toBeVisible();
  await checkout.getByRole('button', { name: 'Issue invoice and check out' }).click();

  // The invoice is on the bill, numbered, with a printable PDF.
  const invoiceLink = page.getByRole('link', { name: /INV\/26-27\/\d{5}/ });
  await expect(invoiceLink).toBeVisible();
  await invoiceLink.click();
  await expect(page.getByRole('heading', { name: /Tax invoice INV\/26-27\/\d{5}/ })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Jeep Safari' })).toBeVisible();

  const invoiceId = page.url().split('/').pop()!;
  const pdf = await page.request.get(`/api/v1/invoices/${invoiceId}/pdf`);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()['content-type']).toBe('application/pdf');
  expect((await pdf.body()).subarray(0, 5).toString()).toBe('%PDF-');
});
