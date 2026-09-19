import { expect, test, type Page } from '@playwright/test';

async function loginAs(page: Page, username: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Username or phone number').fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await page.waitForURL('/');
}

/**
 * The night audit screen (spec §35.1). This test deliberately does **not** complete an audit: doing
 * so would move the business date for every spec that runs after it, and the behaviour of completing
 * is covered in depth — concurrency, replay, the day audit log — in apps/api/test/night-audit.test.ts.
 */
test('night audit lists the steps and will not close a day with anything outstanding', async ({ page }) => {
  await loginAs(page, 'priya', 'Aravali#Desk26');
  await page.getByRole('link', { name: 'Night audit' }).click();
  await page.waitForURL('/night-audit');

  await expect(page.getByRole('heading', { name: 'Night audit' })).toBeVisible();
  await expect(page.getByText(/Closing \w{3} 16 Sep 2026 · next day 17 Sep 2026/)).toBeVisible();

  // Every registered step is shown, in spec order, whether or not it has anything to report.
  for (const title of ['Arrivals not checked in', 'Departures not checked out', 'Room status check', 'Summary']) {
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  }

  const complete = page.getByRole('button', { name: 'Complete night audit' });
  const blockedNotice = page.getByText(/The day cannot be closed while anything below is unresolved/);

  if (await blockedNotice.isVisible()) {
    // The button and the explanation always agree: staff are never invited to press something
    // the server would refuse.
    await expect(complete).toBeDisabled();
    await expect(page.getByText(/to resolve/).first()).toBeVisible();
  } else {
    await expect(complete).toBeEnabled();
  }

  // The summary is real numbers for the closing date, and the log is honest about being empty.
  await expect(page.getByText('Occupancy')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Summary for 16 Sep 2026' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Day audit log' })).toBeVisible();
  await expect(page.getByText('No audit has run yet')).toBeVisible();
});
