import { assert, describe, it } from "@effect/vitest";
import { fixture, skuOf } from "../../fixture.ts";

describe("the dev fixture", () => {
  it("decodes, with the showcase's people and workflows", () => {
    assert.strictEqual(fixture.members.length, 7);
    assert.strictEqual(fixture.teams.length, 8);
    assert.strictEqual(fixture.workflows.length, 8);
  });

  it("has 42 orders numbered #1201 to #1242, oldest first", () => {
    assert.deepStrictEqual(
      fixture.orders.map((order) => order.n),
      Array.from({ length: 42 }, (_, index) => 1201 + index),
    );
    assert.strictEqual(fixture.orders[0]?.placedDaysAgo, 10);
    assert.strictEqual(fixture.orders.at(-1)?.placedDaysAgo, 0);
  });

  it("has 47 line items", () => {
    assert.strictEqual(fixture.orders.flatMap((order) => order.lineItems).length, 47);
  });

  it("closes #1201 as fulfilled and #1202 as cancelled", () => {
    assert.strictEqual(fixture.orders[0]?.after?.fulfillmentStatus, "FULFILLED");
    assert.strictEqual(fixture.orders[1]?.after?.cancelled, true);
  });

  it("gives the gift set's and the weekend workflow their literal tags", () => {
    const tags = fixture.workflows.map((workflow) => workflow.tag);
    assert.include(tags, "gift-set");
    assert.include(tags, "weekend-engraving");
  });

  it("has unique SKUs", () => {
    const skus = fixture.products.flatMap((product) =>
      product.variants.flatMap(({ value }) => skuOf(product, value) ?? []),
    );
    assert.strictEqual(new Set(skus).size, skus.length);
  });

  it("gives a product with a stem a SKU per variant, and one without none", () => {
    assert.strictEqual(skuOf({ skuStem: "CB" }, "Maple"), "CB-MAPLE");
    assert.strictEqual(skuOf({ skuStem: "PF" }, "5×7"), "PF-5X7");
    assert.strictEqual(skuOf({}, "$25"), null);
  });

  it("keeps the three store orders' tags, which the dev stores already hold", () => {
    assert.deepStrictEqual(
      fixture.storeOrders.map((order) => order.tag),
      ["seed-board", "seed-journal", "seed-clock-and-blanket"],
    );
  });
});
