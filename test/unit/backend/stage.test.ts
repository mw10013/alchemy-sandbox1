import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { environmentOf, PerDeveloperStage, UnknownStage } from "../../../src/backend/stage.ts";

const decode = Schema.decodeUnknownSync(PerDeveloperStage);
const encode = Schema.encodeSync(PerDeveloperStage);

describe("stage names", () => {
  for (const [stage, parts] of [
    ["dev-mw", { environment: "dev", user: "mw", checkout: Option.none() }],
    ["dev-mw-wt-01", { environment: "dev", user: "mw", checkout: Option.some(1) }],
    ["test-mw-wt-12", { environment: "test", user: "mw", checkout: Option.some(12) }],
    ["e2e-mw", { environment: "e2e", user: "mw", checkout: Option.none() }],
  ] as const)
    it(`${stage} round-trips`, () => {
      assert.deepStrictEqual(decode(stage), parts);
      assert.strictEqual(encode(parts), stage);
    });

  it.effect("each stage names its environment", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* environmentOf("dev-mw-wt-01"), "dev");
      assert.strictEqual(yield* environmentOf("test-mw"), "test");
      assert.strictEqual(yield* environmentOf("e2e-mw"), "e2e");
      assert.strictEqual(yield* environmentOf("staging"), "staging");
    }),
  );

  for (const stage of [
    "dev_mw",
    "dev-mw_wt01",
    "production",
    "live-mw",
    "pr-42",
    "dev-Bad-wt-01",
    "dev-mw-wt-00",
    "dev-mw-wt-100",
  ])
    it.effect(`${stage} is an unknown stage`, () =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(environmentOf(stage));
        assert.deepStrictEqual(exit, Exit.fail(new UnknownStage({ stage })));
      }),
    );
});
