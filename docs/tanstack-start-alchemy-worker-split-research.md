# Research: TanStack Start in `Website.Vite`, Effect in a separate Worker

Date: 2026-10-09  
Status: research and discussion only. No application changes or deployment performed.  
Versions: Alchemy `2.0.0-beta.81`, Effect `4.0.1`, `@tanstack/react-start` `1.168.60` (this repo); Alchemy source inspected in `refs/alchemy`.

> **Relation to earlier docs.** [Alchemy + Effect 4 + Start](./alchemy-effect4-tanstack-start-research.md) (2026-10-07) recommended **one Worker** with an Effect composition boundary inside Start's server functions. This document revisits that recommendation after reading Alchemy's runtime source. It concludes that the Alchemy-aligned shape is **two Workers**. The earlier docs are left unchanged; reconcile them once this direction is accepted.

## Summary

- **`Cloudflare.Website.Vite` is a plain-TypeScript host for TanStack Start.** Alchemy builds it, deploys it, binds resources to it (in deploy _and_ `alchemy dev`), and types its `env`. It does **not** run an Effect runtime, accept an Effect implementation, or wrap bindings in Effect clients.
- **Effect code belongs in a separate Alchemy Worker** (`Cloudflare.Worker` / `Cloudflare.Workers.RpcWorker`), reached from Start through a **service binding**. Every Alchemy TanStack example, the Alchemy docs, and the recent community repos use this split.
- **Running Effect inside the Start Worker is possible but works against Alchemy.** A hand-rolled `ManagedRuntime` over raw `env` is merely _outside_ Alchemy. Reusing Alchemy's Effect binding layers there means stubbing internals.
- **Service bindings are cheap.** One billed request plus CPU time across both Workers on Workers Standard pricing. The Workers run on the same thread of the same server with "zero overhead or added latency". The real costs are serialization, chatty calls, and deploy skew.
- **Auth fits in the backend.** Alchemy ships `@alchemy.run/better-auth`, an Effect-native Better Auth wrapper with a D1 layer. Its example and tutorial use a single Effect Worker with no TanStack. The Start Worker would proxy `/api/auth/*` and forward the session cookie.

## 1. What `Website.Vite` is

Source: `packages/alchemy/src/Cloudflare/Website/Vite.ts`, `Workers/Sources/Vite.ts`.

- `Website.Vite(id, props)` calls `Worker(id, props)` with `main: undefined` and `vite: { main, rootDir, memo, viteEnvironments }`. It has **no third argument** for an Effect implementation, unlike `Cloudflare.Worker(id, props, Effect.gen(...))`.
- **Build:** `vite build` runs in a child process with Alchemy's Cloudflare Vite plugin injected. The SSR environment becomes the Worker bundle; `client` becomes static assets.
- **Dev:** `vite.createServer` with the Worker's real bindings passed to the plugin, so `env.BUCKET` reaches the Alchemy-managed resource.
- **Env:** only `VITE_*` entries are inlined as `import.meta.env.*`. Other `env` entries become native Worker bindings, typed via `Cloudflare.InferEnv<typeof Website>`.
- **Custom entry:** `main` can point at a module that wraps the framework handler (for example to export Durable Objects). It is still plain TypeScript.

### What Effect Workers get that `Website.Vite` does not

For `Cloudflare.Worker` with an Effect implementation, Alchemy generates an entry that calls `makeWorkerBridge` (`Workers/WorkerBridge.ts`). Per event it builds and caches the isolate layer, then provides `WorkerExecutionContext` (`waitUntil`), a request `Scope`, `RuntimeContext`, and telemetry. This is the managed runtime one might hope `Website.Vite` would provide. It never runs in a Vite Worker, because the entry is TanStack's fetch handler.

### Why Alchemy's Effect bindings don't drop into the Start Worker

For example, `R2.ReadWriteBucketBinding` (`R2/BucketBinding.ts`) requires:

- `WorkerEnvironment` (the raw `env`), which is easy to provide.
- The host `Worker` service. It is yielded at runtime but only used at deploy time, so it would need a stub.
- `globalThis.__ALCHEMY_RUNTIME__ === true`, which Alchemy's Effect-Worker bundler defines. A Vite build does not, so the client would attempt deploy-time `host.bind`.
- Importing `alchemy/Cloudflare` (resource and provider code) into the TanStack bundle. `alchemy/Cloudflare/Bridge` exists specifically to avoid that.

Conclusion: feasible, but unsupported and fragile. This is the "fighting Alchemy" option.

## 2. The Bridge: `alchemy/Cloudflare/Bridge`

A runtime-only entry ("must not depend on resource providers or local development tooling"). It adapts **service bindings between Workers**; it does not wrap R2, D1, and similar resources.

| Export                             | Direction                | Purpose                                                                                                                                                                                                                                                                           |
| ---------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `toRpcAsync<Backend>(env.BACKEND)` | plain TS → Effect Worker | Each Effect RPC method becomes `Promise<T>`, typed from the backend's shape. `Effect.fail` is rethrown (tagged errors keep `_tag`); streams become `ReadableStream`; `fetch`/`connect` pass through. Its doc comment names "TanStack Start route handlers" as an intended caller. |
| `fromCloudflareFetcher(env.X)`     | raw → Effect             | Effect `Fetcher` over a raw binding, with retry for the handler-not-ready window.                                                                                                                                                                                                 |
| `toHttpClient(fetcher)`            | raw → Effect             | An Effect `HttpClient` over a binding, for `HttpApi`/`RpcClient` clients without a base URL.                                                                                                                                                                                      |
| `toCloudflareFetcher`              | Effect → raw             | The reverse adapter.                                                                                                                                                                                                                                                              |
| `makeRpcStub`, `bindEffectRpc`     | Effect → Effect          | Effect-typed clients for Worker RPC stubs and Durable Objects.                                                                                                                                                                                                                    |
| `InferEnv`, `RpcWireShape`         | types                    | Typed `env` and RPC wire shapes.                                                                                                                                                                                                                                                  |

## 3. Alchemy's TanStack examples

### `examples/cloudflare-website-tanstack-start`

- `Website` (`Website.Vite`) with `env: { GREETING, BUCKET, BACKEND }`, plus a `Backend` `Cloudflare.Worker` that is fully Effect (an RPC method `hello` plus an HTTP `fetch` over `R2.ReadWriteBucket`).
- `src/env.ts` proxies `cf.env` because top-level `import { env } from "cloudflare:workers"` breaks in TanStack Start dev.
- The server function in `routes/index.tsx` is plain TS.
- `routes/api.hello.ts` demonstrates four ways to reach data from Start: the raw R2 binding, `env.BACKEND.fetch`, `toRpcAsync(env.BACKEND).hello(key)`, and `toHttpClient(...)` + `Effect.runPromise`.

### `examples/cloudflare-tanstack-rpc-drizzle`

- `Backend` is a private `Cloudflare.Workers.RpcWorker` (`workersDev: false`, `schema: TodoRpcs`) using Alchemy's Effect-native `Drizzle.Postgres` over `Hyperdrive.Connect` to a Neon branch. Migrations come from `Drizzle.Schema`.
- `src/backend/rpc.ts` holds the shared `RpcGroup` and `Schema` contract.
- The Start Worker has a single `/rpc` route: `env.BACKEND.fetch(request)`. It is a same-origin proxy, keeps the backend private, and avoids CORS.
- The browser uses `AtomRpc.Service` (Effect 4 core) plus `@effect/atom-react`. There are **no loaders or server functions**: the list renders "Loading…" during SSR and fetches on the client.

## 4. Cost and performance of the service-binding hop

From `refs/cloudflare-docs` (`workers/platform/pricing.mdx`, `runtime-apis/bindings/service-bindings`, `platform/limits.mdx`):

- **Billing:** "Requests made from your Worker to another worker via a Service Binding do not incur additional request fees." Worker A → Worker B is billed as one request plus the total CPU time of both. This applies to Workers Standard; the deprecated Bundled and Unbound plans charge two requests.
- **Latency:** "zero overhead or added latency. By default, both Workers run on the same thread of the same Cloudflare server."
- **Cloudflare's own framing:** service bindings provide microservice separation "without configuration pain, performance overhead or need to learn RPC protocols." Listed uses: shared internal services (for example auth), keeping Workers off the public internet, and independent deploys. The limits page recommends splitting across Workers as a way to manage size.
- **Same thread, separate isolates.** No shared memory: arguments and results are structured-cloned. Each isolate has its own 128 MB limit, cold start, and module state. Calls share the top-level request's connection limit and appear to count toward subrequest limits.

### Costs to manage

- **Chatty calls.** Prefer coarse, page-shaped methods (one call per loader or server function).
- **Deploy skew.** Two Workers do not roll out atomically. Add RPC methods before removing old ones.
- **Two log and trace streams.** Propagate a request ID; use Effect tracing in the backend.

### Benefits

- The backend stays pure Effect and uses Alchemy's Effect bindings as designed.
- A smaller Start bundle: no Effect, Drizzle, or drivers there.
- The backend is private (`workersDev: false`).
- The backend can be reused by cron jobs, queues, Durable Objects, or another frontend.
- The RPC surface is an explicit, typed contract.

## 5. Better Auth

Source: `refs/alchemy/packages/better-auth`, `examples/cloudflare-better-auth`, `website/src/content/docs/better-auth/*`.

`@alchemy.run/better-auth` is an **Effect-native wrapper** around Better Auth:

- `yield* BetterAuth(options)` inside a `Cloudflare.Worker` implementation, with `Effect.provide(CloudflareD1(AuthDb))`. D1 goes through Alchemy's native binding system. Other layers cover Neon, Hyperdrive, Postgres, MySQL, Drizzle, SQLite, and Memory.
- `auth.fetch` is an `HttpEffect` that serves the Better Auth routes.
- `auth.getSession()` returns a typed session, or `null` for anonymous users. It reads the ambient request or explicit `Headers`.
- `auth.api.*` exposes every endpoint as an Effect, failing with `BetterAuthApiError`. The error includes the `set-cookie` headers that Better Auth normally hides.
- The auth schema is migrated at `alchemy deploy`, plugins included. The secret is auto-provisioned.
- A six-part tutorial covers sign-in, Effect `HttpApi` middleware providing a typed `CurrentUser`, GitHub OAuth, and deployment. The guide is `better-auth/guides/http-api-middleware`.

**Limit:** the example and the tutorial use a **single Effect Worker** that serves auth, the API, and a static UI from one origin. **There is no TanStack Start + Better Auth example.**

### Extrapolated shape with TanStack (not verified)

```
Browser ── /api/auth/* ──► Start Worker ──(proxy) env.BACKEND.fetch ──► Backend: auth.fetch
Browser ── navigation ───► Start beforeLoad → server fn ──(RPC + cookie) ──► Backend: getSession
Loaders / server fns ────► toRpcAsync(env.BACKEND).method(cookie, …) ──► Backend: validate session → D1
```

- The backend owns Better Auth, D1, session checks, and authorization. D1 is bound only to the backend.
- The Start Worker proxies `/api/auth/*`. Cookies land on the site's own origin, and the browser `authClient` works without CORS.
- The `beforeLoad` guard calls a server function that forwards the request's `cookie` header to a backend `getSession`, and redirects on `null`. The guard is UX only; the backend never trusts a frontend-supplied user ID.
- **Open questions:**
  - Better Auth's `baseURL`/`trustedOrigins` behind the proxy, and whether passing `Website.url` into the backend creates a dependency cycle (the Website already binds the Backend).
  - The exact Start 1.168 API for reading request headers in a server function.
  - The cost of a session check per guarded navigation (mitigations: Better Auth `cookieCache`, per-request resolution, or returning the user alongside data).

## 6. How others combine TanStack Start and Alchemy

Searched 2026-10-09; repository contents verified with `gh api`.

| Project                                                                                                                                                          | Shape                                                                                        | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [peterje/alchemy-starter](https://github.com/peterje/alchemy-starter) (pushed 2026-10-03)                                                                        | `Website.Vite` + private Effect `ApiWorker` (`workersDev: false`), `env: { API: ApiWorker }` | **Closest to our direction.** `routes/api.$.ts` proxies `env.API.fetch(request)`. `atoms.ts` builds **one isomorphic `AtomHttpApi` client** via `createIsomorphicFn`: in the browser it uses `fetch` to `/api/*`; during SSR it swaps `FetchHttpClient.Fetch` for `env.API.fetch` (the in-process service binding) and forwards the visitor's `cookie` via `getRequestHeader("cookie")`. Auth (WorkOS, sealed session cookie, `CurrentUser`) lives in the Effect API Worker. Uses PlanetScale Postgres via Hyperdrive, Durable Objects, smart placement, and traces. |
| [patrikduksin/fullstack-take-home-assignment](https://github.com/patrikduksin/fullstack-take-home-assignment) (pushed 2026-10-04)                                | `Website.Vite` (`env: { BACKEND }`) + Effect backend Worker; Alchemy beta.80, Effect 4.0.0   | Start routes `/rpc` and `/api/$` are one-line proxies to `env.BACKEND.fetch`. UI is `ClientOnly` with `@effect/atom-react`.                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| [JustinRoderick/badgebuddy PR #1](https://github.com/JustinRoderick/badgebuddy/pull/1)                                                                           | Reported as `Website.Vite` + service binding to a backend                                    | Repository returned 404 via the API on 2026-10-09; not verified.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| [austinm911/zero-effect-better-t](https://github.com/austinm911/zero-effect-better-t)                                                                            | Effect + Zero + Alchemy + Start template                                                     | Last pushed 2025-08; likely the Alchemy v1 era.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| [leoisadev1/rat-stack-plus](https://github.com/leoisadev1/rat-stack-plus), [Better T Stack guide](https://www.better-t-stack.dev/docs/guides/cloudflare-alchemy) | Scaffolders: Start + Better Auth/D1 + Alchemy infra                                          | Not Effect-based; the guide page shows no `alchemy.run.ts` details.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

No community project was found that runs Effect inside the `Website.Vite` Worker. The Effect-using projects all put Effect in a separate Worker and keep Start thin.

**Pattern worth noting from peterje:** during SSR, an Effect `HttpApi` client in the Start Worker uses the service binding as its transport, so SSR and the browser share one typed client and contract. This is "Effect in the Start Worker" in a narrow, Alchemy-aligned sense: it is a **client** of the backend, not a host for domain services or bindings.

## 7. Recommendation

1. **Keep TanStack Start in `Website.Vite`** as a thin frontend: routing, SSR, proxy routes, and route guards.
2. **Put domain logic, data access, and auth in a private Effect Worker** (`workersDev: false`), bound as `env.BACKEND`, using Alchemy's Effect bindings (D1/R2/Hyperdrive, `@alchemy.run/better-auth`).
3. **Do not try to host Effect services or Alchemy Effect bindings inside the Start Worker.**
4. **Pick a backend contract style:**
   - **Worker RPC methods + `toRpcAsync`.** Simplest from loaders and server functions; plain promises.
   - **Effect `HttpApi`/`RpcGroup` + an isomorphic Atom client** (the peterje pattern). One typed client for SSR (service binding) and the browser (same-origin proxy).
5. **Keep calls coarse,** forward the session cookie, and let the backend authorize.

Open uncertainty: whether Start can stay a thin wrapper in practice (guards, SSR data, and auth redirects all add some glue). A small spike should measure this. The spike: one backend, one guarded route with SSR data, and a Better Auth sign-in, timed under `alchemy dev` and on staging.

## Sources and inspection anchors

- Alchemy (`refs/alchemy`, 2.0.0-beta.81):
  - `packages/alchemy/src/Cloudflare/Website/Vite.ts`
  - `packages/alchemy/src/Cloudflare/Workers/Sources/Vite.ts`
  - `packages/alchemy/src/Cloudflare/Workers/{WorkerBridge,WorkerRuntime,BindingLayer,Rpc,RpcAsync}.ts`
  - `packages/alchemy/src/Cloudflare/{Bridge,Fetcher}.ts`
  - `packages/alchemy/src/Cloudflare/R2/BucketBinding.ts`
  - `packages/better-auth/{README.md,src/ApiProxy.ts}`
  - `examples/{cloudflare-website-tanstack-start,cloudflare-tanstack-rpc-drizzle,cloudflare-better-auth}`
  - `website/src/content/docs/cloudflare/frontend/tanstack-start.mdx`
  - `website/src/content/docs/better-auth/`
- Cloudflare docs (`refs/cloudflare-docs`): `workers/platform/pricing.mdx` (Service bindings), `workers/runtime-apis/bindings/service-bindings/index.mdx`, `workers/platform/limits.mdx`.
- Effect 3 in-process reference (contrast): `refs/effect-tanstack-start/src/routes/api/$.ts` (`ManagedRuntime` + shared `memoMap`).
- Web:
  - [Alchemy TanStack Start guide](https://alchemy.run/cloudflare/frontend/tanstack-start/)
  - [Full-stack TanStack + RPC + Drizzle](https://alchemy.run/cloudflare/frontend/full-stack-tanstack-rpc-drizzle/)
  - [Better Auth D1](https://alchemy.run/better-auth/databases/cloudflare-d1/)
  - Community repositories listed in section 6.
