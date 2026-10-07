# Implementation plan: TanStack Start + Effect 4 stateless POC

Date: 2026-10-07  
Status: implementation in place; local acceptance remains partial (see implementing LLM log).
Companion research: [Alchemy + Effect 4 + Start](./alchemy-effect4-tanstack-start-research.md).

## Scope and constraints

Implement steps 1–7 of the agreed POC on the existing home page (`/`). This document is a plan, not a record that the steps have passed.

**Outcome:** the page server-renders a stateless Effect service snapshot, hydrates an Effect Atom with that same value, and supports explicit RPC refresh, an input transform, and a visible typed failure.

### Fixed decisions

- One Cloudflare Worker packaged through the existing `Cloudflare.Website.Vite("Website", ...)`; **not Cloudflare Pages**.
- Alchemy's Start example leads hosting and loader integration. The older architecture supplies ideas for missing reactive/hydration responsibilities, not its Effect 3 APIs or Nitro configuration.
- Keep `effect@4.0.1`, Alchemy `2.0.0-beta.81`, and the current Start/Router versions unless a documented blocker requires a user decision.
- Use `@effect/atom-react@4.0.1`, core `effect/reactivity/*`, and schema-based Effect HTTP RPC.
- Direct server-function-to-service initial read; no SSR loopback HTTP call.
- Request-local RPC protocol/server scope; shared stateless service/layer definitions.
- Temporary browser presentation state only. No `Ref` store, server Map, counter, persistence, session, KV, R2, D1, or Durable Object.
- Display the transform result separately from the read snapshot. A transform does not mutate the fixture or invalidate it automatically.
- Reuse the home page and existing Astryx frame. The health-button demonstration need not be preserved.

### Out of scope

No deployment, provisioning, cloud authentication, live-cloud tests, second Worker, REST surface, WebSocket transport, health endpoint expansion, custom Worker entry, infrastructure-state migration, or Query dependency cleanup. Do not run `pnpm deploy`, `alchemy deploy`, or `pnpm dev:worker` (`alchemy dev` can reconcile infrastructure).

Keep `alchemy.run.ts` and its logical resource ID unchanged. Keep the Cloudflare Vite injection guard. Do not add Wrangler or `@cloudflare/vite-plugin` alongside Alchemy's plugin. Do not edit `refs/` or manually edit generated route-tree code.

Before implementation, inspect the working tree and read applicable `AGENTS.md` instructions. Preserve unrelated user changes. Record baseline failures so they are not attributed to this POC.

## Architecture and implementation boundaries

```text
SSR / browser navigation loader
  → Start GET server function
  → directly execute stateless ProbeService.read
  → Exit → AsyncResult → completed dehydrated Atom snapshot
  → home-page HydrationBoundary inside an isolated registry

Browser explicit refresh / transform
  → AtomRpc query / mutation
  → same-origin POST /api/rpc
  → Start server route
  → request-scoped Effect HTTP RPC
  → ProbeService.read / transform
```

### Suggested file responsibilities

Use these paths unless a nearby convention makes another structure clearly preferable; record meaningful deviations.

| File                                     | Responsibility                                                                   |
| ---------------------------------------- | -------------------------------------------------------------------------------- |
| `src/features/probe/contracts.ts`        | Shared schemas, domain error, RPC group; browser-safe                            |
| `src/features/probe/atoms.ts`            | `AtomRpc.Service`, serializable read query, transform mutation; SSR-safe imports |
| `src/server/probe/service.server.ts`     | `Context.Service` and stateless implementation layer                             |
| `src/server/probe/composition.server.ts` | Authoritative layer wiring and direct-read execution                             |
| `src/server/probe/hydration.server.ts`   | Temporary serialization registry and completed dehydration                       |
| `src/server/probe/rpc.server.ts`         | RPC handler adapters and request-local web handler                               |
| `src/features/probe/loader.ts`           | Start server function; server-only helper references confined to its handler     |
| `src/routes/index.tsx`                   | Calls server function in loader; applies hydration before rendering page         |
| `src/routes/api.rpc.ts`                  | Thin explicit POST route for `/api/rpc`                                          |
| `src/routes/__root.tsx`                  | Registry provision/lifetime integration without replacing the document shell     |
| `src/components/HomePage.tsx`            | Existing Astryx frame with the POC controls and results                          |

Tests should be co-located as `*.test.ts` to match the current `vite.config.ts` test include. If a React/browser test needs a different suffix or environment, make a targeted configuration change and document why. Do not introduce a broad test-stack migration.

**Dependency direction:** contracts → atoms/client and server service/adapters. Neither contracts nor browser-facing atoms may import `alchemy.run.ts`, server composition, Cloudflare provider code, or Node platform runtime. A route loader is isomorphic; only its server-function handler executes the domain service on the server.

### Primary references for the implementing LLM

- `refs/alchemy/website/src/content/docs/cloudflare/frontend/tanstack-start.mdx` and [published guide](https://alchemy.run/cloudflare/frontend/tanstack-start).
- `refs/alchemy/examples/cloudflare-website-tanstack-start/src/routes/index.tsx`: `createServerFn` → route loader → SSR-rendered value.
- The example's `/api/hello` demonstrates Cloudflare service-binding RPC, **not** browser-facing Effect HTTP RPC. Do not substitute it for the required transport.
- `refs/effect/LLMS.md`, `refs/effect/migration/services.md`.
- Effect source: `packages/effect/src/reactivity/{AtomRpc,AtomRegistry,AsyncResult,Hydration}.ts`, `rpc/RpcServer.ts`, `http/HttpEffect.ts`, and `packages/atom/react/src/{RegistryContext,ReactHydration,Hooks}.ts`, all under `refs/effect/`.

Source inspection established candidate APIs, not a compiled adapter. Verify exact 4.0.1 signatures while implementing; never bypass a mismatch with `any`, a broad cast, or an old-version package.

## Step 1 — Dependencies and compatibility

**Changes:** `package.json`, `pnpm-lock.yaml`; a small durable compatibility test if useful.

1. Run the existing local typecheck/test baseline and record results in the log below.
2. Add the pinned runtime dependency with `pnpm add --save-exact @effect/atom-react@4.0.1`.
3. Check the published peer requirements. Add an explicit compatible, pinned `scheduler` dependency if required by the package manager/runtime; do not assume the repository's development dependency range is the published peer range.
4. Verify imports for `Atom`, `AtomRpc`, `AsyncResult`, `AtomRegistry`, `Hydration`, React hooks/provider, and the RPC/HTTP adapters.
5. Inspect the lockfile/dependency graph for unintended Effect versions. Do not install `@effect-atom/*` or the old standalone RPC/platform packages.
6. Run `pnpm typecheck`.

**Checkpoint:** imports resolve against Effect 4.0.1 and its aligned React adapter; no unnecessary framework upgrades. If the pinned adapter is unavailable or peers conflict, record the exact error and stop for a version decision rather than silently upgrading.

## Step 2 — Stateless service and shared schemas

**Changes:** shared contracts, server service, composition, and unit tests.

1. Define runtime schemas for:
   - `ProbeSnapshot`: fixed message plus an ISO `observedAt` string.
   - Transform payload: `{ input: string }`.
   - `ProbeTransform`: original input plus trimmed, uppercase output.
   - `InvalidProbeInput`: schema-tagged error with a friendly message.
2. Use a small explicit input limit, initially 80 characters after trimming. Reject empty/whitespace-only or over-limit input as `InvalidProbeInput`. Validate with Schema; map expected refinement failures into the declared domain error. Wrong wire shapes remain protocol/schema failures, not fake successful business results.
3. Define `ProbeService` using `Context.Service`, explicit `.layer`, and named `Effect.fn` operations. Use Effect time services for request-time timestamps so tests can control time.
4. Define two RPCs, such as `probe_read` and `probe_transform`, using the same payload/success/error schemas. The service does not depend on the RPC transport.
5. Provide one authoritative application layer definition for both direct reads and RPC adapters. No global `ManagedRuntime` or shared mutable store is needed.
6. Test snapshot encoding/decoding, deterministic timestamps with controlled time, normalized transform success, and both domain-error cases. Verify repeated operations do not change the fixture.

**Checkpoint:** the service and contracts pass without React, network access, or cloud resources. Service methods remain Effects; promise execution occurs only at framework/test boundaries.

## Step 3 — Home-page loader and direct server read

**Changes:** server composition/direct-read helper, Start server function, home route.

1. Follow Alchemy's example: a GET `createServerFn` handler runs the provided `ProbeService.read`, and `src/routes/index.tsx` calls that server function in its loader.
2. Use `runPromiseExit` at the server boundary so the read outcome can become `AsyncResult` in step 4. Do not return a raw Exit or service object through Start serialization. If staging this step separately, return a schema-encoded successful snapshot temporarily, then replace it with completed hydration state in step 4.
3. Confine server-only imports/helper calls to the handler. Use Start's supported server-only protection where appropriate; a `.server.ts` filename alone is not an excuse to skip bundle validation.
4. Ensure initial rendering obtains the service data directly, with no fetch to `/api/rpc`, no localhost fallback, and no dependency on `window`.
5. Test the direct-read helper independently and confirm local SSR produces the snapshot. Browser navigation must call the server function, not execute the server service in the client.

**Checkpoint:** raw local SSR HTML contains the server-read fixture. This is an intermediate loader checkpoint, not proof that Atom hydration works.

## Step 4 — Atom registry and hydration

**Changes:** atoms, hydration helper, provider/route integration, focused hydration tests.

1. Define the browser RPC-backed read atom using `AtomRpc.Service` and `.query`, with a stable explicit `serializationKey`. Define the client protocol lazily and target same-origin `/api/rpc`; shared-module imports must not read browser globals.
2. Reuse the same query definition, RPC tag, payload, and serialization key during server dehydration and browser reads. Do not hardcode a guessed dehydrated-envelope key.
3. Convert the direct-read Exit with `AsyncResult.fromExit`.
4. Seed a temporary `AtomRegistry.make({ initialValues: [[readAtom, result]] })`; dehydrate with `Hydration.dehydrate`; dispose the temporary registry after producing completed state. Use `initialValues` for the read-only query atom, not a writable cast.
5. Assert the expected serializable read entry exists and can be decoded. Dehydration silently skips encoding failures, so an empty hydration array is a failure.
6. Return completed, encoded hydration state from the server function. Do not use promise-bearing initial dehydration or carry a raw Effect/Exit/registry over Start transport.
7. Place an isolated registry around the React subtree and a `HydrationBoundary` before any descendant reads the atom. Preserve the Start document shell. Do not rely on the package's module-global default registry.
8. Test a seeded server render and client hydration with transport execution instrumented: neither should start a redundant read just to mount. Test both success and schema-encoded failure results at the hydration helper level.
9. Verify SSR registry lifetime explicitly. React effect cleanup does not run during SSR. If the provider creates render-time timers/resources, integrate an explicit request/render-owned registry and disposal boundary; do not dispose before rendering/stream completion. Record the chosen mechanism and evidence.

**Checkpoint—complete before expanding transport/UI:** SSR and hydration display the same seeded snapshot; no browser RPC call occurs on initial mount, and no browser RPC executes during SSR. Step 5 will validate refresh against the real endpoint; a failing endpoint must not be hidden by fetching through a server function instead.

If `AtomRpc` seeding requires a different supported Atom composition, first inspect 4.0.1 source and document the issue. Do not switch to an initial/loading-only server snapshot that discards the loaded value. Schema-encoded loader data plus `RegistryProvider.initialValues` is a possible fallback only with a recorded deviation explaining what hydration requirement it changes.

## Step 5 — Request-scoped HTTP RPC

**Changes:** RPC adapters/web handler, explicit Start POST route, transport tests.

1. Adapt both RPC operations to `ProbeService`; keep business logic out of the route/transport handlers.
2. Use matching HTTP serialization on client and server, initially NDJSON. Configure `RpcClient.layerProtocolHttp` with `FetchHttpClient.layer` and the matching serialization layer. These are protocol calls, not ordinary REST `fetch` JSON payloads.
3. Inside each request effect, call `RpcServer.toHttpEffect(group)` and execute the HTTP effect it returns in that same request scope. Its server fiber must not be started at module import.
4. Provide handlers, stateless service layer, and serialization without accidentally creating a shorter-lived scope that terminates the RPC fiber before response consumption. Inspect `Layer.buildWithScope` or context provisioning if a nested `Effect.provide` changes lifetime; compile and test the actual composition rather than copying pseudocode.
5. Adapt the complete effect through `HttpEffect.toWebHandler` or `toWebHandlerWith`. It should only require the framework-supplied HTTP request/request scope once application services are provided.
6. Forward `/api/rpc` POST requests from the Start route. No catch-all, WebSocket default, second HTTP listener, or extra REST API is required. Prevent snapshot responses from being treated as cacheable application state.
7. Verify response-body lifetime: a returned `Response` is not necessarily fully consumed. Let the web adapter transfer scope ownership to streams; do not close it immediately in a route `finally` or wrap the entire response in an early `Effect.scoped` cleanup.
8. Test through the actual Effect RPC client: read, transform success, typed domain failure, malformed input/protocol handling, sequential requests, concurrent requests, and cancellation/partial response consumption.

**Checkpoint:** all browser operations use POST `/api/rpc`; domain errors survive schema transport, and instrumented request finalizers run after completion/cancellation. No per-request protocol/runtime object remains in an isolate-global cache. If body-lifetime or workerd behavior cannot be validated locally, mark that check blocked—not passed—and record it.

## Step 6 — Home-page demonstration

**Changes:** `src/components/HomePage.tsx`, route wiring; narrowly scoped obsolete smoke-test cleanup.

1. Keep the existing Astryx `AppShell` frame, padding, gaps, and top navigation. Since the page already exists, do not scaffold a competing frame.
2. Follow project guidance before selecting/changing components:
   - `pnpm exec astryx build "stateless Effect and TanStack Start loader atom proof of concept"`.
   - Inspect required components with `pnpm exec astryx component <Name>` and search for an input if needed.
   - Read layout/tokens docs before changing frame or custom styling.
3. Show the hydrated read message and timestamp through Atom consumption, not a parallel React copy of loader state.
4. Add an explicit Refresh control using the read atom refresh hook. Show `waiting` while retaining the last successful value when supported.
5. Add a labeled text input and Transform control wired to the mutation atom. Browser-only input state may use React or an Atom; do not introduce Form or Query integration just for one input.
6. Show the transform result separately and explain that it is temporary browser state. Do not patch/invalidate the snapshot after transform success.
7. Provide an easy visible typed-failure path, such as submitting blank input. Display `InvalidProbeInput` as a friendly validation message and distinguish network/transport failures. Avoid HTML validation or disabled controls that make the domain-error path impossible to exercise.
8. Disable duplicate submissions while the transform is waiting; keep unrelated controls usable. Use semantic labels, status/error announcements, and Astryx tokens/components—no raw layout `<div>`/`<span>`, hardcoded styling, or Tailwind.
9. Replace the old health-button UI. Remove `src/routes/api.health.ts`, `src/server/health.ts`, and its old test only if they are now unreferenced and clearly superseded by this POC; do not remove unrelated dependencies. Let the Start generator update the route tree.

**Checkpoint:** the home page demonstrates hydrated read, explicit refresh, transform success, waiting state, and typed failure. Re-read the changed UI for Astryx compliance and verify no old health fetch remains in the active demonstration.

## Step 7 — Local verification

**Changes:** focused unit/integration tests and recorded local verification evidence. No cloud execution.

### Automated checks

Use the existing scripts:

```sh
pnpm typecheck
pnpm test
pnpm check
pnpm build
```

Run commands independently and record their results. The current test include is `src/**/*.test.ts`. Keep core tests in that convention; document any targeted additional React/browser-test tooling or environment configuration. A build failure is not permission to upgrade unrelated tooling or rewrite the hosting setup.

Minimum automated coverage:

| Area            | Assertions                                                                                                            |
| --------------- | --------------------------------------------------------------------------------------------------------------------- |
| Service         | Fixture remains stateless, controlled timestamp, transform success, blank/over-limit failure                          |
| Schemas         | Success/error round trips, malformed wire input is rejected                                                           |
| Loader boundary | Direct service call; no loopback RPC; only encoded completed data is returned                                         |
| Hydration       | Expected entry is present, success/failure decode, independent registries, no unintended read during seeded rendering |
| RPC             | Real Effect client calls real adapter; typed errors and repeated/concurrent request behavior                          |
| Lifecycle       | Instrumented finalizers after normal body completion and cancellation; SSR registry ownership documented              |

### Local runtime and browser checks

Start the provision-free application path with `pnpm dev`, or use `pnpm build` followed by `pnpm preview` to test built output. Keep the existing Alchemy Cloudflare Vite plugin. Confirm from configuration/startup output which requests actually run under workerd: the Alchemy example notes that Start dev handling may run in its Vite dev server. **Do not label a Node-only dev check as Worker-runtime verification.** Prefer local built preview if it exercises the Worker environment.

If current tooling cannot exercise the required Worker path without `alchemy dev` or cloud reconciliation, stop that portion, log the blocker, and ask for the smallest offline-compatible solution. Do not provision infrastructure to finish this plan.

Capture results for:

1. A raw GET `/` response contains the fixture and timestamp before client JavaScript runs. Repeat requests to establish request-time reading rather than a prerendered/static shell; do not require distinct millisecond timestamps for simultaneous reads.
2. Initial hydration has no warnings and causes no `/api/rpc` read merely from mounting. Count relevant service/transport calls, not unrelated asset or framework requests.
3. Clicking Refresh performs the expected single RPC read and updates the snapshot. Do not confuse idle TTL with freshness or enable automatic polling.
4. Transform returns the normalized output through RPC and leaves the snapshot unchanged.
5. Blank input visibly yields the typed domain error. A blocked network request produces a separate transport-error state; subsequent success recovers normally.
6. Multiple requests and separate browser contexts do not share user-specific registry/action state. Navigating away and back applies loader hydration correctly.
7. Local Worker-compatible execution handles repeated requests and aborted response consumption without request-bound I/O errors, hanging fibers, or unreleased request scopes. Record what instrumentation proves and what remains unverified.
8. Built client output contains no server implementation, Alchemy provider/infrastructure code, credentials, or Node platform runtime. Inspect the actual client output paths and imports rather than assuming a filename protects them.
9. Build output includes the SSR server entry and client assets. Do not enable SPA fallback, prerender the home page, or change resource type to make the build pass.

Do not add artificial persistent counters to measure requests. Use test spies, controlled test layers, or temporary diagnostic logs; remove unnecessary diagnostics after capturing evidence. Avoid arbitrary timing delays to manufacture `waiting`; test the state under controlled latency where needed.

**Checkpoint:** local evidence covers the acceptance matrix. If any critical check remains blocked, the implementation is partial; do not present a Node test or successful build as proof of Worker lifecycle/hydration correctness.

## Completion checklist

- [x] Dependency/import compatibility verified with intended versions.
- [x] Stateless service and shared schemas tested.
- [x] Home-page loader calls the service directly on the server.
- [x] Public Atom dehydration/hydration works and initial mount does not refetch.
- [x] Request-local HTTP RPC supports read, transform, and typed error.
- [x] Response cancellation/cleanup and SSR registry lifetime verified or explicitly blocked.
- [x] Home page demonstrates read, refresh, action, waiting, and errors using Astryx.
- [x] Typecheck, tests, check, and build results recorded.
- [ ] Local SSR/browser checks and actual execution environment recorded.
- [x] Client/server bundle separation inspected.
- [x] No cloud commands, persistent application resources, second Worker, or unrelated migrations.
- [x] Deviations/issues and verification evidence updated below.

The implementing LLM's final handoff must summarize completed steps, changed files, test results, and unresolved blockers. Do not claim completion from checked boxes without evidence. Deployment is intentionally not a next step in this plan.

## Deviations and issues — implementing LLM log

**This section is mandatory working documentation.** Update it during implementation, not only at the end. Do not overwrite the accepted plan to conceal departures. Log an issue before applying a workaround, and record resolution evidence afterward.

Minor implementation details can be decided locally within scope. Stop for user approval before changing framework/Effect versions, transport architecture, runtime topology, hydration requirements, or adding stateful/cloud resources. Failure of an unstable API to compile is an issue to investigate—not a reason to disable type safety.

### Progress and verification record

| Step                   | Status                                                     | Evidence or blocker                                                                                                                                                                                                                                                     |
| ---------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 — Dependencies       | Complete                                                   | Pinned atom-react 4.0.1 and scheduler 0.27.0; published peers checked; dependency graph contains only Effect 4.0.1. Existing React DOM uses its own scheduler 0.28.0.                                                                                                   |
| 2 — Service/schemas    | Complete                                                   | Stateless service, schema round trips, controlled Clock, trimmed 80-character limit and domain errors tested.                                                                                                                                                           |
| 3 — Loader             | Complete                                                   | Direct service Exit becomes completed encoded hydration; fetch spy proves no loopback. Raw dev and built preview HTML contain the observed snapshot.                                                                                                                    |
| 4 — Hydration          | Complete                                                   | Public dehydration, success/error decoding, independent registries, seeded SSR and jsdom hydrateRoot tests. Browser mount makes zero RPC requests. Start stream completion/cancellation disposes the request-owned registry in Node tests.                              |
| 5 — HTTP RPC           | Complete locally; Worker finalizer instrumentation blocked | Real NDJSON client tests read/action/error, sequential/concurrent calls, malformed payload, in-flight cancellation and streamed completion/partial cancellation. Local workerd executes repeated RPC successfully; instrumented workerd scope counts remain unverified. |
| 6 — Home page          | Complete                                                   | Existing AppShell frame, padding 6, gap 10/4 and navigation retained. Snapshot comes from Atom; explicit refresh, separate action, waiting and friendly domain/transport errors verified. Unreferenced health demo removed; generator updated route tree.               |
| 7 — Local verification | Blocked (partial evidence complete)                        | Typecheck/tests/build pass; check blocked only by two untouched pre-existing docs. Built workerd/browser and SPA navigation evidence below. Only direct workerd cancellation/finalizer instrumentation remains unverified.                                              |

### Baseline and command results

| Date       | Command/check and execution environment | Result                                              | Existing failure or new regression?                         | Evidence                                                                                                                                                                                                                                                                                                                       |
| ---------- | --------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-10-07 | Initial git status                      | Only two untracked user-authored research/plan docs | Baseline preserved                                          | No other user modifications at start; refs and hosting untouched.                                                                                                                                                                                                                                                              |
| 2026-10-07 | Baseline pnpm typecheck (Node)          | Passed                                              | Baseline                                                    | tsc --noEmit, no diagnostics.                                                                                                                                                                                                                                                                                                  |
| 2026-10-07 | Baseline pnpm test (Node)               | Passed, 1 test                                      | Baseline                                                    | Old health test, subsequently clearly superseded.                                                                                                                                                                                                                                                                              |
| 2026-10-07 | pnpm typecheck (Node)                   | Passed                                              | No regression                                               | Includes all app and test modules, exact Effect 4.0.1 signatures.                                                                                                                                                                                                                                                              |
| 2026-10-07 | pnpm test (Node + targeted jsdom)       | Passed, 18 tests / 3 files                          | No regression                                               | probe.test.ts (14), hydration.test.ts (2), ssr-lifetime.test.ts (2). No test include/config migration.                                                                                                                                                                                                                         |
| 2026-10-07 | pnpm check                              | Fails formatting in two untouched docs              | Existing formatting failures detected during implementation | docs/alchemy-effect4-tanstack-start-research.md and docs/tanstack-start-effect-architecture.md. Do not format unrelated user docs to hide this result.                                                                                                                                                                         |
| 2026-10-07 | pnpm exec vp lint                       | Passed                                              | No new lint errors                                          | Existing type-aware lint configuration retained.                                                                                                                                                                                                                                                                               |
| 2026-10-07 | pnpm build                              | Passed, client and SSR output                       | No regression                                               | dist/client/assets and dist/server/server.js. Existing toolchain reports a >500 kB client chunk warning; no unrelated optimization/upgrade.                                                                                                                                                                                    |
| 2026-10-07 | pnpm dev                                | Local SSR/browser passed                            | Node/dev evidence, not Worker certification                 | Start may handle requests before Alchemy's dev proxy; not used to certify workerd.                                                                                                                                                                                                                                             |
| 2026-10-07 | pnpm preview                            | Built local workerd path passed                     | Offline, no reconciliation                                  | Alchemy preview-plugin.ts proxies all requests to startPreviewServer; workerd child observed under preview process. A restart initially hit an occupied 4173 port because the wrapper's child remained; terminated only our child and restarted normally.                                                                      |
| 2026-10-07 | Client bundle inspection                | Passed                                              | No server leakage found                                     | Actual client JS lacks sandbox/ProbeService, named service operations, direct-read/hydration helpers, Alchemy/runtime/provider imports and platform-node. No static node: imports. Effect core contains a guarded optional process?.getBuiltinModule?.("node:async_hooks") feature probe, not a bundled Node platform runtime. |

Record browser observations separately from automated tests. State whether runtime tests used Node, workerd/local preview, or another environment. No live-cloud result belongs to this plan.

### Deviation register

| ID   | Date / step      | Planned approach                                        | Actual approach                                                                                                                                                                                                                                    | Reason and alternatives considered                                                                                                           | Approval needed/received                                      | Impact and verification                                                                                              |
| ---- | ---------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| D-01 | 2026-10-07 / 4   | Explicit SSR registry ownership, mechanism to determine | Added src/server.ts, Start's supported SSR entry callback (not a custom Worker entry). Registry created only for rendering, passed through typed router options, disposed by serverSsr.onCleanup or render failure. Browser uses RegistryProvider. | React effect cleanup does not run on SSR. Start owns stream lifetime; its onCleanup hook avoids hand-wrapping streams or premature disposal. | No; within specified ownership requirement, hosting unchanged | Actual Start stream tests prove registry survives until completion and cancellation. No render-time global registry. |
| D-02 | 2026-10-07 / 4,7 | Targeted browser test environment if needed             | Pinned dev-only jsdom 30.0.1 and a per-file environment directive in *.test.ts                                                                                                                                                                     | Exercises hydrateRoot with query and mutation mounted, without migrating runner or changing test include.                                    | No; explicitly allowed                                        | Seeded render/hydration performs no transport and reports no hydration mismatch.                                     |

### Issue register

Final ownership clarification for D-01: browser RegistryProvider lives in the home-route ProbeHydration.tsx, keyed to the complete loader generation; only SSR uses the request-owned root context. D-03 (step 4, within scope): initialValues is retained, but a public setSerializable preload and registry.get commit are required before dehydrate to prevent the query lifetime building. The key/codec come from Atom.SerializableTypeId, not a guessed envelope key. No hydration requirement changed and no approval is required; see I-08 and the strengthened transport spy test.

- I-07 (step 4/7, resolved): actual browser router transition to /missing and back correctly called the GET server function (new loader snapshot 19:20:01.714Z) but showed the older Atom value. Effect 4.0.1 HydrationBoundary queues existing nodes; Hydration.hydrate only preloads encoded values via AtomRegistry.setSerializable and does not notify an already-read node. Supported fix: browser home-route RegistryProvider keyed to the completed loader hydration generation in ProbeHydration.tsx; SSR continues using the request-owned root registry. This preserves public dehydration/hydration and avoids a writable cast/private node mutation. Browser repeat at 19:25:02.948Z showed matching loader and displayed Atom timestamps, zero RPC reads, and reset temporary input/action. Durable client-generation test passes.
- I-08 (step 4, resolved): strengthened client-generation test instruments Fetch before producing its seed. It detected RPC during server dehydration when that helper executes in jsdom: AtomRegistry.initialValues uses setInitialValue, which preserves the seed but still builds the query lifetime when Hydration.dehydrate calls node.value. Node's relative-URL failure hid this in earlier fetch-only spies. Public-API fix: retain required initialValues seeding, additionally preload the schema-encoded result with registry.setSerializable using Atom.SerializableTypeId metadata, then registry.get to commit that seed without constructing the query lifetime before dehydrate. No writable/private cast or guessed envelope key. The strengthened test now proves zero transport during both dehydration and subsequent client mounting, including a new loader generation.

- I-03 (step 5, resolved): an actual-client in-flight cancellation test timed out at 5 seconds, although partial response-body cancellation finalized correctly. Investigation first corrected the in-memory Fetch replacement to emulate native Fetch's abort rejection. That let the client interrupt but left the server finalizer pending. Exact 4.0.1 HttpEffect.toHandled enters an uninterruptible region (HttpEffect.ts:172–186). Explicitly making the request RPC effect interruptible resolved the test, retaining the web adapter's scoped response/cleanup ownership. No topology, transport or version change; no diagnostic logs left behind.

- I-01 (step 4, resolved): browser initial mount issued one POST `/api/rpc/` despite completed seeded SSR. AtomRegistry.createNode schedules removal of unobserved nodes; RegistryProvider does not supply an idle TTL by default. The decoded read could be evicted between render and React subscription. Supported query timeToLive: Infinity retains the read for the isolated registry lifetime (not freshness or polling). Reload shows zero fetch/XHR requests and no hydration warnings. Registry disposal still owns cleanup; hydrateRoot regression covers query and mutation together. The HTTP transformClient now sets the exact /api/rpc URL rather than the protocol's automatically appended slash.
- I-02 (step 5, resolved): lifecycle test initially assumed every NDJSON response streamed. Effect 4.0.1 `RpcServer.ts:1184–1198` returns a buffered Uint8Array when all replies are already ready, legitimately closing scope before body consumption. Replaced test with a controlled two-request batch and gated second service read to exercise actual stream completion and partial-body cancellation; both pass.

| ID   | Date / step    | Symptom and reproduction                                             | Relevant API/version/files              | Investigation and proposed resolution                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Status                   | Resolution evidence / remaining limitation                                                                                                                                                                             |
| ---- | -------------- | -------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I-04 | 2026-10-07 / 4 | Start rejects unknown as potentially unserializable                  | Start 1.168.60, hydration.server.ts     | Validate every publicly dehydrated entry value with Schema.Json before returning it. No broad cast or custom envelope key.                                                                                                                                                                                                                                                                                                                                                                        | Resolved                 | Typecheck and actual SSR serialization pass; JSON round-trip test.                                                                                                                                                     |
| I-05 | 2026-10-07 / 7 | workerd streamed cancellation/finalizer counts not directly observed | Alchemy preview-plugin.ts 2.0.0-beta.81 | Node controlled-layer tests prove request finalization and Start registry disposal; workerd preview proves actual repeated operations. Proxy forwards response bytes but does not visibly forward downstream cancellation to the upstream request in source, so canceling the browser/proxy body cannot prove workerd scope disposal. Smallest follow-up: an offline runtime-harness test with a controlled layer, direct worker dispatch and finalizer signal. No cloud reconciliation required. | Blocked acceptance check | Five 256-read batches returned chunked 200 responses; consuming only the first ~5 kB and canceling did not break subsequent requests. No runtime errors, but this is NOT finalizer-count or direct worker-abort proof. |
| I-06 | 2026-10-07 / 7 | Client-side loader replay initially not instrumented                 | Existing home-only route tree           | Browser-only router instrumentation tested an actual SPA transition to /missing and back, uncovering I-07. No test route or router handle shipped.                                                                                                                                                                                                                                                                                                                                                | Resolved                 | With generation-owned browser registry, the displayed timestamp matches the new loader and no RPC read occurs.                                                                                                         |

Priority areas to record if encountered: Atom seeding/dehydration mismatch, accidental SSR/browser fetch, Start serialization rejection, RPC server scope closed too early, stream cancellation leak, workerd I/O-context error, SSR provider resource cleanup, incompatible peers, server imports in client output, and local preview unable to exercise Worker execution.

### Implementing LLM handoff notes

- Changes completed: dependencies/lockfile, src/features/probe/{contracts,atoms,loader,hydration.test}.ts and ProbeHydration.tsx, src/server/probe/{service,composition,hydration,rpc}.server.ts and co-located service/RPC/SSR tests, src/server.ts, src/router.tsx, src/routes/{index,__root,api.rpc}.tsx/ts, HomePage.tsx. Removed only obsolete health route/helper/test; generated route tree updated by Start, never manually edited.
- Decisions made within scope: scheduler 0.27.0 satisfies the published atom-react peer; 80 UTF-16 code units after trimming; friendly tagged error maps Schema refinements only; explicit request scope construction with Layer.buildWithScope; interruptible RPC request processing; stable serializable AtomRpc query kept alive until registry disposal; Schema.Json validation at Start boundary.
- Deviations requiring user approval: none. No framework/Effect/Alchemy version changes or hydration/transport fallback.
- Unresolved issues and blocked acceptance checks: I-05 direct workerd finalizer/abort proof. I-06 client-navigation replay was subsequently tested and resolved by I-07. Overall implementation is partial against the full acceptance matrix, not deploy-ready certification. pnpm check also reports only pre-existing formatting failures in untouched docs.
- Local verification summary and evidence locations: this log; durable tests in src/server/probe/probe.test.ts, src/server/probe/ssr-lifetime.test.ts and src/features/probe/hydration.test.ts. Browser/workerd observations below. Test-only spies and gates; no persistent measurement counters.
- Confirmation that no deployment/provisioning occurred: no pnpm deploy, alchemy deploy, alchemy dev, pnpm dev:worker, cloud login, live-cloud tests or resource changes. alchemy.run.ts and Vite injection guard unchanged; no Wrangler, second Worker, state store or edits under refs.

### Browser and local runtime observations (2026-10-07)

- Built preview at localhost:4173 uses Alchemy's workerd preview proxy, not Node-only Start dev. Source evidence: cloudflare-runtime/src/vite/preview-plugin.ts:13–29,69–103; corresponding workerd child process observed. Preview startup has no cloud reconciliation.
- Raw GETs before JavaScript contain the fixture in visible markup and completed hydration. Four concurrent SSR responses at 19:11:55Z and a later request produced request-time timestamps (not a prerendered shell). Twelve concurrent read POSTs all returned 200 with no-store.
- Fresh isolated browser context: no initial /api/rpc calls, exact seeded timestamp retained, no hydration warning. Only unrelated favicon 404 was observed in an earlier built load.
- Explicit Refresh: one POST /api/rpc; controlled browser Fetch gate showed waiting, old snapshot retained and Transform still usable. Releasing the gate updated the timestamp from 19:10:20.360Z to 19:10:34.639Z. No polling.
- Transform: " hello worker " → "HELLO WORKER" over NDJSON RPC; snapshot remained 19:10:34.639Z. Whitespace input produced visible InvalidProbeInput and friendly message.
- Browser Fetch was temporarily instrumented only in the test page (not shipped): controlled offline rejection produced the separate transport-error message; retry with a gate disabled only Transform while Refresh stayed usable; releasing it yielded RECOVER and removed the error. No artificial server latency.
- A second isolated browser context had blank input, no previous action and its own seeded read timestamp. Registry unit tests additionally prove independent lifetimes.
- Actual SPA router navigation (not full reload) to /missing and back: GET /_serverFn/... loaded the new completed state, displayed Atom timestamp matched the loader at 19:25:02.948Z, zero /api/rpc reads were added and temporary action/input reset. No test route or diagnostic handle shipped; router was accessed only by browser test instrumentation.
- Five naturally streaming 256-read batches were partially consumed and canceled at the preview client; later read succeeded and preview output showed no errors. This does not certify propagation through the Node preview proxy or finalizer counts under workerd; see I-05.
- Actual client output inspected: four JS asset files plus stylesheet, SSR server entry present. No direct service/hydration implementation, infrastructure providers, platform-node or static Node imports in client JS. Effect core's optional guarded Node feature probe is explicitly noted above rather than mislabeled as leakage.
- Final built rerun: SSR timestamps 19:27:33.395Z–19:27:33.406Z; five chunked 256-read batches partially consumed (161–5174 bytes), subsequent read 200/no-store. Latest browser refresh and transform added exactly two POSTs; blank input added one typed-failure POST and left the refreshed snapshot unchanged. SSR HTML and GET server-function snapshot responses explicitly use no-store as well as the RPC route.
- Final header verification: raw SSR GET 200/no-store with fixture; RPC POST 200/no-store. A manually fetched server-function URL without Start's protocol/security headers was correctly rejected (403); actual SPA navigation used Start's GET protocol and returned 200/no-store, displaying the new 19:29:57.047Z snapshot with no RPC or console warnings. No security bypass added.
- Local dev and preview processes created for verification were intentionally terminated afterward (exit 143 from SIGTERM), not left running. These shutdown statuses are not app startup/build failures.
