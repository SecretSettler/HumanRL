import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  outputDir: ".cache/playwright/test-results",
  fullyParallel: false,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:3000",
  },
  webServer: {
    command: "pnpm --filter @intenttrace/web dev --hostname 127.0.0.1",
    url: "http://127.0.0.1:3000/healthz",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
