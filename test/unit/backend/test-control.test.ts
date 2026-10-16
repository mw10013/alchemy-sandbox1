import { assert, describe, it } from "@effect/vitest";
import { RuntimeContext } from "alchemy";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcTest from "effect/rpc/RpcTest";
import * as Schema from "effect/Schema";
import { EmailFromInput } from "../../../src/contract/auth.ts";
import { type Member } from "../../../src/contract/members.ts";
import { SEED_SHOP, ShopKey } from "../../../src/contract/shop.ts";
import { E2eEmail, TestControlRpcs } from "../../../src/contract/test-control.ts";
import { type ShopSessionRow } from "../../../src/backend/shop-sessions.ts";
import { QuietLogs, testAuth, testShopify } from "./layers.ts";
import { SentMail } from "../../../src/backend/mailer.ts";
import { ShopActors } from "../../../src/backend/shop-actors.ts";
import {
  TestControlAuthLive,
  TestControlHandlers,
  TestControlToken,
} from "../../../src/backend/test-control.ts";

const TOKEN = "t";
const email = Schema.decodeUnknownSync(EmailFromInput);

const member = email("m1@m.com");
const stranger = email("nobody@example.com");
const session: ShopSessionRow = {
  shop: SEED_SHOP,
  shopGid: "gid://shopify/Shop/1",
  shopAgentId: SEED_SHOP,
  scope: "read_orders,read_products",
  accessTokenExpiresAt: 1_900_000_000_000,
  accessToken: "shpat_secret_access",
  refreshToken: "shprt_secret_refresh",
  refreshTokenExpiresAt: 1_900_000_000_000,
  planHandle: null,
  planHandleExpiresAt: null,
  planBoundaryAt: null,
};
const members: ReadonlyArray<Member> = [
  { id: "mem-1", shop: SEED_SHOP, email: member, createdAt: 1 },
];

/** What test control asked the actors to revoke; cleared by the tests that read it. */
const revoked: Array<{ key: ShopKey; by: "member" | "session"; id: string }> = [];

/**
 * The test-control handlers and token middleware over Better Auth on an in-memory database,
 * fresh per test, under the given {@link MagicLinkDelivery}.
 */
const TestBackend = (delivery: "inline" | "mailed" = "inline") =>
  Layer.mergeAll(TestControlHandlers, TestControlAuthLive).pipe(
    Layer.provideMerge(
      testAuth({
        members,
        actors: ShopActors.layerTest(revoked),
        delivery,
        extra: Layer.mergeAll(testShopify([session]), Layer.succeed(TestControlToken, TOKEN)),
      }),
    ),
    Layer.provide(RuntimeContext.phantom),
    Layer.provide(QuietLogs),
  );

const authorized = RpcClient.withHeaders({ "x-e2e-token": TOKEN });

describe("test control", () => {
  it.live.each([
    { name: "no token", headers: {} },
    { name: "a wrong token", headers: { "x-e2e-token": "wrong" } },
  ])("a call with $name is TestControlUnauthorized", ({ headers }) =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(TestControlRpcs);
      const error = yield* client
        .IssueMagicLink({ email: member })
        .pipe(RpcClient.withHeaders(headers), Effect.flip);
      assert.strictEqual(error._tag, "TestControlUnauthorized");
    }).pipe(Effect.provide(TestBackend())),
  );

  it.live("IssueMagicLink returns the link and mails nothing", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(TestControlRpcs);
      const { link } = yield* client.IssueMagicLink({ email: member }).pipe(authorized);
      assert.strictEqual(new URL(link).pathname, "/api/auth/magic-link/verify");
      assert.deepStrictEqual(yield* Ref.get(yield* SentMail), []);
    }).pipe(Effect.provide(TestBackend())),
  );

  it.live("IssueMagicLink dies on a stage that mails its links", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(TestControlRpcs);
      const exit = yield* client.IssueMagicLink({ email: member }).pipe(authorized, Effect.exit);
      assert.isTrue(Exit.isFailure(exit) && Cause.hasDies(exit.cause));
      const sent = yield* Ref.get(yield* SentMail);
      assert.deepStrictEqual(
        sent.map((mail) => mail.to),
        [member],
      );
    }).pipe(Effect.provide(TestBackend("mailed"))),
  );

  it.live("IssueMagicLink for a non-member dies", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(TestControlRpcs);
      const exit = yield* client.IssueMagicLink({ email: stranger }).pipe(authorized, Effect.exit);
      assert.isTrue(Exit.isFailure(exit) && Cause.hasDies(exit.cause));
    }).pipe(Effect.provide(TestBackend())),
  );

  it.live("AddMember adds a member once; RemoveMember removes it once and revokes", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(TestControlRpcs);
      const address = Schema.decodeUnknownSync(E2eEmail)("new@e2e.test");
      const added = yield* client.AddMember({ shop: SEED_SHOP, email: address }).pipe(authorized);
      assert.strictEqual(added.email, address);
      assert.strictEqual(added.shop, SEED_SHOP);
      const again = yield* client
        .AddMember({ shop: SEED_SHOP, email: address })
        .pipe(authorized, Effect.flip);
      assert.strictEqual(again._tag, "MemberExists");
      revoked.length = 0;
      const removed = yield* client
        .RemoveMember({ shop: SEED_SHOP, email: address })
        .pipe(authorized);
      assert.isTrue(removed.removed);
      assert.deepStrictEqual(revoked, [{ key: SEED_SHOP, by: "member", id: added.id }]);
      const gone = yield* client.RemoveMember({ shop: SEED_SHOP, email: address }).pipe(authorized);
      assert.isFalse(gone.removed);
    }).pipe(Effect.provide(TestBackend())),
  );

  it.live("GetShopSession returns the non-secret fields, or null for a shop without one", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(TestControlRpcs);
      const found = yield* client.GetShopSession({ shop: SEED_SHOP }).pipe(authorized);
      assert.deepStrictEqual(found, {
        shopGid: "gid://shopify/Shop/1",
        scope: "read_orders,read_products",
        accessTokenExpiresAt: 1_900_000_000_000,
      });
      assert.notInclude(JSON.stringify(found), "secret");
      const other = Schema.decodeUnknownSync(ShopKey)("other-shop.myshopify.com");
      assert.isNull(yield* client.GetShopSession({ shop: other }).pipe(authorized));
    }).pipe(Effect.provide(TestBackend())),
  );
});
