import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Redirects the write journal into a temp directory. Must load before any
    // test imports src/db/index.ts — see tests/setup.ts.
    setupFiles: ['tests/setup.ts'],
    coverage: {
      include: ['src/domain/**'],
      reporter: ['text', 'html'],
    },
  },
});
