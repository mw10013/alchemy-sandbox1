# Research: how the TanStack Start Worker talks to the Effect Worker

Date: 2026-10-10 (revision 4, after the spike)  
Status: research verified against the pinned sources; corrections are marked **[rev 3]**. Implementation plan: [`start-to-effect-worker-ipc-plan.md`](./start-to-effect-worker-ipc-plan.md).  
Versions: Alchemy `2.0.0-beta.81`, Effect `4.0.1`, `@effect/atom-react` `4.0.1`, `@tanstack/react-start` `1.168.60`.

Sources read:

- `refs/` (alchemy, effect including its tests, effect-tanstack-start, tan-router, tan-start, cloudflare-docs).
- Community repos: [peterje/alchemy-starter](https://github.com/peterje/alchemy-starter), [patrikduksin/fullstack-take-home-assignment](https://github.com/patrikduksin/fullstack-take-home-assignment).
- Lucas Barake's [effect-tanstack-start](https://github.com/lucas-barake/effect-tanstack-start), [effect-file-manager](https://github.com/lucas-barake/effect-file-manager), and [effect-monorepo](https://github.com/lucas-barake/effect-monorepo).
- [yielded-dev/auth](https://github.com/yielded-dev/auth).

> **Relation to earlier docs.** [Worker split](./tanstack-start-alchemy-worker-split-research.md) settled on two Workers: Start in `Website.Vite` (plain TypeScript) and Effect in a private `Cloudflare.Worker` behind a service binding. This document covers the IPC across that binding, plus the browser path, atoms with SSR, and auth.

## Decisions so far

| #   | Decision                                                                                                                                                                                                                                                    | Source                       |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| D1  | We need SSR with data. Client-only rendering is out.                                                                                                                                                                                                        | Round 0                      |
| D2  | **Every crossing is external data and is validated with Effect Schema at both ends.** This covers browser ↔ Start, Start ↔ backend, and backend ↔ Durable Objects.                                                                                          | Round 1                      |
| D3  | **Raw `toRpcAsync` is off the table** as the application protocol. See [§2](#2-why-validation-rules-out-raw-torpcasync).                                                                                                                                    | Round 1                      |
| D4  | The backend is **internal**: called by Start, by Durable Objects, and possibly by our own browser code. It is not a public or third-party API.                                                                                                              | Round 1                      |
| D5  | Atoms over `useState`/`useEffect` by default, **without being dogmatic** while we prototype.                                                                                                                                                                | Round 1                      |
| D6  | Version skew is **deferred**. Boundary validation (D2) is the only skew defence for now.                                                                                                                                                                    | Round 1                      |
| D7  | Single package for now (`src/api`, `src/backend`, Start app).                                                                                                                                                                                               | Round 1                      |
| D8  | Auth lives in an Effect Worker, not in the plain-TypeScript Start Worker.                                                                                                                                                                                   | Round 1 (library still open) |
| D9  | **Protocol is Effect RPC (`RpcGroup`)**, ndjson.                                                                                                                                                                                                            | Round 2                      |
| D10 | **Browser path is the same-origin proxy through Start** for now. Revisit a direct Workers Route after a custom domain.                                                                                                                                      | Round 2                      |
| D11 | Detecting multiple sessions is a **proof of concept**, not a hard requirement.                                                                                                                                                                              | Round 2                      |
| D12 | **Two Workers.** The Effect backend stays a separate Worker behind the service binding. Running Effect in Start's catch-all route is tabled ([§10](#10-tabled-effect-inside-starts-catch-all-route)).                                                       | Round 3                      |
| D13 | **Tab limiting is tabled.** The concern is load and cost, and auth libraries can't detect tabs ([§11](#11-tabled-several-tabs-in-one-browser)).                                                                                                             | Round 3                      |
| D14 | **Auth is deferred,** library included. No D1 yet ([§8](#8-auth-deferred-d14)).                                                                                                                                                                             | Round 3                      |
| D15 | The spike includes **router-level `dehydrate`/`hydrate` from the start**.                                                                                                                                                                                   | Round 3                      |
| D16 | **Vocabulary:** `src/api/` holds the API definition (no "contract"); `src/domain/` is created with the first real entity. The Workers are **Website** and **Backend**. No domain vocabulary yet. The glossary lives in [`docs/glossary.md`](./glossary.md). | Round 4                      |

## Revision 3: what source verification changed

Every API named in this document was checked against the installed Effect `4.0.1`, `@effect/atom-react` `4.0.1`, Alchemy `2.0.0-beta.81`, and the pinned TanStack sources in `refs/`. The architecture and decisions D1–D16 stand. These details were wrong or incomplete and are corrected inline below:

| #   | Was                                                                                              | Now                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Where  |
| --- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| C1  | Query atoms get reactivity with `.pipe(Atom.withReactivity([...]))`.                             | **Rev 3 first said to use the `reactivityKeys` option instead; rev 4 reverses that.** Piping `withReactivity` outside is correct and preferable. The wrapper is not serializable, but the inner query atom still is, still gets a registry node, and is dehydrated by its key. On hydration the inner node is set _valid_ (no `initialValueTarget`), so the browser does not refetch. With the `reactivityKeys` option the wrapper is the serializable one, hydration lands on the inner atom as _stale_, and a refetch follows. Measured: 1 Backend call per page load with the outer wrapper, 2 with the option (`Atom.ts:945`, `AtomRegistry.ts:596-606`). | §5     |
| C2  | "Verify whether a background refetch happens after hydration."                                   | Answered from source. With `reactivityKeys`, the hydrated value lands on the inner atom via `setInitialValue`, which marks it stale; the first read runs the procedure again and shows the hydrated value with `waiting: true`. Without `reactivityKeys`, the value is set as valid and no refetch happens (`AtomRegistry.ts:596-606, 935-954`; `Atom.ts:698-701`). Confirmed empirically, and avoided by the C1 (rev 4) shape, which gives both no refetch and declarative invalidation.                                                                                                                                                                     | §5     |
| C3  | "Failed queries are dropped from dehydration and refetched on the client."                       | Wrong. `AtomRpc` builds the serialization schema as `AsyncResult.Schema({ success, error: Union(error, middleware errors, RpcClientError) })`, whose failure branch is `Schema.Cause(error, Schema.Defect())`. Failures _and_ defects serialize. Only a value that the union cannot encode is skipped (Effect's test: a client-side middleware failure). We do not hand-write an `Exit` schema.                                                                                                                                                                                                                                                               | §5     |
| C4  | `dehydrate: () => Hydration.dehydrate(registry, { encodeInitialAs: "promise" })`                 | Use the default (`"ignore"`). Loaders finish before `dehydrate` runs, so primed atoms are already `Success`. `"promise"` puts `Promise` objects into the router's dehydrated state for no benefit.                                                                                                                                                                                                                                                                                                                                                                                                                                                            | §5     |
| C5  | `Layer.succeed(FetchHttpClient.Fetch, fn)`                                                       | Effect 4's `Layer.succeed` is curried: `Layer.succeed(FetchHttpClient.Fetch)(fn)`. `FetchHttpClient.Fetch` is a `Context.Reference` defaulting to `globalThis.fetch`, so overriding it is the right hook.                                                                                                                                                                                                                                                                                                                                                                                                                                                     | §5     |
| C6  | `BackendClient.query("Hello", {})`                                                               | The payload constructor for a procedure without a payload is `void`: `query("Hello", undefined)`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | §5     |
| C7  | Backend `fetch = RpcServer.toHttpEffect(BackendRpcs)` inside `Cloudflare.Worker`.                | Use `Cloudflare.RpcWorker`. It exists for exactly this: the init Effect returns `RpcServer.toHttpEffect(group).pipe(Effect.provide(handlers), Effect.provide(RpcSerialization.layerNdjson))` and Alchemy wires it to `fetch` and manages the scope (`RpcWorker.ts:280-330`). It also keeps `RpcWorker.bind` available if a second Effect Worker ever needs a typed client. Props still accept `workersDev: false` and `compatibility`.                                                                                                                                                                                                                        | §12    |
| C8  | "Vite guard against server-only imports" (alchemy-starter's plugin).                             | Not needed. TanStack Start's built-in import protection denies `*.server.*` files in the client build and fails the build if such an import survives tree-shaking. The compiler prunes imports used only inside a `createIsomorphicFn().server()` body. Rename `src/env.ts` to `src/env.server.ts`.                                                                                                                                                                                                                                                                                                                                                           | §12    |
| C9  | `RpcMiddleware` "declared with `provides: CurrentUser`".                                         | In Effect 4, `provides` is a type parameter: `class CurrentUserMiddleware extends RpcMiddleware.Service<CurrentUserMiddleware, { provides: CurrentUser }>()("CurrentUserMiddleware") {}`. A middleware attached to a procedure must have a server implementation, so the spike declares the class without attaching it.                                                                                                                                                                                                                                                                                                                                       | §4, §8 |
| C10 | `.validator(Schema.toStandardSchemaV1(Input))` on server functions.                              | Confirmed correct after a wrong rev 3 correction: `.validator(...)` is current and `.inputValidator(...)` is deprecated in this Start version (`createServerFn.ts:513`). Moot for the spike, which deletes the server functions.                                                                                                                                                                                                                                                                                                                                                                                                                              | §3     |
| C11 | "Dispose the server registry when the request ends (same lifecycle hook as router-ssr-query)".   | Named: `router.serverSsrLifecycle.onServerSsrAttach` receives the `serverSsr` object; call `serverSsr.onCleanup(() => registry.dispose())`. This is what `@tanstack/router-ssr-query-core` does. It is an undocumented field, so the spike treats it as best effort.                                                                                                                                                                                                                                                                                                                                                                                          | §5     |
| C12 | `timeToLive` "keeps the primed value alive between loader and render" (listed as a verify item). | Required by construction. Without it, node removal is scheduled as soon as the loader's subscription ends and the value may be gone before `dehydrate`. Keep `timeToLive`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | §5     |

Also confirmed: `Wrap` is a router option (`react-router/src/router.ts:58`); the browser calls `options.hydrate` before `matchRoutes` (`load-client.ts:2226, 2240`); `getRouter()` runs once per request on the server (`createStartHandler.ts:610`); `Schema.toStandardSchemaV1`, `Schema.TaggedError`, `RpcSerialization.layerNdjson`, `RpcClient.layerProtocolHttp({ url })`, `AtomRegistry.getResult(registry, atom, { suspendOnWaiting })`, `useAtom(atom, { mode: "promiseExit" })`, and the `RegistryContext` module-level default all exist as described.

## Summary

- **Protocol: Effect RPC (`RpcGroup`)** in a schemas-only API definition (`src/api`), served by the backend over HTTP through the service binding.
  - Because the backend is internal (D4), RPC's advantages win: full `Exit` round-trips including defects, typed streams, simple procedure definitions, and the same protocol Alchemy uses for `RpcWorker`/`RpcDurableObject`.
  - What we give up only matters for public APIs: real HTTP verbs, GET/CDN caching, OpenAPI, curl.
- **Validation is automatic with RPC.**
  - The server decodes payloads and encodes the `Exit`. The client encodes payloads and decodes the `Exit`.
  - We don't hand-write any encode or decode calls.
  - Plain TypeScript in Start can still use Schema directly. It already runs Effect internally, so "no Effect runtime in Start" is not a real constraint ([§3](#3-effect-in-a-plain-typescript-worker)).
- **One client, two transports.** A single `AtomRpc` client:
  - **During SSR** it goes over the service binding in-process. It swaps `FetchHttpClient.Fetch` for `env.BACKEND.fetch` and forwards the visitor's cookie.
  - **In the browser** it goes over `fetch` to a same-origin `/api/rpc` route in Start, which proxies to the binding.
- **SSR with atoms.** One `AtomRegistry` per request, owned by the router:
  1. Loaders prime the query atoms.
  2. The router's `dehydrate` callback serializes the registry with Effect's `Hydration` module.
  3. Its `hydrate` callback restores it in the browser.
  4. Mutations are atoms with `reactivityKeys`.

  None of the repos we looked at wires this up end to end. This is Effect's own canonical pattern, verified against its tests, plus the router wiring, which nobody provides.

- **Browser path:**
  - **Now:** a same-origin proxy through Start. On workers.dev a route that points `/api/*` straight at the backend is impossible.
  - **Later, with a custom domain:** a Workers Route `example.com/api/*` → backend would skip the Start hop. This only pays off if measurements show it's worth it.
- **Auth is deferred (D14).** It will live in the Effect backend (D8). The candidates are recorded in [§8](#8-auth-deferred-d14).

## 1. What the surveyed repos do

|                 | alchemy-starter                                     | take-home                                       | Lucas Barake (effect-tanstack-start)                                                  | Ours (today)                                 |
| --------------- | --------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------- |
| Topology        | Start + private Effect Worker                       | Start + private Effect Worker                   | **Effect inside Start** (one Worker)                                                  | Start + private Effect Worker                |
| Start → backend | `/api/$` proxy → `env.API.fetch`                    | `/api/$` and `/rpc` proxy → `env.BACKEND.fetch` | In-process `HttpRouter.toWebHandler` at `/api/$`                                      | `createServerFn` → `toRpcAsync` (native RPC) |
| Protocol        | `HttpApi`                                           | One definition → `HttpApi` + `RpcGroup` + MCP   | One schema set → `HttpApi` + `RpcGroup`; UI uses RPC (ndjson)                         | Workers JS RPC                               |
| Validation      | Both ends (automatic)                               | Both ends                                       | Both ends over the wire. **Not during SSR**: the loader calls the service in-process. | **None**                                     |
| Client          | `AtomHttpApi`, isomorphic transport                 | `AtomRpc` + hand-written `HttpClient`           | `AtomRpc`-style `runtime.atom` + cache-edit enum                                      | Server functions + `useState`                |
| SSR data        | Yes, but **not transferred**: the client refetches  | None (`ClientOnly`)                             | Yes: server function → hand-built `dehydrate` → `HydrationBoundary`                   | Loader → server function                     |
| Auth            | WorkOS, cookie, `HttpApiMiddleware`                 | None                                            | None (middleware stubs only)                                                          | None                                         |
| Discipline      | Lint bans server functions, `useState`, `useEffect` | None                                            | Uses `useState`                                                                       | None                                         |

**What to take from each:**

- **alchemy-starter:**
  - The isomorphic transport (`createIsomorphicFn`: in-process binding during SSR, `fetch` in the browser).
  - Cookie forwarding.
  - The Vite plugin that fails the client build if server-only modules leak into it.
- **Lucas Barake:**
  - A schemas-only shared package with branded IDs.
  - `TaggedError`s.
  - Auth middleware declared alongside the procedures (`provides: CurrentUser`).
  - Composable policy combinators.
  - `withToast(Cause)`.
  - `serializable` + `HydrationBoundary` for SSR.
  - What to avoid:
    - Skipping the API boundary during SSR.
    - A module-global `ManagedRuntime`.
    - `HttpClient.filterStatusOk`, which swallows typed HttpApi errors.
    - A hydration error schema that is missing domain errors.
- **take-home:** one definition projected to several protocols is elegant, but we don't have several kinds of consumer (D4).

## 2. Why validation rules out raw `toRpcAsync`

**What `toRpcAsync` does today** (`refs/alchemy/.../Workers/RpcAsync.ts`, `WorkerBridge.ts:442-465`):

- Success values are structured-cloned with no checks.
- Typed failures become plain `{ _tag, ...keys }` objects.
- Defects lose their prototype and stack.
- Class instances (`Schema.Class`, `Option`, `DateTime`) are rejected outright.

**Adding validation to it means doing this for every method:**

- The backend decodes the arguments and returns `Schema.encodeSync(Exit(Success, Error, Defect))(exit)`.
- Start encodes the input and decodes that `Exit`.

That is a hand-written copy of what `RpcServer`/`RpcClient` already do. It still has no browser path, atoms, hydration keys, or tracing.

**Verdict:** agreed, drop it as the app protocol.

**Native RPC is still the right tool for:**

- Passing `ReadableStream`, `Request`/`Response`, or `RpcTarget` capabilities.
- Hot internal fan-out.

Use it only where both sides validate, or where the payload is opaque bytes.

## 3. Effect in a plain-TypeScript Worker

**What `Website.Vite` actually lacks** is Alchemy's _managed_ Effect runtime: the per-request layer, scope, `waitUntil`, and Effect binding clients. It does not prevent running Effect code.

**Sync Schema already runs Effect:**

- The sync decoders are implemented with `Effect.runSyncExit` (`Schema.ts:1262`, `SchemaParser.ts:77`).
- Every Schema call in the Start Worker already runs the Effect fiber runtime as ordinary library code.

**Sync APIs** (`Schema.ts`) for when we want them:

| Kind   | Functions                                                                                                     |
| ------ | ------------------------------------------------------------------------------------------------------------- |
| Guards | `Schema.is(S)(u)`, `Schema.asserts(S, u)`                                                                     |
| Decode | `decodeUnknownSync` (throws `SchemaError`), `decodeUnknownExit`, `decodeUnknownOption`, `decodeUnknownResult` |
| Encode | `encodeSync`, `encodeExit`, and so on                                                                         |
| Other  | `Schema.toStandardSchemaV1(S)`                                                                                |

- Every built-in schema is synchronous. Only a custom async `transformOrFail` or `declare` would break the sync adapters.
- The `SchemaError.issue` tree formats to messages with paths.
- **Server functions accept Standard Schema directly** (`start-client-core/createServerFn.ts:895`). Where we keep one, use `.validator(Schema.toStandardSchemaV1(Input))`; `.inputValidator` is the deprecated name **[rev 3, C10]**.

**Atoms and RPC clients in Start:**

- `Effect.runPromise` works in workerd: its scheduler uses `setImmediate`/`setTimeout(0)`, and Alchemy's own bridge calls it.
- Atoms are an Effect runtime per registry. That is how SSR fetches happen.

**The real constraints come from workerd, not Effect:**

- No I/O at module-evaluation time. Layers are lazy, so build them inside a request.
- Don't share I/O objects across requests.
- Close scopes yourself if a finalizer matters.
- Watch the browser bundle size.
- No module-level `AtomRegistry` on the server ([§5](#5-ssr-with-atoms)).

## 4. Protocol: Effect RPC vs `HttpApi` for an internal backend

|                  | **Effect RPC (`RpcGroup`)**                                                        | `HttpApi`                                                 |
| ---------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Validation       | Both ends, whole `Exit`                                                            | Both ends; a defect becomes a 500 response with no detail |
| Errors in the UI | Typed classes; **defects round-trip** (`Schema.Defect`)                            | Typed classes by status code; defects are opaque          |
| Definitions      | `Rpc.make(tag, { payload, success, error, stream? })`                              | Paths, verbs, params, `httpApiStatus` per error           |
| Streaming        | Typed `Stream` (`stream: true`, ndjson), `PullResult` atoms                        | SSE, bytes                                                |
| Atoms            | `AtomRpc`: `query`, `mutation`, `reactivityKeys`, `timeToLive`, `serializationKey` | `AtomHttpApi`: same, plus `responseMode` and `baseUrl`    |
| Alchemy fit      | `RpcWorker.bind` and `RpcDurableObject` use exactly this (ndjson)                  | Not used by Alchemy primitives                            |
| HTTP semantics   | One POST endpoint; no GET or CDN caching; opaque bodies                            | Verbs, caching headers, OpenAPI, curl, `traceparent`      |

**Recommendation: `RpcGroup`.** The `HttpApi` advantages matter for public APIs (D4 says we don't have one). The one real loss is GET caching, and for public pages SSR already covers that.

**Conventions:**

- **Serialization:** use `RpcSerialization.layerNdjson` everywhere, to match Alchemy's `RpcWorker.bind`/`RpcDurableObject` defaults and to allow streaming.
- **The API definition** (`src/api`) holds only schemas: `RpcGroup`s, branded IDs, `Schema.TaggedError`s, and `RpcMiddleware` declarations such as `RpcMiddleware.Service<Self, { provides: CurrentUser }>()("CurrentUserMiddleware")` **[rev 3, C9]**.

**When to revisit:**

- A real external consumer appears.
- We want HTTP caching for public data.

Both protocols share the same schemas, so adding an `HttpApi` projection later is incremental.

## 5. SSR with atoms

This is Effect's canonical pattern (from `test/reactivity/AtomRpc.test.ts` and `atom/react/test/index.test.tsx`): a schemas-only API definition, one `AtomRpc.Service` with an injectable transport, query atoms for reads, mutation atoms (`AtomResultFn`) with `reactivityKeys`, `AsyncResult` in the UI, and `serializationKey` plus `Hydration.dehydrate`/`hydrate` for SSR. The tests even simulate SSR with a JSON round trip.

The tests stop at the registry. **The router wiring is ours to write.**

### Client (sketch, not yet compiled)

```ts
// src/backend-client.ts — runs in SSR and in the browser
// [rev 3, C5] Layer.succeed is curried in Effect 4.
const transport = createIsomorphicFn()
  .client(() => FetchHttpClient.layer)
  .server(() =>
    FetchHttpClient.layer.pipe(
      Layer.provide(
        Layer.succeed(FetchHttpClient.Fetch)((input, init) => env.BACKEND.fetch(input, init)),
      ),
    ),
  );

export class BackendClient extends AtomRpc.Service<BackendClient>()("BackendClient", {
  group: BackendRpcs,
  protocol: RpcClient.layerProtocolHttp({ url: rpcUrl() }).pipe(
    // absolute URL during SSR
    Layer.provide(RpcSerialization.layerNdjson),
    Layer.provide(transport()), // + cookie forwarding during SSR
  ),
}) {}
```

### Registry per request, owned by the router

```tsx
// src/router.tsx
export function getRouter() {
  const registry = AtomRegistry.make({ scheduleTask, defaultIdleTTL: 400 });
  const router = createRouter({
    routeTree,
    context: { registry },
    Wrap: ({ children }) => (
      <RegistryContext.Provider value={registry}>{children}</RegistryContext.Provider>
    ),
    dehydrate: () => ({ atoms: Hydration.dehydrate(registry) }), // [rev 3, C4] default encodeInitialAs
    hydrate: ({ atoms }) => Hydration.hydrate(registry, atoms),
  });
  // [rev 3, C11] Dispose the server registry when the request ends, the way router-ssr-query does:
  // router.serverSsrLifecycle = { onServerSsrAttach: [(ssr) => ssr.onCleanup(() => registry.dispose())] }
  return router;
}
```

### Loader primes, component reads, mutation invalidates

```ts
// [rev 4, C1 + C6] Serializable query inside, reactivity wrapper outside: hydrated as valid
// (no refetch) and still invalidated by Shout. A payload-less procedure takes `undefined`.
export const helloAtom = BackendClient.query("Hello", undefined, {
  serializationKey: "hello", timeToLive: "1 minute",
}).pipe(Atom.withReactivity(["hello"]));

loader: ({ context }) =>
  Effect.runPromise(AtomRegistry.getResult(context.registry, helloAtom, { suspendOnWaiting: true })),

const shoutAtom = BackendClient.mutation("Shout");
// component: const [result, shout] = useAtom(shoutAtom, { mode: "promiseExit" })
//            shout({ payload: { input }, reactivityKeys: ["hello"] })
```

### Why this shape

- **`getRouter()` runs once per request,** so one registry per router means one per request.
- **`dehydrate` runs after loaders finish,** and its output is serialized by seroval. The browser calls `hydrate` before it matches routes.
- **One backend call per SSR page,** with no hydration mismatch. alchemy-starter makes two calls because it never transfers the data.
- **Prime every query that SSR renders in a loader.** Atoms first read during render aren't captured, and the client refetches them.
- **Leak risk:** `RegistryContext`'s default value is a module-level registry. An atom hook rendered outside the router `Wrap` on the server would share state across requests in the isolate. The `Wrap` above prevents that. Never create a registry at module level on the server.

### Resolved from source [rev 3]

- **Hydration and reactivity (C2).** A query with `reactivityKeys` is a `withReactivity` transform around the effect atom. `Hydration.hydrate` follows `initialValueTarget` to the inner atom and calls `setInitialValue`, which marks it stale. The first read runs the procedure again and the UI sees the hydrated value with `waiting: true` until it returns. So **with the `reactivityKeys` option, an SSR page costs two backend calls** (one during SSR, one after hydration). A query without that option is set valid and not refetched. **Rev 4:** wrapping the plain serializable query in `Atom.withReactivity` from the outside keeps the no-refetch behaviour and still lets mutations invalidate it. Measured: 1 call per page load, and 1 refetch after a successful `Shout`. There is no "stale time" knob on hydration itself; `Atom.swr({ staleTime })` exists but governs revalidation on read and strips serializability, so it is not the tool here. This is the same problem Baton solves in TanStack Query with `staleTime: 30_000` on the `QueryClient`.
- **`timeToLive` is required (C12),** not optional. Without it the node is scheduled for removal as soon as the loader's subscription ends.
- **Serialization covers failures and defects (C3).** `AtomRpc` derives the schema from the procedure definition, so nothing is hand-maintained and nothing domain-specific can go missing.

### Still to verify in the spike

- That the Start compiler prunes the `env.server.ts` import from the client bundle when it is only used inside `createIsomorphicFn().server()` (C8). The build fails loudly if not.
- That `router.serverSsrLifecycle` is honoured by the Start version we pin (C11). If not, skip disposal; workerd tears the request context down anyway.
- That `scheduler` (React's) works as the registry's `scheduleTask` in workerd during SSR. The module-level `RegistryContext` default already constructs a registry with it, so this is likely fine. Fallback: omit `scheduleTask` on the server.

### Atoms vs `useState` (D5)

- **Server data:** query atoms.
- **Writes:** mutation atoms.
- **Shared UI state:** `Atom.make`/`family`.
- **Browser-only sources:** `Atom.withServerValue`.
- **Form fields:** TanStack Form.
- **Local toggles:** `useState` is fine.
- **Never `useEffect` for fetching.**
- **Optional patterns:**
  - Lucas's cache-edit enum (`Upsert`/`Delete` written into a writable query atom), for local patching without a refetch.
  - `Atom.optimisticFn`, for real optimistic UI.

## 6. Loaders and server functions

Loaders run on the server during SSR and in the browser on navigation. With the isomorphic client, **a loader needs no server function**. A server function would add a second, separately serialized hop and split the cache between loader data and atoms.

**Keep server functions for work that belongs to the Start server:**

- Combining several backend calls into one.
- Using a secret.
- Setting cookies or headers on the HTML response.

Validate those with `Schema.toStandardSchemaV1`, and call the backend through the same RPC client.

## 7. Browser path to the backend

| Option                                                      | Works on workers.dev?     | Cost                                                                                | Notes                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Same-origin proxy** (`/api/rpc` → `env.BACKEND.fetch`) | Yes                       | One request; CPU of both Workers; Start may cold-start                              | Backend stays private; works unchanged in `alchemy dev`                                                                                                                                                                                                                                              |
| **B. Workers Route** `example.com/api/*` → backend          | **No** (needs a zone)     | One request; backend CPU only                                                       | Same origin, no CORS. Backend is internet-facing, so it enforces auth itself (it does anyway, D8). Alchemy supports `routes` on `Cloudflare.Worker`. Routes take precedence over a Custom Domain on the same hostname. **`alchemy dev` doesn't emulate routes**, so dev needs a Vite `server.proxy`. |
| C. Subdomain + CORS                                         | Cross-site on workers.dev | Preflight requests, `SameSite=None` cookies (broken by third-party cookie blocking) | Avoid                                                                                                                                                                                                                                                                                                |
| D. Server functions                                         | Yes                       | Like A                                                                              | Adds a second protocol with its own serialization (see §6)                                                                                                                                                                                                                                           |

Service-binding hops are not billed as extra requests and add no network latency (`pricing.mdx:304-316`; "same thread"). Going direct only saves Start's CPU and cold starts.

**Recommendation:**

- **Now:** A.
- **With a custom domain:** measure Start's CPU and cold-start share on `/api/*` in `cf o11y` first, and move to B if it matters.
- The API definition and client don't change either way. Only the URL and routing do.

## 8. Auth (deferred, D14)

Auth will live in the Effect backend (D8). The library is undecided, and we're not bringing in D1 yet. These are the round-1 findings, kept for when we return to auth.

**Requirements:**

- Email magic link.
- Detecting several sign-ins (proof of concept, D11).

**Candidates:**

- **Better Auth via `@alchemy.run/better-auth`:**
  - Mature, and it fits our Alchemy version.
  - `magicLink` plugin; links work across devices.
  - `listSessions`/`revokeSession`, with user agent and IP.
  - It's an Effect wrapper over a Promise core, needs D1, and runs only inside an Alchemy Effect Worker.
- **yielded-dev/auth:**
  - Effect-native, on `effect/http-api`.
  - Session list and revoke, but no user agent or IP.
  - Magic links complete only in the browser that requested them.
  - About one month old and still in beta.
- **Write our own in Effect:** full control, but roughly 600–1000 lines, and the security review falls on us.

**How it would plug in, whichever we pick:**

- An `RpcMiddleware` declared in `src/api` (`RpcMiddleware.Service<Self, { provides: CurrentUser }>()`) checks the session. It is attached to procedures with `group.middleware(CurrentUserMiddleware)` only once the backend supplies its implementation layer **[rev 3, C9]**.
- Start proxies the auth routes unchanged, so `Set-Cookie` passes through.
- The SSR transport forwards the visitor's cookie.

The spike declares the middleware as a stub, so the API definition is ready for it.

## 9. Version skew (deferred, D6)

We verified the facts and parked them.

- **Deploy order:** Backend deploys before Website.
- **Atomicity:** there is no atomic deploy, and no automatic rollback.
- **Version pinning:** native RPC calls between Workers can't be pinned to a version.
- **Old assets:** old chunks return 404 after a full cutover.
- **Server function IDs** are stable across builds unless a function is moved or renamed.

D2 handles the part that matters now: a mismatch becomes a typed decode error at the boundary. When we come back to this, start with additive-only API changes and a build-version reload prompt.

## 10. Tabled: Effect inside Start's catch-all route

Lucas Barake mounts his Effect backend in Start's `routes/api/$.ts` with `HttpRouter.toWebHandler`. It is self-contained and tractable.

**Pros:**

- One Worker, so no skew between Workers.
- No proxy.

**Cons:**

- We'd lose Alchemy's Effect Worker integration (binding layers, managed runtime, telemetry).
- `@alchemy.run/better-auth` only runs in that integration.
- Start's bundle grows.

**Tabled under D12.** It stays reversible: the client is the same in both topologies. During SSR only the `Fetch` changes, from `env.BACKEND.fetch` to the in-process handler.

## 11. Tabled: several tabs in one browser

The concern is load from several tabs of the same browser.

- **Auth libraries can't help.** Tabs share one cookie, so they share one session.
- **Options for later:**
  - Web Locks leader election, so one tab is active and the others idle.
  - Cloudflare's Rate Limit binding keyed by session (Alchemy `Cloudflare.Workers.RateLimit`).
  - A Durable Object per session tracking tab leases, for an exact cap.

**Tabled under D13.**

## 12. Recommended spike

1. **`src/api/`:** `BackendRpcs` (`Hello`, `Shout`), `InvalidInput` as `Schema.TaggedError`, and a `CurrentUser` service plus `CurrentUserMiddleware` declaration that is **not yet attached** to the group **[rev 3, C9]**.
2. **Backend:** `Cloudflare.RpcWorker` whose init returns `RpcServer.toHttpEffect(BackendRpcs)` provided with the handlers layer and `layerNdjson`; still `workersDev: false` **[rev 3, C7]**.
3. **Website:**
   - `routes/api.rpc.ts` proxy (`POST` only; forward the request to `env.BACKEND.fetch`, return the response as-is).
   - `src/backend-client.ts` (`BackendClient`: `AtomRpc` + isomorphic transport + cookie forwarding).
   - Router-owned registry with `dehydrate`/`hydrate` from the start (D15). This is the trickiest part, so we tackle it first.
   - Rename `src/env.ts` to `src/env.server.ts` so Start's import protection fails the client build on a leak **[rev 3, C8]**.
4. **Index route:**
   - The loader primes `helloAtom`.
   - `shout` becomes a mutation atom.
   - Delete `functions.ts` and the `useState`s in `HomePage.tsx`.
5. **Verify:**
   - Count backend calls per SSR load in the logs. Expect **two** with `reactivityKeys` on `helloAtom` (SSR + post-hydration refetch, C2) and **one** without.
   - No hydration warning.
   - Typed `InvalidInput` shows in the UI.
   - A defect round-trips (temporarily throw inside the `Shout` handler).
   - Client-side navigation away and back reuses the registry value within `timeToLive`.

**Refetch (C2), decided in rev 4:** `helloAtom` is a plain serializable query wrapped in `Atom.withReactivity(["hello"])`. One Backend call per page load, and `Shout` still invalidates `Hello` declaratively. Measured in the plan's Review section.

Auth, D1, tab limiting, and version skew are out of scope (D6, D13, D14).

## 13. Vocabulary (D16)

The architectural vocabulary is in [`docs/glossary.md`](./glossary.md). It covers the reasoning (Effect's `domain/` / `api/` / `server/` split, and why not "contract"), the source layout, and the terms with the words to avoid.

## Open questions [rev 3]

None block the spike. Each has a recommendation that the plan follows unless you object.

| #   | Question                                                                                                                                                                                              | Recommendation                                                                                                                                                                                                                                |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | **Accept the post-hydration refetch** that `reactivityKeys` causes (C2), or refresh explicitly after mutations?                                                                                       | **Resolved (rev 4).** Neither. Wrap the serializable query in `Atom.withReactivity` from the outside (C1): no refetch after hydration, and mutations still invalidate by key. Measured at one call per page load.                             |
| Q2  | **SSR transport:** override `FetchHttpClient.Fetch` with `env.BACKEND.fetch`, or wrap the binding with Alchemy's `toHttpClient(fromCloudflareFetcher(env.BACKEND))` from `alchemy/Cloudflare/Bridge`? | The `Fetch` override. It is two lines and keeps the client identical in both environments. Alchemy's wrapper adds a retry for the brief "handler does not export fetch" window after a deploy; adopt it if we see that error in staging logs. |
| Q3  | **Registry disposal** relies on the undocumented `router.serverSsrLifecycle` (C11). Keep it?                                                                                                          | **Resolved (rev 4): removed.** workerd tears down the request context and its timers when the response finishes, so explicit disposal buys nothing worth an undocumented dependency. Revisit only if staging logs show leaked timers.         |
| Q4  | **Cookie forwarding** has nothing to test until auth lands (D14). Include it now?                                                                                                                     | Include it. It is three lines in the server transport and keeps the client ready for the auth middleware.                                                                                                                                     |

Rounds 2–4 are recorded under Decisions (D9–D16). Next step: the plan in [`start-to-effect-worker-ipc-plan.md`](./start-to-effect-worker-ipc-plan.md).
