# Research: Alchemy Workers + TanStack Start SSR + Effect 4 Atoms

Date: 2026-10-07  
Status: research reviewed in Plannotator; accepted decisions recorded below. No application changes or deployment performed.  
Purpose: resume the adoption assessment in [the reference architecture](./tanstack-start-effect-architecture.md), translating its boundaries into our actual Alchemy and Effect versions.

## Executive recommendation

**Keep one Cloudflare Worker, keep `Cloudflare.Website.Vite`, and add a stateless Effect service behind Start's loader/server-function and HTTP RPC boundaries. Use Effect 4's built-in Atom/RPC/hydration modules, not the reference's Effect 3 packages or custom serialization cast.**

The hosting concern is resolved at the resource/source level: **`Cloudflare.Website.Vite` is a Vite-packaged Cloudflare Worker, not Cloudflare Pages and not necessarily a static site.** It delegates to Alchemy's `Worker` resource. With TanStack Start, the Vite build supplies both the SSR server bundle and client assets. Static assets do not make the application static-only.

**Alchemy explicitly documents this exact integration:** [TanStack Start guide](https://alchemy.run/cloudflare/frontend/tanstack-start), [checked-in example](https://github.com/alchemy-run/alchemy/tree/v2.0.0-beta.81/examples/cloudflare-website-tanstack-start), and an SSR integration test. These were found and inspected in `refs/alchemy`; the published guide was also fetched after review and confirms that `Website.Vite` builds the client assets and SSR server bundle together. Section 3 summarizes the evidence and its limits.

The remaining integration concern is runtime ownership. Alchemy's Vite plugin supplies Cloudflare hosting/build/dev integration; it does **not** automatically make our domain services available as an Effect context inside every Start server function. We need one explicit application composition boundary. For this stateless pilot, that can be shared layer definitions with request-local execution, rather than an application-wide mutable runtime.

### Confirmed with the user during research

- Use **one Worker**; do not use Cloudflare Pages.
- Demonstrate a stateless transform: mock fixture + request-time snapshot, an input transformation, refresh, and typed failure.
- Browser atoms may hold temporary presentation state. No server-side store, database, KV, R2, Durable Object, session, or process-local counter is required.
- Use the existing home page for the POC; preserving the current smoke-test UI is not a requirement.
- Accepted during Plannotator review: no invented Effect-native capability demonstration, request-local RPC, a separate transform result, and a later deployed Worker test following local checks and deployment approval.

Questions and recommended answers that remain open are in section 9. Existing accepted decisions in the earlier document remain the baseline; this document does not reopen Atoms versus Query or RPC versus REST.

## 1. Evidence, versions, and limits

Primary evidence is the local source requested by the user, not unversioned snippets:

| Item | Inspected version/evidence |
| --- | --- |
| Application | `package.json`, `pnpm-lock.yaml`, `alchemy.run.ts`, `vite.config.ts`, `src/` |
| Alchemy | `refs/alchemy/.ref.json`: `v2.0.0-beta.81`; library manifest agrees |
| Effect | `refs/effect/.ref.json`: `effect@4.0.1`; library manifest agrees |
| React Atom adapter | Effect repository's `packages/atom/react/package.json`: `@effect/atom-react` `4.0.1` |
| Application Start/Router | Start `1.168.60`, Router `1.170.41` in the application manifest |
| Older architecture | `docs/tanstack-start-effect-architecture.md` and `refs/effect-tanstack-start/` |

Both Alchemy and Effect reference snapshots were fetched on 2026-10-07. Their metadata identifies version tags, but does not record immutable commit SHAs. The application lockfile records Alchemy and its Cloudflare runtime using Effect `4.0.1`.

Current library documentation was checked through Context7 as supporting evidence. Generic TanStack Cloudflare instructions recommend Wrangler and `@cloudflare/vite-plugin`; **Alchemy's specific integration takes precedence for this application** and explicitly tells users not to combine that plugin with its own integration. Effect's checked-out 4.0.1 source takes precedence over older or prerelease documentation.

This is source research. No build, browser experiment, cloud deployment, network-count measurement, or compatibility typecheck was performed. Upstream integration tests described below were inspected, not run. Suggested adapter composition is therefore a recommendation to validate, not a tested implementation.

## 2. What we currently have

### Hosting declaration

`alchemy.run.ts:5–8` exports:

```ts
export const Website = Cloudflare.Website.Vite("Website", {
  compatibility: { date: "2026-07-01", flags: ["nodejs_compat"] },
  dev: { port: 3000 },
});
```

The Stack yields that resource and returns its URL. It does not declare a second backend Worker or any application storage resource. `Cloudflare.state()` is Alchemy's infrastructure state backend, not application state: “stateless POC” does not mean removing the deployment engine's resource tracking.

`vite.config.ts:11–19` configures Alchemy's Cloudflare plugin, `tanstackStart()`, and React. The Cloudflare plugin is guarded by `ALCHEMY_CLOUDFLARE_VITE_INJECTED`, so Alchemy-orchestrated dev/deploy does not instantiate it twice. This is not an accidental local workaround: the same guard is documented in Alchemy's `Workers/Sources/Vite.ts:63–96`.

### Application data path

- `src/routes/index.tsx` has a component but **no loader**.
- `src/components/HomePage.tsx` calls `fetch("/api/health")` after a button click and stores the response message in React `useState`.
- `src/routes/api.health.ts` forwards GET to `src/server/health.ts`.
- `health.ts` executes a small dependency-free Effect with `Effect.runPromise` and returns JSON.
- `src/routes/__root.tsx` has the Start document shell, but no Atom registry provider.
- `src/router.tsx` creates a router per `getRouter()` call; no Query or Atom SSR integration is configured there.
- Query is installed, but the inspected application path does not use it. `@effect/atom-react` is not an application dependency yet.

**Conclusion:** we already have the appropriate SSR-capable hosting configuration, but we have not implemented the loader → service → hydrated atom path. A successful health-button response would prove an HTTP backend connection, not Atom hydration or loader data rendering. Source configuration alone does not certify the currently deployed site's SSR behavior.

## 3. “Website Worker” means Workers, not Pages

### Source-level answer

In `refs/alchemy/packages/alchemy/src/Cloudflare/Website/Vite.ts`:

- The resource is described as “A Cloudflare Worker deployed from a Vite project” (`25–30`).
- TanStack Start is explicitly documented as an SSR use case (`46–54`).
- The implementation calls `Worker(id, ...)` with a `vite` source configuration (`270–281`).

The more specific integration guide, `website/src/content/docs/cloudflare/frontend/tanstack-start.mdx`, says that client assets and the SSR bundle are built together, and that non-asset SSR/server-route requests reach the TanStack handler (`10–18`, `103–110`).

### Official integration evidence—not just an inference from the wrapper

**Yes, `Cloudflare.Website.Vite` is Alchemy's documented choice for TanStack Start web applications with SSR.** The [published guide](https://alchemy.run/cloudflare/frontend/tanstack-start), fetched during this review follow-up, describes it as deploying Start to Cloudflare with “SSR, typed Worker bindings, and HMR dev.” It states that the client assets and SSR server bundle are built in one Vite build, without an adapter or Wrangler configuration.

The local snapshot provides three complementary pieces of evidence:

1. **Guide:** `refs/alchemy/website/src/content/docs/cloudflare/frontend/tanstack-start.mdx` documents the plugins, module-level `Website.Vite` declaration, asset-versus-SSR routing, and dev behavior.
2. **Example:** `refs/alchemy/examples/cloudflare-website-tanstack-start/alchemy.run.ts` declares `Website.Vite`. Its `src/routes/index.tsx` uses a GET server function inside a route loader and renders the returned greeting.
3. **Test:** `refs/alchemy/examples/cloudflare-website-tanstack-start/test/integ.test.ts:82–95` requests the page and asserts the configured greeting is in the returned HTML. The test is explicitly named “serves the server-rendered home page.”

The example also includes R2 and a backend Worker to demonstrate bindings. Those are optional example features, not prerequisites for SSR; our stateless, one-Worker POC should not copy them. The upstream example establishes hosting guidance, **not** a complete Effect 4 Atom hydration recipe. Our application still needs the proposed integration checks. No web search was necessary to locate the integration because the requested local reference already contained it; the direct published-page check corroborates it.

### Which example should lead our design?

**Use Alchemy's example as the primary integration baseline.** Follow its supported Worker packaging, Start server-function/loader boundary, and Cloudflare integration conventions. Use the older architecture only for the missing Atom hydration and reactive-client responsibilities, translated against Effect 4.0.1 source—not as a competing hosting/runtime template.

The Alchemy example contains:

- A real TanStack route loader: `loader: () => getGreeting()`, where `getGreeting` is a GET server function that reads a configured environment greeting. The component consumes it with `Route.useLoaderData()`.
- A `/api/hello` server route demonstrating direct R2 bindings, service-binding `fetch`, typed native Worker RPC through `Cloudflare.toRpcAsync`, and an Effect HTTP client over a service binding.
- A sibling Effect-native backend Worker with a `hello` method and GET/PUT handlers backed by R2.
- A typed environment-access proxy, basic React document/router setup, Tailwind styling, and integration tests.

**It does not use Atoms, Atom hydration, or TanStack Query.** Its loader is a minimal SSR/environment demonstration, not an Effect service read with Atom dehydration. Also, its typed Worker RPC is Cloudflare service-binding RPC between Workers; it is **not** Effect's schema-based HTTP RPC accessible directly from a browser.

For our one-Worker POC, replace the greeting read with the stateless Effect service read, omit the R2/sibling backend, and add the Effect 4 Atom/hydration layer. Browser Effect HTTP RPC remains an additional integration to test rather than something already demonstrated by Alchemy's native Worker RPC example. Keep our Astryx layout rather than copying its Tailwind UI.

Think of the relationship as:

```text
Alchemy Stack                         deployment-time Effect program
  └─ Cloudflare.Website.Vite           convenience/resource packaging API
       └─ Cloudflare Worker           actual Cloudflare compute resource
            ├─ TanStack server bundle SSR, server functions, server routes
            └─ Workers static assets  browser JS, CSS, images
```

There is no Pages project in this declaration. The Worker can execute dynamic application code while its asset layer serves files. Assets-first routing is compatible with SSR when there is no matching static HTML replacing the dynamic route.

### Our options

| Option | What changes | Recommendation |
| --- | --- | --- |
| Keep `Cloudflare.Website.Vite` | Nothing about the Cloudflare resource kind; Vite/SSR packaging is handled for us | **Use this for the pilot** |
| Name the exported variable `AppWorker` instead of `Website` | Only source terminology, if the logical resource ID stays `"Website"` | Optional clarity change, not technically necessary |
| Plain `Cloudflare.Worker` with an external entry and assets | We own the server entry, build-output discovery, asset packaging, and dev integration | Valid, but adds work without changing the target from Workers to anything better |
| `Cloudflare.Website.Vite` with a custom `main` | Still one Worker; custom entry wraps the framework and can add other handlers/exports | Consider only if the runtime experiment demonstrates a need |
| Effect-native `Cloudflare.Worker(..., implementationEffect)` | Alchemy bridges Effect handlers, service initialization, request scopes, and runtime capabilities | Useful for Effect-native backend code; not a drop-in replacement for Start's framework entry |
| Separate Start Worker and Effect-native backend Worker | Adds a service-binding boundary and another deployment resource | Not selected by the user; unnecessary for this pilot |
| Assets-only Worker or SPA fallback | Serves static files; does not demonstrate request-time Start SSR | Do not choose for this experiment |

Although `WorkerProps.vite` exists, it is marked **internal** (`Workers/Worker.ts:615–616`). Calling the supported `Website.Vite` wrapper is preferable to manually reproducing that internal configuration just to remove “Website” from the API name.

Changing a logical resource ID can affect infrastructure identity. A future terminology cleanup should not casually rename `"Website"` or replace the deployed resource.

### Routing recommendation

Keep the existing defaults initially. Do not add SPA not-found handling, enable client-only rendering, or introduce prerendering for the pilot route. Verify that requesting the page without JavaScript returns the mock service value in HTML.

Do not set `runWorkerFirst: true` merely to “enable SSR”: it is an asset-routing setting, not an SSR switch. If an emitted/static HTML file shadows the test route, investigate that specific routing conflict. An explicit worker-first rule can then be considered deliberately.

## 4. What Alchemy gives us—and what it does not

There are three different meanings of “Effect runtime” here:

1. **Infrastructure execution:** the Alchemy Stack and providers deploy resources using Effect. This is not the browser or SSR service context.
2. **Cloudflare Vite runtime integration:** `@alchemy.run/cloudflare-runtime/vite` manages Worker-compatible builds and local execution/bindings. Its use of Effect internally does not inject our `ProbeService` into Start.
3. **Effect-native Worker bridge:** an Alchemy Worker whose implementation is an Effect gets a bridge that composes services, provides runtime context, and scopes events.

`Workers/WorkerBridge.ts:73–125` demonstrates the third case: it creates a fresh event scope, provides `WorkerExecutionContext`, `RuntimeContext`, and the scope alongside built services, then closes the event scope through `ctx.waitUntil` unless ownership has transferred to a response stream.

Our Vite-packaged Start entry is not declared with that implementation Effect. **Do not assume those bridge-provided services exist inside our Start handlers.** In particular, installing the Vite plugin is not sufficient to use Alchemy runtime-only capabilities that require `RuntimeContext`.

### One application composition boundary, not necessarily one singleton

For the selected stateless design, share a `ProbeService.layer` and adapter composition module between initial reads and RPC. The same service contract and implementation can be provided separately for each request without violating the architectural goal.

“One authoritative composition boundary” means consistent dependencies and ownership. It does not require one `ManagedRuntime`, one global service instance, or a memo map shared across all requests. The old reference needed shared memoization largely because its service owned a mutable `Ref<Map>`; we explicitly do not want that store.

Recommended execution ownership:

| Boundary | Owner/lifetime |
| --- | --- |
| Resource deployment | Alchemy Stack and Cloudflare provider |
| Outer HTTP routing and SSR | Start inside the Vite-packaged Worker |
| Stateless domain service | Application layer definition; provide at the server execution boundary |
| Initial service read | Start server-function handler; run the provided Effect there |
| RPC protocol/server fibers | Request-local Effect scope for the first experiment |
| SSR registry | Per render/request; never module-global |
| Browser registry/runtime | Per mounted application/browser context |

No additional `ManagedRuntime` is necessary just to execute a stateless service. If later resources require a persistent composition root, that is a separate lifecycle decision.

### Cloudflare lifetime constraints

Alchemy's own guidance distinguishes isolate-wide construction from request-wide I/O. An isolate may retain pure configuration and service functions; it must not retain disposable connections, request-bound streams, or I/O-backed objects/promises across events. Workerd has no dependable isolate shutdown hook for finalization.

Consequently, copying the reference's module-global RPC server and HMR disposal hook would not establish Cloudflare correctness. Even a stateless domain operation has stateful transport machinery: RPC fibers, queues, and request tracking require scopes.

## 5. Translate into Effect 4.0.1, not Effect 3 syntax

The requested `refs/effect` source contains the current idioms in `LLMS.md`, `migration/services.md`, and the exported modules themselves.

| Reference approach | Current local API/direction |
| --- | --- |
| `Effect.Service`, generated `.Default` | `Context.Service`, explicit `Layer.effect` / `Layer.succeed`, conventionally `.layer` |
| Static service accessors | Prefer `const service = yield* ProbeService` inside a generator |
| Reusable function wrapping `Effect.gen` | `Effect.fn("ProbeService.operation")`; generators for inline composition |
| Old standalone platform/RPC packages | `effect/http/*`, `effect/rpc/*` |
| `@effect-atom/atom` | `effect/reactivity/Atom`, `AtomRegistry`, `Hydration`, `AsyncResult` |
| `@effect-atom/atom-react` | `@effect/atom-react` |
| Atom `Result.fromExit` / `Result.Schema` | `AsyncResult.fromExit` / `AsyncResult.Schema` |
| `HttpLayerRouter.toWebHandler` | `HttpRouter.toWebHandler`, or a direct scoped `RpcServer.toHttpEffect` with `HttpEffect.toWebHandler` |
| Hand-built dehydrated envelope and typing cast | Public registry + `Hydration.dehydrate` API |
| Custom RPC-backed query/mutation wiring | Evaluate built-in `AtomRpc.Service`, `.query`, `.mutation` first |

**Important naming distinction:** `effect/Result` is the synchronous success/failure result type. It is not the Atom async-state model. Atom state uses `effect/reactivity/AsyncResult`, with `Initial`, `Success`, `Failure`, and `waiting`.

### Service and schema style

- Declare an explicit `Context.Service` contract with schema-defined success and error models.
- Implement reusable operations with named `Effect.fn` functions.
- Use an explicit implementation layer; wire dependencies with `Layer.provide`, or `Layer.provideMerge` when both the adapter and underlying service must remain available.
- Defer timestamps and other side effects until execution; do not compute them at module import.
- Decode untrusted inputs using Schema. Share runtime schemas across loader hydration and RPC, not just interfaces.
- Use `Schema.TaggedError` for deliberate domain failures; keep transport/decode failures distinct from expected business errors.
- Run/convert Effects only at framework boundaries. Do not scatter `runPromise` through service implementations.

The existing `health.ts` is a valid tiny dependency-free Effect boundary, but it is not yet a service/layer or schema-based data contract.

### Dependency recommendation

For a future implementation, add the version-aligned **`@effect/atom-react@4.0.1`** and satisfy its published peer dependencies (the checked-out manifest includes React and `scheduler`). Core Atom, RPC, and HTTP APIs already live in `effect@4.0.1`; do not install the reference's old `@effect-atom/*` packages or a second Effect major.

**Review question: should we do this now as part of the plan? Recommended: include it as the first implementation step, but do not install it merely to finish this research.** The React adapter is necessary for the proposed hooks/provider/hydration boundary, so postponing it until after writing the POC would not help. When implementation is authorized, install the pinned adapter, resolve its peer requirements, verify the lockfile still uses the intended Effect version, and run a small import/typecheck before building the loader/RPC slice. This review asked for advice rather than unambiguously authorizing a dependency change; no package or lockfile has been changed.

Keep Effect/Atom versions aligned. The relevant reactivity, RPC, and HTTP APIs carry `@stability unstable` annotations even in this release; pinning versions and focused tests are warranted. Research has not verified registry availability or performed a dependency installation.

## 6. Recommended stateless data flow

```text
GET /
  → Workers asset lookup misses the dynamic page
  → Start SSR loader
  → Start GET server function
  → directly execute ProbeService.read with the application layer
  → Exit → AsyncResult → schema-based atom dehydration
  → HydrationBoundary inside a per-render RegistryProvider
  → HTML contains the loaded value
  → browser hydrates its own registry from the serialized snapshot

Refresh / action in React
  → AtomRpc query refresh / mutation atom
  → Fetch HTTP RPC, same-origin POST /api/rpc
  → Start server route
  → request-scoped Effect RPC adapter
  → same ProbeService contract and layer
  → decoded AsyncResult updates browser subscribers
```

Keep the efficient direct initial read: the server does not make an HTTP call to its own RPC endpoint. Later browser route-loader calls still cross Start's server-function transport; explicit atom refresh and actions use Effect RPC. These are intentionally different transports into the same domain service.

No second REST API or new health endpoint is needed. Use the existing home page for the loader/hydration/action demonstration. The current health-button UI need not be preserved; removal of its now-unused route or service can be considered within that authorized implementation, not performed by this research.

### RPC client and route

`AtomRpc.Service` supplies a flattened RPC client, runtime, query atoms, and mutation atoms. Its protocol can compose `RpcClient.layerProtocolHttp`, `FetchHttpClient.layer`, and matching RPC serialization. Start with same-origin `/api/rpc`; do not copy the reference's server-side `localhost:3000` fallback or read `window.location` at shared-module import time.

For a non-streaming query, pass an explicit `serializationKey`. In 4.0.1, `AtomRpc` serializes it under `AtomRpc:<RPC tag>:<serializationKey>` and derives `AsyncResult.Schema` from the RPC success/error contracts, including `RpcClientError`. Reuse the query atom factory/configuration consistently on server and browser.

Use a single explicit Start POST route rather than a catch-all unless routing actually needs a catch-all. Match client and server serialization; HTTP RPC is not an ordinary JSON REST body. If using `RpcServer.layerHttp`, set `protocol: "http"` explicitly: its default is WebSocket.

### Prefer the request-scoped direct adapter for this pilot

The inspected 4.0.1 source offers a smaller alternative to a long-lived router layer:

1. `RpcServer.toHttpEffect(group)` creates the protocol and forks its server inside the **current scope**.
2. Execute the HTTP effect it returns within that same request scope.
3. Provide the RPC handler layer, matching serialization, and stateless service layer.
4. Convert the complete request effect with `HttpEffect.toWebHandler` / `toWebHandlerWith`.

Crucially, create the RPC server **inside** the request effect, not once at module import. This avoids depending on cross-event background fibers or a never-disposed isolate-wide server scope.

`HttpEffect`'s web adapter transfers scope ownership to a streamed response so cleanup occurs when the body exits (`HttpEffect.ts:209–229`, `301–319`). Do not close an outer scope in a route's `finally` as soon as a `Response` object is returned: NDJSON may still be streaming. The exact layer placement, cancellation, and repeated-request behavior require a typechecked Worker experiment before adoption.

This recommendation is **not** a claim that globally memoized `HttpRouter.toWebHandler` can never work. It is a deliberately simpler lifetime for our stateless proof of concept. `HttpRouter.toWebHandler` is available if routing grows; its layer builds immediately and has a separate `dispose` lifecycle, which must not be overlooked.

## 7. Hydration without the reference's custom cast

### Recommended public API path

After the direct server read:

1. Convert the Exit with `AsyncResult.fromExit`.
2. Create a temporary `AtomRegistry.make({ initialValues: [[readAtom, result]] })`.
3. Dehydrate it with `Hydration.dehydrate(registry)`.
4. Dispose that temporary registry after producing the complete snapshot.
5. Return only encoded hydration data through the Start server function/loader.
6. Render under `RegistryProvider` and apply `HydrationBoundary` before descendants read the atom.

`initialValues` is useful because an RPC query atom is read-only; `registry.set` requires a writable atom. Do not bypass that distinction with a cast. Inspect and test seeding on the actual query atom rather than inventing a writable interface.

The temporary registry used for serialization and the SSR React registry have separate lifetimes. No registry object, runtime, or service instance crosses the wire. An atom definition may be shared; its request/user-specific values may not be stored globally.

### Behaviors to verify explicitly

- **Serialization actually includes the read atom.** `Hydration.dehydrate` skips values that fail schema encoding and ignores `Initial` by default. Assert the expected key exists; an empty array must not silently count as success.
- **No unnecessary first browser read.** Source supports preloading before descendants read; observed network behavior remains an acceptance test, not a guarantee from the word “hydration.”
- **SSR does not execute the browser transport.** A seeded atom must not instantiate a browser RPC request during rendering. Avoid relying on client-only globals at import or layer construction.
- **Refresh is not idle TTL.** `AtomRpc.query`'s `timeToLive` maps to idle retention/keep-alive in this source, not Query-style stale-time. Choose freshness through explicit refresh for the pilot.
- **Navigations apply new loader data correctly.** The React hydration boundary applies new keys during render and queues existing-key updates after commit. Test revisit and aborted transitions if they affect the slice.
- **Server registry cleanup is explicit.** React effect cleanup does not run during SSR. Use a per-render provider for isolation, and validate render-lifetime disposal separately; the temporary serialization registry can be disposed directly.
- **No streaming hydration experiment yet.** Return a completed read snapshot rather than promise-bearing initial states. Start serialization support for that more advanced mode is not needed for this POC.

The simpler fallback is schema-encoded loader data plus `RegistryProvider.initialValues`, but that tests initialization rather than the full dehydration/hydration bridge. Prefer the public hydration path first; no custom envelope construction is justified yet.

## 8. Mock contract and acceptance evidence

### Minimal domain

Recommended conceptual contract—not an implementation added by this research:

```text
ProbeService.read()
  → { message: "Effect ↔ Start ↔ Atom", observedAt: ISO timestamp }

ProbeService.transform({ input })
  → { original: input, transformed: normalized uppercase input }
  → InvalidProbeInput { message } for deliberate invalid input
```

Return a fixture-derived snapshot anew for every read. No `Ref`, Map, persisted write, incrementing count, or server cache is needed. Timestamp change demonstrates a fresh response, not durable state. A local result atom may display the last successful transform, clearly labeled as browser-only state; refreshing/reloading is not expected to retrieve that result from the server.

Keep the read and action results separate initially. A transform does not change the fixture, so automatically invalidating the read after every action would imply nonexistent server-state semantics and introduce an unnecessary request. Built-in mutation async state can show waiting/success/failure without the reference's custom upsert cache wrapper.

### Acceptance evidence for a later authorized experiment

| Test | Evidence required |
| --- | --- |
| SSR, not static shell | Raw page response with JavaScript disabled contains the fixture message and request-time snapshot |
| Initial direct read | Server logs show service read through the server function, without loopback HTTP RPC |
| Browser hydration | Visible data matches SSR; no immediate duplicate `/api/rpc` read caused solely by mounting |
| Refresh | Exactly the intended HTTP RPC read occurs and the displayed snapshot updates |
| Transform | POST to the Effect RPC route produces the transformed value and mutation state |
| Typed domain failure | Invalid input returns/decodes the declared error and renders a friendly message |
| Transport failure | Network/decode failure is distinguishable from `InvalidProbeInput` |
| Isolation | Concurrent SSR renders and separate browser contexts have independent registry values |
| Worker lifetimes | Repeated requests and aborted response consumption do not leak protocol scopes/fibers or reuse request-bound I/O |
| Browser bundle boundary | No infrastructure declaration, cloud credentials, Alchemy provider, or Node platform runtime is pulled into client output |
| Deployment packaging | Alchemy build includes the SSR Worker entry and client assets; actual deployment is a Workers resource, not a Pages project |

Use deterministic unit tests for the service and schemas, then a Worker-compatible integration test for transport and hydration. An eventual live test needs explicit authorization: `alchemy dev` can reconcile resources, and the upstream example's dev tests use cloud bindings. Research did not run those commands.

## 9. Reviewed decisions and remaining recommendation

### Q1. Is `Website.Vite` acceptable now that its resource type is clarified?

**Accepted, subject to confirming Start SSR suitability; confirmation complete.** Keep the API and existing logical resource ID. Alchemy's official Start guide explicitly recommends `Website.Vite` for SSR web applications, and its example/test demonstrate loader-backed server rendering. Section 3 records the evidence. Optionally use “application Worker” in explanatory copy; no resource migration is required.

**User direction already recorded:** one Cloudflare Worker, never Cloudflare Pages. The source confirms the existing wrapper meets that requirement; no resource migration is needed to satisfy it.

### Q2. Should the first POC explicitly demonstrate Alchemy Effect-native runtime capabilities?

**Accepted: no, not by inventing a storage binding or another Worker.** Exercise the existing Alchemy build/hosting path and application Effect composition first. The stateless service does not need `RuntimeContext`.

Tradeoff: this validates hosting + Start + Effect RPC + Atoms, **not** automatic binding inference or Effect-native Worker capability injection. If demonstrating those runtime features is itself a requirement, a custom one-Worker Start entry/bridge becomes a separate investigation. That may be worthwhile later, but should not be presented as already solved by the Vite plugin.

### Q3. Should RPC machinery be request-local or isolate-global?

**Accepted: request-local `RpcServer.toHttpEffect` for the stateless pilot.** Reuse pure layer definitions, not transport instances. Verify scope transfer through the response body and cancellation. Optimize toward an isolate-wide adapter only if measured need and Cloudflare lifetime tests justify it.

This is a lifecycle design recommendation, not a user-facing feature choice. No global memo map or managed runtime is required to share a stateless service implementation.

### Q4. Should an action patch the snapshot atom or display its own result?

**Accepted: display a separate action result.** The server transforms input without changing the mock fixture. This honestly demonstrates communication and async state while avoiding a pretend persistence model. An intentionally browser-only editable mock atom can be added later if showcasing local cache patching is important.

**User decision already recorded:** stateless transform, rather than fixture reads only.

### Q5. Where should the experiment appear?

**User-selected: use the home page (`/`), not a dedicated route.** The existing application is POC material, so preserving its smoke-test UI is not necessary. Replace that UI with the hydrated read, transform action, explicit refresh, and typed failure display when implementation is authorized. Keep the existing Astryx page frame/template patterns.

### Q6. Should a later implementation include a deployed Worker test?

**Accepted: yes, after local Worker-compatible checks and explicit deployment approval.** Node-only tests cannot prove workerd scope/I/O compatibility or that the deployed page is request-time SSR. For this research, do not deploy, provision storage, change Alchemy state configuration, or remove Query dependencies.

### Q7. Should the Atom React dependency be added as part of the next implementation?

**Recommended: yes, as the first implementation step.** Add `@effect/atom-react@4.0.1`, satisfy its peer dependencies, and verify version resolution/imports before building the home-page slice. Do not upgrade Effect or add the old Atom packages. No dependency installation is authorized or performed by this research update; section 5 explains the rationale.

## 10. Bottom line and next boundary

We do **not** need to switch hosting resources to obtain a Cloudflare Worker or SSR. `Website.Vite` is the supported Alchemy packaging wrapper for exactly that combination.

The adoption work is primarily application integration: translate the service to Effect 4, add version-aligned React Atom bindings, establish a direct loader read, hydrate with public APIs, and host same-origin Effect HTTP RPC with deliberate request/response lifetimes.

The next authorized experiment should resolve the two technical uncertainties source research cannot certify: **seeding/hydrating the selected RPC query atom without an extra fetch**, and **executing request-local RPC correctly through Start inside workerd, including stream cleanup**. No stateful application infrastructure is necessary to answer either question.

## Sources and inspection anchors

Paths below are relative to the repository root. Versioned local source is the primary authority.

### Application

- `alchemy.run.ts`, `vite.config.ts`, `package.json`, `pnpm-lock.yaml`.
- `src/routes/index.tsx`, `src/routes/__root.tsx`, `src/router.tsx`.
- `src/components/HomePage.tsx`, `src/routes/api.health.ts`, `src/server/health.ts`.
- [Earlier architecture research](./tanstack-start-effect-architecture.md).

### Alchemy 2.0.0-beta.81

- `refs/alchemy/.ref.json` and `packages/alchemy/package.json`.
- `refs/alchemy/packages/alchemy/src/Cloudflare/Website/Vite.ts:25–54, 93–110, 270–281`: Worker identity, SSR support, custom entry, delegation.
- `refs/alchemy/packages/alchemy/src/Cloudflare/Workers/Worker.ts:592–616, 2390–2508`: asset behavior, internal Vite configuration, external and Effect-native Worker forms.
- `refs/alchemy/packages/alchemy/src/Cloudflare/Workers/Sources/Vite.ts:63–96, 193–210`: duplicate-plugin guard and SSR build integration.
- `refs/alchemy/packages/alchemy/src/Cloudflare/Workers/WorkerBridge.ts:73–125`: native bridge's event context/scope lifecycle.
- `refs/alchemy/packages/cloudflare-runtime/src/vite/plugin.ts`: Cloudflare hosting plugin surface.
- `refs/alchemy/AGENTS.md:601–606`: isolate versus request lifetime constraints.
- `refs/alchemy/website/src/content/docs/cloudflare/frontend/tanstack-start.mdx`: supported Start integration, assets/SSR split, binding access.
- `refs/alchemy/examples/cloudflare-website-tanstack-start/alchemy.run.ts`, `src/routes/index.tsx`, `src/backend.ts`, `test/integ.test.ts:82–95`: framework and native backend examples, upstream SSR test evidence. The backend's R2 example is evidence of integration, **not** a storage recommendation for us.
- Published guide: <https://alchemy.run/cloudflare/frontend/tanstack-start>.

### Effect 4.0.1

- `refs/effect/.ref.json`, `packages/effect/package.json`, `packages/atom/react/package.json`.
- `refs/effect/LLMS.md:12–18, 122–179`; `migration/services.md`: service and function idioms.
- `refs/effect/packages/effect/src/reactivity/AtomRpc.ts:135–193, 223–287`: protocol composition, query hydration keys, TTL semantics.
- `refs/effect/packages/effect/src/reactivity/AsyncResult.ts`: async state, Exit conversion, runtime schemas.
- `refs/effect/packages/effect/src/reactivity/AtomRegistry.ts:69–85, 124–137, 377–383, 457–479`: initial values, serialization preload, registry ownership.
- `refs/effect/packages/effect/src/reactivity/Hydration.ts:80–122, 152–179`: public dehydration/hydration and encoding skip behavior.
- `refs/effect/packages/atom/react/src/RegistryContext.ts`, `ReactHydration.ts`: per-provider registry and transition-aware hydration.
- `refs/effect/packages/effect/src/rpc/RpcClient.ts:1014–1025`; `rpc/RpcServer.ts:872–897, 1286–1319`: HTTP protocol and scoped direct server adapter.
- `refs/effect/packages/effect/src/http/HttpEffect.ts:209–229, 301–319`; `http/HttpRouter.ts:1349–1429`: web conversion, stream scope transfer, layer-handler lifecycle.

### TanStack supporting documentation

- <https://tanstack.com/start/latest/docs/framework/react/guide/hosting>
- <https://tanstack.com/start/latest/docs/framework/react/guide/server-functions>
- <https://tanstack.com/start/latest/docs/framework/react/guide/server-routes>

Generic hosting documentation is not a reason to add Wrangler or the official Cloudflare plugin alongside Alchemy's integration.
