import { expect, test } from '@playwright/test';

test('login serves security headers and local install assets without external fonts', async ({ page, request }) => {
  const externalFonts: string[] = [];
  page.on('request', req => { if (/fonts\.(googleapis|gstatic)\.com/.test(req.url())) externalFonts.push(req.url()); });
  const response = await page.goto('/login');
  expect(response?.headers()['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(response?.headers()['strict-transport-security']).toContain('max-age=31536000');
  expect(response?.headers()['x-robots-tag']).toBe('noindex, nofollow');
  await expect(page.getByRole('button', { name: 'Log in', exact: true })).toBeVisible();
  expect(externalFonts).toEqual([]);
  const manifest = await request.get('/manifest.webmanifest');
  expect(manifest.ok()).toBe(true);
  const data = await manifest.json();
  expect(data.display).toBe('standalone');
  for (const icon of data.icons) expect((await request.get(icon.src)).ok()).toBe(true);
  expect((await request.get('/favicon.ico')).ok()).toBe(true);
  expect((await request.get('/robots.txt')).status()).toBe(200);
  expect((await request.get('/api/v1/health/storage')).status()).toBe(401);
});
