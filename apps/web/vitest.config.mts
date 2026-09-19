import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['test/**/*.test.ts'], environment: 'node' },
  // Same '@/' alias the app uses, so a test can import a module that imports another one.
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
});
