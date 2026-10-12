import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { RpcClient } from "effect/rpc";
import * as Schema from "effect/Schema";
import type { ShopKey } from "../api/shop.ts";
import { CALLER_HEADER, Caller } from "../api/shop-actor.ts";
import ShopActor from "./shop-actor.ts";

/** A {@link Caller} as the JSON text of {@link CALLER_HEADER}. */
export const encodeCallerHeader = Schema.encodeSync(Schema.fromJsonString(Caller));

const systemHeader = encodeCallerHeader({ role: "system" });

const make = Effect.gen(function* () {
  const actors = yield* ShopActor;

  /**
   * One call on a shop's actor as the `system` caller, through the stub. The header rides in
   * the RPC message, which the actor's HTTP path merges with the request's own headers, so the
   * actor reads it the same way as on a request the Backend forwarded.
   */
  const call = <A, E>(
    key: ShopKey,
    f: (client: Effect.Success<ReturnType<typeof actors.getByName>>) => Effect.Effect<A, E>,
  ) =>
    actors
      .getByName(key)
      .pipe(
        Effect.flatMap(f),
        RpcClient.withHeaders({ [CALLER_HEADER]: systemHeader }),
        Effect.scoped,
      );

  /**
   * `SystemRevoke` on a shop's actor. Best effort: a failure is logged and counts as nothing
   * closed, because the edit that called for it is already written and a stale socket is
   * bounded by its session's expiry.
   */
  const revoke = Effect.fn("SystemActors.revoke")(function* (
    key: ShopKey,
    by: "member" | "session",
    id: string,
  ) {
    return yield* call(key, (client) => client.SystemRevoke({ by, id })).pipe(
      Effect.catchCause((cause) =>
        Effect.logError(`SystemActors.revoke: shop=${key} by=${by}`, cause).pipe(
          Effect.as({ closed: 0 }),
        ),
      ),
    );
  });

  return { call, revoke };
});

/**
 * The Backend's own calls on a shop's actor, as the `system` caller: the only way a
 * `System…` procedure is reached. Every call carries {@link CALLER_HEADER} with the system
 * caller; nothing a browser sends reaches this path.
 */
export class SystemActors extends Context.Service<SystemActors, Effect.Success<typeof make>>()(
  "app/SystemActors",
) {
  static readonly layer = Layer.effect(SystemActors, make);

  /** Records each revoke and closes nothing, for tests with no actor. */
  static readonly layerTest = (
    revoked: Array<{ key: ShopKey; by: "member" | "session"; id: string }>,
  ) => {
    const revoke = (key: ShopKey, by: "member" | "session", id: string) =>
      Effect.sync(() => {
        revoked.push({ key, by, id });
        return { closed: 0 };
      });
    return Layer.succeed(SystemActors, {
      // Only `SystemRevoke` has a fake; any other procedure is not reachable here.
      call: (key, f) =>
        f(
          new Proxy({} as Parameters<typeof f>[0], {
            get: (_, tag) =>
              tag === "SystemRevoke"
                ? ({ by, id }: { by: "member" | "session"; id: string }) => revoke(key, by, id)
                : () => Effect.die(`SystemActors.layerTest has no ${String(tag)}`),
          }),
        ),
      revoke,
    });
  };
}
