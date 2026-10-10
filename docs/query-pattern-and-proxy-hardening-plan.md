# Plan: the SSR query pattern (stale-while-revalidate) and a hardened `/api/rpc` proxy

Date: 2026-10-10  
Status: ready to implement.  
Background: [research](./loaded-data-path-and-direct-backend-research.md), §9 (query pattern) and §10 (decisions Q1–Q8). Vocabulary: [glossary](./glossary.md).  
Versions: Alchemy `2.0.0-beta.81`, Effect `4.0.1`, `@effect/atom-react` `4.0.1`, `@tanstack/react-start` `1.168.60`. Do not bump dependencies.

## Goal

Two independent changes:

1. **Query pattern.** `helloAtom` becomes the reference implementation of how every SSR-rendered page query works:
   - A stale-while-revalidate loader.
   - A 5-minute idle TTL.
   - A browser-only refresh on window focus.
   - `reactivityKeys` for our own writes.

   The pattern lives in a small module with a JSDoc that explains it. The research doc will go stale and be deleted, so **the JSDoc is the lasting record**: it must be enough on its own.

2. **Proxy hardening.** `POST /api/rpc` rejects bad requests before they reach the Backend, and `GET /api/rpc` returns 405 instead of the app's HTML shell.

The visible page does not change.

## Ground rules for the implementer

- **Git.** Work on `main` (AGENTS.md). **Do not commit and do not push.** The reviewer commits after checking. Pushing `main` deploys staging.
- **Check APIs against source.** Verify every API against the installed source in `node_modules/effect/src` and the pinned TanStack sources in `refs/tan-router` and `refs/tan-start`. Line references below were checked there. If something does not match, follow the source and record it in [Deviations and issues](#deviations-and-issues).
- **Imports.** Effect modules are imported by subpath (`effect/reactivity/Atom`, `effect/reactivity/AtomRegistry`). Local imports keep the `.ts`/`.tsx` extension where the existing code does.
- **Comment density.** Match the surrounding code: short comments that say why, not what. The one exception is the pattern JSDoc in Step 1, which is deliberately longer.
- **Record everything.** Put every deviation, workaround, and unverified check in [Deviations and issues](#deviations-and-issues). Be specific: file, what the plan said, what you did, and why.

## Current state (before)

```
src/backend-client.ts   helloAtom = BackendClient.query("Hello", undefined, { serializationKey: "hello", timeToLive: "1 minute" })
                          .pipe(Atom.withReactivity(["hello"]))
src/routes/index.tsx    loader: await Effect.runPromise(AtomRegistry.getResult(registry, helloAtom, { suspendOnWaiting: true }))
src/routes/api.rpc.ts   POST: ({ request }) => env.BACKEND.fetch(request)    (no GET handler, no checks)
```

Known behavior today:

- An empty-body `POST /api/rpc` returns 500. The Backend logs `HTTP handler failed`.
- `GET /api/rpc` returns the 200 HTML shell, because Start falls through to the app render (`refs/tan-start/packages/start-server-core/src/createStartHandler.ts:965-966, 996-999`).

## Target state (after)

```
src/query.ts            NEW. Pattern JSDoc + loadQuery(registry, atom) + refreshOnFocus(atom)
src/backend-client.ts   helloAtom: timeToLive "5 minutes", .pipe(Atom.withReactivity(["hello"]), refreshOnFocus); comment points to src/query.ts
src/routes/index.tsx    loader: await loadQuery(context.registry, helloAtom)
src/routes/api.rpc.ts   POST: 415 / 411 / 400 / 413 checks, then forward. GET: 405 with Allow: POST
```

## Steps

Do them in order. Run `pnpm typecheck` after each step. Run `pnpm check` at the end and fix what it reports.

### Step 1. `src/query.ts`: the pattern module

Create the module with exactly two exports and the module-level JSDoc below. Keep the JSDoc's substance. You may tighten the wording, but do not drop a rule. Each rule encodes a decision from the research, and the research will be deleted.

```ts
/**
 * The page-query pattern. Every query a page renders during SSR follows it.
 *
 * Define the query (see `helloAtom` in `backend-client.ts`):
 *   BackendClient.query(tag, payload, { serializationKey, timeToLive: "5 minutes" })
 *     .pipe(Atom.withReactivity(keys), refreshOnFocus)
 * - `serializationKey` makes the query dehydrate into the HTML and hydrate in the browser.
 *   Hydration marks the node valid, so the browser does not refetch it. Keep every wrapper
 *   (withReactivity, refreshOnFocus) outside the serializable query, so that the inner node
 *   is the one hydrated.
 * - `timeToLive` is an idle TTL. Its timer starts only when nothing renders the query, and it
 *   decides how long the last value can serve as an instant placeholder on return. It is
 *   not freshness: a mounted query never refreshes on its own.
 * - Freshness comes from three places:
 *   - `loadQuery` revalidates on every navigation.
 *   - `refreshOnFocus` revalidates when a tab becomes visible again.
 *   - Mutations pass `reactivityKeys` for our own writes.
 *
 * Load it with `await loadQuery(context.registry, query)` in the route loader:
 * - Cached value (client navigation): return it at once and refetch in the background
 *   (stale-while-revalidate). The value is `waiting` until the refetch lands.
 * - No cached value (SSR, first visit, TTL expired): wait for the fetch.
 * - Start dehydrates after loaders and before render. A query first read during render is
 *   not dehydrated, and the browser refetches it. Prime every SSR-rendered query here.
 *   The loader does not run on hydration.
 *
 * Exceptions, chosen per query:
 * - Must never show stale data, even briefly (balances, stock at checkout, permissions):
 *   `registry.refresh(query)`, then `AtomRegistry.getResult(registry, query, { suspendOnWaiting: true })`.
 *   No long `timeToLive`.
 * - Session data only this user changes (current user, preferences): `timeToLive: Infinity`
 *   (keepAlive), invalidated by `reactivityKeys` on sign-in and sign-out.
 * - Live data (presence, chat): push it over a WebSocket. A TTL is the wrong tool.
 */
```

Then the two exports:

**`loadQuery(registry, atom): Promise<A>`**, the stale-while-revalidate loader:

```ts
export const loadQuery = <A, E>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
): Promise<A> => {
  registry.refresh(atom);
  return Effect.runPromise(AtomRegistry.getResult(registry, atom));
};
```

Why this works. Check each point in the source and record any mismatch:

- **Refresh reaches the inner query.** `registry.refresh` (`AtomRegistry.ts:551-557`) calls `atom.refresh` when it is defined. Otherwise it calls `invalidateAtom`. `transform` (used by `withReactivity` and `refreshOnWindowFocus`) forwards `refresh` to its source (`Atom.ts`, `export const transform`). So refreshing the outer atom reaches the inner serializable query.
- **No node yet (SSR, or after the TTL):** `invalidateAtom` → `ensureNode` creates the node (`AtomRegistry.ts:624-626`). `invalidate` on an uninitialized node only propagates and does not build it. `getResult` then reads it: one fetch, and it waits through `Initial`.
- **Cached node:** `invalidate` marks the node stale. `getResult` reads it, and the Effect atom's re-run returns `AsyncResult.waitingFrom(previous)` (`Atom.ts:699`), which means `Success` with `waiting: true`. Without `suspendOnWaiting`, `getResult` resumes on any non-`Initial` value (`AtomRegistry.ts:384-393`), so the loader returns at once.
- **Failures still reject.** `getResult` resumes with `Result.toExit`, so a `Failure` rejects the loader and the route error boundary shows (decision Q7). Keep that.

The return type is `Promise<A>` so that a future loader can use the value. `index.tsx` ignores it.

**`refreshOnFocus`**, browser-only `Atom.refreshOnWindowFocus`:

- `Atom.refreshOnWindowFocus` (`Atom.ts:2835`) reads `window` and `document` (`windowFocusSignal`, `Atom.ts:2788-2800`), so it would throw during SSR.
- On the server it must be the identity. Use `createIsomorphicFn` from `@tanstack/react-start`, as `src/backend-client.ts` already does for `rpcUrl` and `transport`. The Start compiler then keeps only the matching body per build.
- It must keep the atom's generic type, so `.pipe(..., refreshOnFocus)` still types `useAtomValue(helloAtom)` as `AsyncResult<Hello, …>`.
- If `createIsomorphicFn` loses the generic, write a typed wrapper around it, for example `<A extends Atom.Atom<any>>(atom: A): A => impl(atom) as A`, and record it.
- Do not use a `typeof window` check: the repo convention is `createIsomorphicFn`.

The value type is `WithoutSerializable<A>` on the client and `A` on the server. That is fine, because nothing reads the outer atom's serializable key.

### Step 2. `src/backend-client.ts`: apply the pattern to `helloAtom`

```ts
// The reference page query. The pattern is documented in ./query.ts.
export const helloAtom = BackendClient.query("Hello", undefined, {
  serializationKey: "hello",
  timeToLive: "5 minutes",
}).pipe(Atom.withReactivity(["hello"]), refreshOnFocus);
```

Replace the existing four-line comment above `helloAtom` (lines 38-41) with that one line. Its points now live in the JSDoc in `src/query.ts`.

- **Wrapper order.** `withReactivity` goes first, then `refreshOnFocus`. Both wrap outside the serializable query. Refreshing the outermost atom reaches the inner query through `transform`.
- **No circular import.** `src/query.ts` must not import from `backend-client.ts`. Its JSDoc names `helloAtom` in text only.

### Step 3. `src/routes/index.tsx`: use `loadQuery`

```ts
// Page-query pattern: see ../query.ts. A failed Hello rejects, and the route error boundary shows it.
loader: async ({ context }) => {
  await loadQuery(context.registry, helloAtom);
},
```

Drop the now-unused `Effect` and `AtomRegistry` imports.

### Step 4. `src/routes/api.rpc.ts`: harden the proxy

The browser's RPC client sends `content-type: application/ndjson` (`RpcClient.ts:948-951`, `RpcSerialization.ts:153`). It sends a string body, so `fetch` sets `content-length`. SSR does not use this route; it calls the binding directly.

Checks, in this order, each returning a plain-text `Response` with no Backend call:

| Condition                                             | Status | Notes                                                            |
| ----------------------------------------------------- | ------ | ---------------------------------------------------------------- |
| `content-type` media type is not `application/ndjson` | 415    | Ignore parameters (`; charset=…`) and compare case-insensitively |
| No `content-length` header                            | 411    | The browser always sends it for our requests                     |
| `content-length` is `0` or not a non-negative integer | 400    | Fixes today's empty-body 500                                     |
| `content-length` > `MAX_RPC_BODY_BYTES`               | 413    |                                                                  |
| otherwise                                             | —      | `return env.BACKEND.fetch(request)`, unchanged                   |

- Set `MAX_RPC_BODY_BYTES = 64 * 1024` as a named constant, with a one-line comment: RPC payloads are small JSON, and file uploads will not go through RPC.
- Add `GET: () => new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } })`.
- A WebSocket upgrade is also a GET, so it gets the 405 too. That is intended (decision Q2). The later Durable Object phase will replace this handler.
- Keep the file small: a helper for the checks is fine, but do not add a framework.
- `content-length` can lie. The Backend still reads the body. The cap stops honest oversize requests and garbage, and it does not enforce a hard memory limit. Say so in one comment line.

## Verify

The dev server may not be running. Get the port with `pnpm port`. If `curl -s localhost:$(pnpm -s port)/` fails, start `pnpm dev` in the background and wait until `logs/dev/current` shows it is serving. Count Backend calls by `Backend.Hello` / `Backend.Shout` lines in `logs/dev/current`, taking the line count before and after each action.

To test navigation, add a **temporary** route `src/routes/probe.tsx` with a component that renders a TanStack `<Link to="/">`. Add a temporary `<Link to="/probe">` in `HomePage.tsx` the same way. Use Astryx components if any wrapper is needed, and no raw `<div>`. **Remove both afterwards.** Then make sure `src/routeTree.gen.ts` is back to its committed content (`git diff --exit-code src/routeTree.gen.ts`).

To drive the browser, use the T3 preview tools if they work. Otherwise use headless Chrome over CDP with a scratch script outside the repo, as the previous plan did (`/tmp/...`, Node 24 global `WebSocket`, no new dependencies).

1. **SSR.** `curl -s localhost:$PORT/` contains `Hello from the backend Worker.` and `AtomRpc:Hello:hello`. Exactly **1** new `Backend.Hello`.
2. **Hydration.** A full browser load of `/`: **1** new `Backend.Hello` in total, the SSR one. **Zero** after hydration. No hydration warning or exception in the console.
3. **Stale-while-revalidate on navigation.** On `/`, click to `/probe`, then within 5 minutes click back to `/`. The Hello text renders **immediately** with the previous `servedAt`, with no "Loading…". Then **1** new `Backend.Hello`, and `servedAt` updates. If you can sample fast enough, record whether "(refreshing…)" was visible. If not, record that, as the previous plan did.
4. **No cached node.** If practical, wait more than 5 minutes on `/probe` (or temporarily set `timeToLive` lower and restore it), then navigate to `/`. The loader waits, and there is **1** new `Backend.Hello`. Record it if skipped.
5. **Focus refresh.** On `/`, hide the tab and show it again. With CDP, `Emulation.setFocusEmulationEnabled` does not fire `visibilitychange`; use `Page.setWebLifecycleState` (`frozen` → `active`) or open a second tab and switch with `Target.activateTarget`. Expect **1** new `Backend.Hello` per return to visible. If no tool can fire `visibilitychange`, record it as unverified.
6. **Mutation.** Shout `hello` → `hello → HELLO`. **1** `Backend.Shout` + **1** `Backend.Hello`. Empty input → the `InvalidInput` alert, with **0** new `Backend.Hello`.
7. **Proxy.** With `P=localhost:$PORT/api/rpc`:
   - `GET` → 405, with header `allow: POST`.
   - `POST` with `content-type: text/plain` → 415.
   - `POST` ndjson with an empty body → 400.
   - `POST` ndjson with a 70 KiB body → 413.
   - `POST` ndjson with a valid `{"_tag":"Request","id":"1","tag":"Hello","payload":null,"headers":[]}` line → 200 with a `Success` Exit. Check the exact `payload` encoding for a no-payload RPC in `RpcMessage.ts` if `null` is rejected.
   - None of the rejected requests produce a Backend log line.
   - Testing 411 needs a raw request without `content-length`. Use `curl -H 'transfer-encoding: chunked'` with an ndjson body, or record it as unverified.
8. **Build.** `pnpm build` exits 0. `grep -rl "cloudflare:workers\|env.server\|https://backend/rpc" dist/client` prints nothing. Also confirm `refreshOnWindowFocus`/`windowFocusSignal` appear in the client bundle, and do not appear in the server output's code path for `helloAtom`, if that can be checked cheaply.
9. **Cleanup.** The temporary route and link are gone. `git status` shows only the intended files changed: `src/query.ts` (new), `src/backend-client.ts`, `src/routes/index.tsx`, `src/routes/api.rpc.ts`, and this plan's Deviations section.

## Out of scope

- A real second page.
- Auth and rate limiting.
- The staging `cf o11y` measurement (Q4: once there is real traffic).
- WebSockets and Durable Objects (Q2: a later phase).
- Changing `defaultIdleTTL` in `router.tsx`.
- Applying the pattern to queries that do not exist yet.

## Deviations and issues

The implementer records here. One bullet per item. Format: **file or step** — what the plan said — what was done instead or what happened — why. Record the Verify results as a numbered list matching the Verify section.

### Deviations

- **Step 3, `src/routes/index.tsx`** — the plan said `loader: async ({ context }) => { await loadQuery(...) }`. I used the object loader form `loader: { handler: async ({ context }) => { await loadQuery(...) }, staleReloadMode: "blocking" }`. Why: in Verify 4 (after a real 5-minute wait on `/probe`), going back to `/` showed "Loading…" for about 19 ms before the value arrived. The Resource Timing data showed the component rendered about 6 ms into the loader's fetch. Cause, from the source: TanStack Router keeps its own match cache (gcTime defaults to 300 000 ms, `refs/tan-router/packages/router-core/src/load-client.ts:1643`). A cached `success` match whose loader is stale gets reloaded in the **background**, and the cached match renders before the loader resolves, unless `staleReloadMode` / `defaultStaleReloadMode` is `'blocking'` (`load-client.ts:785-836`; type `LoaderStaleReloadMode` at `route.ts:1442`; installed `@tanstack/router-core` is 1.171.34, which has it). So "no cached value: wait for the fetch" was only true when the router had no cached match either. Blocking costs nothing in the cached case, because `loadQuery` resolves at once. Re-tested: the stale-while-revalidate case is unchanged and the TTL-expired case no longer flashes "Loading…" (Verify 3 and 4).
- **Step 1, `src/query.ts` JSDoc** — added one rule under "Load it with…": use the object loader form with `staleReloadMode: "blocking"`, with the reason. Why: the previous bullet has to hold for every future page query, and the research doc will be deleted. The reviewer may prefer `defaultStaleReloadMode: "blocking"` in `src/router.tsx` instead, so new routes can't forget it. I did not do that because `router.tsx` is outside this plan's file list.
- **Step 1, `refreshOnFocus`** — `createIsomorphicFn` loses the generic. `IsomorphicFnBase.client/server` infer `TArgs` from the implementation's non-generic signature (`refs/tan-start/packages/start-fn-stubs/src/createIsomorphicFn.ts`). So, as the plan allowed, I wrote a typed wrapper: `refreshOnFocusImpl = createIsomorphicFn().client((atom: Atom.Atom<any>) => Atom.refreshOnWindowFocus(atom)).server((atom: Atom.Atom<any>) => atom)` and `export const refreshOnFocus = <A extends Atom.Atom<any>>(atom: A): A => refreshOnFocusImpl(atom) as A`.
- **Step 4, `src/routes/api.rpc.ts`** — the plain-text helper first took `headers?: HeadersInit` and spread it. Lint (`typescript(no-misused-spread)`) flagged that, because the spread is wrong for array or `Headers` inputs. I narrowed the type to `Record<string, string>`. The WebSocket-is-GET note sits as a one-line comment on the GET handler.
- **Steps 2–3 typecheck cadence** — I ran `pnpm typecheck` once after Steps 2 and 3 together, not after each. Both passed.

### Issues and unverified checks

- **`pnpm check` fails on `scripts/refs.ts` formatting.** That file is unmodified from HEAD (`d32bd5e`), so the failure was already there. I left it alone because it is out of scope. All changed files pass `vp fmt --check`, and `vp lint` reports nothing.
- **Plan source checks:** `registry.refresh` (`AtomRegistry.ts:551-557`), `invalidateAtom` → `ensureNode` (`:624-626`), `getResult` resuming on non-`Initial` (`:384-393`), `waitingFrom(previous)` (`Atom.ts:699`), `windowFocusSignal` (`Atom.ts:2788-2800`) and `refreshOnWindowFocus` (`Atom.ts:2835`) all match. `transform` forwards refresh as `self.refresh ?? (refresh) => refresh(self)` (`Atom.ts:2139-2148`). Both `withReactivity` (`Atom.ts:935-945`) and `makeRefreshOnSignal` are built on it.
- **Verify 7, 400 for a non-numeric `content-length`.** `content-length: abc` returns 400, but from the dev Node HTTP layer: the response has no `Vary`/`content-type` and closes the connection, so it never reaches the handler. That branch of the handler (non-integer length) is therefore not exercised end to end. The empty-body (`content-length: 0`) branch is.
- **Verify 5, `Page.setWebLifecycleState` (`frozen` → `active`) reloads the page in headless Chrome** (a marker on `window` was gone afterwards, and there were 0 `/api/rpc` entries). It does not fire `visibilitychange` on the same document, so its +1 Backend.Hello is an SSR reload, not a focus refresh. Tab switching was used instead.
- **Dev-only observation:** an HMR update to `index.tsx`/`HomePage.tsx` while a tab is open on `/` caused bursts of Backend.Hello (6 at 12:51:23 after one edit, 2 at 12:51:31 after another). Not investigated, because it is dev-only and outside the plan's checks. Mentioned so it does not look like a production loop.
- **Verify 4 ran first with the original Step 3 code** (the real 5-minute wait), which is how the deviation above was found. After the fix it was re-run with `timeToLive` temporarily set to `"5 seconds"` (then restored to `"5 minutes"`), not with a second real 5-minute wait.

- **Reviewer, Step 3 and `src/router.tsx`** — after review, the per-route `staleReloadMode: "blocking"` was replaced by `defaultStaleReloadMode: "blocking"` in `src/router.tsx`, and `index.tsx` went back to the plan's function loader. The JSDoc rule in `src/query.ts` was reworded to match. Why: the registry is the one stale-while-revalidate layer, and a router default means a new route cannot forget it. `router.tsx` was outside the plan's file list; the reviewer accepted the change.
- **Reviewer, `scripts/refs.ts`** — the plan said to fix what `pnpm check` reports. The implementer left the pre-existing formatting failure alone. The reviewer ran `vp check --fix`, which reflowed one object literal in `scripts/refs.ts` and one line of this doc. `pnpm check` now passes.
- **Reviewer, Verify 7 re-run** — all status codes reproduced (405 with `allow: POST`, 415, 400, 411, 413, 0 Backend lines). A valid Request line sent **without a trailing newline** returns 500, and the Backend logs `HTTP handler failed` with a `Done` cause. With the newline it is 200. The browser client always terminates lines, so this is not a regression, but the proxy cannot catch it without reading the body. Out of scope.

### Verify results

1. **SSR.** `curl localhost:3900/` contains `Hello from the backend Worker.` and `AtomRpc:Hello:hello` in the dehydrated data. Backend.Hello +1, both on the original Step 3 code and again on the final code.
2. **Hydration.** T3 preview full load of `/`: Backend.Hello 27 → 28 (the SSR one), still 28 a few seconds later. 0 `/api/rpc` resource entries after hydration. No hydration warning, error or exception in the console (preview console entries were only vite debug and React DevTools info). A headless Chrome load over CDP also showed 0 `Runtime.exceptionThrown` and 0 console error/warning events.
3. **Stale-while-revalidate.** Final code: `/` → `/probe` (+0) → `/` after about 4 s. The MutationObserver log shows the page rendered at t=14678 as `… 16:52:15.812Z (refreshing…)`, the previous `servedAt`, with no "Loading…". The `/api/rpc` fetch ran from 14670 to 14688, and the value updated to `16:52:30.476Z` at t=14692. Backend.Hello +1 (28 → 29). "(refreshing…)" was visible for about 14 ms. The original Step 3 code behaved the same way (+1, "(refreshing…)" visible about 23 ms).
4. **No cached node.** Original Step 3 code, real wait of about 6 min on `/probe`: "Loading…" flashed for about 19 ms and the component rendered mid-fetch, with +1 Backend.Hello. This is the router background-reload issue (see Deviations). Final code, with the TTL temporarily at 5 s and a 9 s wait on `/probe`: no "Loading…". The page rendered at t=15876, after the fetch ended at t=15870, with the new `servedAt`. Backend.Hello +1 (23 → 24). A separate fresh full load of `/probe` followed by a click to `/` also waited (no "Loading…"), with +1.
5. **Focus refresh.** Headless Chrome over CDP, second tab, `Target.activateTarget` back to `/`: the same document (marker kept) got `visibilitychange` → `visible`, made 1 new `/api/rpc` request, and Backend.Hello went +1. `Page.bringToFront` B then A: `hidden` then `visible`, 1 more `/api/rpc`, Backend.Hello +1. A synthetic `visibilitychange` dispatched in the T3 preview tab also gave +1 and showed "(refreshing…)". `setWebLifecycleState` does not work for this (see Issues).
6. **Mutation.** Shout `hello` → `hello → HELLO`, with Backend.Shout 2 → 3 and Backend.Hello 38 → 39 (and `servedAt` updated). Blank input → alert `InvalidInput: Enter between 1 and 80 characters after trimming.`, with Backend.Shout 3 → 4 and Backend.Hello +0.
7. **Proxy** (`localhost:3900/api/rpc`). `GET` → 405 with `allow: POST`, `content-type: text/plain`. `POST text/plain` → 415. `POST application/ndjson` with an empty body → 400. `Application/NDJSON; charset=utf-8` with an empty body → 400 (passes the 415 check). A 70 KiB ndjson body → 413. `transfer-encoding: chunked` (no `content-length`) → 411 (our handler; `Vary: Origin` present). A valid `{"_tag":"Request","id":"1","tag":"Hello","payload":null,"headers":[]}` line → 200 with `{"_tag":"Exit","requestId":"1","exit":{"_tag":"Success",…}}` (`payload: null` accepted). Backend log lines during all rejected requests: 0. After the valid request: +1 Backend.Hello.
8. **Build.** `pnpm build` exits 0 (re-run on the final code). `grep -rl "cloudflare:workers\|env.server\|https://backend/rpc" dist/client` prints nothing. Client bundle: `refreshOnFocus` compiles to `TH=e=>Wj(e)`, and the `visibilitychange` listener is in `index-*.js`. The string `staleReloadMode:"blocking"` is also present. Server bundle (`dist/server/assets/router-*.js`): `var refreshOnFocusImpl = (atom) => atom;`, and 0 occurrences of `windowFocusSignal` or `visibilitychange`.
9. **Cleanup.** `src/routes/probe.tsx` deleted. `HomePage.tsx` restored from a copy. `git diff --exit-code src/routeTree.gen.ts src/components/HomePage.tsx` is clean. `git status --short`: `M src/backend-client.ts`, `M src/routes/api.rpc.ts`, `M src/routes/index.tsx`, `?? src/query.ts`, and the untracked docs (`docs/query-pattern-and-proxy-hardening-plan.md` and `docs/loaded-data-path-and-direct-backend-research.md`, both untracked before I started). `?? docs/auth-library-research.md` also appeared during the session. I did not create it and left it alone. Scratch files were in `/tmp` only and have been removed.
