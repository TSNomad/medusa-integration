import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'medusa-integration',
    setupFiles: ['./test/network-guard.ts'],
  },
});
