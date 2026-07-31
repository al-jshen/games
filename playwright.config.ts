import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests run against the *production* build served by the real server, on one origin, exactly
 * as deployed. Testing the Vite dev server instead would exercise a different asset pipeline and a
 * proxy that does not exist in production.
 */
const PORT = 8799;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // Build the web app, then serve it from the Node server so the app and its WebSocket share an
    // origin, as they do in production.
    command: `npm run --workspace @games/web build && SESSION_SECRET=playwright-secret-abcdefghijkl PORT=${PORT} DATA_DIR=.cache/e2e-data node apps/server/dist/main.js`,
    url: `http://127.0.0.1:${PORT}/healthz`,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
