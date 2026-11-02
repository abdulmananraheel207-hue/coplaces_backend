import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Some suites hash a password per person (bcrypt) and build whole tenants in memory; under load they pass 5 s.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
