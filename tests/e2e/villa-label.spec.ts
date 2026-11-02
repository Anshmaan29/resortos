import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

let villaId: string;
test.beforeAll(() => {
  // This fixture is restricted to the disposable E2E database. No provider is configured.
  villaId = execFileSync(process.execPath, ['-r', './apps/api/scripts/swc-register.cjs', '-e', `
    const {Client}=require('./apps/api/node_modules/pg');
    const {addVilla}=require('./apps/api/scripts/add-villa-lib.ts');
    (async()=>{const c=new Client({connectionString:'postgres://resortos_migrator:migrator_dev_password@localhost:5433/resortos_test'});
    await c.connect();try{if((await c.query('SELECT current_database() AS db')).rows[0].db!=='resortos_test')throw Error('Wrong fixture database');
    const u=(await c.query("SELECT id,property_id FROM users WHERE role='owner' ORDER BY created_at LIMIT 1")).rows[0];
    await c.query('BEGIN');const v=await addVilla(c,u.property_id,u.id,'324001');await c.query('COMMIT');process.stdout.write(v.propertyId);
    }finally{await c.end();}})().catch(()=>process.exit(1));
  `], { encoding: 'utf8', env: { ...process.env, RESORTOS_ENV: 'test' } }).trim();
});

test('Villa choices and legacy edits show one Whole villa option and retain allocation @phone', async ({ page }, info) => {
  await page.goto('/login');
  await page.getByLabel('Username or phone number').fill('owner');
  await page.getByLabel('Password', {exact:true}).fill('Aravali#Hills26');
  await page.getByRole('button',{name:'Log in',exact:true}).click();
  await page.waitForURL('/');
  await page.getByRole('combobox',{name:'Choose resort'}).filter({visible:true}).selectOption(villaId);
  await page.goto('/villa/new');
  const book=page.getByRole('combobox',{name:'Book',exact:true});
  await expect(book.locator('option')).toHaveText(['One room','Whole villa','Swimming pool','Garden']);
  await book.selectOption('both_bedrooms');
  await expect(page.getByText('Room 1 and Room 2, including pool and garden. One combined price.')).toBeVisible();
  const headers={'x-resortos':'1','x-resortos-property':villaId,'idempotency-key':randomUUID()};
  const day=info.project.name==='phone'?'28':'26';
  const result=await page.request.post('/api/v1/villa/bookings',{headers,data:{
    useKind:'whole_villa',startsAt:`2026-09-${day}T12:30:00+05:30`,endsAt:`2026-09-${Number(day)+1}T10:30:00+05:30`,
    guestCount:2,price:'3500',gstPercent:'5',guest:{firstName:'Legacy Villa QA',mobile:info.project.name==='phone'?'9899980102':'9899980101'},
  }});
  expect(result.status()).toBe(201);const before=await result.json();
  await page.goto(`/villa/bookings/${before.id}/edit`);
  await expect(book).toHaveValue('whole_villa');
  await expect(book.locator('option')).toHaveText(['One room','Whole villa']);
  await expect(page.getByLabel('Agreed price per night before GST')).toHaveValue('3500.00');
  const after=await page.request.get(`/api/v1/villa/bookings/${before.id}`,{headers:{'x-resortos-property':villaId}});
  expect(await after.json()).toMatchObject({useKind:'whole_villa',useLabel:'Whole villa',resourceMask:3,price:'3500.00',version:before.version});
});
