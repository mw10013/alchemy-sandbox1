import { assert } from "@effect/vitest";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Vitest";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import type { ShopKey } from "../../src/contract/shop.ts";
import { ORDERS_KEY } from "../../src/contract/shop-actor.ts";
import type { LineItemNode, OrderNode } from "../../src/backend/order-sync.ts";
import { ShopLimits } from "../../src/domain/platform.ts";
import { OTHER_SHOP, SEED_SHOP } from "../seed-shops.ts";
import { dev, integ, openAs } from "./actor-clients.ts";
import { fileStage } from "./file-stage.ts";
import Stack from "./stack.ts";

/**
 * The shop actor's orders against a real Backend and actor: the stub methods the Backend calls
 * (`storeOrder`, `orderVersion`, `getOrder`, `listOrders`), the merchant's `MerchantListOrders`
 * and its notice. The repository's own rules are unit tests over the same schema.
 */
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  stage: fileStage("orders"),
});

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

const orderId = (n: number) => `gid://shopify/Order/${String(n)}`;
const lineItemId = (n: number) => `gid://shopify/LineItem/${String(n)}`;

/** A `storeOrder` answer. */
const answer = (written: boolean, fresh: boolean, changed: boolean, refused: boolean) => ({
  written,
  fresh,
  changed,
  refused,
});

/** An order as Shopify answers it, at `updatedAt`; a recent `processedAt`, so retention keeps it. */
const aNode = (n: number, updatedAt: number, overrides: Partial<OrderNode> = {}): OrderNode => ({
  id: orderId(n),
  legacyResourceId: String(n),
  name: `#${String(1000 + n)}`,
  processedAt: Date.now() - 86_400_000 + n,
  updatedAt,
  cancelledAt: null,
  displayFulfillmentStatus: "UNFULFILLED",
  fullyPaid: true,
  note: null,
  ...overrides,
});

const aLineItemNode = (n: number, overrides: Partial<LineItemNode> = {}): LineItemNode => ({
  id: lineItemId(n),
  title: `Item ${String(n)}`,
  variantTitle: null,
  sku: null,
  quantity: 1,
  currentQuantity: 1,
  customAttributes: [],
  product: { tags: ["engraved"] },
  ...overrides,
});

/** Empties `shop`'s orders (and its members and teams): a load of an empty fixture. */
const reset = (shop: ShopKey) =>
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    yield* dev(backendUrl, (c) =>
      c.LoadFixture({ shop, fixture: { members: [], teams: [], workflows: [], orders: [] } }),
    );
  });

const store = (shop: ShopKey, order: OrderNode, lineItems: ReadonlyArray<LineItemNode>) =>
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    return yield* integ(backendUrl, (c) => c.StoreOrder({ shop, order, lineItems }));
  });

const read = (shop: ShopKey, id: string) =>
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    return yield* integ(backendUrl, (c) => c.GetOrder({ shop, orderId: id }));
  });

const version = (shop: ShopKey, id: string, updatedAt: number | null) =>
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    return yield* integ(backendUrl, (c) => c.OrderVersion({ shop, orderId: id, updatedAt }));
  });

test(
  "storeOrder stores the order Shopify answered, and getOrder reads it back with its items",
  Effect.gen(function* () {
    yield* reset(SEED_SHOP);
    const stored = yield* store(SEED_SHOP, aNode(1, 2000, { note: "Rush" }), [
      aLineItemNode(1, { customAttributes: [{ key: "text", value: "Hello" }] }),
      aLineItemNode(2, { product: null }),
    ]);
    assert.deepStrictEqual(stored, answer(true, true, true, false));
    const detail = yield* read(SEED_SHOP, orderId(1));
    assert.isNotNull(detail);
    if (detail === null) return;
    assert.strictEqual(detail.order.name, "#1001");
    assert.strictEqual(detail.order.note, "Rush");
    assert.strictEqual(detail.order.fullyPaid, true);
    assert.isAbove(detail.order.syncedAt, 0);
    assert.deepStrictEqual(
      detail.lineItems.map(({ id, productTags, properties }) => ({ id, productTags, properties })),
      [
        {
          id: lineItemId(1),
          productTags: ["engraved"],
          properties: [{ key: "text", value: "Hello" }],
        },
        { id: lineItemId(2), productTags: [], properties: [] },
      ],
    );
    assert.isNull(yield* read(SEED_SHOP, orderId(99)));
  }),
);

test(
  "a multi-statement write completes under the actor's transaction",
  Effect.gen(function* () {
    yield* reset(SEED_SHOP);
    const items = Array.from({ length: 40 }, (_, i) => aLineItemNode(100 + i));
    const stored = yield* store(SEED_SHOP, aNode(2, 2000), items).pipe(
      Effect.timeout("10 seconds"),
    );
    assert.strictEqual(stored.written, true);
    assert.strictEqual((yield* read(SEED_SHOP, orderId(2)))?.lineItems.length, 40);
  }),
);

test(
  "storeOrder's version guard: an older copy is skipped, the same version rewritten, a newer one replaces the items",
  Effect.gen(function* () {
    yield* reset(SEED_SHOP);
    yield* store(SEED_SHOP, aNode(3, 2000), [aLineItemNode(1)]);
    const older = yield* store(SEED_SHOP, aNode(3, 1000, { name: "#STALE" }), [aLineItemNode(9)]);
    assert.deepStrictEqual(older, answer(false, false, false, false));
    assert.strictEqual((yield* read(SEED_SHOP, orderId(3)))?.order.name, "#1003");

    const equal = yield* store(SEED_SHOP, aNode(3, 2000, { note: "same version" }), [
      aLineItemNode(1),
    ]);
    assert.deepStrictEqual(equal, answer(true, false, false, false));
    assert.strictEqual((yield* read(SEED_SHOP, orderId(3)))?.order.note, "same version");

    const newer = yield* store(SEED_SHOP, aNode(3, 3000), [aLineItemNode(2), aLineItemNode(3)]);
    assert.deepStrictEqual(newer, answer(true, false, true, false));
    assert.deepStrictEqual(
      (yield* read(SEED_SHOP, orderId(3)))?.lineItems.map(({ id }) => id),
      [lineItemId(2), lineItemId(3)],
    );
  }),
);

test(
  "orderVersion skips a version not newer than the row, and fetches a newer one, an edit and a new order",
  Effect.gen(function* () {
    yield* reset(SEED_SHOP);
    yield* store(SEED_SHOP, aNode(4, 2000), []);
    assert.strictEqual(yield* version(SEED_SHOP, orderId(4), 1999), "stale");
    assert.strictEqual(yield* version(SEED_SHOP, orderId(4), 2000), "stale");
    assert.strictEqual(yield* version(SEED_SHOP, orderId(4), 2001), "fetch");
    assert.strictEqual(yield* version(SEED_SHOP, orderId(4), null), "fetch");
    assert.strictEqual(yield* version(SEED_SHOP, orderId(5), 1), "fetch");
  }),
);

test(
  "an item's properties past 8 KB are not stored and the order syncs",
  Effect.gen(function* () {
    yield* reset(SEED_SHOP);
    const kept = { key: "text", value: "Hello" };
    const stored = yield* store(SEED_SHOP, aNode(6, 2000), [
      aLineItemNode(1, {
        customAttributes: [
          kept,
          { key: "proof", value: "x".repeat(ShopLimits.maxPropertiesBytesPerItem) },
          { key: "after", value: "small" },
        ],
      }),
    ]);
    assert.strictEqual(stored.written, true);
    const detail = yield* read(SEED_SHOP, orderId(6));
    assert.strictEqual(detail?.lineItems.length, 1);
    assert.deepStrictEqual(detail?.lineItems[0]?.properties, [kept]);
  }),
);

/**
 * The ceiling is reached with real rows: `LoadFixture` stores {@link ShopLimits.maxOpenOrders}
 * open orders, so no limit is lowered for the test.
 */
test(
  "at the order ceiling a new order is refused before the fetch and by the write, and a stored one still updates",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    yield* dev(backendUrl, (c) =>
      c.LoadFixture({
        shop: OTHER_SHOP,
        fixture: {
          members: [],
          teams: [],
          workflows: [],
          orders: Array.from({ length: ShopLimits.maxOpenOrders }, (_, i) => ({
            n: i + 1,
            lineItems: [],
          })),
        },
      }),
    );
    assert.strictEqual(yield* version(OTHER_SHOP, orderId(7), 1), "refused");
    const refused = yield* store(OTHER_SHOP, aNode(7, 2000), []);
    assert.deepStrictEqual(refused, answer(false, false, false, true));
    assert.isNull(yield* read(OTHER_SHOP, orderId(7)));

    const fixtureOrder = "gid://shopify/Order/fixture-1";
    assert.strictEqual(yield* version(OTHER_SHOP, fixtureOrder, Date.now() + 60_000), "fetch");
    const update = yield* store(
      OTHER_SHOP,
      aNode(1, Date.now() + 60_000, { id: fixtureOrder, displayFulfillmentStatus: "FULFILLED" }),
      [],
    );
    assert.deepStrictEqual(update, answer(true, false, true, false));
    // Fulfilling one made room for one.
    assert.strictEqual(yield* version(OTHER_SHOP, orderId(7), 1), "fetch");
  }),
  { timeout: 60_000 },
);

test(
  "a merchant socket is told ORDERS_KEY when an order changes, and nothing on a same-version rewrite",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    yield* reset(SEED_SHOP);
    yield* Effect.gen(function* () {
      const merchant = yield* openAs(backendUrl, SEED_SHOP, { role: "merchant" });
      yield* merchant.client.MerchantWhoAmI();
      yield* store(SEED_SHOP, aNode(8, 2000), [aLineItemNode(1)]);
      const notice = yield* PubSub.take(merchant.received).pipe(Effect.timeout("5 seconds"));
      assert.deepStrictEqual(notice, { _tag: "ShopActorNotice", invalidated: [ORDERS_KEY] });

      const same = yield* store(SEED_SHOP, aNode(8, 2000), [aLineItemNode(1)]);
      assert.deepStrictEqual(same, answer(true, false, false, false));
      yield* Effect.sleep("500 millis");
      assert.strictEqual(yield* PubSub.remaining(merchant.received), 0, "no notice");
    }).pipe(Effect.scoped);
  }),
);

test(
  "MerchantListOrders and listOrders page newest first through a keyset cursor",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    yield* reset(SEED_SHOP);
    // Two orders in one millisecond: the id breaks the tie, newest id first.
    const at = Date.now() - 86_400_000;
    yield* store(SEED_SHOP, aNode(11, 1, { processedAt: at }), [aLineItemNode(11)]);
    yield* store(SEED_SHOP, aNode(12, 1, { processedAt: at + 10 }), []);
    yield* store(SEED_SHOP, aNode(13, 1, { processedAt: at + 10 }), []);
    yield* Effect.gen(function* () {
      const merchant = yield* openAs(backendUrl, SEED_SHOP, { role: "merchant" });
      const first = yield* merchant.client.MerchantListOrders({ limit: 2, cursor: null });
      assert.deepStrictEqual(
        first.orders.map(({ order }) => order.id),
        [orderId(13), orderId(12)],
      );
      assert.strictEqual(first.nextCursor, `${String(at + 10)}:${orderId(12)}`);
      const second = yield* integ(backendUrl, (c) =>
        c.ListOrders({ shop: SEED_SHOP, limit: 2, cursor: first.nextCursor }),
      );
      assert.deepStrictEqual(
        second.orders.map(({ order, lineItems }) => [order.id, lineItems.map(({ id }) => id)]),
        [[orderId(11), [lineItemId(11)]]],
      );
      assert.strictEqual(second.nextCursor, null);
    }).pipe(Effect.scoped);
  }),
);
