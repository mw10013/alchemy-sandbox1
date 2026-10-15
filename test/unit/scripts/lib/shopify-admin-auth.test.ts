import { assert, describe, it } from "@effect/vitest";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { createCipheriv } from "node:crypto";

import {
  adminSessionFresh,
  chromeMicrosToEpochMs,
  ChromeProfile,
  deriveKey,
  makeDecrypt,
  SESSION_MAX_AGE_MS,
} from "../../../../scripts/lib/shopify-admin-auth.ts";

const NOW = 1_800_000_000_000;

describe("makeDecrypt", () => {
  const key = deriveKey("a made-up password");
  const encrypt = (plain: string) => {
    // Chrome prepends a 32-byte hash to the plaintext, and the `v10` prefix to the ciphertext.
    const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
    const body = Buffer.concat([
      cipher.update(Buffer.concat([Buffer.alloc(32, 7), Buffer.from(plain)])),
      cipher.final(),
    ]);
    return Buffer.concat([Buffer.from("v10"), body]);
  };

  it("decrypts a v10 value and drops the hash", () => {
    assert.strictEqual(makeDecrypt(key)(encrypt("session=abc; ünï")), "session=abc; ünï");
  });

  it("returns a value without the v10 prefix as text", () => {
    assert.strictEqual(makeDecrypt(key)(Buffer.from("plain")), "plain");
  });

  it("derives the 16-byte key Chrome does", () => {
    assert.strictEqual(key.length, 16);
    assert.deepStrictEqual(key, deriveKey("a made-up password"));
    assert.notDeepEqual(key, deriveKey("another"));
  });
});

describe("chromeMicrosToEpochMs", () => {
  it("maps Chrome's 1601 epoch to Unix", () => {
    assert.strictEqual(chromeMicrosToEpochMs(11_644_473_600n * 1_000_000n), 0);
    assert.strictEqual(
      chromeMicrosToEpochMs((11_644_473_600n + 1_700_000_000n) * 1_000_000n + 5_000n),
      1_700_000_000_005,
    );
  });
});

describe("adminSessionFresh", () => {
  const koa = (expires: number) => ({ name: "koa.sid", domain: "admin.shopify.com", expires });
  const essential = { name: "_merchant_essential", domain: ".shopify.com", expires: 0 };

  it("accepts koa.sid with more than 5 minutes left, refuses 5 minutes or fewer", () => {
    assert.isTrue(adminSessionFresh([koa((NOW + 5 * 60_000 + 1000) / 1000)], 0, NOW));
    assert.isFalse(adminSessionFresh([koa((NOW + 5 * 60_000) / 1000)], 0, NOW));
  });

  it("accepts a koa.sid session cookie (-1)", () => {
    assert.isTrue(adminSessionFresh([koa(-1)], 0, NOW));
  });

  it("ignores koa.sid on another host", () => {
    assert.isFalse(adminSessionFresh([{ ...koa(-1), domain: ".shopify.com" }], 0, NOW));
  });

  it("accepts _merchant_essential issued less than 24 hours ago, refuses exactly 24 hours", () => {
    assert.isTrue(adminSessionFresh([essential], NOW - SESSION_MAX_AGE_MS + 1, NOW));
    assert.isFalse(adminSessionFresh([essential], NOW - SESSION_MAX_AGE_MS, NOW));
  });

  it("ignores _merchant_essential on another host", () => {
    assert.isFalse(adminSessionFresh([{ ...essential, domain: "admin.shopify.com" }], NOW, NOW));
  });

  it("refuses no cookies", () => {
    assert.isFalse(adminSessionFresh([], NOW, NOW));
  });
});

describe("ChromeProfile", () => {
  const decode = Schema.decodeUnknownOption(ChromeProfile);
  for (const name of ["Default", "Profile 1"])
    it(`accepts ${name}`, () => assert.isTrue(Option.isSome(decode(name))));
  for (const name of ["", ".", "..", "a/b", "../x", "a\\b"])
    it(`refuses ${JSON.stringify(name)}`, () => assert.isTrue(Option.isNone(decode(name))));
});
