import { defineConfig, devices } from "playwright/test";
import process from "node:process";

process.loadEnvFile(".env");
const websitePort = Number(process.env.WEBSITE_PORT);
if (!Number.isInteger(websitePort))
  throw new Error("WEBSITE_PORT is not set; copy .env.example to .env");
/** The e2e stage's port. Worktrees take WEBSITE_PORT + NN with small NN, so +100 stays clear. */
const port = websitePort + 100;
const stage = `e2e_${process.env.USER ?? "unknown"}`;
const baseURL = process.env.PLAYWRIGHT_TEST_BASE_URL ?? `http://localhost:${port}`;
/** The runner supplies the token; the stack binds it to the Backend. A deployed target sets it in the environment. */
export const e2eToken = process.env.E2E_TOKEN ?? "e2e";

/**
 * Runs the e2e specs against an `alchemy dev` stack on its own stage and port, with local state.
 * `alchemy dev` reads `.env` itself and the process environment wins over it, so `WEBSITE_PORT`
 * here overrides the checkout's port for this server only. `use.baseURL` is set explicitly
 * because Playwright derives it only from the deprecated `webServer.port`. With
 * `PLAYWRIGHT_TEST_BASE_URL` the specs run against that target and no server is started.
 */
export default defineConfig({
  testDir: "e2e",
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
        command: "vp exec alchemy dev",
        env: {
          ALCHEMY_STAGE: stage,
          ALCHEMY_STATE: "local",
          WEBSITE_PORT: String(port),
          E2E_TOKEN: e2eToken,
        },
        url: `${baseURL}/`,
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
        gracefulShutdown: { signal: "SIGTERM", timeout: 20_000 },
      },
});
