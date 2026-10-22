import { expect, test, type Page } from '@playwright/test';

async function loginAs(page: Page, username: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Username or phone number').fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await page.waitForURL('/');
}
const receptionist = (page: Page) => loginAs(page, 'priya', 'Aravali#Desk26');

test('Save booking records WhatsApp agreement without an extra checkbox or send action @phone', async ({ page }, testInfo) => {
  const invalidPreviews: number[] = [];
  page.on('response', response => { if (response.url().endsWith('/reservations/estimate') && response.status() >= 400) invalidPreviews.push(response.status()); });
  await receptionist(page);
  await page.goto('/reservations/new');
  await page.getByLabel('First name').fill('Automatic');
  await page.getByLabel('Last name').fill('Confirmation');
  await page.getByRole('textbox', { name: 'Mobile', exact: true }).fill(testInfo.project.name === 'phone' ? '9899920002' : '9899920001');
  await page.getByLabel('Email', { exact: true }).fill('automatic@example.com');
  await expect(page.getByRole('combobox', { name: 'Room type', exact: true })).toHaveCount(0);
  await page.getByLabel('Meal plan', { exact: true }).selectOption('MAP');
  // Assign later must support the hotel's guest limit, not the first hidden tariff's limit.
  await page.getByRole('button', {name:'More adults',exact:true}).click();
  await expect(page.getByText('Max 3 guests', {exact:true})).toBeVisible();
  await page.getByRole('button', {name:'Fewer adults',exact:true}).click();
  await page.getByLabel('Room price per night').fill('6000');
  await page.getByLabel('GST %', { exact: true }).fill('7.5');
  await page.getByLabel('Extra guest price per night').fill('300');
  await page.getByRole('button', { name: 'Fewer adults' }).click();
  await expect(page.getByLabel('Extra guest price per night')).toHaveCount(0);
  await page.getByLabel('Child age').fill('7');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByLabel('Extra guest price per night')).toBeVisible();
  await page.getByLabel('Extra guest price per night').fill('250');
  await page.getByRole('button', { name: 'Remove child aged 7' }).click();
  await expect(page.getByLabel('Extra guest price per night')).toHaveCount(0);
  await page.getByRole('button', { name: 'More adults' }).click();
  await expect(page.getByLabel('Extra guest price per night')).toHaveValue('0');
  await page.getByLabel('Extra guest price per night').fill('300');
  await page.getByRole('textbox', { name: 'Arrival' }).fill(testInfo.project.name === 'phone' ? '16/12/2026' : '12/12/2026');
  await page.getByRole('textbox', { name: 'Departure' }).fill(testInfo.project.name === 'phone' ? '17/12/2026' : '13/12/2026');
  await page.getByRole('textbox', { name: 'Departure' }).blur();
  await expect(page.getByLabel('Room number', { exact: true }).locator('option').filter({hasText:/^106$/})).toHaveCount(1);
  await page.getByLabel('Room number', { exact: true }).selectOption({label:'106'});
  await expect(page.getByText('Confirmation sends automatically', { exact: true })).toBeVisible();
  await expect(page.getByText(/By saving, you confirm the guest agreed/)).toBeVisible();
  await expect(page.getByLabel('WhatsApp messages', { exact: true })).toBeHidden();
  const response = page.waitForResponse(r => r.url().endsWith('/api/v1/reservations') && r.request().method() === 'POST' && r.status() === 201);
  await page.getByRole('button', { name: 'Save booking', exact: true }).click();
  const created = await response;
  expect(created.request().postDataJSON().whatsappOptedIn).toBe(true);
  const booking = await created.json();
  expect(booking.rooms[0]).toMatchObject({ mealPlan: 'MAP', nightlyRate: '6000.00', gstRate: '7.50', includesMealPlan: true, extrasTotal: '300.00', mealTotal: '0.00' });
  expect(booking.estimate.grandTotal).toBe('6773.00');
  expect(invalidPreviews).toEqual([]);
  expect(booking.guest.whatsappOptedIn).toBe(true);
  expect(booking.guest.whatsappConsentAt).toBeTruthy();
  await page.waitForURL(`/reservations/${booking.id}`);
});

test('a returning guest who declined WhatsApp stays email only when saving another booking', async ({ page }) => {
  await receptionist(page);
  await page.route('**/api/v1/guests?*', async route => {
    const response = await route.fetch();
    const guests = await response.json();
    await route.fulfill({response,json:guests.map((g: object) => ({...g,whatsappOptedIn:false,whatsappConsentAt:'2026-09-16T08:00:00Z'}))});
  });
  await page.goto('/reservations/new');
  await page.getByLabel('Search existing guests').fill('9876543210');
  await page.getByLabel('Room price per night').fill('6000');
  // An exact, unique mobile now selects the returning guest automatically.
  await expect(page.getByText('Rahul Sharma', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Change', exact: true })).toBeVisible();
  await expect(page.getByText('WhatsApp is off for this guest.', { exact: false })).toBeVisible();
  await expect(page.getByText(/By saving, you confirm the guest agreed/)).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Arrival' }).fill('14/12/2026');
  await page.getByRole('textbox', { name: 'Departure' }).fill('15/12/2026');
  await page.getByRole('textbox', { name: 'Departure' }).blur();
  const response = page.waitForResponse(r => r.url().endsWith('/api/v1/reservations') && r.request().method() === 'POST' && r.status() === 201);
  await page.getByRole('button', { name: 'Save booking', exact: true }).click();
  expect((await response).request().postDataJSON().whatsappOptedIn).toBe(false);
});

test('staff UI has no developer wording and meets the Indian formats @phone', async ({ page }) => {
  await receptionist(page);
  await expect(page.getByText(/phase|milestone/i)).toHaveCount(0);
  await page.goto('/reservations');
  await expect(page.getByText('+91 98765 43210').locator('visible=true').first()).toBeVisible();
});

test('new bookings and the header use today even while an earlier accounting day is open', async ({ page }) => {
  await page.route('**/api/v1/property', async (route) => {
    const response = await route.fetch();
    const property = await response.json();
    await route.fulfill({ response, json: { ...property, today: '2026-10-07', businessDate: '2026-10-06' } });
  });
  await receptionist(page);
  await expect(page.getByText('Today', { exact: true })).toBeVisible();
  await expect(page.getByText('Day closing: 6 Oct', { exact: true })).toBeVisible();
  await page.goto('/reservations/new');
  await expect(page.getByRole('textbox', { name: 'Arrival' })).toHaveValue('07/10/2026');
  await expect(page.getByRole('textbox', { name: 'Departure' })).toHaveValue('08/10/2026');
  await page.getByRole('button', { name: 'Choose arrival date from calendar' }).click();
  await expect(page.getByRole('button', { name: 'Tue 6 Oct 2026' })).toBeDisabled();
});

test('dates are entered as DD/MM/YYYY with our own picker, independent of browser locale', async ({ page }) => {
  await receptionist(page);
  await page.goto('/reservations/new');
  const arrival = page.getByRole('textbox', { name: 'Arrival' });
  await expect(arrival).toHaveValue('16/09/2026');
  await expect(arrival).toHaveAccessibleDescription('Wed 16 Sep 2026');

  const departure = page.getByRole('textbox', { name: 'Departure' });
  await departure.fill('');
  await departure.pressSequentially('19092026');
  await expect(departure).toHaveValue('19/09/2026');
  await expect(departure).toHaveAccessibleDescription('Sat 19 Sep 2026 · 3 nights');

  // US order is refused, never silently swapped
  await departure.fill('');
  await departure.pressSequentially('09192026');
  await departure.blur();
  await expect(page.getByText('Enter the date as DD/MM/YYYY')).toBeVisible();

  // calendar popup; past days are disabled
  await page.getByRole('button', { name: 'Choose departure date from calendar' }).click();
  await expect(page.getByRole('button', { name: 'Tue 15 Sep 2026' })).toBeDisabled();
  await page.getByRole('button', { name: 'Mon 21 Sep 2026' }).click();
  await expect(departure).toHaveValue('21/09/2026');
});

test('below-minimum rate: four-digit Owner PIN typed on the physical keyboard, override shown on the booking', async ({ page, request }) => {
  await receptionist(page);
  await page.goto('/reservations/new');
  await page.getByLabel('First name').fill('Kavya');
  await page.getByLabel('Last name').fill('Reddy');
  await page.getByLabel('Mobile').fill('9849012345');
  await expect(page.getByLabel('Meal plan')).toBeVisible();
  await page.getByLabel('Room price per night').fill('2000');
  await page.getByLabel('Extra guest price per night').fill('375.50');
  await expect(page.getByText('₹2,375.50', { exact: true }).first()).toBeVisible();
  await page.getByLabel('Extra guest price per night').fill('');
  await expect(page.getByText('₹3,150', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/Below the minimum rate of ₹3,200/)).toBeVisible();
  await expect(page.getByText('Estimated total incl. GST')).toBeVisible();
  const ownersLoaded = page.waitForResponse((r) => r.url().endsWith('/api/v1/auth/owners') && r.status() === 200);
  await page.getByRole('button', { name: 'Save booking' }).click();

  const pad = page.getByRole('dialog', { name: 'Owner authorisation' });
  await expect(pad.getByText('Needed because: Rate ₹2,000 is below the minimum ₹3,200')).toBeVisible();
  await ownersLoaded;
  await expect(pad.getByText('Loading owners…')).toBeHidden();
  // Keep a burst of digits and Enter in the same browser task. This reproduces the
  // lost-submit race without depending on how quickly a CI runner commits React state.
  await page.evaluate(() => {
    for (const key of [...'000000', 'Enter']) window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
  await expect(pad.getByText('Owner PIN is incorrect.')).toBeVisible();
  // The owner sets a shorter PIN through the actual password-protected API.
  expect((await request.post('/api/v1/auth/login', { headers: { 'x-resortos': '1' }, data: { login: 'owner', password: 'Aravali#Hills26' } })).ok()).toBe(true);
  const setPin = (pin: string) => request.post('/api/v1/auth/owner-pin', { headers: { 'x-resortos': '1' }, data: { password: 'Aravali#Hills26', pin } });
  expect((await setPin('7294')).ok()).toBe(true);
  try {
    await page.keyboard.type('7295');
    await page.keyboard.press('Backspace');
    await expect(pad.getByRole('button', { name: 'Authorise' })).toBeDisabled();
    // The last digit and Enter in one task must submit all four digits.
    await page.evaluate(() => {
      for (const key of ['4', 'Enter']) window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    });
    await page.waitForURL(/\/reservations\/[0-9a-f-]{36}$/);
  } finally {
    expect((await setPin('482916')).ok()).toBe(true);
  }
  // The override records the real time it happened, not the seeded business date, so the day is
  // whatever today is — matching a fixed date here would fail on every other day of the year.
  await expect(page.getByText(/Rate ₹2,000 is below the minimum ₹3,200\. Authorised by Vikram Rathore \(Owner\), \d{1,2} \w{3}, \d{1,2}:\d{2} [AP]M, requested by Priya Sharma\./)).toBeVisible();
  await expect(page.getByText('+91 98490 12345')).toBeVisible();
  await expect(page.getByText(/Room ₹2,000 · extra guests ₹1,000/)).toBeVisible(); // Room only: single ₹2,000 plus the second adult
  await expect(page.getByText('Estimated total incl. GST')).toBeVisible();
  await expect(page.getByText('₹3,150')).toBeVisible(); // ₹3,000 at the configured 5% demo GST
  await expect(page.getByText('Assign a room first')).toBeVisible();
});

test('edit a booking, then cancel and rebook it', async ({ page }) => {
  await receptionist(page);
  await page.goto('/reservations?view=arrivals');
  await page.getByRole('link', { name: 'BK-000001' }).first().click();
  await page.getByRole('button', { name: 'Edit booking' }).click();
  await expect(page.getByRole('heading', { name: 'Edit BK-000001' })).toBeVisible();
  await expect(page.getByText('Agreed rates kept')).toBeVisible();
  await page.getByLabel('Special requests').fill('Airport pickup at 6 PM');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Booking BK-000001 updated')).toBeVisible();
  await expect(page.getByText('Airport pickup at 6 PM')).toBeVisible();

  await page.getByRole('button', { name: 'Cancel booking' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel booking' }).click();
  await expect(page.getByText(/Cancelled .* The booking is kept in history/)).toBeVisible();
  await page.getByRole('button', { name: 'Rebook' }).click();
  await expect(page.getByRole('heading', { name: 'Rebook BK-000001' })).toBeVisible();
  await page.getByLabel('Room price per night').fill('6000');
  await page.getByRole('button', { name: 'Create new booking' }).click();
  await expect(page.getByText(/Rebooked as BK-\d+/).first()).toBeVisible();
  await expect(page.getByText('Rebook of')).toBeVisible();
});

test('all ready room numbers remain available during booking edits and check-in @phone', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
  await receptionist(page);
  const types = await (await page.request.get('/api/v1/room-types')).json();
  const deluxe = types.find((t: any) => t.code === 'DLX');
  const response = await page.request.post('/api/v1/reservations', {
    headers: { 'x-resortos': '1', 'idempotency-key': crypto.randomUUID() },
    data: {
      guest: { firstName: 'Category', lastName: 'Change', mobile: testInfo.project.name === 'phone' ? '9899910602' : '9899910601' },
      source: 'walk_in', arrival: '2026-09-16', departure: '2026-09-17', whatsappOptedIn: false,
      rooms: [{ roomTypeId: deluxe.id, adults: 1, nightlyRate: '6000', includesMealPlan: true, gstRate: '0', extraPersonRate: '0' }],
    },
  });
  expect(response.status()).toBe(201);
  const booking = await response.json();
  await page.goto(`/reservations/${booking.id}`);
  await page.getByRole('button', { name: 'Check in', exact: true }).click();
  await page.waitForURL(/\/check-in\/[^/]+$/);
  const originalDraftUrl = page.url();
  await expect(page).toHaveTitle(/ResortOS/);
  await page.getByRole('button', { name: /^(2\. )?Room$/ }).click();
  await expect(page.getByRole('heading', { name: 'Choose a room', exact: true })).toBeVisible();
  const firstPicker = page.getByRole('combobox', { name: 'Room', exact: true });
  for (const number of ['103','106','107']) await expect(firstPicker.locator('option').filter({hasText:new RegExp(`^${number}$`)})).toHaveCount(1);
  for (const number of ['101','104','105','201']) await expect(firstPicker.locator('option').filter({hasText:new RegExp(`^${number}$`)})).toHaveCount(0);
  await expect(page.locator('main')).not.toContainText(/Delux|Premium|Executive/);
  await page.getByRole('link', { name: booking.number, exact: true }).click();
  await page.getByRole('button', { name: 'Edit booking' }).click();
  await expect(page.getByRole('combobox', { name:'Room type', exact:true })).toHaveCount(0);
  await page.getByLabel('Room number', {exact:true}).selectOption({label:'107'});
  await page.getByLabel('Room pricing', { exact: true }).selectOption('custom');
  await page.getByRole('textbox', { name: 'Room price per night', exact: true }).fill('6000');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByText(`Booking ${booking.number} updated`)).toBeVisible();
  await page.getByRole('button', { name: 'Check in', exact: true }).click();
  await page.waitForURL(originalDraftUrl);
  await expect(page.getByRole('heading', { name: 'Choose a room', exact: true })).toBeVisible();
  const roomSelect = page.getByRole('combobox', { name: 'Room', exact: true });
  const option = roomSelect.locator('option').filter({ hasText: /^106$/ });
  await expect(option).toHaveCount(1);
  const savedRoom = page.waitForResponse(r => r.url().includes('/check-in-drafts/') && r.request().method() === 'PATCH' && r.status() === 200);
  await roomSelect.selectOption({ label: '106' });
  await savedRoom;
  await expect(page.getByText('Room 106 is ready.')).toBeVisible();
  const selectedId = await roomSelect.inputValue();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Choose a room', exact: true })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Room', exact: true })).toHaveValue(selectedId);
  expect(errors).toEqual([]);
  if (process.env.E2E_SCREENSHOTS) await page.screenshot({ path: `${process.env.E2E_SCREENSHOTS}/room-numbers-106-${testInfo.project.name}.png`, fullPage: true });
  const cancelled = await page.request.post(`/api/v1/reservations/${booking.id}/cancel`, {
    headers: {'x-resortos':'1','idempotency-key':crypto.randomUUID()}, data:{reason:'guest_request'},
  });
  expect(cancelled.status()).toBe(200);
});
