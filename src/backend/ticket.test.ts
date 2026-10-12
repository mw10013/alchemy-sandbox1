import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { EmailFromInput } from "../api/backend.ts";
import { SANDBOX_SHOP, ShopKey } from "../api/shop.ts";
import type { TicketClaims } from "../api/shop-actor.ts";
import { Tickets } from "./ticket.ts";

const NOW = 1_000_000;
const claims: TicketClaims = {
  shop: SANDBOX_SHOP,
  caller: {
    role: "member",
    memberId: "mem-1",
    memberEmail: Schema.decodeUnknownSync(EmailFromInput)("m1@m.com"),
    teamIds: ["team-1"],
    userId: "user-1",
    sessionId: "session-1",
    sessionExpiresAt: NOW + 60_000,
  },
  expiresAt: NOW + 60_000,
};
const otherShop = Schema.decodeUnknownSync(ShopKey)("other-shop.myshopify.com");
const layer = Tickets.layerWith(Redacted.make("test-ticket-secret"));

/** Base64url of a string, as a ticket's claims segment is written. */
const base64Url = (text: string) => Buffer.from(text).toString("base64url");

describe("Tickets", () => {
  it.effect("a minted ticket verifies to its claims", () =>
    Effect.gen(function* () {
      const tickets = yield* Tickets;
      const ticket = yield* tickets.mint(claims);
      assert.deepStrictEqual(
        yield* tickets.verify(ticket, { shop: SANDBOX_SHOP, now: NOW }),
        claims,
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect.each([
    {
      name: "a changed role",
      tamper: (ticket: string) => {
        const [segment, signature] = ticket.split(".");
        const json = Buffer.from(segment!, "base64url")
          .toString()
          .replace('"member"', '"merchant"');
        return `${base64Url(json)}.${signature}`;
      },
    },
    {
      name: "a changed signature",
      tamper: (ticket: string) => `${ticket.slice(0, -2)}${ticket.endsWith("AA") ? "BB" : "AA"}`,
    },
    { name: "no dot", tamper: (ticket: string) => ticket.replace(".", "") },
  ])("$name fails Unauthorized", ({ tamper }) =>
    Effect.gen(function* () {
      const tickets = yield* Tickets;
      const ticket = yield* tickets.mint(claims);
      const error = yield* tickets
        .verify(tamper(ticket), { shop: SANDBOX_SHOP, now: NOW })
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "Unauthorized");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("a past expiresAt fails Unauthorized", () =>
    Effect.gen(function* () {
      const tickets = yield* Tickets;
      const ticket = yield* tickets.mint(claims);
      const error = yield* tickets
        .verify(ticket, { shop: SANDBOX_SHOP, now: claims.expiresAt + 1 })
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "Unauthorized");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("another shop fails Unauthorized", () =>
    Effect.gen(function* () {
      const tickets = yield* Tickets;
      const ticket = yield* tickets.mint(claims);
      const error = yield* tickets.verify(ticket, { shop: otherShop, now: NOW }).pipe(Effect.flip);
      assert.strictEqual(error._tag, "Unauthorized");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("another secret fails Unauthorized", () =>
    Effect.gen(function* () {
      const ticket = yield* Effect.flatMap(Tickets, (tickets) => tickets.mint(claims)).pipe(
        Effect.provide(Tickets.layerWith(Redacted.make("another-secret"))),
      );
      const tickets = yield* Tickets;
      const error = yield* tickets
        .verify(ticket, { shop: SANDBOX_SHOP, now: NOW })
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "Unauthorized");
    }).pipe(Effect.provide(layer)),
  );
});
