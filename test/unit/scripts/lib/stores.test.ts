import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  CliResult,
  FIXTURE_SCOPES,
  missingScopes,
  requireFixtureStore,
  resultText,
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
    assert.deepStrictEqual(missingScopes([]), FIXTURE_SCOPES);
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

describe("requireFixtureStore", () => {
  it.effect("accepts a dev store", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* requireFixtureStore("mw10013-dev-shop-03"), {
        environment: "dev",
        index: 3,
      });
    }),
  );

  it.effect("refuses e2e, staging, production and stores outside the scheme", () =>
    Effect.gen(function* () {
      for (const store of [
        "mw10013-e2e-shop-00",
        "mw10013-staging-shop-00",
        "mw10013-production-shop-00",
        "sandbox-shop-00",
        "mw10013-staging-shop-00.myshopify.com",
      ]) {
        const exit = yield* Effect.exit(requireFixtureStore(store));
        assert.isTrue(exit._tag === "Failure", store);
      }
    }),
  );
});
