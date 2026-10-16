import * as Schema from "effect/Schema";
import type { BrowserContext, Page } from "playwright/test";

import { ShopKey } from "../../../src/contract/shop.ts";
import { control, expect, test } from "../fixtures.ts";
import { gotoApp, openApp } from "./app.ts";

/**
 * The Backend's own Admin calls on the e2e store, against Shopify itself: the refresh grant with
 * no merchant present, one refresh under concurrent calls, and Shopify's real answer to a dead
 * refresh token. The tests run in order and share one store row, so `workers: 1` keeps the
 * other embedded specs off it.
 */
test.describe.configure({ mode: "serial" });

const shop = Schema.decodeUnknownSync(ShopKey)(`${process.env.SHOPIFY_E2E_STORE}.myshopify.com`);

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

let context: BrowserContext;
let page: Page;

test.beforeAll(async ({ browser }) => {
  ({ context, page } = await openApp(browser));
});

/**
 * Whatever the tests did, leave a live session: a reload exchanges when the stored token is not
 * fresh, and a failed `invalidate` test would otherwise leave a dead refresh token that breaks
 * the next run. Serial mode skips the remaining tests after a failure, so this cannot be a test.
 */
test.afterAll(async ({ backend }) => {
  const answer = await gotoApp(page)
    .then(() => backend(control((c) => c.PingAdmin({ shop }))))
    .finally(() => context.close());
  expect(answer).toMatchObject({ ok: expect.stringMatching(/^gid:\/\/shopify\/Shop\/\d+$/u) });
});

test("an expired token refreshes and the Admin call succeeds", async ({ backend }) => {
  const before = await backend(control((c) => c.GetShopSession({ shop })));
  await backend(control((c) => c.ExpireAccessToken({ shop, refreshToken: "keep" })));
  const answer = await backend(control((c) => c.PingAdmin({ shop })));
  expect(answer).toMatchObject({ ok: expect.stringMatching(/^gid:\/\/shopify\/Shop\/\d+$/u) });
  const after = await backend(control((c) => c.GetShopSession({ shop })));
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

test("five parallel pings all succeed, and a second refresh still works", async ({ backend }) => {
  await backend(control((c) => c.ExpireAccessToken({ shop, refreshToken: "keep" })));
  const answers = await Promise.all(
    Array.from({ length: 5 }, () => backend(control((c) => c.PingAdmin({ shop })))),
  );
  for (const answer of answers) expect(answer).toHaveProperty("ok");
  await backend(control((c) => c.ExpireAccessToken({ shop, refreshToken: "keep" })));
  expect(await backend(control((c) => c.PingAdmin({ shop })))).toHaveProperty("ok");
});

test("reloading the embedded app reuses the refreshed row without an exchange", async ({
  backend,
}) => {
  const before = await backend(control((c) => c.GetShopSession({ shop })));
  await gotoApp(page);
  const after = await backend(control((c) => c.GetShopSession({ shop })));
  expect(after?.accessTokenExpiresAt).toBe(before?.accessTokenExpiresAt);
});

test("a rejected refresh token is ReauthorizationRequired, Shopify's real 401", async ({
  backend,
}) => {
  await backend(control((c) => c.ExpireAccessToken({ shop, refreshToken: "invalidate" })));
  expect(await backend(control((c) => c.PingAdmin({ shop })))).toStrictEqual({
    error: "ReauthorizationRequired",
    reason: "refresh-token-rejected",
  });
});

test("reloading the embedded app exchanges and restores the session", async ({ backend }) => {
  await gotoApp(page);
  expect(await backend(control((c) => c.PingAdmin({ shop })))).toHaveProperty("ok");
});
