import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false, // Explicit imports preferred for tree-shaking clarity
    environment: 'node',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    coverage: {
      provider: 'v8', // S4: @vitest/coverage-v8
      enabled: false, // Only enabled when --coverage flag is passed
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/testing/index.ts', 'src/ack-from-hl7/index.ts'],
      reporter: ['text', 'lcov', 'html'],
      thresholds: {
        // Per-directory 90% gates on src/framing, src/server, src/client (SETUP-01, TEST-01)
        // These directories will be populated in Phases 2-5.
        // Thresholds only apply once files exist in those directories.
        lines: 90,
        functions: 90,
        branches: 90,
        statements: 90,
      },
    },
  },
});
