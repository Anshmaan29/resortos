import { devices, expect, test, type Page } from '@playwright/test';

async function login(page: Page, username = 'priya', password = 'Aravali#Desk26') {
  await page.goto('/login');
  await page.getByLabel('Username or phone number').fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await page.waitForURL('/');
}

/** Draws a slightly rotated "ID card" on a dark table so edge detection has something real to find. */
async function syntheticCard(page: Page, label: string): Promise<Buffer> {
  const dataUrl = await page.evaluate((text) => {
    const c = document.createElement('canvas');
    c.width = 1600; c.height = 1100;
    const g = c.getContext('2d')!;
    g.fillStyle = '#3b2f2a'; g.fillRect(0, 0, c.width, c.height);
    g.save(); g.translate(800, 550); g.rotate(-0.05);
    g.fillStyle = '#f4f1e8'; g.fillRect(-560, -350, 1120, 700);
    g.fillStyle = '#1d4e89'; g.fillRect(-560, -350, 1120, 110);
    g.fillStyle = '#222'; g.font = 'bold 54px sans-serif'; g.fillText(text, -500, -180);
    g.font = '40px monospace';
    for (let i = 0; i < 6; i++) g.fillText(`LINE ${i} ${Math.random().toString(36).slice(2, 14).toUpperCase()}`, -500, -90 + i * 60);
    g.fillText('1234 5678 9012', -150, 290);
    g.restore();
    return c.toDataURL('image/jpeg', 0.92);
  }, label);
  return Buffer.from(dataUrl.split(',')[1]!, 'base64');
}

async function useEditor(page: Page, { aadhaar = false, crop = true } = {}) {
  const dialog = page.getByRole('dialog').last();
  if (crop) {
    await expect(dialog.getByText(/Edges found|Drag the four corners|Finding the document edges/)).toBeVisible({ timeout: 20_000 });
    await dialog.getByRole('button', { name: 'Crop' }).click();
  }
  if (aadhaar) {
    await expect(dialog.getByText(/cover the first 8 digits/i)).toBeVisible();
    const cont = dialog.getByRole('button', { name: 'Continue' });
    await expect(cont).toBeDisabled();
    await dialog.getByLabel(/first 8 digits are fully covered/).check();
    await cont.click();
  }
  await dialog.getByRole('button', { name: 'Use photo' }).click();
  await expect(dialog).toBeHidden();
}

test('the whole stay: desk check-in with phone scanner, registration card, room change and checkout', async ({ page, browser }) => {
  test.setTimeout(180_000);
  await login(page);

  // A booking arriving today in room 205 (owner creates it through the API).
  const ownerCtx = await browser.newContext();
  const owner = ownerCtx.request;
  await owner.post('/api/v1/auth/login', { headers: { 'x-resortos': '1' }, data: { login: 'owner', password: 'Aravali#Hills26' } });
  const types = await (await owner.get('/api/v1/room-types')).json();
  const rooms = await (await owner.get('/api/v1/rooms')).json();
  const booking = await owner.post('/api/v1/reservations', {
    headers: { 'x-resortos': '1', 'idempotency-key': `e2e-${Date.now()}-checkin` },
    data: {
      guest: { firstName: 'Ishaan', lastName: 'Malhotra', mobile: '9829077123' }, source: 'phone', arrival: '2026-09-16', departure: '2026-09-18',
      rooms: [{ roomTypeId: types.find((t: any) => t.code === 'DLX').id, roomId: rooms.find((r: any) => r.number === '205').id, adults: 2, mealPlan: 'CP' }],
    },
  });
  expect(booking.status()).toBe(201);
  const reservation = await booking.json();
  await ownerCtx.close();

  await page.goto(`/reservations/${reservation.id}`);
  await expect(page.getByText('Ready for check-in')).toBeVisible();
  await page.getByRole('button', { name: 'Check in' }).click();
  await page.waitForURL(/\/check-in\//);

  // Step 1 — guests
  await expect(page.getByLabel('Adult 1 name')).toHaveValue('Ishaan Malhotra');
  await page.getByLabel('Adult 2 name').fill('Riya Malhotra');
  await expect(page.getByText('Saved')).toBeVisible({ timeout: 10_000 });
  await page.getByRole('button', { name: 'Next' }).click();

  // Step 2 — room already assigned
  await expect(page.getByLabel('Room')).toHaveValue(rooms.find((r: any) => r.number === '205').id);
  await page.getByRole('button', { name: 'Next' }).click();

  // Draft survives a refresh
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Check in · Ishaan Malhotra' })).toBeVisible();
  await expect(page.getByText('Ishaan Malhotra').first()).toBeVisible();

  // Step 3 — desk uploads for the primary guest
  const ishaan = page.locator('div.rounded-lg').filter({ has: page.getByRole('heading', { name: 'Ishaan Malhotra' }) }).first();
  await ishaan.getByLabel('ID type').selectOption('driving_licence');
  await ishaan.getByLabel('Last 4 characters of the ID').fill('9012');
  const card = await syntheticCard(page, 'DRIVING LICENCE');
  await ishaan.getByTestId('file-input-id_front').setInputFiles({ name: 'dl-front.jpg', mimeType: 'image/jpeg', buffer: card });
  await useEditor(page);
  await ishaan.getByTestId('file-input-id_back').setInputFiles({ name: 'dl-back.jpg', mimeType: 'image/jpeg', buffer: await syntheticCard(page, 'BACK') });
  await useEditor(page);
  await ishaan.getByTestId('file-input-guest_photo').setInputFiles({ name: 'photo.jpg', mimeType: 'image/jpeg', buffer: await syntheticCard(page, 'PHOTO') });
  await useEditor(page, { crop: false });
  await expect(ishaan.getByRole('status').filter({ hasText: 'Received' })).toHaveCount(3, { timeout: 30_000 });

  // Phone scanner for the second guest
  const riya = page.locator('div.rounded-lg').filter({ has: page.getByRole('heading', { name: 'Riya Malhotra' }) }).first();
  await riya.getByLabel('Last 4 characters of the ID').fill('4455');
  const sessionResponse = page.waitForResponse((r) => r.url().includes('/capture-sessions') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Show QR code' }).click();
  const { captureUrl } = await (await sessionResponse).json();
  await expect(page.getByAltText('QR code for the phone scanner')).toBeVisible();
  if (process.env.E2E_SCREENSHOTS) await page.screenshot({ path: `${process.env.E2E_SCREENSHOTS}/desk-documents.png`, fullPage: true });

  const phoneCtx = await browser.newContext({ ...devices['Pixel 7'], locale: 'en-IN' });
  const phone = await phoneCtx.newPage();
  await phone.goto(new URL(captureUrl).pathname);
  await expect(phone.getByText('This page can only send photos to the desk')).toBeVisible();
  await expect(phone.getByText(/Ishaan|Riya|Malhotra|205|BK-/)).toHaveCount(0);
  await expect(page.getByText('Phone connected')).toBeVisible();

  const guest2 = phone.locator('section').filter({ has: phone.getByRole('heading', { name: 'Guest 2' }) });
  await guest2.getByLabel('ID type').selectOption('aadhaar');

  // Weak network: go offline mid-capture, the photo waits on the phone, then resumes.
  await phoneCtx.setOffline(true);
  await expect(phone.getByText(/No network\. Photos are saved on this phone/)).toBeVisible();
  await guest2.getByTestId('file-input-id_front').setInputFiles({ name: 'aadhaar.jpg', mimeType: 'image/jpeg', buffer: await syntheticCard(phone, 'AADHAAR') });
  if (process.env.E2E_SCREENSHOTS) {
    const dlg = phone.getByRole('dialog').last();
    await expect(dlg.getByText(/Edges found|Drag the four corners/)).toBeVisible({ timeout: 20_000 });
    await phone.screenshot({ path: `${process.env.E2E_SCREENSHOTS}/phone-corners.png` });
    await dlg.getByRole('button', { name: 'Crop' }).click();
    await phone.screenshot({ path: `${process.env.E2E_SCREENSHOTS}/phone-mask.png` });
    await dlg.getByLabel(/first 8 digits are fully covered/).check();
    await dlg.getByRole('button', { name: 'Continue' }).click();
    await dlg.getByRole('button', { name: 'Use photo' }).click();
  } else {
    await useEditor(phone, { aadhaar: true });
  }
  await expect(guest2.getByText('Saved — waiting for network')).toBeVisible({ timeout: 15_000 });
  if (process.env.E2E_SCREENSHOTS) await phone.screenshot({ path: `${process.env.E2E_SCREENSHOTS}/phone-offline.png` });
  await phoneCtx.setOffline(false);
  await phone.reload(); // refresh after the network returns: the queued photo is still on the phone
  const guest2Again = phone.locator('section').filter({ has: phone.getByRole('heading', { name: 'Guest 2' }) });
  const slot = (title: RegExp) => guest2Again.locator('div.rounded-lg').filter({ has: phone.getByText(title) }).first();
  await expect(guest2Again.getByLabel('ID type')).toHaveValue('aadhaar'); // remembered across the refresh
  await expect(slot(/^ID — front/).getByRole('status')).toHaveText(/Received/, { timeout: 30_000 });

  await guest2Again.getByTestId('file-input-id_back').setInputFiles({ name: 'aadhaar-back.jpg', mimeType: 'image/jpeg', buffer: await syntheticCard(phone, 'AADHAAR BACK') });
  await useEditor(phone, { aadhaar: true });
  await expect(slot(/^ID — back/).getByRole('status')).toHaveText(/Received/, { timeout: 30_000 });
  await expect(slot(/^ID — front/).getByRole('status')).toHaveText(/Received/);
  if (process.env.E2E_SCREENSHOTS) {
    await phone.screenshot({ path: `${process.env.E2E_SCREENSHOTS}/phone-page.png`, fullPage: true });
    await page.screenshot({ path: `${process.env.E2E_SCREENSHOTS}/desk-phone-arrived.png` });
  }

  // Desk sees each document arrive live and picks up the ID type chosen on the phone.
  await expect(page.getByRole('list', { name: 'Documents received from the phone' }).getByText('Received')).toHaveCount(2, { timeout: 15_000 });
  await expect(riya.getByLabel('ID type')).toHaveValue('aadhaar', { timeout: 10_000 });
  await page.getByRole('button', { name: 'Done with phone' }).click();
  await phoneCtx.close();

  // Step 4 — consent and signature
  await page.getByRole('button', { name: 'Next' }).click();
  await page.getByLabel(/agrees to the house rules/).check();
  const pad = page.getByTestId('signature-canvas');
  const box = (await pad.boundingBox())!;
  await page.mouse.move(box.x + 40, box.y + 120);
  await page.mouse.down();
  for (let i = 0; i < 25; i++) await page.mouse.move(box.x + 40 + i * 14, box.y + 120 - Math.sin(i / 3) * 40);
  await page.mouse.up();
  await page.getByRole('button', { name: 'Save signature' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Received' }).first()).toBeVisible({ timeout: 30_000 });

  // Step 5 — confirm
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByText('Everything is ready.')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Confirm check-in' }).click();
  await expect(page.getByText('Checked in', { exact: true })).toBeVisible();
  await page.waitForURL(`/reservations/${reservation.id}`);
  await expect(page.getByText('In house').first()).toBeVisible();
  await expect(page.getByText('Room 205 · In house')).toBeVisible();

  // Privacy: the stored Aadhaar image really is black where the number was (not just a flag).
  const stayLink = await page.getByText('Room 205 · In house').getAttribute('href');
  const stay = await (await page.request.get(`/api/v1/stays/${stayLink!.split('/').pop()}`)).json();
  const aadhaar = stay.documents.find((d: any) => d.idType === 'aadhaar' && d.docType === 'id_front');
  expect(aadhaar.maskedOnDevice).toBe(true);
  const { url } = await (await page.request.get(`/api/v1/documents/${aadhaar.id}/view-url`)).json();
  const darkness = await page.evaluate(async (src) => {
    const blob = await (await fetch(src)).blob();
    const bitmap = await createImageBitmap(blob);
    const c = document.createElement('canvas'); c.width = bitmap.width; c.height = bitmap.height;
    const g = c.getContext('2d')!; g.drawImage(bitmap, 0, 0);
    // centre of the default masking box (x 24–64 %, y 70–82 %)
    const d = g.getImageData(Math.round(c.width * 0.3), Math.round(c.height * 0.73), Math.round(c.width * 0.28), Math.round(c.height * 0.06)).data;
    let sum = 0; for (let i = 0; i < d.length; i += 4) sum += (d[i]! + d[i + 1]! + d[i + 2]!) / 3;
    return sum / (d.length / 4);
  }, url);
  expect(darkness).toBeLessThan(12);

  // ---------------------------------------------------------------------------
  // The rest of the stay: registration card, room change, checkout (spec §20–§22)
  // ---------------------------------------------------------------------------
  await page.getByText('Room 205 · In house').click();
  await page.waitForURL(/\/stays\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name: /Room\s*205/ })).toBeVisible();
  await expect(page.getByText('In house').first()).toBeVisible();

  // The registration card is created from the signature the guest gave on the desk.
  await expect(page.getByText('Not created yet')).toBeVisible();
  await page.getByRole('button', { name: 'Create and print' }).click();
  await expect(page.getByText(/Registration card GRC-\d{6} created/)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/GRC-\d{6} · version 1/)).toBeVisible();
  await expect(page.getByText('Signed on the reception touchscreen')).toBeVisible();

  // What was stored really is a PDF, and its hash is the one shown on screen.
  const grc = await (await page.request.get(`/api/v1/stays/${stayLink!.split('/').pop()}/grc`)).json();
  const cardLink = await (await page.request.get(`/api/v1/grc-documents/${grc.current.id}/view-url`)).json();
  const pdf = await page.request.get(cardLink.url);
  expect(pdf.status()).toBe(200);
  expect((await pdf.body()).subarray(0, 5).toString('ascii')).toBe('%PDF-');
  await expect(page.getByText(grc.current.sha256)).toBeVisible();

  // Room change: the desk picks from what is actually free, and the reason is kept on the stay.
  await page.getByRole('button', { name: 'Change room' }).click();
  const shift = page.getByRole('dialog', { name: /Move .* out of room 205/ });
  await shift.getByLabel('New room').selectOption(rooms.find((r: any) => r.number === '203').id);
  await shift.getByLabel('Reason').selectOption('Air conditioning not working');
  await shift.getByRole('button', { name: 'Move to room 203' }).click();
  await expect(page.getByText('Guest moved to room 203')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('heading', { name: /Room\s*203/ })).toBeVisible();
  const shiftRow = page.getByRole('listitem').filter({ hasText: 'Air conditioning not working' });
  await expect(shiftRow).toHaveCount(1);
  await expect(shiftRow).toContainText('Priya Sharma');
  await expect(shiftRow).toContainText('205');
  await expect(shiftRow).toContainText('203');

  // Checkout is a status change in Phase 1; the screen is built around the server's blocker list.
  await page.getByRole('button', { name: 'Check out' }).click();
  const checkout = page.getByRole('dialog', { name: 'Check out room 203?' });
  await expect(checkout.getByText('Nothing is blocking this checkout.')).toBeVisible();
  await checkout.getByRole('button', { name: 'Check out' }).click();
  await expect(page.getByText('Room 203 checked out')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Checked out').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Check out' })).toHaveCount(0);

  // The room the guest left is waiting for housekeeping, and the booking is closed.
  await page.goto('/rooms');
  await expect(page.getByText('203').first()).toBeVisible();
  const rooms203 = await (await page.request.get('/api/v1/rooms')).json();
  expect(rooms203.find((r: any) => r.number === '203').housekeeping).toBe('dirty');
  expect(rooms203.find((r: any) => r.number === '203').occupancy).toBe('vacant');
});
