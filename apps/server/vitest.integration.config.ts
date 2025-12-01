import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

/**
 * Integration Test Configuration
 *
 * Run with: pnpm test:integration
 *
 * Integration tests:
 * - Located in: test/integration/*.integration.test.ts
 * - Test service classes with mocked external dependencies (fetch, database)
 * - May have longer timeouts for more complex scenarios
 * - Run separately from unit tests to keep CI fast
 */

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/integration/**/*.integration.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    setupFiles: ['./src/test/setup.ts'],
    testTimeout: 30000, // Longer timeout for integration tests
    hookTimeout: 30000,
    clearMocks: true,
    restoreMocks: true,
  },
  resolve: {
    alias: {
      '@tracearr/shared': resolve(__dirname, '../../packages/shared/src'),
    },
  },
});
