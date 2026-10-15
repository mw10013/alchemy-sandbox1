import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import * as DevShop from "../../../../seed/dev-shop.ts";
import {
  CliResult,
  missingScopes,
  resultText,
  SEED_SCOPES,
} from "../../../../scripts/lib/stores.ts";

describe("CLI --json output", () => {
  const progress = '{"event":"progress","message":"Creating"}\n{"event":"progress","step":2}\n';
  const pretty = JSON.stringify({ store: { domain: "a.myshopify.com" }, ok: [1, 2] }, null, 2);
  const Result = Schema.Struct({ store: Schema.Struct({ domain: Schema.String }) });

  it("takes the pretty-printed object after progress lines, not the last line", () => {
    assert.strictEqual(resultText(`${progress}${pretty}\n`), pretty);
    assert.deepStrictEqual(Schema.decodeUnknownSync(CliResult(Result))(`${progress}${pretty}\n`), {
      store: { domain: "a.myshopify.com" },
    });
  });

  it("takes a single-line result", () => {
    assert.strictEqual(resultText('{"event":"progress"}\n{"a":1}\n'), '{"a":1}');
  });

  it("takes a pretty-printed array", () => {
    assert.deepStrictEqual(
      Schema.decodeUnknownSync(CliResult(Schema.Array(Schema.Number)))(
        `${progress}${JSON.stringify([1, 2], null, 2)}`,
      ),
      [1, 2],
    );
  });

  it("rejects a result of another shape", () => {
    assert.throws(() => Schema.decodeUnknownSync(CliResult(Result))(`${progress}{"x":1}\n`));
  });
});

describe("missingScopes", () => {
  it("wants every scope when none is granted", () => {
    assert.deepStrictEqual(missingScopes([]), SEED_SCOPES);
  });

  it("counts write_X as read_X", () => {
    assert.deepStrictEqual(
      missingScopes(["write_products", "write_orders", "write_draft_orders"]),
      [],
    );
  });

  it("names what is missing", () => {
    assert.deepStrictEqual(missingScopes(["write_products", "read_orders", "write_draft_orders"]), [
      "write_orders",
    ]);
  });
});

describe("the dev shop table", () => {
  it("has unique handles", () => {
    const handles = DevShop.products.map(({ handle }) => handle);
    assert.strictEqual(new Set(handles).size, handles.length);
  });

  it("has unique SKUs", () => {
    const skus = DevShop.products.flatMap((product) =>
      product.variants.flatMap(({ value }) => DevShop.skuOf(product, value) ?? []),
    );
    assert.strictEqual(new Set(skus).size, skus.length);
  });

  it("gives a product with a stem a SKU per variant, and one without none", () => {
    assert.strictEqual(DevShop.skuOf(DevShop.products[0]!, "Maple"), "CB-MAPLE");
    assert.strictEqual(DevShop.skuOf(DevShop.products[5]!, "5×7"), "PF-5X7");
    assert.strictEqual(DevShop.skuOf(DevShop.products.at(-1)!, "$25"), null);
  });

  it("has orders with unique tags whose lines name a product and one of its variants", () => {
    const tags = DevShop.orders.map(({ tag }) => tag);
    assert.strictEqual(new Set(tags).size, tags.length);
    for (const line of DevShop.orders.flatMap(({ lines }) => lines)) {
      const product = DevShop.products.find(({ handle }) => handle === line.handle);
      assert.isTrue(product?.variants.some(({ value }) => value === line.value) ?? false);
    }
  });
});
