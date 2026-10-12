import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { Ticket, Unauthorized } from "../api/backend.ts";
import type { ShopKey } from "../api/shop.ts";
import { TicketClaims } from "../api/shop-actor.ts";

/** {@link TicketClaims} as the first segment of a {@link Ticket}: base64url of their JSON. */
const ClaimsSegment = Schema.StringFromBase64Url.pipe(
  Schema.decodeTo(Schema.fromJsonString(TicketClaims)),
);
const encodeClaims = Schema.encodeSync(ClaimsSegment);
const decodeClaims = Schema.decodeUnknownEffect(ClaimsSegment);

/**
 * A {@link Ticket} split into its signed segment (kept as text, because the signature is over
 * exactly those bytes) and its signature. Base64url has no `.`, so the split is unambiguous.
 */
const TicketWire = Schema.TemplateLiteralParser([
  Schema.String.check(Schema.isBase64Url()),
  ".",
  Schema.Uint8ArrayFromBase64Url,
]);
const decodeWire = Schema.decodeUnknownEffect(TicketWire);
const encodeSignature = Schema.encodeSync(Schema.Uint8ArrayFromBase64Url);
const makeTicket = Schema.decodeSync(Ticket);

const encoder = new TextEncoder();

const make = (secret: Redacted.Redacted<string>) =>
  Effect.gen(function* () {
    // Imported on first use, not at Worker init, and then reused for the isolate's life.
    const key = yield* Effect.cached(
      Effect.promise(() =>
        crypto.subtle.importKey(
          "raw",
          encoder.encode(Redacted.value(secret)),
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign", "verify"],
        ),
      ),
    );

    const mint = Effect.fn("Tickets.mint")(function* (claims: TicketClaims) {
      const segment = encodeClaims(claims);
      const hmac = yield* key;
      const signature = yield* Effect.promise(() =>
        crypto.subtle.sign("HMAC", hmac, encoder.encode(segment)),
      );
      return makeTicket(`${segment}.${encodeSignature(new Uint8Array(signature))}`);
    });

    const verify = Effect.fn("Tickets.verify")(
      function* (ticket: string, expected: { readonly shop: ShopKey; readonly now: number }) {
        const [segment, , signature] = yield* decodeWire(ticket);
        const hmac = yield* key;
        const valid = yield* Effect.promise(() =>
          crypto.subtle.verify("HMAC", hmac, new Uint8Array(signature), encoder.encode(segment)),
        );
        if (!valid) return yield* new Unauthorized();
        const claims = yield* decodeClaims(segment);
        if (claims.shop !== expected.shop || claims.expiresAt < expected.now)
          return yield* new Unauthorized();
        return claims;
      },
      Effect.catchTag("SchemaError", () => Effect.fail(new Unauthorized())),
    );

    return { mint, verify };
  });

/**
 * Mints and verifies {@link Ticket}s with HMAC-SHA256 under `TICKET_SECRET`. The Backend mints
 * one per socket connect; the actor verifies it on that socket's first call. `verify` fails
 * {@link Unauthorized} on anything but a well-formed ticket, signed with this secret, for the
 * expected shop and not yet expired.
 */
export class Tickets extends Context.Service<Tickets, Effect.Success<ReturnType<typeof make>>>()(
  "app/Tickets",
) {
  /** Over a literal secret, for tests. */
  static readonly layerWith = (secret: Redacted.Redacted<string>) =>
    Layer.effect(Tickets, make(secret));

  /**
   * Over `TICKET_SECRET`, which the stack binds to the Backend. It is absent while the stack is
   * planned, when nothing mints or verifies; a running Worker without it is broken.
   */
  static readonly layer = Layer.unwrap(
    Effect.gen(function* () {
      const secret = yield* Config.option(Config.Redacted("TICKET_SECRET"));
      if (globalThis.__ALCHEMY_RUNTIME__ && Option.isNone(secret))
        return yield* Effect.die(new Error("TICKET_SECRET is not bound to the Backend"));
      return Tickets.layerWith(Option.getOrElse(secret, () => Redacted.make("")));
    }),
  );
}
