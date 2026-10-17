import { assert, describe, it } from "@effect/vitest";
import { isCrossSiteUpgrade } from "../../../../src/web/server/actor-upgrade.ts";

const URL_OF_SITE = "https://baton.example/api/actor/seed-shop.myshopify.com";

const upgrade = (origin?: string) =>
  new Request(URL_OF_SITE, {
    headers: { upgrade: "websocket", ...(origin === undefined ? {} : { origin }) },
  });

describe("isCrossSiteUpgrade", () => {
  it("an upgrade with no Origin is not cross-site", () => {
    assert.isFalse(isCrossSiteUpgrade(upgrade()));
  });

  it("an upgrade from this site is not cross-site", () => {
    assert.isFalse(isCrossSiteUpgrade(upgrade("https://baton.example")));
  });

  it.each(["https://evil.example", "http://baton.example", "https://baton.example:8443"])(
    "an upgrade from %s is cross-site",
    (origin) => {
      assert.isTrue(isCrossSiteUpgrade(upgrade(origin)));
    },
  );
});
