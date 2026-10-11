import { createIsomorphicFn } from "@tanstack/react-start";
import * as Effect from "effect/Effect";
import type * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";

/**
 * Loads a page query in a route loader. Every query a page renders during SSR is defined and
 * loaded this way; `helloAtom` is the reference.
 *
 * Defining the query:
 * - `serializationKey` makes the query dehydrate into the HTML and hydrate in the browser.
 *   Hydration marks the node valid, so the browser does not refetch it. Keep every wrapper
 *   (`withReactivity`, {@link refreshOnFocus}) outside the serializable query, so that the
 *   inner node is the one hydrated.
 * - `timeToLive` is an idle TTL. Its timer starts only when nothing renders the query, and it
 *   decides how long the last value can serve as an instant placeholder on return. It is
 *   not freshness: a mounted query never refreshes on its own.
 * - Freshness comes from three places: `loadQuery` revalidates on every navigation,
 *   {@link refreshOnFocus} revalidates when a tab becomes visible again, and mutations pass
 *   `reactivityKeys` for our own writes.
 *
 * Loading it:
 * - Cached value (client navigation): return it at once and refetch in the background
 *   (stale-while-revalidate). The value is `waiting` until the refetch lands.
 * - No cached value (SSR, first visit, TTL expired): wait for the fetch.
 * - The router keeps its own match cache and, by default, reruns a stale loader in the
 *   background while it renders the cached match, so after the TTL expires the page would
 *   render `Initial` ("Loading…"). `getRouter` sets `defaultStaleReloadMode: "blocking"` so
 *   the loader is awaited. Blocking costs nothing when the value is cached, because
 *   `loadQuery` returns at once. Do not override it per route.
 * - Start dehydrates after loaders and before render. A query first read during render is
 *   not dehydrated, and the browser refetches it, so load every SSR-rendered query here.
 *   The loader does not run on hydration.
 *
 * Exceptions, chosen per query:
 * - Must never show stale data, even briefly (balances, stock at checkout, permissions):
 *   `registry.refresh(query)`, then
 *   `AtomRegistry.getResult(registry, query, { suspendOnWaiting: true })`. No long
 *   `timeToLive`.
 * - Session data only this user changes (preferences): `timeToLive: Infinity` (keepAlive),
 *   invalidated by `reactivityKeys`. The current user is the exception; see `meAtom`.
 * - Live data (presence, chat): push it over a WebSocket. A TTL is the wrong tool.
 *
 * @example
 * export const helloAtom = BackendClient.query("Hello", undefined, {
 *   serializationKey: "hello",
 *   timeToLive: "5 minutes",
 * }).pipe(Atom.withReactivity(["hello"]), refreshOnFocus);
 *
 * export const Route = createFileRoute("/")({
 *   loader: async ({ context }) => {
 *     await loadQuery(context.registry, helloAtom);
 *   },
 * });
 */
export const loadQuery = <A, E>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
): Promise<A> => {
  registry.refresh(atom);
  return Effect.runPromise(AtomRegistry.getResult(registry, atom));
};

/** `windowFocusSignal` reads `window` and `document`, so the server keeps the atom as is. */
const refreshOnFocusImpl = createIsomorphicFn()
  .client((atom: Atom.Atom<any>) => Atom.refreshOnWindowFocus(atom))
  .server((atom: Atom.Atom<any>) => atom);

/** Refetches `atom` when the tab becomes visible again. A no-op on the server. */
export const refreshOnFocus = <A extends Atom.Atom<any>>(atom: A): A =>
  // createIsomorphicFn infers non-generic args, so restore the atom's type here.
  refreshOnFocusImpl(atom) as A;
