/**
 * Vitest test setup - runs before all tests
 */

import { beforeAll, afterAll, vi } from 'vitest';

// Set test environment variables
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-must-be-32-chars-min';
process.env.ENCRYPTION_KEY = 'test-encryption-key-32-chars!!!';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/tracearr_test';
process.env.REDIS_URL = 'redis://localhost:6379';

// Silence console.log in tests unless DEBUG=true
if (!process.env.DEBUG) {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
}

beforeAll(() => {
  // Global test setup
});

afterAll(() => {
  // Global test cleanup
});
