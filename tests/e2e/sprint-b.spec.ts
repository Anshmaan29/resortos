import { expect, test, type Page } from '@playwright/test';

async function loginAs(page: Page, username: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Username or phone number').fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await page.waitForURL('/');
}

test('express check-in: one form creates the walk-in booking and opens the whole check-in on one page', async ({ page }) => {
  await loginAs(page, 'priya', 'Aravali#Desk26');
  await page.getByRole('link', { name: 'Express check-in' }).click();
  await page.waitForURL('/check-in/express');
  await page.getByLabel('First name').fill('Arjun');
  await page.getByLabel('Mobile').fill('9829012345');
  await page.getByRole('button', { name: /^Deluxe/ }).click();
  await page.getByRole('button', { name: '205', exact: true }).click();
  await page.getByRole('button', { name: 'Continue to IDs and signature' }).click();
  await page.waitForURL(/\/check-in\/express\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name: 'Express check-in · Arjun' })).toBeVisible();
  for (const section of ['1. Guests', '2. Room', '3. IDs', '4. Registration card and signature', '5. Check']) {
    await expect(page.getByRole('heading', { name: section })).toBeVisible();
  }
  // Same rules as the wizard: nothing confirms until everything the check-in needs is there.
  await expect(page.getByRole('button', { name: 'Confirm check-in' })).toBeDisabled();
});

test('the owner changes a policy in settings, and a receptionist only sees their own PIN', async ({ page, browser }) => {
  await loginAs(page, 'owner', 'Aravali#Hills26');
  await page.goto('/settings?tab=policies');
  const threshold = page.getByLabel('Cash difference needing a reason (₹)');
  await threshold.fill('250');
  await page.getByRole('button', { name: 'Save' }).first().click();
  await expect(page.getByText('Policies saved')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Cash difference needing a reason (₹)')).toHaveValue('250.00');

  const desk = await (await browser.newContext()).newPage();
  await loginAs(desk, 'priya', 'Aravali#Desk26');
  await desk.goto('/settings');
  await expect(desk.getByRole('button', { name: 'My PIN' })).toBeVisible();
  await expect(desk.getByRole('button', { name: 'Policies & printing' })).toHaveCount(0);
});

test('a shared desk: PIN switch after a password login today, and locking ends the session', async ({ page }) => {
  // The receptionist sets a PIN (after today's password login) in their own browser.
  await loginAs(page, 'priya', 'Aravali#Desk26');
  await page.goto('/settings?tab=pin');
  await page.getByLabel('New PIN').fill('4829');
  await page.getByLabel('Your password').fill('Aravali#Desk26');
  await page.getByRole('button', { name: 'Save PIN' }).click();
  await expect(page.getByText('PIN saved')).toBeVisible();
  await page.context().clearCookies();

  // The owner marks this computer as the shared desk.
  await loginAs(page, 'owner', 'Aravali#Hills26');
  await page.goto('/settings?tab=desks');
  await page.getByRole('button', { name: 'Make this a shared desk' }).click();
  await expect(page.getByText(/is now a shared desk/)).toBeVisible();

  // Lock, then switch to the receptionist by PIN.
  await page.getByRole('button', { name: /Vikram|Owner/ }).first().click();
  await page.getByRole('menuitem', { name: 'Lock desk' }).click();
  await page.waitForURL('/desk');
  await page.getByRole('button', { name: /Priya/ }).click();
  for (const d of '4829') await page.keyboard.press(d);
  await page.getByRole('button', { name: 'Unlock' }).click();
  await page.waitForURL('/');
  const me = await page.request.get('/api/v1/auth/me');
  expect((await me.json()).user.username).toBe('priya');
});
