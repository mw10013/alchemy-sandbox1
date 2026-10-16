import type { Browser, FrameLocator, Page } from "playwright/test";
import { expect } from "playwright/test";

import { storageStatePath } from "../../../playwright.config.ts";

/**
 * The embedded app's iframe: its `src` carries `embedded=1`; the Shopify admin's own chrome is the
 * top-level `page`. Re-resolved on every call on purpose: App Bridge re-renders the iframe during
 * navigation, so a captured `contentFrame()` handle detaches and throws, where a `frameLocator`
 * never does. `embedded=1` alone is not unique: an open `s-app-window` is a second embedded
 * iframe carrying it, and every locator built on that fails with a strict mode violation, so
 * `chrome=window` is excluded to keep this the app's own frame.
 */
export const appFrame = (page: Page): FrameLocator =>
  page.frameLocator('iframe[src*="embedded=1"]:not([src*="chrome=window"])');

/**
 * Waits until the document in `scope` is safe to interact with: the `data-hydrated` marker on
 * `<body>`, which flips in the commit that clears the body's `inert`. Playwright's actionability
 * is inert-blind, so a click inside an inert subtree passes every check and is silently
 * swallowed by the browser.
 */
export const awaitHydration = (scope: Page | FrameLocator, timeout?: number): Promise<void> =>
  scope.locator("body[data-hydrated]").waitFor({ state: "attached", timeout });

/**
 * Collapses the Shopify CLI's Dev Console panel if it is expanded. The panel is an admin-document
 * overlay over the lower half of the viewport that outranks the app's iframe in the top
 * document's hit test, so a click Playwright finds actionable inside the frame lands on the
 * console instead, and silently: the action reports success and the app never sees the event.
 * Whether it is expanded comes from the Shopify admin session the storage state was exported from, so it
 * varies between machines and runs; it is closed here rather than left to whoever opened it last.
 *
 * Expansion is read from the panel's geometry, not the toggle: the button keeps the name "Close
 * Dev Console" in both states and has no `aria-expanded`, so an unconditional click would
 * expand a collapsed console every other run. Collapsing slides the "Dev Console" heading below
 * the viewport. No heading means no console (a production-like admin), and nothing to do.
 */
export const closeDevConsole = async (page: Page): Promise<void> => {
  const heading = page.getByRole("heading", { name: "Dev Console" }).first();
  if ((await heading.count()) === 0) return;
  const expanded = () =>
    heading.evaluate((el) => el.getBoundingClientRect().bottom < globalThis.innerHeight);
  if (!(await expanded())) return;
  await page.getByRole("button", { name: "Close Dev Console" }).evaluate((el) => {
    (el as HTMLElement).click();
  });
  await expect.poll(expanded).toBe(false);
};

/**
 * Lands on the app's home and returns once it is safe to interact inside the iframe.
 *
 * `goto` waits for `"commit"`, not `"load"`: the Shopify admin SPA immediately client-redirects the app
 * route to re-run the embed handshake, and under `"load"` that redirect aborts the navigation
 * being awaited (`net::ERR_ABORTED`, intermittently). `"commit"` resolves before the redirect,
 * and the retrying hydration wait is the real gate.
 *
 * Local previews go through a Cloudflare quick tunnel, where a module request can stay pending
 * forever, leaving the server-rendered page visible while the client entry never hydrates. After
 * 15 s the Shopify admin document is reloaded once; the second wait is bounded by `actionTimeout`.
 */
export const gotoApp = async (page: Page, path = ""): Promise<FrameLocator> => {
  await page.goto(path, { waitUntil: "commit" });
  const frame = appFrame(page);
  await awaitHydration(frame, 15_000).catch(async () => {
    await page.reload({ waitUntil: "commit" });
    await awaitHydration(frame);
  });
  await closeDevConsole(page);
  return frame;
};

/**
 * Opens the embedded app once for a whole spec file: a context under the exported admin session,
 * one page, and {@link gotoApp}. Call it from `beforeAll` in a file set to serial mode, and close
 * the context in `afterAll`. One boot per file, because the boot (seconds, through the tunnel) is
 * the cost; serial mode is what makes the shared page safe, and after a failure Playwright skips
 * the rest of the file because the page may be in any state.
 */
export const openApp = async (browser: Browser) => {
  const context = await browser.newContext({ storageState: storageStatePath });
  const page = await context.newPage();
  return { context, page, frame: await gotoApp(page) };
};
