import { defineConfig } from 'vitest/config';

// `test/contract` and `test/live` need an openapi.json / a key: they have their own scripts and configs
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/contract/**', 'test/live/**', '**/node_modules/**'],
    environment: 'node',
  },
});
