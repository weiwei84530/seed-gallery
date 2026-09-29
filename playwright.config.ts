import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  retries: 0,
  timeout: 40000,
  expect: { timeout: 10000 },
  workers: 2,
  use: {
    baseURL: 'http://127.0.0.1:43827',
    trace: 'retain-on-failure',
    serviceWorkers: 'block',
  },
  projects: [
    { name: 'android-chromium', use: { ...devices['Pixel 7'] } },
    { name: 'iphone-webkit', use: { ...devices['iPhone 13'] } },
  ],
  webServer: {
    command: 'npm run preview -- --port 43827 --strictPort',
    url: 'http://127.0.0.1:43827',
    reuseExistingServer: false,
  },
});
