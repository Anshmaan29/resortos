import { defineConfig } from 'vitest/config';
import base from './vitest.config.mts';

// Opt-in launch audit. These assertions express required behaviour and intentionally
// expose unresolved defects; they are separate from the existing green regression suite.
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ['test/market-readiness.audit.ts'],
    globalSetup: [],
    hookTimeout: 120_000,
  },
});
