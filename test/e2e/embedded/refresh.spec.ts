import type { BrowserContext, FrameLocator, Page } from "playwright/test";

import { dev, expect, type Run, test } from "../fixtures.ts";
import { E2E_SHOP as shop } from "../shop-fixture.ts";
import { gotoApp, openApp } from "./app.ts";

/**
 * The Backend's own Admin calls on the e2e store, against Shopify itself: the refresh grant with
 * no merchant present, one refresh under concurrent calls, and Shopify's real answer to a dead
 * refresh token. Each call is a press of Sync from Shopify on the orders screen, on an order the
 * spec adds with `AddToFixture`: Shopify answers null for its id, so a press that reaches Shopify
 * toasts Gone, and since the session is ensured before the fetch, the refresh has happened by
 * then. No order is written to the store, so the spec needs no order scopes. The tests run in
 * order and share one store row, so `workers: 1` keeps the other embedded specs off it.
 */
test.describe.configure({ mode: "serial" });

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;
const GONE = "Shopify no longer has this order";
const REAUTHORIZE = "Couldn't reach Shopify. Reload Baton to reconnect.";

/** The spec's own order numbers, unique per run, so a reused server's earlier run never clashes. */
const first = 900_000_000 + (Date.now() % 90_000_000);
const numbers = Array.from({ length: 5 }, (_, i) => first + i);

let context: BrowserContext;
let page: Page;
let frame: FrameLocator;

const gotoOrders = async () => {
  frame = await gotoApp(page, "app/orders");
};

/** Presses Sync from Shopify on order `n`. */
const press = (n: number) => frame.getByRole("button", { name: `Sync #${n} from Shopify` }).click();

test.beforeAll(async ({ browser, backend }) => {
  await backend(
    dev((c) =>
      c.AddToFixture({
        shop,
        fixture: {
          members: [],
          teams: [],
          workflows: [],
          orders: numbers.map((n) => ({ n, lineItems: [] })),
        },
      }),
    ),
  );
  ({ context, page } = await openApp(browser));
  await gotoOrders();
});

/** The stored access token's expiry, once it is past `after`: the refresh or exchange landed. */
const refreshedAfter = async (backend: Run, after: number) => {
  await expect
    .poll(
      async () =>
        (await backend(dev((c) => c.GetShopSession({ shop }))))?.accessTokenExpiresAt ?? 0,
    )
    .toBeGreaterThan(after);
  return backend(dev((c) => c.GetShopSession({ shop })));
};

/**
 * Whatever the tests did, leave a live session: a reload exchanges when the stored token is not
 * fresh, and a failed `invalidate` test would otherwise leave a dead refresh token that breaks
 * the next run. Serial mode skips the remaining tests after a failure, so this cannot be a test.
 */
test.afterAll(async ({ backend }) => {
  await gotoOrders()
    .then(() => refreshedAfter(backend, Date.now()))
    .finally(() => context.close());
});

test("an expired token refreshes and the Admin call succeeds", async ({ backend }) => {
  const before = await backend(dev((c) => c.GetShopSession({ shop })));
  await backend(dev((c) => c.ExpireShopSession({ shop, refreshToken: "keep" })));
  await press(first);
  await expect(page.getByText(GONE).first()).toBeVisible();
  const after = await refreshedAfter(backend, Date.now());
  const now = Date.now();
  expect(Math.abs((after?.accessTokenExpiresAt ?? 0) - (now + HOUR))).toBeLessThan(5 * MINUTE);
  expect(after?.refreshTokenExpiresAt ?? 0).toBeGreaterThan(now + MINUTE);
  expect(after?.refreshLeaseUntil).toBeNull();
  // Shopify says a refresh "can shorten" the successor's lifetime, so only record the values.
  test.info().annotations.push({
    type: "refreshTokenExpiresAt",
    description: `before=${before?.refreshTokenExpiresAt} after=${after?.refreshTokenExpiresAt}`,
  });
});

test("five parallel syncs all succeed, and a second refresh still works", async ({ backend }) => {
  await backend(dev((c) => c.ExpireShopSession({ shop, refreshToken: "keep" })));
  await Promise.all(numbers.map((n) => press(n)));
  const after = await refreshedAfter(backend, Date.now());
  expect(after?.refreshLeaseUntil).toBeNull();
  await expect(page.getByText(GONE).first()).toBeVisible();
  await expect(page.getByText(REAUTHORIZE)).toHaveCount(0);
  await backend(dev((c) => c.ExpireShopSession({ shop, refreshToken: "keep" })));
  await press(first);
  await refreshedAfter(backend, Date.now());
});

test("reloading the embedded app reuses the refreshed row without an exchange", async ({
  backend,
}) => {
  const before = await backend(dev((c) => c.GetShopSession({ shop })));
  await gotoOrders();
  const after = await backend(dev((c) => c.GetShopSession({ shop })));
  expect(after?.accessTokenExpiresAt).toBe(before?.accessTokenExpiresAt);
});

test("a rejected refresh token is ReauthorizationRequired, Shopify's real 401", async ({
  backend,
}) => {
  await backend(dev((c) => c.ExpireShopSession({ shop, refreshToken: "invalidate" })));
  const expired = await backend(dev((c) => c.GetShopSession({ shop })));
  await press(first);
  await expect(page.getByText(REAUTHORIZE).first()).toBeVisible();
  const after = await backend(dev((c) => c.GetShopSession({ shop })));
  expect(after?.accessTokenExpiresAt).toBe(expired?.accessTokenExpiresAt);
});

test("reloading the embedded app exchanges and restores the session", async ({ backend }) => {
  await gotoOrders();
  await refreshedAfter(backend, Date.now());
  await press(first);
  await expect(page.getByText(GONE).first()).toBeVisible();
});
