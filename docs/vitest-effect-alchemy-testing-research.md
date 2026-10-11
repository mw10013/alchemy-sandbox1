# Research: Vitest for unit and integration tests with Effect and Alchemy, starting with authentication

Date: 2026-10-11  
Status: implemented 2026-10-11 on `main`, uncommitted ([§10](#10-implementation-notes)); decisions in [§9](#9-decisions-and-open-questions) were all accepted in Plannotator.  
Versions: Vite+ `1.1.0` (bundles Vitest `5.0.3`), Effect `4.0.1`, `@effect/vitest` `4.0.1` (on npm, not installed; peers `effect ^4.0.1`, `vitest >=5.0.0 <6.0.0`), Alchemy `2.0.0-beta.81`, `@alchemy.run/better-auth` `2.0.0-beta.81`, `better-auth` `1.7.7`, Node `24.21.0`. Do not bump dependencies.  
Vocabulary: [glossary](./glossary.md). Background: [better-auth-integration-plan.md](./better-auth-integration-plan.md) (the code under test, uncommitted on `main`).

Sources: `refs/alchemy` (`packages/alchemy/src/Test`, `packages/better-auth/test`, `website/src/content/docs/testing`, `cloudflare/tutorial/part-3`, `part-4`, `cloudflare/local-development`), `refs/effect` (`ai-docs/src/09_testing`, `packages/vitest`, `packages/effect/src/rpc/RpcTest.ts`, `src/testing`), `refs/vite-plus` (`docs/guide/test.md`, `vitest-v5.md`, `packages/cli/src/define-config.ts`, `resolve-test.ts`), `refs/vitest` (`packages/vitest/src/runtime/runner/context.ts`), and the installed `node_modules`. Anchors are relative to the named ref. Claims not confirmed by running code are marked **[spike]**.

## Summary

- **Three ready-made pieces fit together.** `@effect/vitest` gives `it.effect` / `it.live` / `layer` on top of the Vitest that Vite+ already runs. `alchemy/Test/Vitest` is built on `@effect/vitest`'s `it.live` and adds `deploy(Stack)` / `destroy(Stack)` with a `dev: true` mode that boots the stack in workerd with the local D1 and email simulators. `@alchemy.run/better-auth` ships a `Memory()` database layer that its own unit tests use to run Better Auth with no database and no Worker ([§2](#2-the-pieces), [§4](#4-in-process-tests-of-the-auth-backend), [§5](#5-stack-tests-in-dev-mode)).
- **Two tiers of tests, both Effect-native.** Tier 1: in-process tests in Node of the Backend's services and RPC handlers through `RpcTest.makeClient`, with Better Auth on `Memory()` and test layers for members, mail and the rate limit. Tier 2: a dev-mode stack test that deploys the real Backend Worker locally and drives the magic-link flow over HTTP. Tier 1 is the bulk; tier 2 is one or two tests that prove the wiring ([§3](#3-recommended-shape)).
- **The auth code needs four small changes before tier 1 is possible.** `makeAuth` must accept a literal secret (the default is an `Alchemy.Random` resource, which needs a stack); it must take its collaborators as services rather than yielding Cloudflare bindings directly (`Members`, a new `Mailer`); `findRole` should go through `Members`; and config (`ALCHEMY_DEV`, `AUTH_ORIGIN`) must come from a `ConfigProvider` the test controls ([§4.2](#42-what-blocks-testing-makeauth-today)).
- **One real setup risk: two copies of Vitest.** Vite+ runs its bundled Vitest and only re-points `vitest` imports for browser-mode tests. `@effect/vitest` imports `vitest` itself, so under pnpm it may bind to a second physical copy, whose test collector is separate module state. The first implementation step is a spike that proves a single `it.effect` test is collected; the fallback is an alias plus `server.deps.inline` ([§2.1](#21-vite-vitest-and-effectvitest)).
- **Dev-mode stack tests have three traps specific to this stack.** The full `Stack` includes `Website.Vite`, which would start the TanStack Start dev server and require `WEBSITE_PORT`; the per-stage seed resolves to `./seed/test_<user>.sql`, which does not exist; and inline link delivery depends on `ALCHEMY_DEV` in the test process environment, not on the harness's `dev` flag ([§5.2](#52-traps-for-this-stack)).

## 1. Current state

- `vite.config.ts` already has `test: { include: ["src/**/*.test.ts"], passWithNoTests: true }` and a `mode === "test"` branch that loads no plugins, so tests run in plain Node, not in the Cloudflare Vite plugin's workerd. `vp test run` works today: "No test files found, exiting with code 0".
- `package.json` `test` is `vp test run`. Note Vite+'s rule: `vp test` is the built-in, `vp run test` the script; both reach the same runner here.
- No `vitest` or `@effect/vitest` in `package.json`. Vitest `5.0.3` is present only as a dependency of `vite-plus` and of `@vitest/browser-playwright` (two physical copies already exist under `node_modules/.pnpm`, with different peer hashes). `jsdom` and `@vitest/browser-playwright` were added by the last commit for later UI tests; they are out of scope here.
- `tsconfig.json` includes `src`, `scripts`, `alchemy.run.ts`, `vite.config.ts`. Lint is type-aware and forbids the `effect` barrel import.
- The code under test is the Backend in `src/backend/` and the RPC contract in `src/api/backend.ts`: `Auth` (Better Auth with `magicLink` and `admin`, invite-only through `validateUserInfo`), `Members` (`SQL.D1`), `SignInLimiter`, `CurrentUserLive` and `RequireAdminLive` middleware, `BackendHandlers`, and the Worker's `fetch` dispatcher.

## 2. The pieces

### 2.1 Vite+, Vitest and `@effect/vitest`

Facts:

- Vite+ pins Vitest to the bundled `5.0.3` and runs that copy as the runner (`refs/vite-plus/packages/cli/src/resolve-test.ts`, `resolveBundled`). Test configuration goes in the `test` block of `vite.config.ts`; a separate `vitest.config.ts` is discouraged (`refs/vite-plus/docs/guide/test.md`). Assertions and runner APIs are meant to be imported from `vite-plus/test`.
- Vite+'s resolver plugin that re-points `vitest` / `@vitest/*` imports to the bundled copy is active **only for browser-mode tests**; for Node tests "vitest's own module runner handles resolution there" (`refs/vite-plus/packages/cli/src/define-config.ts`, `vitePlusVitestResolverPlugin`). The same comment names the failure mode a second copy causes: "internal-state and mock-hoisting mismatches".
- `@effect/vitest` does `export * from "vitest"` and builds `it.effect`, `it.live`, `layer`, `it.prop`, `flakyTest`, `makeMethods` on it (`refs/effect/packages/vitest/src/index.ts`). It is a `node_modules` dependency, so Vitest externalizes it and Node resolves its `vitest` import from its own location.
- Vitest's suite collector is module state (`refs/vitest/packages/vitest/src/runtime/runner/context.ts`, `collectorContext`). A test registered through a second copy of `vitest` lands in a collector the runner never reads: "No test suite found in file".
- Vite+'s own migrator adds `vitest: 5.0.3` to the package manager overrides for exactly this family (`refs/vite-plus/packages/cli/src/utils/constants.ts`, `VITE_PLUS_OVERRIDE_PACKAGES`). Our `pnpm-workspace.yaml` overrides only `vite@*`.

Consequence: adding `@effect/vitest` is the one step that cannot be settled from source alone. **[spike]** Install `@effect/vitest@4.0.1` plus an exact `vitest@5.0.3` devDependency (and the `vitest: 5.0.3` override), write one `it.effect` test, run `vp test run`, and confirm it is collected and passes. If it is not collected, the fallback is `test.server.deps.inline: ["@effect/vitest"]` so Vite processes the package, with `resolve.alias: { vitest: "vite-plus/test" }` so its `vitest` import binds to the runner's copy. Whatever the outcome, Effect tests should import `it`, `describe`, `assert` or `expect` from `@effect/vitest` only, never mixing with `vite-plus/test` in one file; `expect`'s assertion state is per copy (Vitest 5 release note in `refs/effect/packages/vitest/README.md`, "Migrating to Vitest 5").

Idioms from `refs/effect/ai-docs/src/09_testing`:

- `it.effect` provides `TestClock`, `TestConsole` and a fresh `Scope` per test, and suppresses logs. `it.live` uses the live runtime. Property tests: `it.effect.prop` with `Schema` arbitraries. Shared layers: `layer(L)("name", (it) => ...)` builds `L` once per block and tears it down in `afterAll`; state inside the layer is shared across the block's tests (`20_layer-tests.ts` demonstrates this on purpose).
- Error assertions: `yield* effect.pipe(Effect.flip)` then assert on `_tag`; or `Effect.exit` and compare `Exit`s.
- Test layers are static members on the service class next to the live one: `Repo.layerTest` backed by a `Ref`, composed with `Layer.provideMerge` so the test can also reach the `Ref`.
- Never wrap a test body in `Effect.scoped`; the runner owns the scope.

### 2.2 `alchemy/Test/Vitest`

Facts (`refs/alchemy/packages/alchemy/src/Test/Vitest.ts`, `Core.ts`, `Http.ts`; `website/.../testing/test-harness.mdx`):

- `Test.make({ providers, state?, profile?, stage?, dev?, sidecar?, adopt? })` returns `test`, `beforeAll`, `beforeEach`, `afterAll`, `afterEach`, `deploy`, `destroy`. `test(name, effect, { timeout })` is `it.live` from `@effect/vitest` with the Alchemy runtime provided; `HttpClient` (`FetchHttpClient`) is in scope. `beforeAll(deploy(Stack))` returns a lazy accessor, `yield* stack`, with a 120 s default hook timeout. `afterAll.skipIf(cond)(destroy(Stack))`.
- `dev: true` runs the file like `alchemy dev`: Workers in workerd, D1 and email simulated, local ids `dev:`-prefixed. When omitted, `dev` falls back to the `ALCHEMY_DEV` env var; `ALCHEMY_TEST_DEV` overrides in both directions. Local providers run behind one RPC sidecar process per test file (`sidecar` defaults to `dev`).
- Stage defaults to `test_$USER` (`ALCHEMY_TEST_STAGE` overrides). State defaults to `localState()` under `.alchemy/`, which is gitignored. Re-runs diff and skip unchanged resources.
- `Test.rpcClientLayer(url)` is a complete Effect RPC over HTTP transport (ndjson, fetch, a content-type guard that retries edge HTML) for driving a deployed Worker's `RpcGroup`. `getWhenReady` / `executeWhenReady` retry 404 and 5xx on cold start.
- Alchemy's own suites run under its `alchemy-test` runner on bun, not Vitest; its `packages/better-auth` tests use `describe`/`it.live` with the same shape. The harness's Vitest adapter is documented as equivalent, with `test.todo` as a stub.

### 2.3 `@alchemy.run/better-auth` in tests

Facts (`refs/alchemy/packages/better-auth/src/Memory.ts`, `BetterAuth.ts`, `test/BetterAuth.test.ts`):

- `Memory()` provides `BetterAuth.Database` with Better Auth's `memoryAdapter`; tables are seeded from the resolved schema, so plugins' tables exist. No migration is registered (`migrate` is undefined on the service).
- `BetterAuth(options)` with `secret` omitted yields `Random(`${id}Secret`)`, an Alchemy resource. That requires a stack context. Its unit tests pass a literal `secret`.
- `BetterAuth` memoizes one Better Auth instance per execution `Scope` (`makeExecutionMemo`). In a test the `Scope` comes from `it.effect` / `it.live`. The construction effect requires `RuntimeContext`, satisfied in tests by `RuntimeContext.phantom` (`Layer.empty` cast), exactly as the package's tests do.
- The package's test drives `auth.fetch` with a web `Request`: `Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(request))`, then `HttpServerResponse.toWeb`. That is how a test can hit `GET /api/auth/magic-link/verify` in-process and read `set-cookie` with `response.headers.getSetCookie()`.
- Better Auth itself uses `Date.now()` and Promises, not Effect's `Clock`, so `TestClock.adjust` cannot expire a magic link. Tests that exercise Better Auth should use `it.live` (as Alchemy does); pure Effect units can use `it.effect`.

### 2.4 Effect RPC in tests

Facts (`refs/effect/packages/effect/src/rpc/RpcTest.ts`, `RpcMiddleware.ts`, `RpcClient.ts`):

- `RpcTest.makeClient(group)` connects a generated client straight to the group's handlers over the no-serialization transport; headers, middleware and errors travel as in production. It requires `Rpc.ToHandler<Rpcs>` (the handlers layer) and `Rpc.Middleware<Rpcs>` (our two middleware layers) in context. `Rpc.MiddlewareClient` is only required for middleware declared `requiredForClient`, which ours are not.
- Request headers reach handlers and middleware (`{ headers }` in `RequestMagicLink` and `CurrentUserMiddleware`). The client sets them with `RpcClient.withHeaders({ cookie })` around a call.
- This matches how `Backend` builds its RPC server: `BackendHandlers`, `CurrentUserLive`, `RequireAdminLive` provided with the init context. `RpcSerialization.layerNdjson` is not needed in the in-memory path.

## 3. Recommended shape

| Tier              | Where                                                | Runner                                                                   | What it proves                                                                                                                                       | Speed                                           |
| ----------------- | ---------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 1. In-process     | `src/backend/*.test.ts` next to the code             | `@effect/vitest`, `it.live` for Better Auth flows, `it.effect` elsewhere | Auth rules, middleware, handlers, schemas; the whole magic-link flow without a Worker                                                                | sub-second per test                             |
| 2. Dev-mode stack | `test/integ/auth.test.ts` with `test/integ/stack.ts` | `alchemy/Test/Vitest`, `dev: true` via `ALCHEMY_DEV=1`                   | The deployed Backend in workerd with real local D1 (migrations and seed), Better Auth's D1 migration Action, the HTTP surface, the cookie round trip | tens of seconds for the first deploy, then fast |
| 3. Browser        | later                                                | Vitest browser mode with Playwright                                      | UI; explicitly out of scope now                                                                                                                      |                                                 |

Vitest `projects` in `vite.config.ts` keep the tiers apart: a `unit` project (`src/**/*.test.ts`, Node, default timeouts) and an `integ` project (`test/integ/**/*.test.ts`, `env: { ALCHEMY_DEV: "1" }`, `testTimeout: 30_000`, `hookTimeout: 120_000`, `fileParallelism: false`, `pool: "forks"` as Alchemy's own Vitest configs use). `vp test run` runs both; `vp test run --project unit` runs one. Add `test` to `tsconfig.json` `include` so tier 2 is type-checked and lint-aware.

Tier 1 is where the user's "focus on authentication" lands. The smallest useful set:

1. Member requests a link: `RequestMagicLink` returns `Some(link)` under inline delivery; `GET` the link through `auth.fetch`; the response redirects to `returnTo` and sets the session cookie; `Me` with that cookie returns the member with the seeded role.
2. Role copy: an admin member's first sign-in creates a user with `role = "admin"` (the `databaseHooks.user.create.before` path); a plain member gets `"user"`.
3. Non-member: `RequestMagicLink` returns `None`, nothing is sent, no user exists afterwards. Separately, `auth.api.signInMagicLink` called directly for a non-member then verified lands on `/sign-in?error=not_invited` (the `validateUserInfo` gate).
4. Guards: `Me` without a cookie fails `Unauthorized`; `ListMembers` as a user fails `Forbidden`, as an admin succeeds.
5. Rate limit: with the test limiter saying no, `RequestMagicLink` fails `TooManyRequests` when `inline` is false.
6. Sign-out: `POST /api/auth/sign-out` through `auth.fetch`, then `Me` fails `Unauthorized`.
7. Schemas: `EmailFromInput` and `ReturnPath` with `it.effect.prop` or a table (`it.effect.each`).

Tier 2 is one file: deploy a Backend-only test stack, then the happy path over HTTP (request link via `rpcClientLayer`, follow the verify URL with redirects disabled, call `Me` with the cookie) plus the `Unauthorized` case.

## 4. In-process tests of the auth backend

### 4.1 Target composition

```
AuthTest = Auth.layer                       (makeAuth with a literal secret)
  ├─ Memory()                               Better Auth tables, in memory
  ├─ Members.layerTest                      Ref<Member[]> seeded per test
  ├─ Mailer.layerTest                       Ref capturing sent messages (or unused under inline)
  ├─ ConfigProvider.fromMap({ ALCHEMY_DEV: "true", AUTH_ORIGIN: "http://test.local" })
  └─ RuntimeContext.phantom

RpcTest.makeClient(BackendRpcs) with
  BackendHandlers, CurrentUserLive, RequireAdminLive
  ├─ AuthTest, Members.layerTest, SignInLimiter.layerTest
```

`AUTH_ORIGIN` is the `baseURL`, so links are `http://test.local/api/auth/magic-link/verify?token=...`; `auth.fetch` routes by pathname, so the host is irrelevant. With `ALCHEMY_DEV` true, `inline` is true and `RequestMagicLink` returns the link; the `Mailer` is not called. A second, smaller set of tests can run with `ALCHEMY_DEV` false to assert the `Mailer` received a message with the link and the rate limiter was consulted.

### 4.2 What blocks testing `makeAuth` today

Each item is a change in `src/backend/auth.ts` (or its neighbours); none changes behaviour under `alchemy dev` or on deploy.

1. **Secret.** `BetterAuth({...})` without `secret` yields `Random("BetterAuthSecret")`, a resource that needs the stack engine. Make `makeAuth` a function of options, `makeAuth({ secret? })`, so `Auth.layer` keeps the default and `Auth.layerTest` (or the test file) passes a literal. `secret` accepts `string | Redacted | Effect<Redacted>` (`BetterAuth.ts`, `BetterAuthProps.secret`).
2. **Bindings yielded directly.** `makeAuth` yields `Cloudflare.Email.Send(AuthEmail)` and `Cloudflare.D1.QueryDatabase(AuthDb)`. Outside a Worker or stack, the binding callable runs `routeClientDataPlane` over the resource arguments and needs the provider registry (`node_modules/alchemy/src/Binding.ts`). Faking the binding service itself is possible but fights the engine. The Effect-idiomatic fix is a service boundary: a `Mailer` service (`send(message)`) with `Mailer.layer` built on `Cloudflare.Email.Send(AuthEmail)` and `Mailer.layerTest` on a `Ref`; and members through the existing `Members` service. `makeAuth` then yields `Mailer` and `Members`, nothing Cloudflare-specific. The Worker still provides the live layers in `worker.ts`.
3. **`findRole` uses raw D1.** It bypasses `Members` because `SQL.D1` is memoized on an execution `Scope` and Better Auth's callbacks run with the construction snapshot, which has none (`makeExecutionMemo`: evaluating outside an execution scope is a defect). `members.findByEmail(email).pipe(Effect.scoped)` gives each callback its own scope, so the client is built and released per callback. That is a few extra statements per sign-in, acceptable for auth. With this, `findRole` is `Members.findByEmail` mapped to the role and the duplicate SQL goes away.
4. **Config.** `Alchemy.ALCHEMY_DEV` and `Config.String("AUTH_ORIGIN")` read the ambient `ConfigProvider`; tests provide `ConfigProvider.fromMap` (or `ConfigProvider.layer`) with the two keys. No code change, but the test must provide it below `Auth.layer`.

`Members.layerTest` and `SignInLimiter.layerTest` follow the `20_layer-tests.ts` pattern: `Layer.effect(Members, Ref.make([...]))`-style, exposing the `Ref` through `Layer.provideMerge` for assertions. `Members` is already a `Context.Service` with a `layer`, so this is additive.

### 4.3 Isolation versus speed

Building `BetterAuth` on `Memory()` is cheap, so the recommendation is a fresh `AuthTest` per test (`Effect.provide` in the test body) rather than `layer(AuthTest)` per file. A shared layer would carry users and sessions across tests, which `20_layer-tests.ts` shows is easy to trip over. If a file grows slow, switch that file to `layer(...)` with distinct emails per test.

### 4.4 Worker `fetch` dispatcher

`Backend` in `worker.ts` branches `/api/auth*` to `auth.fetch` and everything else to the RPC server. The class is an Alchemy resource; constructing it outside a stack is not supported. Leave the dispatcher to tier 2, or extract the branching into a small pure function if a unit test is wanted. Recommendation: tier 2 covers it.

## 5. Stack tests in dev mode

### 5.1 How it would run

```ts
// test/integ/stack.ts
export default Alchemy.Stack(
  "Alchemy-sandbox1-test",
  { providers: Cloudflare.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const backend = yield* Backend;
    // Better Auth builds links on AUTH_ORIGIN; in this stack the Backend is its own origin.
    yield* backend.bind("AuthOrigin", { env: { AUTH_ORIGIN: backend.url } });
    return { backendUrl: backend.url.as<string>() };
  }),
);

// test/integ/auth.test.ts
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});
const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!process.env.CI)(destroy(Stack));
```

Under `ALCHEMY_DEV=1` the harness resolves `dev` true, boots the Backend in workerd with the local D1 (applying `migrations/` and the seed on reconcile) and runs Better Auth's migration Action against the simulator (`website/.../cloudflare/local-development.mdx`, "D1 Databases"). `backend.url` is the local proxy URL; `dev: { port: 0 }` picks a free port (`LocalWorkerProvider.ts`, `maybeStartProxy`). Tests then use `RpcClient.make(BackendRpcs)` over `Test.rpcClientLayer(backendUrl)` for `RequestMagicLink` and `Me`, and `HttpClient` for the verify `GET`.

A self-referential `env` binding of the Worker's own URL is a recognised `self_url` binding (`Worker.ts`, `isSelfUrl`, "lowers the `self_url` sentinel into a plain-text binding"). **[spike]** Confirm `backend.bind(...)` with `backend.url` takes that path rather than forming a dependency cycle.

### 5.2 Traps for this stack

1. **`Website.Vite` in the real `Stack`.** Deploying `alchemy.run.ts`'s stack in dev mode starts the TanStack Start dev server (websites run their framework dev server under dev) and `Website` reads `Config.Port("WEBSITE_PORT")`. Use the Backend-only test stack above. This also means tier 2 does not cover the Website's `/api/auth/$` allowlist or `/api/rpc` proxy; those are thin and can get in-process tests of their `allowed` / `rejectRequest` functions later.
2. **Seed file per stage.** `AuthDb` imports `./seed/${stage}.sql` from `Effect.serviceOption(Alchemy.Stage)`. The harness stage is `test_<user>`, so the file does not exist and the import hashing fails. Either add a mapping (`Match` on the stage: `dev`, `staging`, `production` keep their files; anything else uses `seed/test.sql`) or pin `Test.make({ stage: "test" })` and add `seed/test.sql`. The mapping is more robust (worktrees, CI stage names) and keeps the harness default. `seed/test.sql` can hold the same three rows as dev; the tests then know `a@a.com` is admin.
3. **Inline delivery is decided at plan time from the planning process's environment.** The Worker's init runs under a `ConfigProvider` that, in the plan phase, records every `Config` lookup into the Worker's env and, at runtime, reads it back (`node_modules/alchemy/src/Platform.ts`, the interceptor around line 500). `alchemy dev` sets `ALCHEMY_DEV=true` on its process (`Cli/commands/dev.ts:101`); the test harness's `dev: true` does not. So the integ project must set `ALCHEMY_DEV=1` (Vitest `test.env`), which also flips the harness into dev mode without `dev: true` in the file. Without it, `inline` is false, `RequestMagicLink` returns `None`, the rate limiter runs, and the link is only in an `.eml` under `.alchemy/local/email` (`Cloudflare/Email/SendEmail.ts`). Reading the `.eml` is a workable fallback for a "real delivery" test but is not needed now.
4. **Redirects.** The verify `GET` answers with a redirect that carries `set-cookie`. Effect's `FetchHttpClient` uses fetch's default `redirect: "follow"`; provide `FetchHttpClient.RequestInit` with `{ redirect: "manual" }` for that call (`effect/http/FetchHttpClient.ts:52`).
5. **State and data.** Default `localState()` writes under `.alchemy/`; local D1 data lives under `.alchemy/local/d1`. `vp run db:reset` deletes `.alchemy/local`, which also wipes the test database; the next run re-creates and re-seeds it. Each worktree has its own `.alchemy`, so parallel checkouts do not collide. Whether `Cloudflare.providers()` needs credentials for an all-local stack with `localState()` is **[spike]**; `alchemy dev` here needs cloud access only for the shared state backend.
6. **Timeouts and process shape.** First deploy includes a workerd boot, migrations and the Better Auth migration Action; 120 s hook timeout is the harness default. Per-test, set 30 s. The sidecar child process lives for the file and is closed by the harness's final `afterAll`. Keep the integ project to one file for now.

### 5.3 Why not Miniflare or `@cloudflare/vitest-pool-workers`

Alchemy's runtime (`RuntimeContext`, binding env packing, the Better Auth execution memo) is what the Worker depends on; running the bundle in Miniflare by hand would mean re-implementing Alchemy's bootstrap. `dev: true` is the supported way to get workerd with the right env. `@cloudflare/vitest-pool-workers` is not installed and would need a Wrangler config this project deliberately does not have.

## 6. Effect idioms to hold to in tests

- Import from `@effect/vitest` only; `it.live` for Better Auth flows, `it.effect` for pure logic, `it.effect.prop` with `Schema` for schema round-trips.
- Assert on typed errors with `Effect.flip` and `_tag`; never `try`/`catch`. Decode fixtures with `Schema` (the `Email` brand is required by the RPC payload, so tests build emails with `Schema.decodeUnknownSync(EmailFromInput)` or the branded constructor).
- Test layers live on the service class as `layerTest`, built on `Ref`, composed with `Layer.provideMerge`. Reusable test effects are `Effect.fn("name")`.
- Cookie handling in tests is one helper, `toCookieHeader(setCookies)`, as in Alchemy's `test/http.ts`.
- Comments follow AGENTS.md: JSDoc on helpers that encode a rule (why `it.live`, why `Effect.scoped` around `findByEmail`), no references to this document.

## 7. Configuration sketch

`vite.config.ts` `test` block (replacing the current one):

```ts
test: {
  projects: [
    { extends: true, test: { name: "unit", include: ["src/**/*.test.ts"] } },
    {
      extends: true,
      test: {
        name: "integ",
        include: ["test/integ/**/*.test.ts"],
        env: { ALCHEMY_DEV: "1" },
        testTimeout: 30_000,
        hookTimeout: 120_000,
        fileParallelism: false,
        pool: "forks",
      },
    },
  ],
},
```

`package.json`: `@effect/vitest@4.0.1` and `vitest@5.0.3` as exact devDependencies; `vitest: 5.0.3` under `overrides` in `pnpm-workspace.yaml`; scripts `test:unit` and `test:integ` as `vp test run --project <name>`. `tsconfig.json` `include` gains `test`. `.gitignore` already covers `.alchemy` and `logs`.

Vitest 5 behaviours worth knowing (`refs/vite-plus/docs/guide/vitest-v5.md`): `clearMocks` is on by default; `{ concurrent: false }` replaces `.sequential`; attachments and blob reports go under `.vitest/` (add to `.gitignore` when browser tests arrive).

## 8. Spike checklist

Run in this order; each is small.

1. Install `@effect/vitest` and `vitest`, add the override, write `src/backend/schemas.test.ts` with one `it.effect.prop` over `EmailFromInput`. `vp test run` must collect and pass it. If not collected, apply the alias and inline fallback from §2.1.
2. Run Alchemy's own Memory pattern against our options: `BetterAuth({ ...our options, secret })` with `Memory()` and `RuntimeContext.phantom`, call `auth.api.signInMagicLink` for a seeded member, capture the link from `sendMagicLink`, `GET` it through `auth.fetch`, read `set-cookie`, `auth.getSession(headers)`. This validates §4 before any refactor.
3. Refactor `makeAuth` per §4.2, add `Members.layerTest`, `SignInLimiter.layerTest`, `Mailer`; write the seven tier 1 tests.
4. Tier 2: `test/integ/stack.ts`, seed mapping, `ALCHEMY_DEV=1` project, one happy-path test. Confirm the self-URL binding and the credentials question.

## 9. Decisions and open questions

Reviewed in Plannotator on 2026-10-11. Every recommendation below was accepted as written; the implementation follows them.

| #   | Question                                                                                                                                                                                                                                     | Recommendation                                                                                                                                                                                                                                                      |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | **Where do test files live?** Co-located `src/**/*.test.ts` for tier 1 (matches the existing include and keeps tests type-checked), `test/integ/` for tier 2 (needs the Alchemy harness and a test stack, which do not belong under `src/`). | As stated: both, split by Vitest `projects`. Add `test` to `tsconfig.json`.                                                                                                                                                                                         |
| Q2  | **Assertion style:** `assert` (Effect's ai-docs idiom, `assert.strictEqual`, `assert.deepStrictEqual`) or `expect` (Vitest's and Alchemy's idiom)?                                                                                           | `assert` from `@effect/vitest`, to match the Effect references the team reads. `expect` only where a matcher is clearly better (`toMatchObject`). Either is fine; consistency matters more.                                                                         |
| Q3  | **Refactor the auth module for testability** (literal secret option, `Mailer` service, `findRole` via `Members`, test layers)? It touches uncommitted code that works in dev.                                                                | Yes. Each change is small and removes a Cloudflare-specific dependency from a service that should not have one. Do it after step 2 of the spike confirms the Memory path, and before writing tests.                                                                 |
| Q4  | **Should tier 1 assert the "real delivery" branch** (`ALCHEMY_DEV` false: `Mailer` called, limiter consulted) as well as the inline branch?                                                                                                  | Yes, two or three tests. It is the branch staging runs and nothing else exercises it.                                                                                                                                                                               |
| Q5  | **Seed for the test stage:** a stage-to-seed mapping with `seed/test.sql` for unknown stages, or pin `stage: "test"` in `Test.make`?                                                                                                         | Mapping. Harness defaults (per-user stage) stay intact and a CI stage name needs no file. Add `seed/test.sql` with the dev rows.                                                                                                                                    |
| Q6  | **Tier 2 in CI?** It boots workerd and needs the Alchemy toolchain in the runner; the first deploy takes tens of seconds.                                                                                                                    | Run it in CI with `afterAll.skipIf(!process.env.CI)(destroy(Stack))`, after the credentials spike answers whether `Cloudflare.providers()` needs a token for an all-local stack. If it does, decide then whether CI gets a scoped token or tier 2 stays local-only. |
| Q7  | **`it.live` versus `it.effect` for auth-flow tests.** `it.live` keeps real time and logs; `it.effect` gives `TestClock` but cannot move Better Auth's own clock.                                                                             | `it.live` for anything that calls Better Auth; `it.effect` elsewhere. Document the rule once in a JSDoc on the shared test layer.                                                                                                                                   |
| Q8  | **Fresh `Memory()` per test or shared per file?**                                                                                                                                                                                            | Fresh per test (§4.3). Revisit if a file exceeds a few seconds.                                                                                                                                                                                                     |
| Q9  | **Scope of this round.** The UI, the Website's proxy routes, and a magic-link expiry test (needs control of Better Auth's clock) are excluded.                                                                                               | Agree. Add the proxy routes' pure functions when the Website settles; skip expiry unless a bug appears.                                                                                                                                                             |

## 10. Implementation notes

Implemented on 2026-10-11 following [§8](#8-spike-checklist). `vp check`, `vp run typecheck`, `vp run build` and `vp test run` (23 tests: 21 unit, 2 integ) pass. Deviations from the plan above:

- **Vitest dual copy (§2.1): no problem in practice.** With `vitest@5.0.3` as an exact devDependency and the `vitest: 5.0.3` override, pnpm links `@effect/vitest`, the project and `vite-plus` to one physical copy; `it.effect` tests are collected. No alias or `server.deps.inline` needed.
- **Tier 2 is never destroyed** (changes Q6's `afterAll.skipIf(!CI)(destroy(Stack))`). `destroy(Stack)` of the dev-mode stack hangs past the 120 s hook timeout on Alchemy `2.0.0-beta.81`. The stack is local and lives under the checkout's `.alchemy/`; a reused stack redeploys as a no-op in milliseconds, and a CI runner is ephemeral. Revisit when the harness is bumped.
- **Self-URL binding and the random dev port.** `backend.bind("AuthOrigin", { env: { AUTH_ORIGIN: backend.url } })` works, but on a redeploy the binding resolves to the previous run's URL while `dev: { port: 0 }` gives the Worker a new port. The real stack is unaffected (the Website's port is fixed). The integ test follows the link's path and query against the live Backend URL instead of the link's origin.
- **`Members.layerTest(rows)`** takes a fixed list rather than a `Ref`: nothing in the auth flow mutates members. `SignInLimiter.layerTest(success)` likewise.
- **Credentials for an all-local stack:** the integ run passed on a machine that has a Cloudflare profile; whether `Cloudflare.providers()` needs one with only local resources and `localState()` is still unverified (Q6, CI).
- **Dev server:** the Worker changes hot-reloaded under the running `alchemy dev`; the magic-link page still works.

## Appendix A: File plan

| Path                                  | Role                                                                                    |
| ------------------------------------- | --------------------------------------------------------------------------------------- |
| `vite.config.ts`                      | `test.projects`: `unit`, `integ` (§7)                                                   |
| `package.json`, `pnpm-workspace.yaml` | `@effect/vitest@4.0.1`, `vitest@5.0.3`, override; `test:unit`, `test:integ`             |
| `tsconfig.json`                       | `include` adds `test`                                                                   |
| `src/backend/auth.ts`                 | `makeAuth({ secret? })`; yields `Members` and `Mailer`; `findRole` via `Members`        |
| `src/backend/mailer.ts`               | `Mailer` service: `layer` on `Cloudflare.Email.Send(AuthEmail)`, `layerTest` on a `Ref` |
| `src/backend/members.ts`              | `Members.layerTest`                                                                     |
| `src/backend/handlers.ts`             | `SignInLimiter.layerTest`                                                               |
| `src/backend/worker.ts`               | provides `Mailer.layer`; otherwise unchanged                                            |
| `src/backend/auth.test.ts`            | tier 1 flows (§3, items 1 to 6) through `RpcTest.makeClient` and `auth.fetch`           |
| `src/api/backend.test.ts`             | schema tests (item 7)                                                                   |
| `src/backend/resources.ts`            | seed selection by stage (Q5)                                                            |
| `seed/test.sql`                       | test members                                                                            |
| `test/integ/stack.ts`                 | Backend-only stack with the self `AUTH_ORIGIN` binding                                  |
| `test/integ/auth.test.ts`             | tier 2 happy path and `Unauthorized`                                                    |
