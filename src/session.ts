import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import type { Me } from "./api/backend.ts";
import { meAtom } from "./backend-client.ts";

/**
 * The signed-in member for a route guard: Some(me), or None when signed out. Unlike
 * `loadQuery` it does not refetch a cached value on every navigation; {@link meAtom} says
 * when the value is refetched. Any other failure rejects, and the route error boundary
 * shows it.
 */
export const currentMember = (registry: AtomRegistry.AtomRegistry): Promise<Option.Option<Me>> =>
  Effect.runPromise(
    AtomRegistry.getResult(registry, meAtom).pipe(
      Effect.map(Option.some),
      Effect.catchTag("Unauthorized", () => Effect.succeedNone),
    ),
  );

/**
 * Ends the Better Auth session through the Website's auth proxy, then refetches {@link meAtom}
 * and waits for it. Without the wait, a guard or loader that runs next reads the cached member
 * while the refetch is in flight.
 */
export const signOut = async (registry: AtomRegistry.AtomRegistry): Promise<void> => {
  const response = await fetch("/api/auth/sign-out", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (!response.ok) throw new Error(`Sign-out failed with status ${response.status}`);
  registry.refresh(meAtom);
  // The refetch is expected to fail with Unauthorized; only its settling matters.
  await Effect.runPromise(
    Effect.ignore(AtomRegistry.getResult(registry, meAtom, { suspendOnWaiting: true })),
  );
};
