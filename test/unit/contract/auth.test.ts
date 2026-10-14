import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { EmailFromInput, ReturnPath } from "../../../src/contract/auth.ts";

const decodeEmail = Schema.decodeUnknownEffect(EmailFromInput);
const decodeReturnPath = Schema.decodeUnknownEffect(ReturnPath);

describe("Email", () => {
  it.effect("trims and lowercases before the checks", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* decodeEmail(" A@a.com "), "a@a.com");
    }),
  );

  it.effect.each(["not-an-email", "a@b", "a b@c.com"])("rejects %#", (input) =>
    Effect.gen(function* () {
      const error = yield* decodeEmail(input).pipe(Effect.flip);
      assert.strictEqual(error._tag, "SchemaError");
    }),
  );
});

describe("ReturnPath", () => {
  it.effect("accepts a same-origin path", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* decodeReturnPath("/admin/members"), "/admin/members");
    }),
  );

  it.effect.each(["//evil.com", "/\\evil.com", "https://evil.com", "admin"])(
    "rejects %#",
    (input) =>
      Effect.gen(function* () {
        const error = yield* decodeReturnPath(input).pipe(Effect.flip);
        assert.strictEqual(error._tag, "SchemaError");
      }),
  );
});
