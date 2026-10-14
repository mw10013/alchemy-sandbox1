import { assert, describe, it } from "@effect/vitest";
import {
  ConnectionMiddleware,
  RequireMember,
  RequireMerchant,
  ShopActorRpcs,
} from "../../../src/api/shop-actor.ts";

/** Each role's middleware and the name prefix its procedures carry. */
const roles = [
  { prefix: "Member", middleware: RequireMember },
  { prefix: "Merchant", middleware: RequireMerchant },
] as const;

describe("ShopActorRpcs surface", () => {
  it("every procedure has exactly one role, the connection middleware, and its role's prefix", () => {
    assert.isAbove(ShopActorRpcs.requests.size, 0);
    for (const [tag, rpc] of ShopActorRpcs.requests) {
      const middlewares: ReadonlySet<unknown> = rpc.middlewares;
      const own = roles.filter(({ middleware }) => middlewares.has(middleware));
      assert.lengthOf(own, 1, `${tag} has exactly one role middleware`);
      assert.isTrue(middlewares.has(ConnectionMiddleware), `${tag} has ConnectionMiddleware`);
      assert.strictEqual(middlewares.size, 2, `${tag} has no other middleware`);
      assert.isTrue(tag.startsWith(own[0]!.prefix), `${tag} starts with ${own[0]!.prefix}`);
    }
  });
});
