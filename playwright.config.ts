import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests run the built API and web app against the isolated resortos_test database,
 * which is rebuilt from migrations + demo seed before the run (tests/e2e/global-setup.ts).
 */
/**
 * Storage for the run: plain-HTTP MinIO in CI. `TEST_S3_ENDPOINT` points it elsewhere — e.g. at the
 * HTTPS MinIO the LAN phone-testing setup runs (with NODE_EXTRA_CA_CERTS set to the mkcert root).
 */
const TEST_DB_APP = 'postgres://resortos_app:app_dev_password@localhost:5433/resortos_test';

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: [['list']],
  globalSetup: './tests/e2e/global-setup.ts',
  use: { baseURL: 'http://localhost:3000', locale: 'en-IN', timezoneId: 'Asia/Kolkata', trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'phone', use: { ...devices['Pixel 7'] }, grep: /@phone/ },
  ],
  webServer: [
    {
      command: 'node apps/api/dist/main.js',
      url: 'http://localhost:4000/api/v1/health',
      reuseExistingServer: false,
      env: {
        NODE_ENV: 'test', DATABASE_URL: TEST_DB_APP, API_PORT: '4000', WEB_ORIGIN: 'http://localhost:3000', SESSION_COOKIE_SECURE: 'false',
        S3_ENDPOINT: process.env.TEST_S3_ENDPOINT ?? 'http://localhost:9000', S3_BUCKET: 'resortos-documents-test', S3_ACCESS_KEY_ID: 'resortos',
        S3_SECRET_ACCESS_KEY: 'resortos-dev-minio-secret', S3_FORCE_PATH_STYLE: 'true',
      },
    },
    { command: 'pnpm --filter @resortos/web start', url: 'http://localhost:3000/login', reuseExistingServer: false },
  ],
});
