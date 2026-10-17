import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BrowserContext, FrameLocator, Page } from "playwright/test";
import * as Schema from "effect/Schema";

import { expect, test } from "../fixtures.ts";
import { gotoApp, openApp } from "./app.ts";

/**
 * The orders screen against Shopify itself: the spec creates its own order on the e2e store
 * (`scripts/test-order.ts`, a child process, since the runner is plain Node and the CLI's store
 * auth is the credential), sees it arrive by webhook, cancels it and sees the row follow, then
 * runs Sync open orders. The order is tagged with the test's id, so no other run's order is
 * mistaken for it. The store needs the one-time `shopify store auth` in the stores runbook.
 */
test.describe.configure({ mode: "serial" });

const run = promisify(execFile);

const CreatedOrder = Schema.fromJsonString(
  Schema.Struct({ id: Schema.String, name: Schema.String }),
);
const decodeCreated = Schema.decodeUnknownSync(CreatedOrder);

/** `scripts/test-order.ts <args>` on this checkout's `.env`; its last stdout line. */
const testOrder = async (...args: ReadonlyArray<string>) => {
  const { stdout } = await run("node", ["--env-file=.env", "scripts/test-order.ts", ...args]);
  return stdout.trim().split("\n").at(-1) ?? "";
};

let context: BrowserContext;
let page: Page;
let frame: FrameLocator;
let order: typeof CreatedOrder.Type;

test.beforeAll(async ({ browser }) => {
  ({ context, page } = await openApp(browser));
  frame = await gotoApp(page, "app/orders");
});

test.afterAll(async () => {
  await context.close();
});

/** The screen's row for the spec's order. */
const row = () => frame.locator("s-table-row", { hasText: order.name });

test("the orders screen shows an order Shopify sends by webhook", async () => {
  const { testId, retry } = test.info();
  order = decodeCreated(await testOrder("create", `e2e-${testId}-${retry}`));
  await expect(row()).toBeVisible({ timeout: 60_000 });
  await expect(row().getByText("Paid")).toBeVisible();
});

test("a cancelled order shows Cancelled", async () => {
  await testOrder("cancel", order.id);
  await expect(row().getByText("Cancelled")).toBeVisible({ timeout: 60_000 });
});

test("Sync open orders runs and the order stays listed", async () => {
  await page.getByRole("button", { name: "Sync open orders" }).click();
  await expect(page.getByRole("button", { name: "Sync open orders" })).toBeEnabled({
    timeout: 60_000,
  });
  await expect(row()).toBeVisible();
  await expect(frame.getByText(/^Step failed/u)).toHaveCount(0);
});
