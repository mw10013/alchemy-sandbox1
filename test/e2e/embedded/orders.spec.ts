import type { BrowserContext, FrameLocator, Page } from "playwright/test";

import { dev, expect, test } from "../fixtures.ts";
import { E2E_SHOP as shop } from "../shop-fixture.ts";
import { gotoApp, openApp } from "./app.ts";
import { cancelTestOrder, createTestOrder, type TestOrder } from "./test-orders.ts";

/**
 * The orders screen against Shopify itself, on one real order the spec creates on the e2e store
 * ({@link createTestOrder}): it arrives by webhook; taken off the screen with the dev door's
 * `RemoveOrder`, only Sync open orders can bring it back, and does; cancelled in Shopify, its row
 * follows. The order is open and recent until the last case, so the open-orders sync's 30-day
 * query includes it.
 */
test.describe.configure({ mode: "serial" });

/** How long Sync open orders may take: Shopify's bulk export plus the stream, at worst. */
const SYNC_TIMEOUT = 180_000;

/**
 * How long a removed row must stay off the screen before the sync. Shopify sends several webhooks
 * within seconds of the create, and any of them stores the order again; once the row has stayed
 * away this long they are done, so a row that reappears after the press came from the sync.
 */
const QUIET = 10_000;

let context: BrowserContext;
let page: Page;
let frame: FrameLocator;
let order: TestOrder | undefined;
let cancelled = false;

test.beforeAll(async ({ browser }) => {
  ({ context, page } = await openApp(browser));
  frame = await gotoApp(page, "app/orders");
});

test.afterAll(async () => {
  try {
    if (order !== undefined && !cancelled) await cancelTestOrder(order);
  } finally {
    await context.close();
  }
});

/** The screen's row for the spec's order. */
const row = () => frame.locator("s-table-row", { hasText: order?.name ?? "(no order yet)" });

test("the orders screen shows an order Shopify sends by webhook", async () => {
  order = await createTestOrder();
  await expect(row()).toBeVisible({ timeout: 60_000 });
  await expect(row().getByText("Paid")).toBeVisible();
});

test("Sync open orders brings back an open order the screen no longer lists", async ({
  backend,
}) => {
  test.setTimeout(SYNC_TIMEOUT + 120_000);
  const orderId = order?.id ?? "";
  // Removed again whenever a late webhook brought the row back, until it stays away.
  await expect
    .poll(
      async () => {
        await backend(dev((c) => c.RemoveOrder({ shop, orderId })));
        await expect(row()).toHaveCount(0);
        await page.waitForTimeout(QUIET);
        return row().count();
      },
      { timeout: 60_000, intervals: [0] },
    )
    .toBe(0);

  await page.getByRole("button", { name: "Sync open orders" }).click();
  await expect(page.getByText("Syncing open orders").first()).toBeVisible();
  await expect(row()).toBeVisible({ timeout: SYNC_TIMEOUT });
  await expect(row().getByText("Paid")).toBeVisible();
  await expect(frame.getByText(/^Step failed/u)).toHaveCount(0);
});

test("a cancelled order shows Cancelled", async () => {
  if (order !== undefined) await cancelTestOrder(order);
  cancelled = true;
  await expect(row().getByText("Cancelled")).toBeVisible({ timeout: 60_000 });
});
