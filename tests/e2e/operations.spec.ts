import { expect, test, type Page } from '@playwright/test';

async function signIn(page: Page, owner=false) {
  await page.goto('/login');
  await page.getByLabel('Username or phone number').fill(owner?'owner':'priya');
  await page.getByLabel('Password',{exact:true}).fill(owner?'Aravali#Hills26':'Aravali#Desk26');
  await page.getByRole('button',{name:'Log in'}).click();
  await page.waitForURL('/');
}

test('owner saves sender settings and sees an honest practice email result',async({page})=>{
  await signIn(page,true);
  await page.goto('/settings?tab=messages');
  await expect(page.getByRole('heading',{name:'Email setup',exact:true})).toBeVisible();
  await expect(page.getByText('Practice mode: emails are recorded locally. No email reaches a guest.')).toBeVisible();
  await page.getByLabel('Sender name',{exact:true}).fill('Resort Reception');
  await page.getByLabel('Sender email',{exact:true}).fill('reception@example.com');
  await page.getByLabel('Reply to',{exact:true}).fill('desk@example.com');
  await page.getByLabel('Daily summary recipients',{exact:true}).fill('accounts@example.com');
  await page.getByRole('button',{name:'Save email settings'}).click();
  await expect(page.getByText('Email settings saved',{exact:true})).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Sender email',{exact:true})).toHaveValue('reception@example.com');
  await expect(page.getByLabel('Daily summary recipients',{exact:true})).toHaveValue('accounts@example.com');
  await page.getByLabel('Send a test to').fill('owner@example.com');
  await page.getByRole('button',{name:'Send test',exact:true}).click();
  await expect(page.getByText('Test recorded in practice mode; no email was delivered.')).toBeVisible();
  await page.screenshot({path:'/tmp/resortos-email-setup.png',fullPage:true});
});

test('@phone full navigation reaches maintenance and compliance',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  await signIn(page);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth-window.innerWidth)).toBeLessThanOrEqual(1);
  await page.getByRole('button',{name:'Open navigation'}).click();
  const menu=page.getByRole('dialog',{name:'Menu',exact:true});
  await expect(menu.getByRole('link',{name:'Maintenance',exact:true})).toBeVisible();
  await expect(menu.getByRole('link',{name:'Form C',exact:true})).toBeVisible();
  await expect(menu.getByRole('link',{name:'Night audit',exact:true})).toBeVisible();
  await menu.getByRole('link',{name:'Maintenance',exact:true}).click();
  await expect(menu).not.toBeVisible();
  await expect(page).toHaveURL(/\/maintenance$/);
  await page.screenshot({path:'/tmp/resortos-phone-maintenance.png',fullPage:true});
});


test('receptionist changes GST using dated rules in settings', async ({ page }) => {
  await signIn(page);
  await page.goto('/settings?tab=tax');
  const laundry = page.getByText('Laundry · 18%', { exact: true }).locator('..').locator('..');
  await laundry.getByRole('button', { name: 'Close', exact: true }).click();
  const close = page.getByRole('dialog', { name: 'Close this rule' });
  await close.getByLabel('Last day it applies').fill('31/12/2029');
  await close.getByRole('button', { name: 'Close rule', exact: true }).click();
  await expect(page.getByText('Rule closed', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add rule', exact: true }).click();
  const add = page.getByRole('dialog', { name: 'Add a GST rule' });
  await add.getByLabel('For', { exact: true }).selectOption('laundry');
  await add.getByRole('textbox', { name: 'GST %', exact: true }).fill('7.25');
  await add.getByRole('textbox', { name: 'SAC', exact: true }).fill('999712');
  await add.getByRole('textbox', { name: 'From', exact: true }).fill('01/01/2030');
  await add.getByRole('button', { name: 'Add rule', exact: true }).click();
  await expect(page.getByText('Rule added', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText('Laundry · 7.25%', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Policies & printing' })).toHaveCount(0);
});
