import { assert, describe, it } from "@effect/vitest";
import { RuntimeContext } from "alchemy";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcTest from "effect/rpc/RpcTest";
import * as Schema from "effect/Schema";
import { EmailFromInput } from "../../../src/contract/auth.ts";
import { type Member } from "../../../src/contract/members.ts";
import { SEED_SHOP, ShopKey } from "../../../src/contract/shop.ts";
import { E2eEmail, TestControlRpcs } from "../../../src/contract/test-control.ts";
import { ShopSessions, type ShopSessionRow } from "../../../src/backend/shop-sessions.ts";
import { QuietLogs, testAuth, testShopify } from "./layers.ts";
import { jsonResponse, withShopifyStub } from "./shopify-stub.ts";
import { SentMail } from "../../../src/backend/mailer.ts";
import { ShopActors } from "../../../src/backend/shop-actors.ts";
import { ShopifyAdmin } from "../../../src/backend/shopify-admin.ts";
import { ShopifyFake } from "../../../src/backend/shopify-fake.ts";
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
  shopActorId: SEED_SHOP,
  scope: "read_orders,read_products",
  accessTokenExpiresAt: 1_900_000_000_000,
  accessToken: "shpat_secret_access",
  refreshToken: "shprt_secret_refresh",
  refreshTokenExpiresAt: 1_900_000_000_000,
  refreshLeaseUntil: null,
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
        extra: Layer.mergeAll(
          ShopifyAdmin.layer.pipe(Layer.provideMerge(testShopify([session]))),
          ShopifyFake.layer,
          Layer.succeed(TestControlToken, TOKEN),
        ),
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
        refreshTokenExpiresAt: 1_900_000_000_000,
        refreshLeaseUntil: null,
      });
      assert.notInclude(JSON.stringify(found), "secret");
      const other = Schema.decodeUnknownSync(ShopKey)("other-shop.myshopify.com");
      assert.isNull(yield* client.GetShopSession({ shop: other }).pipe(authorized));
    }).pipe(Effect.provide(TestBackend())),
  );
  it.live("ExpireAccessToken ages the token; invalidate also replaces the refresh token", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(TestControlRpcs);
      const before = Date.now();
      yield* client.ExpireAccessToken({ shop: SEED_SHOP, refreshToken: "keep" }).pipe(authorized);
      const kept = yield* client.GetShopSession({ shop: SEED_SHOP }).pipe(authorized);
      assert.isBelow(kept?.accessTokenExpiresAt ?? Infinity, before);
      assert.strictEqual(kept?.refreshTokenExpiresAt, 1_900_000_000_000);
      const sessions = yield* ShopSessions;
      const row = (yield* sessions.find(SEED_SHOP)).pipe(Option.getOrThrow);
      assert.strictEqual(row.refreshToken, "shprt_secret_refresh");
      yield* client
        .ExpireAccessToken({ shop: SEED_SHOP, refreshToken: "invalidate" })
        .pipe(authorized);
      const invalid = (yield* sessions.find(SEED_SHOP)).pipe(Option.getOrThrow);
      assert.match(invalid.refreshToken ?? "", /^shprt_invalid_/u);
    }).pipe(Effect.provide(TestBackend())),
  );

  it.live("PingAdmin answers the shop's id, and tokens never appear in an answer", () =>
    withShopifyStub(
      () => jsonResponse(200, { data: { shop: { id: "gid://shopify/Shop/1" } } }),
      (calls) =>
        Effect.gen(function* () {
          const client = yield* RpcTest.makeClient(TestControlRpcs);
          const answer = yield* client.PingAdmin({ shop: SEED_SHOP }).pipe(authorized);
          assert.deepStrictEqual(answer, { ok: "gid://shopify/Shop/1" });
          assert.strictEqual(calls.length, 1);
          assert.notInclude(JSON.stringify(answer), "shpat_");
        }),
    ).pipe(Effect.provide(TestBackend())),
  );

  it.live("PingAdmin encodes the failures as answers", () =>
    withShopifyStub(
      () => jsonResponse(401, { error: "invalid_request" }),
      () =>
        Effect.gen(function* () {
          const client = yield* RpcTest.makeClient(TestControlRpcs);
          const other = Schema.decodeUnknownSync(ShopKey)("other-shop.myshopify.com");
          assert.deepStrictEqual(yield* client.PingAdmin({ shop: other }).pipe(authorized), {
            error: "OfflineSessionMissing",
          });
          yield* client
            .ExpireAccessToken({ shop: SEED_SHOP, refreshToken: "invalidate" })
            .pipe(authorized);
          assert.deepStrictEqual(yield* client.PingAdmin({ shop: SEED_SHOP }).pipe(authorized), {
            error: "ReauthorizationRequired",
            reason: "refresh-token-rejected",
          });
        }),
    ).pipe(Effect.provide(TestBackend())),
  );

  it.live("ScriptShopify and ShopifyCalls are defects without the fake binding", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(TestControlRpcs);
      const script = yield* Effect.exit(client.ScriptShopify({ replies: [] }).pipe(authorized));
      assert.isTrue(Exit.isFailure(script) && Cause.hasDies(script.cause));
      const calls = yield* Effect.exit(client.ShopifyCalls({}).pipe(authorized));
      assert.isTrue(Exit.isFailure(calls) && Cause.hasDies(calls.cause));
    }).pipe(Effect.provide(TestBackend())),
  );
});
