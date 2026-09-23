import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    root: './src',
    include: ['**/*.spec.ts'],
    coverage: {
      exclude: ['main.ts', 'database/seed.ts'],
    },
  },
});
