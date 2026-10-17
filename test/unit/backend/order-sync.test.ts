import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import {
  type LineItemNode,
  type OrderNode,
  OrderSyncResponse,
  orderSyncVariables,
  toOrderLineItems,
  toShopOrder,
} from "../../../src/backend/order-sync.ts";
import { ShopLimits } from "../../../src/domain/platform.ts";
import recorded from "./fixtures/order-sync-response.json";

/**
 * The mapping both sync paths store through, and the decode of an `OrderSync` answer. The
 * recorded answer is in the Admin API's documented shape for 2026-10 (the `data` envelope and the
 * cost extension included), written by hand: no response has been recorded from a store yet.
 */

const SHOP = "a-shop.myshopify.com";

/** Each warning and error logged, with its annotations. */
const capturing = (logged: Array<{ message: unknown; annotations: Record<string, unknown> }>) =>
  Logger.layer([
    Logger.make(({ message, logLevel, fiber }) => {
      if (logLevel !== "Warn" && logLevel !== "Error") return;
      logged.push({
        message: Array.isArray(message) ? message[0] : message,
        annotations: fiber.getRef(References.CurrentLogAnnotations),
      });
    }),
  ]);

const aNode = (overrides: Partial<OrderNode> = {}): OrderNode => ({
  id: "gid://shopify/Order/1",
  legacyResourceId: "1",
  name: "#1001",
  processedAt: 1000,
  updatedAt: 2000,
  cancelledAt: null,
  displayFulfillmentStatus: "UNFULFILLED",
  fullyPaid: true,
  note: null,
  ...overrides,
});

const aLineItemNode = (n: number, overrides: Partial<LineItemNode> = {}): LineItemNode => ({
  id: `gid://shopify/LineItem/${String(n)}`,
  title: `Item ${String(n)}`,
  variantTitle: null,
  sku: null,
  quantity: 1,
  currentQuantity: 1,
  customAttributes: [],
  product: { tags: ["engraved"] },
  ...overrides,
});

describe("OrderSync", () => {
  it("decodes a recorded OrderSync answer: times to epoch ms, the item page, null product", () => {
    const { order } = Schema.decodeUnknownSync(OrderSyncResponse)(recorded.data);
    assert.isNotNull(order);
    if (order === null) return;
    assert.strictEqual(order.processedAt, Date.parse("2026-10-14T15:02:11Z"));
    assert.strictEqual(order.updatedAt, Date.parse("2026-10-15T09:30:45Z"));
    assert.strictEqual(order.cancelledAt, null);
    assert.strictEqual(order.lineItems.pageInfo.hasNextPage, false);
    assert.strictEqual(order.lineItems.nodes.length, 2);
    assert.strictEqual(order.lineItems.nodes[1]?.product, null);
  });

  it("decodes an order Shopify no longer has as null", () => {
    assert.deepStrictEqual(Schema.decodeUnknownSync(OrderSyncResponse)({ order: null }), {
      order: null,
    });
  });

  it("refuses an answer whose updatedAt is not a date", () => {
    const order = { ...recorded.data.order, updatedAt: "yesterday" };
    assert.throws(() => Schema.decodeUnknownSync(OrderSyncResponse)({ order }));
  });

  it("asks for one page of the line-item ceiling", () => {
    assert.deepStrictEqual(orderSyncVariables("gid://shopify/Order/1"), {
      id: "gid://shopify/Order/1",
      lineItems: ShopLimits.maxLineItemsPerOrder,
    });
  });

  it("toShopOrder maps the node and stamps syncedAt", () => {
    assert.deepStrictEqual(
      toShopOrder({ node: aNode({ note: "Rush", cancelledAt: 1500 }), syncedAt: 9000 }),
      {
        id: "gid://shopify/Order/1",
        legacyId: "1",
        name: "#1001",
        processedAt: 1000,
        updatedAt: 2000,
        cancelledAt: 1500,
        fulfillmentStatus: "UNFULFILLED",
        fullyPaid: true,
        note: "Rush",
        syncedAt: 9000,
      },
    );
  });

  it.effect("toOrderLineItems maps each item to the order, a null product to no tags", () =>
    Effect.gen(function* () {
      const items = yield* toOrderLineItems({
        shop: SHOP,
        orderId: "gid://shopify/Order/1",
        nodes: [
          aLineItemNode(1, { customAttributes: [{ key: "text", value: "Hello" }] }),
          aLineItemNode(2, { product: null, variantTitle: "Large", sku: "S-2" }),
        ],
      });
      assert.deepStrictEqual(items, [
        {
          id: "gid://shopify/LineItem/1",
          orderId: "gid://shopify/Order/1",
          title: "Item 1",
          variantTitle: null,
          sku: null,
          quantity: 1,
          currentQuantity: 1,
          productTags: ["engraved"],
          properties: [{ key: "text", value: "Hello" }],
        },
        {
          id: "gid://shopify/LineItem/2",
          orderId: "gid://shopify/Order/1",
          title: "Item 2",
          variantTitle: "Large",
          sku: "S-2",
          quantity: 1,
          currentQuantity: 1,
          productTags: [],
          properties: [],
        },
      ]);
    }),
  );

  it.effect(
    "toOrderLineItems keeps each item's properties that fit in 8 KB and logs the drops once per order",
    () =>
      Effect.gen(function* () {
        const logged: Array<{ message: unknown; annotations: Record<string, unknown> }> = [];
        const kept = { key: "text", value: "Hello" };
        const proof = { key: "proof", value: "x".repeat(ShopLimits.maxPropertiesBytesPerItem) };
        const items = yield* toOrderLineItems({
          shop: SHOP,
          orderId: "gid://shopify/Order/1",
          nodes: [
            aLineItemNode(1, { customAttributes: [kept, proof, { key: "after", value: "small" }] }),
            aLineItemNode(2, { customAttributes: [proof] }),
          ],
        }).pipe(Effect.provide(capturing(logged)));
        assert.deepStrictEqual(
          items.map(({ properties }) => properties),
          [[kept], []],
        );
        assert.deepStrictEqual(logged, [
          {
            message: `OrderSync.capProperties: shop=${SHOP} orderId=gid://shopify/Order/1 dropped=3`,
            annotations: {
              shop: SHOP,
              orderId: "gid://shopify/Order/1",
              dropped: 3,
              limit: ShopLimits.maxPropertiesBytesPerItem,
            },
          },
        ]);
      }),
  );

  it.effect("toOrderLineItems logs nothing when every property fits", () =>
    Effect.gen(function* () {
      const logged: Array<{ message: unknown; annotations: Record<string, unknown> }> = [];
      yield* toOrderLineItems({
        shop: SHOP,
        orderId: "gid://shopify/Order/1",
        nodes: [aLineItemNode(1, { customAttributes: [{ key: "a", value: null }] })],
      }).pipe(Effect.provide(capturing(logged)));
      assert.deepStrictEqual(logged, []);
    }),
  );
});
