import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Atom from "effect/reactivity/Atom";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcTest from "effect/rpc/RpcTest";
import { onTestFinished } from "vite-plus/test";
import {
  BackendRpcs,
  CurrentUser,
  CurrentUserMiddleware,
  type Me,
  RequireAdmin,
  Unauthorized,
} from "../../src/api/backend.ts";
import { BackendClient } from "../../src/backend-client.ts";

type Handlers = RpcGroup.HandlersFrom<RpcGroup.Rpcs<typeof BackendRpcs>>;

/** Dies on any RPC a test did not give a handler, so a test names every call its component makes. */
const unexpected = Object.fromEntries(
  [...BackendRpcs.requests.keys()].map((tag) => [tag, () => Effect.die(`unexpected ${tag}`)]),
) as unknown as Handlers;

/**
 * {@link BackendClient} over the given handlers, in memory: no serialization, proxy or Worker.
 * `me` is who the member RPCs see; without it they fail `Unauthorized`, as for a signed-out
 * visitor. `RequireAdmin` lets everyone through, so a handler for an admin RPC decides itself.
 */
export const backendClientLayer = (
  handlers: Partial<Handlers>,
  me: Option.Option<Me> = Option.none(),
) =>
  Layer.effect(BackendClient, RpcTest.makeClient(BackendRpcs, { flatten: true })).pipe(
    Layer.provide(BackendRpcs.toLayer({ ...unexpected, ...handlers })),
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(CurrentUserMiddleware)((effect) =>
          Option.match(me, {
            onNone: () => Effect.fail(new Unauthorized()),
            onSome: (user) => Effect.provideService(effect, CurrentUser, user),
          }),
        ),
        Layer.succeed(RequireAdmin)((effect) => effect),
      ),
    ),
  );

/**
 * A registry whose {@link BackendClient} atoms run on {@link backendClientLayer}, disposed when
 * the test finishes. The component keeps its real atoms; only the client behind them changes,
 * because `AtomRpc` builds every query and mutation on `BackendClient.runtime`, whose layer is
 * itself an atom a registry can seed.
 */
export const testRegistry = (handlers: Partial<Handlers>, me?: Option.Option<Me>) => {
  const registry = AtomRegistry.make({
    initialValues: [
      Atom.initialValue(BackendClient.runtime.layer, backendClientLayer(handlers, me)),
    ],
  });
  onTestFinished(() => registry.dispose());
  return registry;
};
