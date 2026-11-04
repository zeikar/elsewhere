import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The site is served from https://zeikar.dev/elsewhere/ (docs/PLAN.md section 3).
  base: '/elsewhere/',
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
