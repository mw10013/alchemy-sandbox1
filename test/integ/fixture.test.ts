import { assert } from "@effect/vitest";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { RpcClient } from "effect/rpc";
import { FixtureRpcs, ShopFixtureData } from "../../src/contract/fixture.ts";
import { ShopKey } from "../../src/contract/shop.ts";
import {
  CONNECTION_CLOSE_NOT_A_MEMBER,
  CONNECTION_CLOSE_REVOKED,
} from "../../src/contract/shop-actor.ts";
import { OTHER_SHOP, SEED_SHOP } from "../seed-shops.ts";
import { connectAs, email, nextCloseCode, signIn } from "./actor-clients.ts";
import Stack from "./stack.ts";

/**
 * `LoadFixture` against a real Backend, D1 and actor: it replaces one shop's rows, answers the
 * counts it reads back, refuses a shop with no session, revokes the members it replaced, and
 * leaves every other shop alone.
 */
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

/**
 * A fresh stage per file, destroyed afterwards (see `auth.test.ts`), so this file's loads never
 * reach another file and `seed/test.sql`'s rows need no restoring.
 */
const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

const m1 = email("m1@m.com");
const m2 = email("m2@m.com");

const data = Schema.decodeUnknownSync(ShopFixtureData)({
  members: ["m1@m.com", "fixture-a@e2e.test", "fixture-b@e2e.test"],
  teams: [
    { name: "Engraving", members: ["m1@m.com", "fixture-a@e2e.test"] },
    { name: "Nobody", members: [] },
  ],
  workflows: [
    {
      name: "Engrave",
      tag: "engraved",
      tasks: [
        { name: "Cut", team: "Engraving" },
        { name: "Engrave", team: "Engraving" },
      ],
      draft: { tasks: [{ name: "Cut", team: null }] },
    },
    { name: "Off", tag: "off", tasks: [] },
  ],
  orders: [
    {
      n: 1201,
      after: { fulfillmentStatus: "FULFILLED" },
      lineItems: [{ title: "Board", quantity: 1, tags: ["engraved"] }],
    },
    {
      n: 1202,
      note: "Gift",
      lineItems: [
        {
          title: "Board",
          quantity: 2,
          tags: ["engraved"],
          properties: [{ key: "a", value: null }],
        },
        { title: "Card", quantity: 1, tags: [] },
      ],
    },
  ],
});

/** One `LoadFixture` call, straight at the Backend, as `vp run fixture` makes it through the Website. */
const load = (backendUrl: string, shop: ShopKey) =>
  Effect.gen(function* () {
    const client = yield* RpcClient.make(FixtureRpcs);
    return yield* client.LoadFixture({ shop, fixture: data });
  }).pipe(Effect.scoped, Effect.provide(Test.rpcClientLayer(`${backendUrl}/api/dev/fixture`)));

const counts = { members: 3, teams: 2, workflows: 2, orders: 2, lineItems: 3 };

test(
  "LoadFixture revokes the shop's replaced members and leaves other shops alone",
  Effect.gen(function* () {
    const { backendUrl, e2eToken } = yield* stack;
    // First in the file, while `seed/test.sql`'s members are still there, and signed in before
    // the load: once it drops m2 from its one shop, m2 could not sign in at all.
    const m1Cookie = yield* signIn(backendUrl, e2eToken, m1);
    const m2Cookie = yield* signIn(backendUrl, e2eToken, m2);
    yield* Effect.gen(function* () {
      const before = yield* connectAs(backendUrl, SEED_SHOP, { cookie: m2Cookie });
      yield* before.client.MemberWhoAmI();
      yield* load(backendUrl, SEED_SHOP);
      assert.strictEqual(yield* nextCloseCode(before.closes), CONNECTION_CLOSE_REVOKED);
      // The reconnect goes back through the gate, and m2 is no longer a member.
      assert.strictEqual(yield* nextCloseCode(before.closes), CONNECTION_CLOSE_NOT_A_MEMBER);
    }).pipe(Effect.scoped);
    yield* Effect.gen(function* () {
      const other = yield* connectAs(backendUrl, OTHER_SHOP, { cookie: m1Cookie });
      assert.strictEqual((yield* other.client.MemberWhoAmI()).role, "member");
    }).pipe(Effect.scoped);
    yield* Effect.gen(function* () {
      const refused = yield* connectAs(backendUrl, OTHER_SHOP, { cookie: m2Cookie });
      assert.strictEqual(yield* nextCloseCode(refused.closes), CONNECTION_CLOSE_NOT_A_MEMBER);
    }).pipe(Effect.scoped);
  }),
);

test(
  "LoadFixture replaces a shop's rows, again and again, and answers the counts",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    assert.deepStrictEqual(yield* load(backendUrl, SEED_SHOP), counts);
    assert.deepStrictEqual(yield* load(backendUrl, SEED_SHOP), counts);
  }),
);

test(
  "LoadFixture fails with ShopNotInstalled for a shop with no session",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    const shop = Schema.decodeUnknownSync(ShopKey)("not-installed.myshopify.com");
    const error = yield* load(backendUrl, shop).pipe(Effect.flip);
    assert.strictEqual(error._tag, "ShopNotInstalled");
  }),
);
