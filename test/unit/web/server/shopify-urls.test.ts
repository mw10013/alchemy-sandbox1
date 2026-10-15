import { assert, describe, it } from "@effect/vitest";
import * as Option from "effect/Option";
import {
  embeddedAppUrl,
  exitIframeDestination,
  sessionTokenBounce,
} from "../../../../src/web/server/shopify-urls.ts";

const APP_URL = "https://example.trycloudflare.com";

/** Shopify's `host` param for `admin`, unpadded as Shopify sends it. */
const hostOf = (admin: string) => btoa(admin).replace(/=+$/u, "");

describe("embeddedAppUrl", () => {
  it.each([
    "admin.shopify.com/store/sandbox-shop-00",
    "admin.shopify.com/store/sandbox-shop-0",
    "sandbox-shop-00.myshopify.com/admin",
  ])("an admin host %s becomes the app inside that admin", (admin) => {
    assert.deepStrictEqual(
      embeddedAppUrl(hostOf(admin), "api-key"),
      Option.some(`https://${admin}/apps/api-key`),
    );
  });

  it("a padded host decodes too", () => {
    const admin = "admin.shopify.com/store/sandbox-shop-0";
    assert.isTrue(btoa(admin).endsWith("="));
    assert.isTrue(Option.isSome(embeddedAppUrl(btoa(admin), "api-key")));
  });

  it.each(["evil.example.com/store/x", "admin.shopify.com.evil.com/store/x", "not base64!"])(
    "anything else (%s) is none",
    (host) => {
      assert.isTrue(Option.isNone(embeddedAppUrl(hostOf(host), "api-key")));
      assert.isTrue(Option.isNone(embeddedAppUrl(host, "api-key")));
    },
  );
});

describe("sessionTokenBounce", () => {
  it("drops id_token and reloads the same path and search on the app URL", () => {
    const bounce = sessionTokenBounce(
      APP_URL,
      "/app",
      "?shop=sandbox-shop-00.myshopify.com&host=abc&embedded=1&id_token=secret",
    );
    const url = new URL(bounce, APP_URL);
    assert.strictEqual(url.pathname, "/auth/session-token");
    assert.isNull(url.searchParams.get("id_token"));
    assert.strictEqual(url.searchParams.get("shop"), "sandbox-shop-00.myshopify.com");
    assert.strictEqual(
      url.searchParams.get("shopify-reload"),
      `${APP_URL}/app?shop=sandbox-shop-00.myshopify.com&host=abc&embedded=1`,
    );
  });
});

describe("exitIframeDestination", () => {
  it.each([
    ["the app's own origin", `${APP_URL}/app?x=1`],
    ["a path, resolved on the app's origin", "/app"],
    [
      "Shopify Admin's pricing plans page",
      "https://admin.shopify.com/store/sandbox-shop-00/charges/baton/pricing_plans",
    ],
  ])("allows %s", (_, candidate) => {
    assert.isTrue(Option.isSome(exitIframeDestination(APP_URL, candidate)));
  });

  it.each([
    ["another origin", "https://evil.example.com/app"],
    ["credentials", "https://user:pass@example.trycloudflare.com/app"],
    [
      "a pricing page with a search",
      "https://admin.shopify.com/store/sandbox-shop-00/charges/baton/pricing_plans?x=1",
    ],
    ["another admin path", "https://admin.shopify.com/store/sandbox-shop-00/orders"],
    ["a javascript: URL", "javascript:alert(1)"],
  ])("refuses %s", (_, candidate) => {
    assert.isTrue(Option.isNone(exitIframeDestination(APP_URL, candidate)));
  });
});
