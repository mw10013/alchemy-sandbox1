import { defineConfig, devices } from "playwright/test";
import process from "node:process";

import { e2ePortOf } from "./scripts/lib/worktree.ts";

process.loadEnvFile(".env");
const websitePort = Number(process.env.WEBSITE_PORT);
if (!Number.isInteger(websitePort))
  throw new Error("WEBSITE_PORT is not set; copy .env.example to .env");
/** The e2e server's port: above the dev server's, as the server's own script computes it. */
const port = e2ePortOf(websitePort);
const baseURL = process.env.PLAYWRIGHT_TEST_BASE_URL ?? `http://localhost:${port}`;
/**
 * The runner supplies the token; the stack binds it to the Backend. A deployed target sets it in
 * the environment.
 */
export const e2eToken = process.env.E2E_TOKEN ?? "e2e";

/**
 * Runs the e2e specs against the e2e server (`scripts/e2e-server.ts`): Shopify CLI on this
 * checkout's e2e store, serving the e2e stage on its own port. The server script destroys the
 * stage before starting it, so every run begins from the seed alone. A reused server keeps the
 * last run's data, so reuse is opt-in for iterating (`E2E_REUSE_SERVER=1`). `use.baseURL` is set
 * explicitly because Playwright derives it only from the deprecated `webServer.port`. With
 * `PLAYWRIGHT_TEST_BASE_URL` the specs run against that target and no server is started.
 */
export default defineConfig({
  testDir: "test/e2e",
  outputDir: "playwright/test-results",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [["html", { outputFolder: "playwright/report" }]] : "list",
  use: { baseURL, trace: "on-first-retry" },
  projects: [
    { name: "setup", testMatch: /.*\.setup\.ts/ },
    { name: "chromium", use: { ...devices["Desktop Chrome"] }, dependencies: ["setup"] },
  ],
  webServer: process.env.PLAYWRIGHT_TEST_BASE_URL
    ? undefined
    : {
        command: "vp run test:e2e:server",
        env: { E2E_TOKEN: e2eToken },
        url: `${baseURL}/`,
        reuseExistingServer: process.env.E2E_REUSE_SERVER === "1",
        timeout: 180_000,
        gracefulShutdown: { signal: "SIGTERM", timeout: 20_000 },
      },
});
