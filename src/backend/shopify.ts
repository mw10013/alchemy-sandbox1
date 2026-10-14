import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type { ShopKey } from "../contract/shop.ts";

/** The fake Shopify app's API key (its client ID), the `aud` of every token it accepts. */
export const SHOPIFY_API_KEY = "fake-api-key";

/** A Shopify session token that is malformed, badly signed, for another app, or out of date. */
export class InvalidSessionToken extends Schema.TaggedError<InvalidSessionToken>()(
  "InvalidSessionToken",
  {},
) {}

/** A JSON object as one base64url JWT segment. */
const jsonSegment = <S extends Schema.Constraint>(schema: S) =>
  Schema.StringFromBase64Url.pipe(Schema.decodeTo(Schema.fromJsonString(schema)));

const Header = Schema.Struct({ alg: Schema.Literal("HS256"), typ: Schema.optional(Schema.String) });
const HeaderSegment = jsonSegment(Header);

/** The claims Shopify puts in a session token (an ID token). Times are UNIX seconds. */
const Payload = Schema.Struct({
  iss: Schema.String,
  dest: Schema.String,
  aud: Schema.String,
  sub: Schema.String,
  exp: Schema.Number,
  nbf: Schema.Number,
  iat: Schema.Number,
  jti: Schema.String,
  sid: Schema.String,
});
type Payload = typeof Payload.Type;
const PayloadSegment = jsonSegment(Payload);

/**
 * A JWT split into its signed part (header and payload as text, because the signature is over
 * exactly those bytes) and its signature. Base64url has no `.`, so the split is unambiguous.
 */
const Segment = Schema.String.check(Schema.isBase64Url());
const Jwt = Schema.TemplateLiteralParser([
  Segment,
  ".",
  Segment,
  ".",
  Schema.Uint8ArrayFromBase64Url,
]);
const decodeJwt = Schema.decodeUnknownEffect(Jwt);
const decodeHeader = Schema.decodeUnknownEffect(HeaderSegment);
const decodePayload = Schema.decodeUnknownEffect(PayloadSegment);
const encodeHeader = Schema.encodeSync(HeaderSegment);
const encodePayload = Schema.encodeSync(PayloadSegment);
const encodeSignature = Schema.encodeSync(Schema.Uint8ArrayFromBase64Url);

const encoder = new TextEncoder();

/** A day: long enough for a merchant window opened by a test to outlive the run. */
const DEFAULT_EXPIRES_IN_SECONDS = 24 * 60 * 60;

const make = (options: {
  readonly apiKey: string;
  readonly apiSecret: Redacted.Redacted<string>;
}) =>
  Effect.gen(function* () {
    const key = yield* Effect.cached(
      Effect.promise(() =>
        crypto.subtle.importKey(
          "raw",
          encoder.encode(Redacted.value(options.apiSecret)),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign", "verify"],
        ),
      ),
    );

    const decodeSessionToken = Effect.fn("Shopify.decodeSessionToken")(
      function* (token: string) {
        const [header, , payload, , signature] = yield* decodeJwt(token);
        const hmac = yield* key;
        const valid = yield* Effect.promise(() =>
          crypto.subtle.verify(
            "HMAC",
            hmac,
            new Uint8Array(signature),
            encoder.encode(`${header}.${payload}`),
          ),
        );
        if (!valid) return yield* new InvalidSessionToken();
        yield* decodeHeader(header);
        const claims = yield* decodePayload(payload);
        const now = Math.floor(Date.now() / 1000);
        if (claims.aud !== options.apiKey || claims.exp <= now || claims.nbf > now)
          return yield* new InvalidSessionToken();
        return { dest: claims.dest, exp: claims.exp };
      },
      Effect.catchTag("SchemaError", () => Effect.fail(new InvalidSessionToken())),
    );

    const signSessionToken = Effect.fn("Shopify.signSessionToken")(function* (input: {
      readonly shop: ShopKey;
      readonly expiresIn?: number | undefined;
    }) {
      const now = Math.floor(Date.now() / 1000);
      const claims: Payload = {
        iss: `https://${input.shop}/admin`,
        dest: `https://${input.shop}`,
        aud: options.apiKey,
        sub: "1",
        exp: now + (input.expiresIn ?? DEFAULT_EXPIRES_IN_SECONDS),
        nbf: now,
        iat: now,
        jti: crypto.randomUUID(),
        sid: crypto.randomUUID(),
      };
      const signed = `${encodeHeader({ alg: "HS256", typ: "JWT" })}.${encodePayload(claims)}`;
      const hmac = yield* key;
      const signature = yield* Effect.promise(() =>
        crypto.subtle.sign("HMAC", hmac, encoder.encode(signed)),
      );
      return `${signed}.${encodeSignature(new Uint8Array(signature))}`;
    });

    return { decodeSessionToken, signSessionToken };
  });

/**
 * The sandbox's stand-in for `@shopify/shopify-api` until the Shopify slice brings the real
 * app, with the one method Baton's gate uses. `decodeSessionToken` checks what Shopify's
 * library checks: an HS256 signature under the app's API secret (`SHOPIFY_API_SECRET`), `aud`
 * equal to the app's API key (`SHOPIFY_API_KEY`), `exp` in the future and `nbf` in the past.
 * The key and secret are fakes, so no real Shopify token verifies here.
 *
 * `signSessionToken` is test-only and has no counterpart in Shopify's library: test control
 * mints a token as Shopify would, which is how a merchant window exists in dev and e2e.
 */
export class Shopify extends Context.Service<Shopify, Effect.Success<ReturnType<typeof make>>>()(
  "app/Shopify",
) {
  /** Over a literal key and secret, for tests. */
  static readonly layerWith = (options: Parameters<typeof make>[0]) =>
    Layer.effect(Shopify, make(options));

  /**
   * Over `SHOPIFY_API_KEY` and `SHOPIFY_API_SECRET`, which the stack binds to the Backend. They
   * are absent while the stack is planned, when nothing decodes a token; a running Worker
   * without them is broken.
   */
  static readonly layer = Layer.unwrap(
    Effect.gen(function* () {
      const apiKey = yield* Config.option(Config.String("SHOPIFY_API_KEY"));
      const apiSecret = yield* Config.option(Config.Redacted("SHOPIFY_API_SECRET"));
      if (globalThis.__ALCHEMY_RUNTIME__ && (Option.isNone(apiKey) || Option.isNone(apiSecret)))
        return yield* Effect.die(new Error("the Shopify API key and secret are not bound"));
      return Shopify.layerWith({
        apiKey: Option.getOrElse(apiKey, () => ""),
        apiSecret: Option.getOrElse(apiSecret, () => Redacted.make("")),
      });
    }),
  );
}
