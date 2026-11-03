import { defineConfig } from '@playwright/test'

// E2E smoke over the real service; the harness in scripts/e2e.sh builds the
// binaries, starts the fake provider and the service, and runs this suite.
// Unit tests stay in src/; this config only owns web/e2e.
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.SWARM_URL ?? 'http://127.0.0.1:8382',
    trace: 'retain-on-failure',
  },
})
