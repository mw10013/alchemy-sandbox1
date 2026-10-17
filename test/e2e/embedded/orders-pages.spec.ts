import type { BrowserContext, FrameLocator, Page } from "playwright/test";

import { FIXTURE_ORDER_PREFIX } from "../../../src/contract/fixture.ts";
import { dev, expect, test } from "../fixtures.ts";
import { E2E_SHOP as shop } from "../shop-fixture.ts";
import { gotoApp, openApp } from "./app.ts";

/**
 * The orders screen's pages inside the Shopify admin, over fixture orders the spec adds with
 * `AddToFixture`: 25 placed yesterday, then two older than anything else on the shop, an open one
 * and a cancelled one. Whatever else the other specs put on the shop (their few real orders are
 * newer), the two old ones sort past the first page and stay on the second.
 */
test.describe.configure({ mode: "serial" });

/** The spec's own order numbers, unique per run, so a reused server's earlier run never clashes. */
const first = 800_000_000 + (Date.now() % 90_000_000);
const recent = Array.from({ length: 25 }, (_, i) => first + i);
const olderOpen = first + 25;
const olderCancelled = first + 26;

let context: BrowserContext;
let page: Page;
let frame: FrameLocator;

test.beforeAll(async ({ browser, backend }) => {
  await backend(
    dev((c) =>
      c.AddToFixture({
        shop,
        fixture: {
          members: [],
          teams: [],
          workflows: [],
          orders: [
            ...recent.map((n) => ({ n, placedDaysAgo: 1, lineItems: [] })),
            { n: olderOpen, placedDaysAgo: 200, lineItems: [] },
            { n: olderCancelled, placedDaysAgo: 300, after: { cancelled: true }, lineItems: [] },
          ],
        },
      }),
    ),
  );
  ({ context, page } = await openApp(browser));
  frame = await gotoApp(page, "app/orders");
});

test.afterAll(async () => {
  await context.close();
});

/** The screen's row for fixture order `n`. */
const row = (n: number) => frame.locator("s-table-row", { hasText: `#${String(n)}` });

test("Next page shows the orders past the first 25, the fixture's cancelled order among them", async () => {
  await expect(row(recent[0] ?? first)).toBeVisible();
  await expect(frame.locator("s-table-row")).toHaveCount(25);
  await expect(row(olderCancelled)).toHaveCount(0);
  await frame.getByRole("link", { name: "Next page" }).click();
  await expect(row(olderCancelled).getByText("Cancelled")).toBeVisible();
  await expect(row(olderOpen)).toBeVisible();
});

test("a notice on the second page refetches the second page", async ({ backend }) => {
  const orderId = `gid://shopify/Order/${FIXTURE_ORDER_PREFIX}${String(olderOpen)}`;
  expect(await backend(dev((c) => c.RemoveOrder({ shop, orderId })))).toStrictEqual({
    removed: true,
  });
  await expect(row(olderOpen)).toHaveCount(0);
  await expect(row(olderCancelled).getByText("Cancelled")).toBeVisible();
});
