# Research: Vitest browser mode for components and hooks

Research date: 2026-10-11.
Status: research only. A throwaway spike ran inside the checkout and was reverted (`git status` clean, `vitest-browser-react` uninstalled) ([§2](#2-what-the-spike-showed)). All recommendations in [§10](#10-questions-with-recommendations) accepted in Plannotator on 2026-10-11; implemented the same day on `main`, uncommitted ([§11](#11-implementation-notes)).
Versions: Vite+ `1.1.0` (Vitest `5.0.3`, which bundles `@vitest/browser` `5.0.3`), `@vitest/browser-playwright` `5.0.3` and `playwright` `1.64.0` (both installed, unused), `vitest-browser-react` `2.3.0` (on npm, not installed; peers `vitest ^4 || ^5`, `react ^18 || ^19`), React `19.3.0`, Effect `4.0.1`, `@effect/vitest` `4.0.1`, `@effect/atom-react` `4.0.1`, Alchemy `2.0.0-beta.81`, Node `24.21.0`. Do not bump dependencies.
Background: [vitest-effect-alchemy-testing-research.md](./vitest-effect-alchemy-testing-research.md) (the `unit` and `integ` tiers), [playwright-e2e-research.md](./playwright-e2e-research.md) (§10.1 leaned toward Vitest browser mode for component tests and deferred the decision to this research), [glossary](./glossary.md).

Sources: `refs/vitest` (`docs/guide/browser/index.md`, `component-testing.md`, `multiple-setups.md`, `visual-regression-testing.md`, `docs/api/browser/react.md`, `context.md`, `locators.md`, `assertions.md`, `interactivity.md`, `commands.md`, `docs/config/browser/*.md`, `docs/guide/migration/index.md`, `docs/blog/vitest-5.md`, `packages/browser/src/node/plugins/pluginContext.ts`, `test/browser/fixtures/locators`), `refs/vite-plus` (`docs/guide/migrate.md` > Vitest, `migrate-rules.md`, `vitest-v5.md`, `packages/cli/src/define-config.ts` `vitePlusVitestResolverPlugin`, `packages/cli/src/oxlint-plugin.ts` `preferVitePlusImportsRule`, `packages/cli/BUNDLING.md`, `crates/vp_cli_snapshots/tests/cli_snapshots/fixtures/vitest_browser_mode`), `refs/effect` (`vitest.config.ts`, `packages/atom/react/test/index.test.tsx`, `packages/atom/react/vitest.setup.ts`, `packages/effect/src/reactivity/AtomRpc.ts` `Service`, `Atom.ts` `AtomRuntime`, `AtomRegistry.ts` `make`, `packages/effect/test/reactivity/Atom.test.ts` "runtime replacement", `packages/effect/src/rpc/RpcTest.ts`, `packages/vitest/src`), `refs/alchemy` (`packages/cloudflare-test-tools/src/e2e`, `packages/frontend-frameworks/fixtures`), the installed `vitest-browser-react@2.3.0` `dist/`, and `@tanstack/start-fn-stubs` `createIsomorphicFn`. Anchors are relative to the named ref.

## 1. Summary

- **It works in this repo today with one new devDependency.** A `browser` project in `vite.config.ts` `test.projects`, with `provider: playwright()` from `vite-plus/test/browser-playwright` and `vitest-browser-react` for `render` / `renderHook`, ran a smoke test against an Astryx `Button` in headless Chromium in 2.2 s cold. Chromium is already installed for the e2e suite. `vp check` and `vp run typecheck` pass with no `tsconfig` change ([§2](#2-what-the-spike-showed), [§3](#3-configuration)).
- **Our components cannot be imported as they are without three tiny stubs.** Every page component reaches `src/backend-client.ts`, which imports `@tanstack/react-start` (whose root entry pulls Start's server storage, `AsyncLocalStorage`), `@tanstack/react-start/server` and, through `env.server.ts`, `cloudflare:workers`. Running the TanStack Start plugin in the browser project breaks Vitest's runner. Exact-match `resolve.alias` entries to three stubs under `test/browser/` fix it. The stubbed `createIsomorphicFn` picks the `.client()` branch, which is what the browser runs in the app ([§4](#4-the-tanstack-start-problem-and-the-stubs)).
- **Effect carries forward at the boundary, not in the runner.** The best seam is Effect's own: `AtomRpc.Service` builds `BackendClient.runtime`, and that runtime's `layer` is an atom. `AtomRegistry.make({ initialValues: [Atom.initialValue(BackendClient.runtime.layer, testLayer)] })` swaps the RPC client for `RpcTest.makeClient(BackendRpcs)` over handlers written with `BackendRpcs.toLayer`. The component under test keeps its real atoms (`requestMagicLinkAtom`, `helloAtom`), real schemas and real `AsyncResult` handling; only the network is replaced, by typed Effect handlers. This is the same pattern `@effect/atom-react`'s own tests use ([§5](#5-where-effect-fits)).
- **`@effect/vitest` runs in Chromium, but it is the wrong default for component tests.** `it.effect` passed in the browser (its main entry has no Node imports). But the locator and `render` APIs are Promise-based, so every step becomes `yield* Effect.promise(...)`, and `TestClock` does not reach the atoms, which run on their own runtime. Effect's own React tests use plain `it`. Recommendation: plain `it` with `async`/`await` in `*.test.tsx`, with Effect in the layers and handlers ([§5.3](#53-the-runner-it-or-iteffect)).
- **There are no custom hooks to test.** The client-side state is Effect atoms consumed through `@effect/atom-react`'s hooks. The spike tested `useAtomValue(helloAtom)` through `renderHook` with a registry wrapper; it works. Vitest's docs prefer rendering a small component over `renderHook` except for libraries that publish hooks ([§6](#6-hooks)).
- **Alchemy has nothing for browser-mode testing.** Its UI testing is Playwright e2e against fixture apps (`cloudflare-test-tools/src/e2e/Playwright.ts`), which our e2e suite already mirrors. No component tests, no jsdom or happy-dom, no `@vitest/browser` anywhere in the ref ([§7](#7-alchemy)).
- **Recommended first landing:** the config, the three stubs, a `test/browser/backend.ts` helper, a smoke test, and one reference test of `SignInPage`; `.vitest/` gitignored; `jsdom` removed. That proves every moving part, and the component test costs nothing to delete if the page changes ([§9](#9-proposed-first-landing), [§10](#10-questions-with-recommendations)).

## 2. What the spike showed

Run in the checkout on `main`, then reverted. In order:

| Step                                                                                                                                                     | Result                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm add -D vitest-browser-react@2.3.0`; a `browser` project with `plugins: [react()]`; Astryx `Button` render + click; `renderHook(() => useState(1))` | Passed, 2.21 s total including Chromium start                                                                                                                                  |
| `SignInPage` with real atoms and an `RpcTest` client, written with `@effect/vitest` `it.effect`                                                          | Failed to import: `@tanstack/react-start/server` → `#tanstack-start-entry` cannot resolve                                                                                      |
| Add `tanstackStart()` to the browser project's plugins                                                                                                   | Every file failed, the smoke test included: "Vitest failed to find the runner"                                                                                                 |
| Alias `@tanstack/react-start/server` and `cloudflare:workers` to stubs                                                                                   | `AsyncLocalStorage is not a constructor`, from the `@tanstack/react-start` root entry                                                                                          |
| Also alias `@tanstack/react-start` to a stub `createIsomorphicFn` (string keys)                                                                          | Prefix collision: the root alias rewrote `@tanstack/react-start/server` too, and a `vite-error-overlay` swallowed clicks                                                       |
| Exact-match regex aliases                                                                                                                                | All passed: email typed as `"M1@m.com "` (decoded by `EmailFromInput`), "Send link", heading "Check your email", "Open link" `href`; the `TooManyRequests` path shows its copy |
| Change the expected `href`                                                                                                                               | Failed with a clear diff, and a failure screenshot under `.vitest/attachments/failure-screenshots/`                                                                            |
| `renderHook(() => useAtomValue(helloAtom))` with a registry wrapper, through a shared helper, plain `it`                                                 | Passed. 4 files, 6 tests, 1.7 s                                                                                                                                                |
| `vp check --fix`, `vp run typecheck`, `vp test run --project unit`                                                                                       | Clean; unit tier unaffected (24 passed, 1 todo)                                                                                                                                |

## 3. Configuration

### 3.1 Packages and imports

Facts:

- Vite+ bundles `@vitest/browser` and `@vitest/browser-preview`; the Playwright provider and `playwright` are opt-in, and both are already devDependencies here (`refs/vite-plus/docs/guide/migrate-rules.md`). Import the provider from `vite-plus/test/browser-playwright` and the browser context from `vite-plus/test/browser`. The `vite-plus/prefer-vite-plus-imports` lint rule rewrites `@vitest/browser-playwright` and `vitest/browser` to those (`refs/vite-plus/packages/cli/src/oxlint-plugin.ts`, `rewriteVitePlusImportSpecifier`).
- In Vitest 5 the browser context is `vitest/browser` only; `@vitest/browser/context` now throws (`refs/vitest/packages/browser/src/node/plugins/pluginContext.ts`, `ID_CONTEXT`). Vite+ maps `vite-plus/test/browser` and `vite-plus/test/browser/context` to it.
- `vitest-browser-react` is a separate community package, the one Vitest's docs and `vitest init browser` use (`refs/vitest/docs/api/browser/react.md`). The lint rule leaves its imports alone. Its main entry registers `cleanup` in a `beforeEach`, not an `afterEach`, so the last test's DOM stays up for inspection; `render` and `renderHook` are async. `configure({ reactStrictMode })` is in `./pure` and off by default; the app does not render in `StrictMode`, so leave it off.
- Vite+'s `vitePlusVitestResolverPlugin` re-points `vitest` and `@vitest/*` imports to the bundled copy in browser mode (`refs/vite-plus/packages/cli/src/define-config.ts`). That is why `vitest-browser-react`, which imports `vitest` itself, worked with no alias.
- Matchers (`toBeVisible`, `toHaveTextContent`, `toHaveAttribute`, ...) are built in, forked from jest-dom; `expect.element(locator)` retries them (`refs/vitest/docs/api/browser/assertions.md`). Do not add `@testing-library/jest-dom` or `@testing-library/react`. Vitest 5 locators are strict (`locators.exact: true`), and `toHaveTextContent` is exact; `toMatchTextContent` is the partial or regex form (`refs/vitest/docs/guide/migration/index.md`).
- No `tsconfig.json` change was needed: importing from `vite-plus/test/browser` or `vitest-browser-react` brings the types, including `expect.element`.

### 3.2 The project

```ts
// vite.config.ts, inside test.projects, after "unit"
{
  plugins: [react()],
  resolve: { alias: browserTestStubs },   // §4
  optimizeDeps: { include: ["react/jsx-dev-runtime"] },
  test: {
    name: "browser",
    include: ["src/**/*.test.tsx"],
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [{ browser: "chromium" }],
    },
  },
},
```

Notes:

- `react()` only for the JSX transform and React's dev runtime; the app's `tanstackStart()` and the Cloudflare plugin must stay out ([§4](#4-the-tanstack-start-problem-and-the-stubs)). The root config already loads no plugins in `mode === "test"`, so the browser project adds its own. In Vitest 5 inline projects inherit the root config (`extends` defaults to `true`); a project with its own `plugins` or `resolve` gets its own Vite server.
- `optimizeDeps.include: ["react/jsx-dev-runtime"]` is what Vitest's own React fixtures set to avoid a re-optimisation reload in the middle of a run (`refs/vitest/test/browser/fixtures/locators/vitest.config.ts`). The spike did not hit that reload, so this is optional.
- The include globs must stay disjoint: `vitest/browser` throws if a Node test imports it. `unit` is `src/**/*.test.ts`, `browser` is `src/**/*.test.tsx` ([Q4](#10-questions-with-recommendations)).
- `headless: true` is explicit because the default is `process.env.CI`. `vp test --project browser --browser.headless=false` opens a headed browser for debugging; `vp test` (watch) with `browser.ui` gives Vitest's browser UI.
- One page per test file; files run in parallel, each in its own browser context (`refs/vitest/docs/config/browser/playwright.md`). `isolate`, `fileParallelism` and `api` are top-level options in Vitest 5, no longer under `browser`.
- Failure screenshots go to `.vitest/attachments/`. Gitignore `.vitest/`.
- `trace: "retain-on-failure"` and Vitest 5's `traceView` exist; not needed for a first landing.

### 3.3 Running

- `vp test run` runs `unit`, `browser` and `integ`. Add `"test:browser": "vp test run --project browser"` beside `test:unit` and `test:integ`.
- CI installs the browser once for both browser suites: `vp exec playwright install chromium --with-deps` (or `--only-shell` for the headless shell, which is what both suites use). The e2e plan already needs this step.

## 4. The TanStack Start problem and the stubs

`SignInPage`, `Playground` and `MembersPage` import their atoms from `src/backend-client.ts`, and so does any future page that talks to the Backend. That module is isomorphic by way of the Start compiler:

- `createIsomorphicFn` from `@tanstack/react-start` picks the client or server branch at build time. Without the compiler, Start's runtime fallback (`@tanstack/start-fn-stubs`, `createIsomorphicFn`) returns whichever branch is chained last; ours chain `.client(...).server(...)`, so even a successful import would point the client at `https://backend/rpc` with the SSR transport.
- `@tanstack/react-start` itself imports Start's server storage context, which reaches for `node:async_hooks` `AsyncLocalStorage`; Vite externalises that for the browser and the constructor is missing.
- `@tanstack/react-start/server` (for `getRequestHeader`) imports `#tanstack-start-entry` and `#tanstack-router-entry`, virtual modules only the Start plugin provides.
- `src/env.server.ts` imports `cloudflare:workers`.

And the Start plugin cannot simply be added to the browser project: with it, Vitest fails to find its runner for every file.

So the browser project aliases three modules, exactly (a string key would also capture `@tanstack/react-start/server`):

```ts
/**
 * Server-only modules that components reach through `backend-client.ts`, replaced for the
 * browser test project. The app gets the same effect from the TanStack Start compiler, which
 * cannot run under Vitest's browser runner.
 */
const browserTestStubs = [
  { find: /^@tanstack\/react-start$/, replacement: stub("start.ts") },
  { find: /^@tanstack\/react-start\/server$/, replacement: stub("start-server.ts") },
  { find: /^cloudflare:workers$/, replacement: stub("cloudflare-workers.ts") },
];
```

```ts
// test/browser/stubs/start.ts
type Impl = (...args: Array<any>) => any;

const isomorphic = (client?: Impl): any =>
  Object.assign((...args: Array<any>) => client?.(...args), {
    client: (impl: Impl) => isomorphic(impl),
    server: (_impl: Impl) => isomorphic(client),
  });

/** Always the `.client()` branch: these tests run in a browser, as the client bundle does. */
export const createIsomorphicFn = () => isomorphic();
```

```ts
// test/browser/stubs/start-server.ts: only reached from a `.server()` branch, which never runs.
export const getRequestHeader = (_name: string): string | undefined => undefined;

// test/browser/stubs/cloudflare-workers.ts: likewise.
export const env = {};
```

With the client branch chosen, `refreshOnFocus` attaches the real `Atom.refreshOnWindowFocus`, `rpcUrl` is `${location.origin}/api/rpc`, and the transport is `FetchHttpClient.layer`, exactly as in the browser bundle. The tests replace that transport anyway ([§5](#5-where-effect-fits)), so a stray request would 404 against Vitest's server rather than reach a Backend.

Cost and limits:

- A component that imports some other Start API (`createServerFn`, `useServerFn`) needs it added to `start.ts`. Today only `createIsomorphicFn` is imported from the root entry, by `backend-client.ts` and `query.ts`.
- Route modules (`src/routes/*`) are out of scope for browser tests: they need the router and the generated route tree. Test the page component a route renders, not the route. That is already how the code is split (`routes/sign-in.tsx` → `components/SignInPage.tsx`).
- The alternative is to move the SSR transport out of `backend-client.ts` into a server-only module. It removes two of the three stubs, but the `createIsomorphicFn` stub stays, and `backend-client.ts` is shaped the way TanStack Start recommends. Not worth it for tests ([Q3](#10-questions-with-recommendations)).

## 5. Where Effect fits

### 5.1 The seam: swap the atom runtime's layer

Facts:

- `AtomRpc.Service` (`refs/effect/packages/effect/src/reactivity/AtomRpc.ts`, `Service`) builds a `Context.Service` for the flat RPC client and an `Atom.runtime` over `Layer.provide(clientLayer, protocol)`. Every `BackendClient.query(...)` and `BackendClient.mutation(...)` atom runs on `BackendClient.runtime`.
- `AtomRuntime.layer` is itself an atom (`Atom.ts`, `AtomRuntime`), and `AtomRegistry.make({ initialValues })` seeds atoms. Effect's test "runtime replacement" swaps a runtime's services this way: `AtomRegistry.make({ initialValues: [Atom.initialValue(counterRuntime.layer, CounterTest)] })` (`packages/effect/test/reactivity/Atom.test.ts`). `@effect/atom-react`'s own tests do the same through `<RegistryProvider initialValues={...}>` (`packages/atom/react/test/index.test.tsx`).
- `RpcTest.makeClient(group, { flatten: true })` gives the flat client that `AtomRpc` expects, wired straight to the group's handlers and middleware with no serialisation (`packages/effect/src/rpc/RpcTest.ts`). The `unit` tier already uses `RpcTest.makeClient` for the Backend.

So a component test supplies a registry whose `BackendClient` is an in-memory client over handlers the test writes:

```ts
// test/browser/backend.ts
type Handlers = RpcGroup.HandlersFrom<RpcGroup.Rpcs<typeof BackendRpcs>>;

/** Fails any RPC a test did not expect, so a test names every call its component makes. */
const unexpected = Object.fromEntries(
  [...BackendRpcs.requests.keys()].map((tag) => [tag, () => Effect.die(`unexpected ${tag}`)]),
) as unknown as Handlers;

/**
 * {@link BackendClient} over the given handlers, in memory. `me` is who the member RPCs see;
 * without it they fail `Unauthorized`, as for a signed-out visitor. `RequireAdmin` passes
 * everyone, so a handler for an admin RPC decides for itself.
 */
export const backendClientLayer = (handlers: Partial<Handlers>, me = Option.none<Me>()) =>
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

/** A registry whose {@link BackendClient} atoms run on {@link backendClientLayer}. */
export const testRegistry = (handlers: Partial<Handlers>, me?: Option.Option<Me>) => {
  const registry = AtomRegistry.make({
    initialValues: [
      Atom.initialValue(BackendClient.runtime.layer, backendClientLayer(handlers, me)),
    ],
  });
  onTestFinished(() => registry.dispose());
  return registry;
};
```

(The spike compiled and ran this, without the `onTestFinished` line and the JSDoc.)

What the test exercises for real: the component, its atoms and their `AsyncResult` states, `schemaForm` and `EmailFromInput` decoding, the RPC client's typed errors (`TooManyRequests` arrives as a typed failure and `describeFailure` maps it to copy), `reactivityKeys` invalidation, Astryx. What it does not: serialisation over the wire (`RpcTest` passes values, not ndjson), the `/api/rpc` proxy, SSR, hydration and loaders. Those belong to the e2e suite.

### 5.2 What does not carry over

- **The Backend's test layers.** `Members.layerTest`, `Mailer.layerTest` and Better Auth on `Memory()` live behind `alchemy` and Better Auth server code, which do not belong in a browser bundle. The browser tier fakes one level up, at the RPC contract, which is the boundary the UI actually depends on.
- **`TestClock`.** Atoms run on their own runtime, so `it.effect`'s `TestClock` does not reach them unless the test threads its context in (`Atom.test.ts` "stream" does it with `Stream.provideContext`). Atom TTLs and `refreshOnWindowFocus` run on real timers in these tests.
- **`@effect/vitest/utils`** imports `node:assert`. Use the main `@effect/vitest` entry, or `vite-plus/test`.

### 5.3 The runner: `it` or `it.effect`

Both ran in Chromium. Side by side, the same step:

```ts
// it.effect
yield * Effect.promise(() => screen.getByRole("button", { name: "Send link" }).click());
yield *
  Effect.promise(() =>
    expect.element(screen.getByRole("heading", { name: "Check your email" })).toBeVisible(),
  );

// it
await screen.getByRole("button", { name: "Send link" }).click();
await expect.element(screen.getByRole("heading", { name: "Check your email" })).toBeVisible();
```

`it.effect` adds `TestClock` (which does not reach the atoms), `TestConsole`, and a scope (which `onTestFinished` replaces). Every locator, `render` and `expect.element` call is a Promise. Effect's own `@effect/atom-react` suite uses plain `it`; its Solid and Vue suites use `@effect/vitest` because their render APIs are synchronous. Recommendation: plain `it` from `vite-plus/test` in `*.test.tsx`; Effect stays in handlers and layers, where its types pay off ([Q2](#10-questions-with-recommendations)).

### 5.4 The resulting test

```tsx
// src/components/SignInPage.test.tsx
describe("SignInPage", () => {
  it("shows the link after a request", async () => {
    const registry = testRegistry({
      RequestMagicLink: () => Effect.succeed({ link: Option.some("http://test.local/verify") }),
    });
    const screen = await renderInApp(
      <SignInPage returnTo={undefined} error={undefined} />,
      registry,
    );

    await screen.getByLabelText("Email").fill("M1@m.com ");
    await screen.getByRole("button", { name: "Send link" }).click();

    await expect.element(screen.getByRole("heading", { name: "Check your email" })).toBeVisible();
    await expect
      .element(screen.getByRole("link", { name: "Open link" }))
      .toHaveAttribute("href", "http://test.local/verify");
  });

  it("says when the rate limit is hit", async () => {
    const registry = testRegistry({ RequestMagicLink: () => Effect.fail(new TooManyRequests()) });
    const screen = await renderInApp(
      <SignInPage returnTo={undefined} error={undefined} />,
      registry,
    );

    await screen.getByLabelText("Email").fill("m1@m.com");
    await screen.getByRole("button", { name: "Send link" }).click();

    await expect
      .element(screen.getByText("Too many attempts. Try again in a minute."))
      .toBeVisible();
  });
});
```

`renderInApp` is a small helper in `test/browser/render.tsx` ([Q6](#10-questions-with-recommendations)), not yet spiked (the spike wrapped in `RegistryContext.Provider` only): `render(ui, { wrapper })` where the wrapper is `RegistryContext.Provider` plus the app's `<Theme theme={neutralTheme} mode="dark">`, with `styles.css` imported once, so the component renders as it does in the app (and failure screenshots look like the app). `LinkProvider` is left out: `RouterLink` needs a router, and Astryx falls back to a plain anchor.

## 6. Hooks

- There are no custom React hooks in `src/`. Client state is Effect atoms (`helloAtom`, `meAtom`, `membersAtom`, `shoutAtom`, `requestMagicLinkAtom`) read through `useAtomValue` / `useAtom`.
- `renderHook(() => useAtomValue(helloAtom), { wrapper })` with the `testRegistry` wrapper worked in the spike. `result.current` is the `AsyncResult`; wait with `expect.poll(() => AsyncResult.isSuccess(result.current)).toBe(true)`. `renderHook` also returns `act`, `rerender` and `unmount`.
- Vitest's docs prefer rendering a small component that uses the hook over `renderHook` except for hook libraries (`refs/vitest/docs/api/browser/react.md` > renderHook). With atoms there is a third option that needs no React: `AtomRegistry.getResult(registry, helloAtom)` in a test, which tests the atom rather than the hook. That needs no browser, but in the Node `unit` project `backend-client.ts` would hit the same `cloudflare:workers` import, so the stubs would have to be shared. Not needed until there is atom logic worth testing on its own; today's atoms are declarations.
- Recommendation: when a custom hook appears, test it with `renderHook` and the `testRegistry` wrapper in the browser project. Keep the `renderHook` case in `src/components/test-setup.test.tsx` as the pattern ([Q1](#10-questions-with-recommendations)).

## 7. Alchemy

- No `@vitest/browser`, `vitest-browser-*`, `@testing-library`, jsdom or happy-dom anywhere in `refs/alchemy`. Its Vitest configs are Node-only.
- UI testing there is Playwright e2e: `packages/cloudflare-test-tools/src/e2e/Playwright.ts` extends Playwright's `test` with a worker-scoped `server` fixture built from an Effect `ManagedRuntime`, run against `live` and `dev` builds of fixture apps (`packages/frontend-frameworks/fixtures/*`, with `toHaveScreenshot`). Our e2e suite already follows that design ([playwright-e2e-research.md](./playwright-e2e-research.md)).
- `Website.Vite` tests are infrastructure tests (deploy, then an HTTP check). Nothing there applies to component tests. The one Alchemy concern for this tier is negative: keep Alchemy and Worker code out of the browser bundle, which the stubs and the RPC-level fakes do.

## 8. Other options considered

- **jsdom or happy-dom in a Node project.** Effect's atom-react suite runs on jsdom with `@testing-library/react`. Faster to start, but not a browser: no layout, no real focus or pointer events, no CSS, which Astryx components depend on (`toBeVisible` is approximated). The repo already has Chromium and the Playwright provider; `jsdom` is installed and unused. Remove it.
- **Playwright's component `mount`** (1.64). Considered in [playwright-e2e-research.md](./playwright-e2e-research.md) §10.1: it needs a story gallery served by our own dev server. Vitest browser mode stays inside `vp test` with the project's Vite config.
- **`vi.mock("../backend-client.ts")`** to replace atoms per test. Works in browser mode (`vi.mock(path, { spy: true })`), but it mocks the module that holds the atoms, so the test no longer exercises them, and it still needs the module graph to load. The layer swap is narrower and typed.
- **MSW** at the network. The repo's RPC is ndjson over POST; handlers would be hand-written wire formats. `RpcTest` with typed handlers is strictly better here.
- **Visual regression** (`toMatchScreenshot`, experimental). Needs a fixed viewport and an environment with stable fonts (Docker or CI only), and the UI is still moving. Not now.

## 9. Proposed first landing

| Path                                       | Role                                                                                                                    |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `package.json`                             | `vitest-browser-react@2.3.0` (exact); `test:browser` script; remove `jsdom`                                             |
| `vite.config.ts`                           | `browser` project ([§3.2](#32-the-project)) with `browserTestStubs` ([§4](#4-the-tanstack-start-problem-and-the-stubs)) |
| `.gitignore`                               | `.vitest/`                                                                                                              |
| `test/browser/stubs/start.ts`              | client-branch `createIsomorphicFn`                                                                                      |
| `test/browser/stubs/start-server.ts`       | `getRequestHeader`                                                                                                      |
| `test/browser/stubs/cloudflare-workers.ts` | `env`                                                                                                                   |
| `test/browser/backend.ts`                  | `backendClientLayer`, `testRegistry` ([§5.1](#51-the-seam-swap-the-atom-runtimes-layer))                                |
| `test/browser/render.tsx`                  | `renderInApp`: registry, theme, `styles.css`                                                                            |
| `src/components/test-setup.test.tsx`       | Astryx `Button` renders and clicks; `renderHook` over an atom through `testRegistry`                                    |
| `src/components/SignInPage.test.tsx`       | the two cases in [§5.4](#54-the-resulting-test)                                                                         |

Verification: `vp check`, `vp run typecheck`, `vp test run --project unit`, `vp test run --project browser`; then break one assertion to see the failure and its screenshot.

## 10. Questions with recommendations

Round 1 (Plannotator, 2026-10-11): every recommendation accepted; the blocks below record the decisions.

:::question
Q1. What lands first: smoke test only, or smoke test plus one real component test?

- [x] Smoke test plus `SignInPage.test.tsx` (recommended). The smoke test alone proves the config but not the stubs, the RPC layer swap or the helper, which are the parts most likely to rot unnoticed. `SignInPage` is the most stable screen (auth is settled) and exercises every piece: atoms, schema form, typed RPC failure, copy. If the page changes, the test is two cases and cheap to rewrite or delete.
- [ ] Smoke test only (Astryx render and click, `renderHook` over an atom). The stubs and helper land unexercised by a page.
- [ ] Config only, no tests until a component deserves one.
:::

:::question
Q2. Runner in `*.test.tsx`: plain `it` with `async`/`await`, or `@effect/vitest` `it.effect`?

- [x] Plain `it` from `vite-plus/test` (recommended). The browser APIs are all Promises; `it.effect` wraps each step in `Effect.promise` and its `TestClock` does not reach the atoms. Effect stays where it pays: handlers, layers, `Option` and typed errors in fakes. Matches `@effect/atom-react`'s own suite.
- [ ] `it.effect` everywhere, for one idiom across tiers. Works (proven in the spike) at the cost of noise.
:::

:::question
Q3. TanStack Start and Worker imports: alias three stubs in the browser project, or refactor `backend-client.ts`?

- [x] Alias to stubs in `test/browser/stubs/` (recommended). Three files, under ten lines in total, invisible to app code; the client-branch `createIsomorphicFn` makes the test run the browser branch, as the app does.
- [ ] Move the SSR transport (`serverFetch`, `env`, `getRequestHeader`) out of `backend-client.ts` into a server-only module. Removes two stubs; the `createIsomorphicFn` stub stays, and the app code changes shape for tests.
:::

:::question
Q4. Which files are browser tests?

- [x] `*.test.tsx` under `src/` is a browser test; `*.test.ts` is a Node unit test (recommended). JSX in a test means a DOM; no new naming to learn; the globs are disjoint, which Vitest requires.
- [ ] An explicit `*.browser.test.tsx` suffix, as Vitest's docs illustrate. Clearer intent, more to type, and a pure-logic `.tsx` test (rare) could stay in Node.
:::

:::question
Q5. Should `vp test run` include the browser project by default?

- [x] Yes, plus a `test:browser` script (recommended). It adds about 2 s and needs Chromium, which the e2e suite already requires; one command runs everything that does not need the e2e stack.
- [ ] No: run it only through `test:browser`, keeping `vp test run` browser-free.
:::

:::question
Q6. Render inside the app's theme (`renderInApp` with `Theme` dark and `styles.css`), or bare `render`?

- [x] `renderInApp` (recommended). Components render as they do in the app; `toBeVisible` and failure screenshots reflect real CSS; one place to add providers later.
- [ ] Bare `render` with a `RegistryContext.Provider` wrapper only. Less setup; components render unstyled.
:::

:::question
Q7. Remove the unused `jsdom` devDependency?

- [x] Yes (recommended). Nothing imports it; browser mode replaces it.
- [ ] Keep it for a possible fast DOM tier later.
:::

:::question
Q8. Visual regression (`toMatchScreenshot`) now?

- [x] Not now (recommended). Experimental, needs a fixed viewport and font-stable environment (Docker or CI), and the UI is still changing. Failure screenshots already give a picture when a test breaks.
- [ ] Add one baseline for `SignInPage` in a `vrt` project.
:::

## 11. Implementation notes

Implemented on 2026-10-11 following [§9](#9-proposed-first-landing). `vp check`, `vp run typecheck` and `vp test run` pass (29 tests and 1 todo across `unit`, `browser` and `integ`, 11 s; the browser project alone takes about 1.5 s). Deviations from the plan above:

- **`renderInApp` works as designed, and `styles.css` is required.** Astryx components inject some styles on their own, but without the stylesheet a button falls back to the browser's defaults (Arial, gray). `src/components/test-setup.test.tsx` asserts the Astryx font (`Figtree`), which fails when the import is removed. A first draft asserted "background is not transparent", which passed without the CSS because a default button is gray.
- **`renderHookInApp`** sits beside `renderInApp` in `test/browser/render.tsx`, with the same providers.
- **The smoke test is `src/components/test-setup.test.tsx`.** It guards the harness rather than a component (the stylesheet, `renderHookInApp` over a query atom), so it stays when page tests are rewritten or deleted.
- **`testRegistry` disposes its registry** with `onTestFinished`, as planned. The spike did not include this; it works.
- **The `SignInPage` test also asserts the decoded payload**: the handler records the email it receives, and `" M1@m.com "` arrives as `"m1@m.com"`.
