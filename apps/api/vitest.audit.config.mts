import { defineConfig } from 'vitest/config';
import base from './vitest.config.mts';

// Operational regression checks first added by the launch audit. Kept separate
// for isolated database setup and generated PDF evidence; required by CI.
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['test/market-readiness.audit.ts'],
    globalSetup: [],
    hookTimeout: 120_000,
  },
});
