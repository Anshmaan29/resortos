import { expect, test, type Page } from '@playwright/test';

async function loginAs(page: Page, username: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Username or phone number').fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await page.waitForURL('/');
}
const receptionist = (page: Page) => loginAs(page, 'priya', 'Aravali#Desk26');

test('staff UI has no developer wording and meets the Indian formats @phone', async ({ page }) => {
  await receptionist(page);
  await expect(page.getByText(/phase|milestone/i)).toHaveCount(0);
  await page.goto('/reservations');
  await expect(page.getByText('+91 98765 43210').locator('visible=true').first()).toBeVisible();
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

test('below-minimum rate: Owner PIN typed on the physical keyboard, override shown on the booking', async ({ page }) => {
  await receptionist(page);
  await page.goto('/reservations/new');
  await page.getByLabel('First name').fill('Kavya');
  await page.getByLabel('Last name').fill('Reddy');
  await page.getByLabel('Mobile').fill('9849012345');
  await expect(page.getByLabel('Meal plan')).toHaveCount(0);
  await page.getByLabel('Room rate per night').fill('2000');
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
  await page.keyboard.type('48291');
  await page.keyboard.press('Backspace');
  await page.keyboard.type('16');
  await expect(pad.getByRole('status')).toHaveAttribute('aria-label', '6 of 6 digits entered');
  await page.keyboard.press('Enter');

  await page.waitForURL(/\/reservations\/[0-9a-f-]{36}$/);
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
  await page.getByRole('button', { name: 'Create new booking' }).click();
  await expect(page.getByText(/Rebooked as BK-\d+/).first()).toBeVisible();
  await expect(page.getByText('Rebook of')).toBeVisible();
});
