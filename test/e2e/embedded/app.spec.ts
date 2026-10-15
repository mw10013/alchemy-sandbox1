import * as Schema from "effect/Schema";
import type { BrowserContext, FrameLocator } from "playwright/test";

import { ShopKey } from "../../../src/contract/shop.ts";
import { control, expect, test } from "../fixtures.ts";
import { openApp } from "./app.ts";

test.describe.configure({ mode: "serial" });

const shop = Schema.decodeUnknownSync(ShopKey)(`${process.env.SHOPIFY_E2E_STORE}.myshopify.com`);

let context: BrowserContext;
let frame: FrameLocator;

test.beforeAll(async ({ browser }) => {
  ({ context, frame } = await openApp(browser));
});

test.afterAll(async () => {
  await context.close();
});

test("the app loads embedded and shows the e2e store's domain", async () => {
  await expect(frame.getByText("We got here")).toBeVisible();
  await expect(frame.getByText(shop, { exact: true })).toBeVisible();
});

test("the exchange stored a real session", async ({ backend }) => {
  const session = await backend(control((c) => c.GetShopSession({ shop })));
  expect(session).not.toBeNull();
  expect(session?.shopGid).toMatch(/^gid:\/\/shopify\/Shop\/\d+$/u);
  expect(session?.scope).toBe("read_orders,read_products");
});
