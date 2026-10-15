import { defineConfig, devices } from "playwright/test";
import * as Array from "effect/Array";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { readFileSync } from "node:fs";
import process from "node:process";

import { e2ePortOf } from "./scripts/lib/worktree.ts";

process.loadEnvFile(".env");
const websitePort = Number(process.env.WEBSITE_PORT);
if (!Number.isInteger(websitePort))
  throw new Error("WEBSITE_PORT is not set; copy .env.example to .env");
/** The e2e server's port: above the dev server's, as the server's own script computes it. */
const port = e2ePortOf(websitePort);
/**
 * The e2e server's own URL, or the deployed target's. The test-control client uses it in every
 * project, because the `embedded` project's `baseURL` is the Shopify admin.
 */
export const e2eServerURL = process.env.PLAYWRIGHT_TEST_BASE_URL ?? `http://localhost:${port}`;
/** Where the Shopify admin cookie export lives; it holds a login, so it stays under `playwright/.auth/`. */
export const storageStatePath = "playwright/.auth/shopify-admin.json";
/**
 * The runner supplies the token; the stack binds it to the Backend. A deployed target sets it in
 * the environment.
 */
export const e2eToken = process.env.E2E_TOKEN ?? "e2e";

const AppHandleLine = Schema.TemplateLiteralParser(['handle = "', Schema.String, '"']);
const decodeAppHandleLine = Schema.decodeUnknownOption(AppHandleLine);

/** The app's handle, from the `handle = "…"` line of `shopify.app.toml`, as `scripts/dev.ts` reads `client_id`. */
const appHandle = () =>
  Option.getOrThrowWith(
    Array.findFirst(readFileSync("shopify.app.toml", "utf8").split("\n"), (line) =>
      Option.map(decodeAppHandleLine(line.trim()), ([, handle]) => handle),
    ),
    () => new Error('shopify.app.toml has no handle = "<app handle>" line'),
  );

/** The app inside the e2e store's admin, where the `embedded` project opens it. */
const embeddedURL = () => {
  const store = process.env.SHOPIFY_E2E_STORE;
  if (!store) throw new Error("SHOPIFY_E2E_STORE is not set; see .env.example");
  return `https://admin.shopify.com/store/${store}/apps/${appHandle()}/app`;
};

/**
 * Runs the e2e specs against the e2e server (`scripts/e2e-server.ts`): Shopify CLI on this
 * checkout's e2e store, serving the e2e stage on its own port. The server script destroys the
 * stage before starting it, so every run begins from the seed alone. A reused server keeps the
 * last run's data, so reuse is opt-in for iterating (`E2E_REUSE_SERVER=1`). The top-level `use.baseURL` is set
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
  use: { baseURL: e2eServerURL, trace: "on-first-retry" },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    {
      name: "chromium",
      testIgnore: "**/embedded/**",
      use: { ...devices["Desktop Chrome"] },
      dependencies: ["setup"],
    },
    // The embedded project and its login exist only against the local e2e server: a deployed
    // target has no e2e store yet.
    ...(process.env.PLAYWRIGHT_TEST_BASE_URL
      ? []
      : [
          { name: "shopify-admin", testMatch: /shopify-admin\.setup\.ts/ },
          {
            name: "embedded",
            testMatch: "**/embedded/**/*.spec.ts",
            dependencies: ["shopify-admin"],
            // Per-file serial mode and one admin boot per file; files must not share a worker's page.
            fullyParallel: false,
            timeout: 60_000,
            expect: { timeout: 10_000 },
            use: {
              channel: "chrome",
              baseURL: embeddedURL(),
              storageState: storageStatePath,
              actionTimeout: 10_000,
              navigationTimeout: 30_000,
            },
          },
        ]),
  ],
  webServer: process.env.PLAYWRIGHT_TEST_BASE_URL
    ? undefined
    : {
        command: "vp run test:e2e:server",
        env: { E2E_TOKEN: e2eToken },
        url: `${e2eServerURL}/`,
        reuseExistingServer: process.env.E2E_REUSE_SERVER === "1",
        timeout: 180_000,
        gracefulShutdown: { signal: "SIGTERM", timeout: 20_000 },
      },
});
