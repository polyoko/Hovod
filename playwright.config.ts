import { defineConfig } from '@playwright/test';

// Runs against a running stack: `docker compose up -d --build`
export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:3001',
    trace: 'retain-on-failure',
  },
});
