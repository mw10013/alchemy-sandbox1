// Registers the library's runtime adapter (fetch, crypto, headers) for workerd; imported once.
import "@shopify/shopify-api/adapters/web-api";
import {
  ApiVersion,
  HttpResponseError,
  InvalidJwtError,
  RequestedTokenType,
  Session,
  shopifyApi,
} from "@shopify/shopify-api";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { InvalidSessionToken, ShopKey, type AdminSession } from "../contract/shop.ts";
import { ShopSessions, ShopSessionUpsert } from "./shop-sessions.ts";

/** The fake Shopify app's API key (its client ID), bound wherever Shopify CLI is not the parent. */
export const SHOPIFY_API_KEY = "fake-api-key";

/**
 * How close to its expiry a stored access token may be and still be reused by
 * `authenticateAdmin`; nearer than this, the session token is exchanged again (Baton's
 * `EMBEDDED_SESSION_REEXCHANGE_BUFFER_MS`).
 */
const EMBEDDED_SESSION_REEXCHANGE_BUFFER_MS = 30 * 1000;

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
const encodeHeader = Schema.encodeSync(HeaderSegment);
const encodePayload = Schema.encodeSync(PayloadSegment);
const encodeSignature = Schema.encodeSync(Schema.Uint8ArrayFromBase64Url);

/** The claims `decodeSessionToken` hands on, as the library returns them. */
const DecodedClaims = Schema.Struct({ dest: Schema.String, exp: Schema.Number });
const decodeClaims = Schema.decodeUnknownEffect(DecodedClaims);

/** A shop domain from a session token's `dest` (`https://<shop>`). */
const ShopFromDest = Schema.URLFromString.pipe(
  Schema.decodeTo(
    ShopKey,
    SchemaTransformation.transform({
      decode: (url) => url.hostname,
      encode: (shop) => new URL(`https://${shop}`),
    }),
  ),
);
const decodeShopFromDest = Schema.decodeUnknownEffect(ShopFromDest);

/** Epoch ms in a row, a `Date` on the library's `Session`. */
const StoredExpiry = Schema.NullOr(Schema.DateFromMillis);
const decodeExpiry = Schema.decodeUnknownEffect(StoredExpiry);
const encodeExpiry = Schema.encodeUnknownEffect(StoredExpiry);

/** The `shop { id }` answer, the shop's Admin API id. */
const ShopGidResponse = Schema.Struct({ shop: Schema.Struct({ id: Schema.NonEmptyString }) });
const decodeShopGidResponse = Schema.decodeUnknownEffect(ShopGidResponse);
const decodeUpsert = Schema.decodeUnknownEffect(ShopSessionUpsert);

/**
 * Shopify refused the session token in a token exchange: Baton's `isInvalidSubjectTokenError`,
 * an HTTP 400 whose body names `invalid_subject_token`.
 */
const InvalidSubjectToken = Schema.Struct({
  code: Schema.Literal(400),
  body: Schema.Struct({ error: Schema.Literal("invalid_subject_token") }),
});
const isInvalidSubjectToken = Schema.is(InvalidSubjectToken);

/** A library call that may reject, its rejection kept as the defect's cause. */
const tryShopify = <A>(evaluate: () => Promise<A>) =>
  Effect.tryPromise({ try: evaluate, catch: (cause) => cause });

const encoder = new TextEncoder();

/** A day: long enough for a merchant window opened by a test to outlive the run. */
const DEFAULT_EXPIRES_IN_SECONDS = 24 * 60 * 60;

const make = (options: {
  readonly apiKey: string;
  readonly apiSecret: Redacted.Redacted<string>;
  readonly appUrl: string;
}) =>
  Effect.gen(function* () {
    const shopSessions = yield* ShopSessions;
    // Built on first use, so planning the stack, where the bindings are absent, never builds it.
    const api = yield* Effect.cached(
      Effect.sync(() => {
        const { host, protocol } = new URL(options.appUrl);
        return shopifyApi({
          apiKey: options.apiKey,
          apiSecretKey: Redacted.value(options.apiSecret),
          hostName: host,
          hostScheme: protocol === "http:" ? "http" : "https",
          apiVersion: ApiVersion.October26,
          isEmbeddedApp: true,
          // Every future flag on, which silences the library's "Future flag X is disabled" log
          // on every isolate start; neither changes a path this app uses.
          future: { customerAddressDefaultFix: true, unstable_managedPricingSupport: true },
        });
      }),
    );
    const key = yield* Effect.cached(
      Effect.promise(() =>
        crypto.subtle.importKey(
          "raw",
          encoder.encode(Redacted.value(options.apiSecret)),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign"],
        ),
      ),
    );

    const decodeSessionToken = Effect.fn("Shopify.decodeSessionToken")(
      function* (token: string) {
        const shopify = yield* api;
        const payload = yield* tryShopify(() => shopify.session.decodeSessionToken(token));
        return yield* decodeClaims(payload).pipe(Effect.orDie);
      },
      Effect.catch((cause) =>
        cause instanceof InvalidJwtError
          ? Effect.fail(new InvalidSessionToken())
          : Effect.die(cause),
      ),
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

    /** The stored row as the library's offline `Session`, which knows whether it is still active. */
    const storedSession = Effect.fn("Shopify.storedSession")(function* (shop: ShopKey) {
      const shopify = yield* api;
      const stored = yield* shopSessions.find(shop);
      if (Option.isNone(stored)) return Option.none();
      const row = stored.value;
      const expires = yield* decodeExpiry(row.accessTokenExpiresAt).pipe(Effect.orDie);
      const refreshTokenExpires = yield* decodeExpiry(row.refreshTokenExpiresAt).pipe(Effect.orDie);
      const session = new Session({
        id: shopify.session.getOfflineId(shop),
        shop,
        state: "",
        isOnline: false,
        scope: row.scope ?? undefined,
        expires: expires ?? undefined,
        accessToken: row.accessToken ?? undefined,
        refreshToken: row.refreshToken ?? undefined,
        refreshTokenExpires: refreshTokenExpires ?? undefined,
      });
      return Option.some({ session, shopGid: row.shopGid });
    });

    /** Baton's `fetchShopGid`: the shop's Admin API id, asked for once, on first install. */
    const fetchShopGid = Effect.fn("Shopify.fetchShopGid")(function* (session: Session) {
      const shopify = yield* api;
      const client = new shopify.clients.Graphql({ session });
      const { data, errors } = yield* tryShopify(() =>
        client.request<unknown>(`#graphql
          query ShopGid {
            shop {
              id
            }
          }`),
      ).pipe(Effect.orDie);
      if (errors !== undefined)
        return yield* Effect.die(new Error("shop { id } query failed", { cause: errors }));
      return (yield* decodeShopGidResponse(data).pipe(Effect.orDie)).shop.id;
    });

    /**
     * Baton's `decodeAdminToken` and `exchangeAndStore`, without the HTTP responses: the
     * Website turns `InvalidSessionToken` into App Bridge's retry or the session-token bounce.
     * A stored session that is still active is reused and Shopify is not called; otherwise the
     * session token is exchanged for an expiring offline access token and the row upserted. An
     * undefined scope list counts as unchanged, so a stored session stays active across a scope
     * change until it expires. Any failure other than a refused token is a defect.
     */
    const authenticateAdmin = Effect.fn("Shopify.authenticateAdmin")(
      function* (sessionToken: string) {
        const { dest } = yield* decodeSessionToken(sessionToken);
        const shop = yield* decodeShopFromDest(dest).pipe(Effect.orDie);
        const existing = yield* storedSession(shop);
        if (
          Option.isSome(existing) &&
          existing.value.session.isActive(undefined, EMBEDDED_SESSION_REEXCHANGE_BUFFER_MS)
        )
          return { shop, shopGid: existing.value.shopGid } satisfies AdminSession;

        const shopify = yield* api;
        const { session } = yield* tryShopify(() =>
          shopify.auth.tokenExchange({
            shop,
            sessionToken,
            requestedTokenType: RequestedTokenType.OfflineAccessToken,
            expiring: true,
          }),
        ).pipe(
          Effect.catch((cause) =>
            cause instanceof InvalidJwtError ||
            (cause instanceof HttpResponseError && isInvalidSubjectToken(cause.response))
              ? Effect.fail(new InvalidSessionToken())
              : Effect.die(cause),
          ),
        );
        const shopGid = Option.isSome(existing)
          ? existing.value.shopGid
          : yield* fetchShopGid(session);
        const row = yield* decodeUpsert({
          shop,
          shopGid,
          shopActorId: shop,
          scope: session.scope ?? null,
          accessTokenExpiresAt: yield* encodeExpiry(session.expires ?? null),
          accessToken: session.accessToken ?? null,
          refreshToken: session.refreshToken ?? null,
          refreshTokenExpiresAt: yield* encodeExpiry(session.refreshTokenExpires ?? null),
        }).pipe(Effect.orDie);
        yield* shopSessions.upsert(row);
        yield* Effect.log(`Shopify.authenticateAdmin: exchanged shop=${shop}`);
        return { shop, shopGid } satisfies AdminSession;
      },
      Effect.catchTag("SchemaError", Effect.die),
    );

    return { decodeSessionToken, signSessionToken, authenticateAdmin };
  });

/**
 * The Backend's Shopify app, over `@shopify/shopify-api`. `decodeSessionToken` is the library's:
 * an HS256 signature under the app's API secret (`SHOPIFY_API_SECRET`), `aud` equal to the
 * app's API key (`SHOPIFY_API_KEY`), `exp` and `nbf` with ten seconds of clock tolerance.
 * `authenticateAdmin` exchanges a session token for the shop's offline access token and keeps it
 * in {@link ShopSessions}. The key and secret are the real app's under `shopify app dev` and
 * fakes elsewhere, where no Shopify token verifies and the seeded rows stand in for exchanges.
 *
 * `signSessionToken` is test-only and has no counterpart in Shopify's library: test control
 * mints a token as Shopify would, which is how a merchant window exists in dev and e2e.
 */
export class Shopify extends Context.Service<Shopify, Effect.Success<ReturnType<typeof make>>>()(
  "app/Shopify",
) {
  /** Over a literal key, secret and app URL, for tests. */
  static readonly layerWith = (options: Parameters<typeof make>[0]) =>
    Layer.effect(Shopify, make(options));

  /**
   * Over `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET` and `SHOPIFY_APP_URL`, which the stack binds to
   * the Backend. They are absent while the stack is planned, when nothing calls Shopify; a
   * running Worker without them is broken.
   */
  static readonly layer = Layer.unwrap(
    Effect.gen(function* () {
      const apiKey = yield* Config.option(Config.String("SHOPIFY_API_KEY"));
      const apiSecret = yield* Config.option(Config.Redacted("SHOPIFY_API_SECRET"));
      const appUrl = yield* Config.option(Config.String("SHOPIFY_APP_URL"));
      if (
        globalThis.__ALCHEMY_RUNTIME__ &&
        (Option.isNone(apiKey) || Option.isNone(apiSecret) || Option.isNone(appUrl))
      )
        return yield* Effect.die(
          new Error("the Shopify API key, secret and app URL are not bound"),
        );
      return Shopify.layerWith({
        apiKey: Option.getOrElse(apiKey, () => ""),
        apiSecret: Option.getOrElse(apiSecret, () => Redacted.make("")),
        appUrl: Option.getOrElse(appUrl, () => ""),
      });
    }),
  );
}
