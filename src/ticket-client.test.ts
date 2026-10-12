import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import * as RpcTest from "effect/rpc/RpcTest";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";
import { Ticket } from "./api/backend.ts";
import { SANDBOX_SHOP } from "./api/shop.ts";
import {
  CONNECTION_CLOSE_DISPLACED,
  CONNECTION_CLOSE_FORBIDDEN,
  CONNECTION_CLOSE_REVOKED,
  CallerMiddleware,
  CurrentCaller,
  RequireMember,
  RequireMerchant,
  RequireSystem,
  ShopActorRpcs,
  TICKET_HEADER,
  TicketClaims,
} from "./api/shop-actor.ts";
import {
  TicketRefused,
  bindOnConnect,
  makeTicketStep,
  resetBinding,
  retryPolicy,
  setClient,
  ticketMiddleware,
} from "./ticket-client.ts";

const closed = (code: number) =>
  new Socket.SocketError({ reason: new Socket.SocketCloseError({ code }) });
const refused = new Socket.SocketError({
  reason: new Socket.SocketOpenError({
    kind: "Unknown",
    cause: new TicketRefused({ reason: "NotAShopMember" }),
  }),
});

/** Whether the policy continues after one input, stepped directly (no time passes). */
const continuesAfter = (error: Socket.SocketError) =>
  Effect.gen(function* () {
    const step = yield* Schedule.toStep(retryPolicy(() => Effect.void));
    const exit = yield* Effect.exit(step(0, error));
    return Exit.isSuccess(exit);
  });

/**
 * A ticket whose claims expire at `expiresAt`; the signature is not checked here. `it.effect`
 * runs on the TestClock, whose time starts at 0.
 */
const ticketExpiringAt = (expiresAt: number) =>
  Schema.decodeSync(Ticket)(
    `${Schema.encodeSync(
      Schema.StringFromBase64Url.pipe(Schema.decodeTo(Schema.fromJsonString(TicketClaims))),
    )({ shop: SANDBOX_SHOP, caller: { role: "merchant" }, expiresAt })}.signature`,
  );

describe("retry policy", () => {
  it.effect.each([
    { name: "4403", error: closed(CONNECTION_CLOSE_FORBIDDEN), continues: false },
    { name: "4409", error: closed(CONNECTION_CLOSE_DISPLACED), continues: false },
    { name: "a refused ticket", error: refused, continues: false },
    { name: "3401", error: closed(CONNECTION_CLOSE_REVOKED), continues: true },
    { name: "1006", error: closed(1006), continues: true },
  ])("after $name it continues: $continues", ({ error, continues }) =>
    Effect.gen(function* () {
      assert.strictEqual(yield* continuesAfter(error), continues);
    }),
  );
});

describe("ticket step", () => {
  const registry = AtomRegistry.make();

  it.effect("a fresh primed ticket is used without a fetch, and only once", () =>
    Effect.gen(function* () {
      let fetches = 0;
      const step = makeTicketStep({
        registry,
        merchantToken: Option.none(),
        primed: Option.some(ticketExpiringAt(60_000)),
        fetch: Effect.sync(() => {
          fetches += 1;
          return ticketExpiringAt(60_000);
        }),
      });
      yield* step;
      assert.strictEqual(fetches, 0);
      yield* step;
      assert.strictEqual(fetches, 1, "a reconnect asks the Backend");
    }),
  );

  it.effect("an expired primed ticket is fetched again", () =>
    Effect.gen(function* () {
      let fetches = 0;
      const step = makeTicketStep({
        registry,
        merchantToken: Option.none(),
        primed: Option.some(ticketExpiringAt(-1)),
        fetch: Effect.sync(() => {
          fetches += 1;
          return ticketExpiringAt(60_000);
        }),
      });
      yield* step;
      assert.strictEqual(fetches, 1);
    }),
  );
});

describe("ticket middleware", () => {
  /** The actor's middlewares, recording the ticket header each call arrives with. */
  const recording = (seen: Array<string | undefined>) =>
    Layer.mergeAll(
      Layer.succeed(CallerMiddleware)(
        CallerMiddleware.of((effect, { headers }) => {
          seen.push(headers[TICKET_HEADER]);
          return Effect.provideService(effect, CurrentCaller, { role: "merchant" });
        }),
      ),
      Layer.succeed(RequireMember)(RequireMember.of((effect) => effect)),
      Layer.succeed(RequireMerchant)(RequireMerchant.of((effect) => effect)),
      Layer.succeed(RequireSystem)(RequireSystem.of((effect) => effect)),
    );

  const seen: Array<string | undefined> = [];
  const recordingLayer = recording(seen);

  it.effect("sends the ticket on the first call after a connect and not on the second", () =>
    Effect.gen(function* () {
      const ticket = ticketExpiringAt(60_000);
      yield* makeTicketStep({
        registry: AtomRegistry.make(),
        merchantToken: Option.none(),
        primed: Option.some(ticket),
        fetch: Effect.die("no fetch"),
      });
      yield* resetBinding;
      const client = yield* RpcTest.makeClient(ShopActorRpcs).pipe(
        Effect.provide(ticketMiddleware),
      );
      yield* client.MerchantGetCount();
      yield* client.MerchantGetCount();
      assert.deepStrictEqual(seen, [ticket, undefined]);
    }).pipe(
      Effect.provide(
        ShopActorRpcs.toLayer({
          MemberGetCount: () => Effect.die("unused"),
          MemberIncrement: () => Effect.die("unused"),
          MemberActivation: () => Effect.die("unused"),
          MemberWhoAmI: () => Effect.die("unused"),
          MerchantGetCount: () => Effect.succeed({ value: 1 }),
          MerchantResetCount: () => Effect.die("unused"),
          MerchantWhoAmI: () => Effect.die("unused"),
          SystemRevoke: () => Effect.die("unused"),
        }).pipe(Layer.merge(recordingLayer)),
      ),
      Effect.scoped,
    ),
  );

  it.effect("binds on connect with the role's who-am-I, carrying the ticket", () => {
    const bound: Array<string | undefined> = [];
    const called = Deferred.makeUnsafe<string>();
    const ticket = ticketExpiringAt(60_000);
    return Effect.gen(function* () {
      yield* makeTicketStep({
        registry: AtomRegistry.make(),
        merchantToken: Option.some("token"),
        primed: Option.some(ticket),
        fetch: Effect.die("no fetch"),
      });
      const client = yield* RpcTest.makeClient(ShopActorRpcs, { flatten: true }).pipe(
        Effect.provide(ticketMiddleware),
      );
      yield* setClient(client);
      yield* bindOnConnect;
      assert.strictEqual(yield* Deferred.await(called), "MerchantWhoAmI");
      assert.deepStrictEqual(bound, [ticket]);
    }).pipe(
      Effect.provide(
        ShopActorRpcs.toLayer({
          MemberGetCount: () => Effect.die("unused"),
          MemberIncrement: () => Effect.die("unused"),
          MemberActivation: () => Effect.die("unused"),
          MemberWhoAmI: () =>
            Deferred.succeed(called, "MemberWhoAmI").pipe(Effect.andThen(Effect.die("member"))),
          MerchantGetCount: () => Effect.die("unused"),
          MerchantResetCount: () => Effect.die("unused"),
          MerchantWhoAmI: () =>
            Deferred.succeed(called, "MerchantWhoAmI").pipe(
              Effect.as({ role: "merchant" as const }),
            ),
          SystemRevoke: () => Effect.die("unused"),
        }).pipe(Layer.merge(recording(bound))),
      ),
      Effect.scoped,
    );
  });
});
