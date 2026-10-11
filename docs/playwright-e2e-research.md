# Research: Playwright end-to-end tests with Alchemy and Effect

Research date: 2026-10-11.
Status: research only; nothing added to the project. One throwaway spike was run against the running dev server from `/tmp` ([§2](#2-what-the-spike-showed)). All decisions in [§11](#11-questions-with-recommendations) accepted in Plannotator over two rounds on 2026-10-11; not implemented.
Versions: Playwright `1.64.0` (installed; `playwright/test` is the runner), Vite+ `1.1.0` (Vitest `5.0.3`), `@vitest/browser-playwright` `5.0.3` (installed, unused), Effect `4.0.1`, Alchemy `2.0.0-beta.81`, TypeScript `7.0.2`, Node `24.21.0`. Do not bump dependencies.
Background: [vitest-effect-alchemy-testing-research.md](./vitest-effect-alchemy-testing-research.md) (tiers 1 and 2; this is tier 3), [test-speed-research.md](./test-speed-research.md), [glossary](./glossary.md).

Sources: `refs/playwright/docs/src` (`pom.md`, `test-fixtures-js.md`, `best-practices-js.md`, `auth.md`, `test-webserver-js.md`, `test-global-setup-teardown-js.md`, `test-projects-js.md`, `test-parallel-js.md`, `test-typescript-js.md`, `library-js.md`, `aria-snapshots.md`, `test-components-js.md`, `ci.md`), `refs/playwright/tests/config` (how Playwright's own suite is written), `refs/alchemy` (`packages/cloudflare-test-tools/src/e2e`, `packages/alchemy/src/Cli/commands/dev.ts`, `Test/Core.ts`, `Cloudflare/Email/SendEmail.ts`, `website/src/content/docs/testing`, `cli/state.mdx`), `refs/baton` (`playwright.config.ts`, `e2e/`), `refs/astryx` (`apps/docsite/playwright.config.ts`), `refs/effect` (`LLMS.md`, `ai-docs/src/04_integration`, `packages/vitest/src`, `migration/v3-to-v4.md`), `refs/tan-router/packages/react-router/src/ClientOnly.tsx`. Anchors are relative to the named ref. Claims not confirmed by running code are marked **[spike]**.

## 1. Summary

- **Use Playwright Test, not Vitest plus the Playwright library.** The runner is where Playwright's value is: per-test browser contexts, web-first assertions that retry, actionability checks, traces, UI mode, the `webServer` block and `storageState`. The library gives none of that, and `@effect/vitest` cannot run under Playwright Test because it imports Vitest's runtime ([§3](#3-runner-playwright-test-or-vitest-with-the-playwright-library)).
- **Effect belongs at the edges of a test, not around `page`.** Playwright's `page` and `expect` are Promise APIs with their own waiting, timeouts and reporting; wrapping them in `Effect.tryPromise` adds a layer that reports worse and waits no better. Where Effect earns its place is everything that talks to the Backend from the test process: a worker-scoped fixture holding a `ManagedRuntime` with an Effect RPC client over the Website's proxy route, reusing `BackendRpcs` and its schemas. That is the pattern Effect's own docs give for non-Effect hosts and the one Alchemy's own Playwright harness uses ([§4](#4-where-effect-fits)).
- **No page object classes. Functions and fixtures.** Playwright's page object model is one way to name things; its docs show only a class shape, but its real recommendation is "wrap it in a fixture", and Playwright's own suite uses plain fixture modules and no page objects at all. For this app (four screens, role-based locators that Astryx already gives us) the right shape is small functions over `Page` grouped by screen, exposed through `test.extend` fixtures. `erasableSyntaxOnly` in our `tsconfig.json` also forbids the constructor parameter properties every class page object uses ([§5](#5-page-objects-classes-objects-or-functions)).
- **The one trap is hydration.** The spike's only failures were clicks that landed before React attached handlers after a server render. TanStack Router exports `useHydrated`; marking `<body data-hydrated>` from it and waiting for that marker after every full page load is the fix. Baton does the same ([§6](#6-hydration-the-trap-the-spike-found)).
- **The suite owns its server and its data: a dedicated `e2e_$USER` stage, and a test-control surface on the Backend.** Playwright's `webServer` starts `alchemy dev` on its own stage and port (`WEBSITE_PORT + 100`) with local state, and adopts it when already running. A small `TestControlRpcs` group, mounted off production behind a token, gives `ResetData`, `CreateMember` and `IssueMagicLink`: repeatable runs, per-test data for parallel workers, and sessions without mail on every target, deployed stages included ([§7](#7-the-server-under-test-from-first-principles)).
- **Sign in once per role through the test-control surface, in a setup project, and reuse `storageState`.** Only the sign-in screen's own test goes through the UI ([§8](#8-authentication-in-tests)).
- **CI changes configuration, not tests.** First a workflow running the dev-mode stack in the runner; later PR preview stages, reached by the same specs through `PLAYWRIGHT_TEST_BASE_URL` ([§9](#9-ci-from-first-principles)).

## 2. What the spike showed

Run from `/tmp/pw-spike` with `vp exec playwright test -c /tmp/pw-spike/playwright.config.ts` against the dev server on `WEBSITE_PORT` 3900, Chromium headless shell 1248 (already installed under `~/Library/Caches/ms-playwright`, matching `playwright-core@1.64.0`'s `browsers.json`). Nothing in the repo changed; the `test-results/` directory Playwright wrote under the cwd was removed.

| Step                                                                                                      | Result                                                                                                                                          |
| --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `page.goto("/sign-in")`, `expect(getByRole("heading", { name: "Sign in" })).toBeVisible()`                | Passes. The aria snapshot is clean: `heading "Sign in"`, `textbox "Email"`, `button "Send link"`.                                               |
| Fill `getByLabel("Email")`, click `Send link` right after `goto`                                          | **Fails**: no `/api/rpc` request is made; the heading `Check your email` never appears. The click ran before hydration.                         |
| Same, after `waitForLoadState("networkidle")`                                                             | Passes: one `POST /api/rpc/`, then `link "Open link"` with the verify URL.                                                                      |
| Click `Open link`, `waitForURL(/\/app/)`                                                                  | Passes. The verify redirect through the Website proxy sets the session cookie; `/app` renders `heading "Member area"`, `Signed in as m1@m.com`. |
| Click `Sign out` right after the navigation                                                               | **Fails** the same way: the handler is not attached yet.                                                                                        |
| As `a@a.com`: land on `/admin`, click `link "Members"`, `expect(getByRole("cell", { name: "m1@m.com" }))` | Passes. `getByRole("table").ariaSnapshot()` gives three rows with `cell "admin"` / `cell "user"` tokens.                                        |
| Click `Sign out` after a hydration wait, `waitForURL(/\/$/)`, expect `link "Sign in"`                     | Passes; `context.cookies()` is empty afterwards.                                                                                                |

Whole file: 2.3 s. Conclusions:

- Playwright Test runs from the `playwright` package alone (`import { test, expect } from "playwright/test"`); no `@playwright/test` dependency is needed.
- Astryx components expose good roles and names, so role locators cover the whole app with no test ids.
- Both failures are the same hydration race, and `networkidle` is the wrong fix (it is a dev-server artefact; it is discouraged in Playwright's docs and would not hold under HMR or a slow asset). [§6](#6-hydration-the-trap-the-spike-found) has the right one.
- The `Collapse sidebar` button and the submit button each carry an empty `status` child (Astryx's loading region). Harmless, but `toMatchAriaSnapshot` templates should omit them with partial matching.

## 3. Runner: Playwright Test, or Vitest with the Playwright library?

The question matters because the Vitest side is already Effect-native (`@effect/vitest`, `alchemy/Test/Vitest`) and a Vitest-hosted e2e tier could use `it.live` and the same stack harness as tier 2.

| Concern                   | Playwright Test (`playwright/test`)                                                                    | Vitest `integ`-style project + `playwright` library                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Isolation                 | A fresh `BrowserContext` and `page` per test, one browser per worker, for free.                        | Hand-rolled: `chromium.launch()` once, `browser.newContext()` per test, close both; `library-js.md` > Key Differences.                          |
| Assertions                | Web-first `expect(locator).toBeVisible()` retries until the 5 s expect timeout.                        | "No built-in Web-First Assertions" (`library-js.md`); you poll by hand or import `playwright/test`'s `expect` outside its runner (unsupported). |
| Failure output            | Trace on first retry, screenshots, the `error-context.md` aria snapshot, UI mode, `--debug`.           | None of it. A failed `click` is a stack trace.                                                                                                  |
| Server lifecycle          | `webServer` block with `reuseExistingServer`, URL polling, `gracefulShutdown`.                         | `beforeAll` spawning `alchemy dev` yourself, or require the server up front as Baton does.                                                      |
| Auth state                | `storageState`, setup projects, `dependencies`.                                                        | Hand-rolled cookie plumbing.                                                                                                                    |
| Effect in the test body   | Only at the edges ([§4](#4-where-effect-fits)).                                                        | `it.live` bodies; but `page.*` calls still go through `Effect.tryPromise`, so the body reads worse than Promise code for no gain.               |
| Stack harness reuse       | Not applicable: tests need the Website, which the tier 2 Backend-only stack leaves out on purpose.     | `deploy(Stack)` of the full stack would start Vite under the harness; untested, and the same `WEBSITE_PORT` and state-store questions apply.    |
| Type checking             | Babel strip, no checking (`test-typescript-js.md`); `vp run typecheck` must include the e2e directory. | Vite transform, no checking either; same answer.                                                                                                |
| Second runner in the repo | Yes: a `playwright.config.ts` beside `vite.config.ts`, and `vp exec playwright` beside `vp test`.      | No.                                                                                                                                             |

Playwright's own position (`library-js.md` > Introduction): "Under most circumstances, for end-to-end testing, you'll want to use `@playwright/test` ... and not `playwright` ... directly." Alchemy agrees in practice: its only Playwright code, `packages/cloudflare-test-tools/src/e2e/Playwright.ts`, is a `test.extend` worker fixture, not a Vitest suite. The cost of Playwright Test is one more config file and runner; the cost of the library route is rebuilding the parts of Playwright that make e2e tests readable when they fail.

Vitest browser mode (`@vitest/browser-playwright`, added last commit "for later UI tests") is a different thing and not an alternative: it runs test files inside a browser page against components you mount, not a browser against the running site. Keep it for component tests if and when they are wanted ([§10.1](#101-component-tests-a-temperature-check-not-a-decision)).

**Recommendation:** Playwright Test, under `e2e/`, run as `vp exec playwright test` through a `test:e2e` script.

## 4. Where Effect fits

Three levels were considered.

**Level 0, none.** Plain Playwright. Everything in [§2](#2-what-the-spike-showed) was written this way and needed nothing else. For the four screens that exist today this is enough.

**Level 1, Effect at the edges.** Playwright owns the test body, fixtures and `page`; Effect owns anything the test process does against the Backend. Effect's idiom guide for non-Effect hosts (`refs/effect/LLMS.md` > "Integrating Effect into existing applications", `ai-docs/src/04_integration/10_managed-runtime.ts`) is exactly this: build one `ManagedRuntime` from a Layer at the edge and call `runtime.runPromise(...)` from the host's hooks. In Playwright the host hook is a worker-scoped fixture:

```ts
// e2e/fixtures.ts
import { test as base } from "playwright/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { BackendRpcs } from "../src/api/backend.ts";

/** Effect RPC to the Backend through the Website's proxy route, as the browser does. */
const backendLayer = (baseURL: string) =>
  RpcClient.layerProtocolHttp({ url: `${baseURL}/api/rpc` }).pipe(
    Layer.provide(RpcSerialization.layerNdjson),
    Layer.provide(FetchHttpClient.layer),
  );

export const test = base.extend<
  {},
  { backend: <A, E>(effect: Effect.Effect<A, E, RpcClient.Protocol>) => Promise<A> }
>({
  backend: [
    async ({ baseURL }, use) => {
      const runtime = ManagedRuntime.make(backendLayer(baseURL!));
      await use((effect) => runtime.runPromise(effect));
      await runtime.dispose();
    },
    { scope: "worker" },
  ],
});
```

A test then does `const link = await backend(Effect.gen(function* () { const client = yield* RpcClient.make(BackendRpcs); return yield* client.RequestMagicLink({ email }); }))` and hands the result to `page`. What this buys: the Backend's schemas (`EmailFromInput`, `Member`, the tagged errors) and procedures are reused with no hand-written JSON, which is what Effect is for at a boundary; typed failures (`TooManyRequests`) can be asserted with `Effect.flip` the way tier 1 does; and future seeding or reset procedures get a client for free. What to carry over from `@effect/vitest`'s internals (`packages/vitest/src/internal/internal.ts`): log `Cause.prettyErrors` before rejecting, or use `runPromiseExit`, so a failed Effect reads well in Playwright's report; `runPromise` rejects with the squashed cause only.

Caveats: `ManagedRuntime` has no `TestClock` (and virtual time cannot move a real browser anyway); Playwright has no per-test `AbortSignal` to forward into `runPromise({ signal })`, so a hung Effect is ended by the fixture timeout, not interrupted. Both are acceptable for a client that only makes HTTP calls. **[spike]** The Website's `/api/rpc` proxy requires a positive `content-length`; the ndjson protocol over `FetchHttpClient` sends a string body for unary calls, which fetch sizes, but this has only been proven Backend-direct in tier 2, not through the proxy.

**Level 2, Effect around `page`.** A `Browser`/`Page` service in a Layer with `Effect.acquireRelease` for contexts, `Effect.tryPromise` around every `page.*` call, test bodies as `Effect.gen`. This was rejected:

- Playwright's actions already wait, retry and time out; `Effect.retry`/`Effect.timeout` on top double the policies and hide which one fired.
- `expect(locator)` is the assertion model; its auto-retrying matchers have no Effect equivalent and must stay outside Effect anyway, so the body is half and half.
- Playwright's report shows `page.*` calls as steps with locators and screenshots; an Effect wrapper collapses them into one opaque promise unless every wrapper also calls `test.step`.
- A per-test `BrowserContext` is already a scoped resource the runner manages; re-expressing it as a `Scope` only adds a second owner.
- The result is Promise code written in generator syntax: no typed errors to recover from (a failed click is a defect), no services to swap, no concurrency to structure.

Alchemy's harness is the reference for the boundary: `cloudflare-test-tools/src/e2e/Playwright.ts` builds its server with `ManagedRuntime` and a `Scope` inside a worker fixture and exposes a plain `{ url, fetch }` object to tests; the specs are ordinary Playwright.

**Recommendation:** Level 1, introduced with the first test that needs the Backend from Node, which is the setup project in [§8](#8-authentication-in-tests). Until then, level 0 is correct and not a compromise.

## 5. Page objects: classes, objects or functions?

What Playwright actually says (`pom.md`): page objects "simplify authoring by creating a higher-level API which suits your application and simplify maintenance by capturing element selectors in one place". The only shape shown is a class with `readonly` locator fields set in `constructor(page: Page)` and async methods, constructed with `new` inside each test. `pom.md` offers no alternative. The stronger, newer guidance is in `test-fixtures-js.md`: "if you have a helper function that is used in multiple tests, consider turning it into a fixture", fixtures are "on-demand" and "composable", and "you no longer need to wrap tests in `describe`s that set up their environment". `auth.md` > "Testing multiple roles with POM fixtures" again wraps classes in fixtures. And Playwright's own suite (`tests/config/baseTest.ts`, `serverFixtures.ts`, `tests/page/pageTest.ts`) is built entirely from fixture modules, `mergeTests`, and plain functions; no page object classes were found in it.

So the model Playwright promotes is really two things: a place to put locators and flows per screen (the "page object"), and fixtures as the way tests reach them. The second is the valuable part. The first can take any shape.

| Shape                         | Looks like                                                                                                                            | For us                                                                                                                                                                                                                                                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Class per screen              | `class SignInPage { constructor(readonly page: Page) {} async requestLink(email) {...} }`                                             | Blocked as written: `erasableSyntaxOnly` rejects constructor parameter properties, so every class needs an explicit field and assignment. Classes also invite state (`this.lastLink`) that Playwright's per-test isolation then has to be reasoned about. No upside here: no inheritance, no instances to distinguish. |
| Object of locators per screen | `const signIn = (page) => ({ email: page.getByLabel("Email"), send: page.getByRole("button", { name: "Send link" }) })`               | Fine and cheap. A record built from `page` is the class without `this`. Best for screens with many controls.                                                                                                                                                                                                           |
| Functions per flow            | `requestMagicLink(page, email)`, `followMagicLink(page)`, `signIn(page, email)`                                                       | What Baton converged on (`refs/baton/e2e/member.ts`); composes naturally (`signIn` is the first two); reads like the test. Best for flows that span screens.                                                                                                                                                           |
| Fixtures                      | `test.extend<{ signIn: (email: string) => Promise<void> }>({ signIn: async ({ page }, use) => use((email) => signIn(page, email)) })` | How tests reach the above without importing and passing `page` everywhere; also where teardown lives. Playwright-idiomatic.                                                                                                                                                                                            |

Locators: with role-based locators and Astryx's accessible names, there is little "selector capture" to centralize. A screen's locators are two or three one-liners; a shared record is worth it only where the same name is used in several tests (the shells' `Sign out` button, the sign-in form).

**Recommendation:** no classes. One module per screen or flow under `e2e/` exporting functions over `Page` (and locator records where a screen has several controls), and one `e2e/fixtures.ts` that extends `test` with the flows the tests call and the Backend runtime from [§4](#4-where-effect-fits). Tests import `test` and `expect` from `./fixtures`, never from `playwright/test` directly (Playwright's own convention and Alchemy's).

## 6. Hydration: the trap the spike found

TanStack Start renders every page on the server and hydrates in the browser; until React attaches handlers, a button is visible and enabled, so Playwright's actionability checks pass and the click is lost. This is why the first and fourth steps in [§2](#2-what-the-spike-showed) failed, and it will bite after every full page load: the first `goto`, following the magic link, and anything that reloads.

Options:

1. `waitForLoadState("networkidle")`: worked in the spike, but it is timing, not a signal, and Playwright marks time-based waits as flaky by nature.
2. Retry the click until a side effect appears (`expect(...).toPass()`): hides the problem and slows every action.
3. A hydration marker. TanStack Router exports `useHydrated()` (`refs/tan-router/packages/react-router/src/ClientOnly.tsx`: "Return a boolean indicating if the JS has been hydrated already", documented with a `disabled={!hydrated}` button example). `RootDocument` renders `<body data-hydrated={useHydrated() ? "" : undefined}>`, and the test side waits for `body[data-hydrated]` after a full load. Baton has the same helper (`refs/baton/e2e/hydration.ts`, `awaitHydration`, and its `AGENTS.md` rule "Wait for `body[data-hydrated="true"]` before any fill or click").

Option 3 is the one that states the rule once. The hook returns `false` on the first client render and `true` after, so the server markup and the hydration render agree and no hydration mismatch warning results. On the test side the wait belongs in a `goto` flow (`await page.goto(path); await page.locator("body[data-hydrated]").waitFor()`) and after `followMagicLink`, not in every test. Playwright 1.64's `page.goto` also supports a custom `waitUntil`, but none of its values is "hydrated".

**Recommendation:** add the marker to `RootDocument` with a JSDoc stating the rule (end-to-end tests wait for it), and an `e2e` `goto` flow that waits for it. One attribute, no layout `div`.

## 7. The server under test, from first principles

The app is small today; the question is what an end-to-end suite needs in order to stay trustworthy as it grows, so that the first setup is the one that scales rather than one to be replaced.

### 7.1 What a suite must own

1. **Its starting state.** Every run begins from data the tests chose, not from whatever a person last clicked. Playwright's best practices put it as "make sure you control the data".
2. **Its own server.** A suite that adopts a developer's dev server is coupled to that person's tabs, hot reloads and database. It also cannot run in CI the same way it runs locally.
3. **Isolation between parallel tests.** Playwright runs files in parallel workers; two tests that mutate the same rows race. Playwright's answer is per-worker data (`parallelIndex`) and per-test unique data (`testInfo.testId`), which needs a way to create that data.
4. **An authenticated session without mail.** Magic links go out by email everywhere except under `alchemy dev`, where delivery is inline. A suite that depends on the inline UI can only ever run against a dev-mode stack.
5. **One suite, several targets.** The same specs should run against a local dev-mode stack, a CI runner, and later a deployed preview stage, with only the base URL and the way of getting a session changing ([§9](#9-ci-from-first-principles)).

Items 1, 3 and 4 share one answer: the Backend needs a small **test-control surface**, a procedure group that exists only off production. Items 2 and 5 are answered by a dedicated stage and by configuration.

### 7.2 A dedicated `e2e` stage

Alchemy facts (`environments/stages.mdx`, `cli/dev.mdx`, `Cli/commands/dev.ts`, `State/LocalState.ts`):

- A stage is an isolated instance of the stack: its own state rows, its own `dev:<uuid>` local D1 under `.alchemy/local/d1`, its own migrations and seed run. Alchemy's own conventions are per-user stages: `dev_$USER`, `test_$USER`, `pr-<n>`.
- `alchemy dev --stage <name>` or `ALCHEMY_STAGE=<name>`; the dev command sets `ALCHEMY_DEV=true` on its child, so inline delivery and the local simulators follow the command, not the stage name.
- The Website's dev port comes from `WEBSITE_PORT`, read through Alchemy's `.env` loading; a value in the process environment wins over `.env`, so Playwright's `webServer.env` can set it.
- There is no ready signal; Playwright's URL poll is the readiness check. A failed apply keeps the process alive serving healthy resources, so the poll can run to its timeout on a broken build; `timeout` must be generous (the `dev:start` script uses 180 s) and the log is where the failure shows.
- `.alchemy/local/email` is shared by all stages on a machine, and nothing reads it when delivery is inline.
- State: `alchemy.run.ts` uses `Cloudflare.state()`, the remote store, for every stage. The Vitest harness defaults to `Alchemy.localState()` for its `test_$USER` stage. An e2e stage can do the same: pick the state layer in `alchemy.run.ts` from an environment variable (`ALCHEMY_STATE=local`), so e2e stages leave no remote rows and need no state-store credentials. **[spike]** Whether `Cloudflare.providers()` still wants an account token for an all-local stack is the open question tier 2 left; the dev log shows the token being read.

Stage name `e2e_$USER` locally (Alchemy's own pattern, so two people on one machine or account do not collide) and `e2e_ci_<run id>` in CI. Port: `WEBSITE_PORT + 100` by convention (worktrees take `WEBSITE_PORT + NN` with small `NN`), derived in `playwright.config.ts` from `.env`, never written to `.env`. `scripts/worktree.ts` needs no change. The spike showed the stack boots and answers in a few seconds once Vite and workerd are warm; a cold start on a fresh stage (D1 create, migrations, seed, Better Auth migration, workerd) is tens of seconds and happens once, since the stage persists under `.alchemy/`. For a fast local loop a person can keep the e2e server running (`vp run dev:e2e`, a script that sets the stage and port), and Playwright adopts it through `reuseExistingServer` outside CI; Playwright only stops servers it started.

```ts
// playwright.config.ts (sketch)
process.loadEnvFile(".env");
const port = Number(process.env.WEBSITE_PORT) + 100;
const baseURL = process.env.PLAYWRIGHT_TEST_BASE_URL ?? `http://localhost:${port}`;
export default defineConfig({
  use: { baseURL, trace: "on-first-retry" },
  webServer: process.env.PLAYWRIGHT_TEST_BASE_URL
    ? undefined
    : {
        command: "vp exec alchemy dev",
        env: {
          ALCHEMY_STAGE: `e2e_${process.env.USER}`,
          ALCHEMY_STATE: "local",
          WEBSITE_PORT: String(port),
        },
        url: `${baseURL}/`,
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
        gracefulShutdown: { signal: "SIGTERM", timeout: 20_000 },
      },
});
```

`use.baseURL` must be set explicitly: with `url` (not the deprecated `port`) Playwright does not derive it (`packages/playwright/src/plugins/webServerPlugin.ts`). With a base URL given from outside, the same specs run against a deployed stage and no server is started (Playwright's own "On deployment" recipe in `ci.md`).

Rejected: adopting the `dev` stage (couples the suite to a person's data and server; the shortcut that would have to be unwound first); `globalSetup` deploying through `alchemy/Test/Core` (undocumented outside the harness, runs without fixtures, traces or retries, and Playwright itself says to prefer project dependencies); the `webServer` pointing at `vp run dev` (that script pipes through `s6-log` and is the person's server by definition).

### 7.3 The test-control surface

The seam that makes items 1, 3 and 4 possible is a second `RpcGroup` in `src/api/`, say `TestControlRpcs`, served by the Backend only off production:

| Procedure          | Purpose                                                                                                                                                                                                     |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ResetData`        | Restore the stage's D1 to the seed: delete Better Auth's users, sessions, verifications; reload the members from the seed. Run once per suite (a `setup` project) and by any test that wants a clean slate. |
| `CreateMember`     | Insert a member with an email and role, so a test can own its data (`e2e-${testId}@test.local`) and a worker can own its account (`parallelIndex`).                                                         |
| `IssueMagicLink`   | Call Better Auth's `signInMagicLink` for an email and return the link, whatever the delivery mode. This is `RequestMagicLink` without the inline condition, the limiter or the non-member silence.          |
| `SentMail` (later) | If a test ever needs to assert on mail content, the Backend records sent mail under test control; the `.eml` directory is a worse API than a procedure.                                                     |

Gating: the group is mounted when the stage is not `production` and a shared secret header matches (`E2E_TOKEN`, an `Alchemy.Random` bound to the Backend and read by the test runner from stack outputs or state); under dev the token can be the fixed value `dev`. A production stack never mounts it, so the procedures cannot exist there. Baton's `/api/dev/seed` and demo-mode link store are the precedent; this version is typed, lives in the API definition like every other procedure, and is reachable with the same Effect RPC client the fixture already holds. It also gives tier 2 (`test/integ`) a cleaner way to reset than redeploying.

This is the first-principles reason the Effect-at-the-edge fixture ([§4](#4-where-effect-fits)) is not optional: the suite's control of its own data and sessions is an RPC conversation with the Backend, and it should speak the Backend's schemas.

**Recommendation:** a dedicated `e2e_$USER` stage on `WEBSITE_PORT + 100`, started by Playwright's `webServer` and adopted when already running; local state for e2e stages; the test-control group with `ResetData`, `CreateMember` and `IssueMagicLink` from the start, since the auth setup needs `IssueMagicLink` on day one and `ResetData` is what makes a run repeatable.

## 8. Authentication in tests

Playwright's `auth.md` recommends a `setup` project that signs in once and saves `storageState`, with browser projects declaring `dependencies: ["setup"]`; one account per role, files under `playwright/.auth/` and gitignored; per-worker accounts when tests modify server-side state. "Authenticate with API request" is the variant that skips the UI.

Terms, since the earlier draft used them without saying what they are:

- A **fixture** is Playwright's dependency injection. `test.extend({ name: async ({ otherFixtures }, use) => { ...setup; await use(value); ...teardown } })` declares a named value; a test that lists `name` in its first argument gets it, built on demand and torn down after the test (or after the worker, with `scope: "worker"`). `page`, `context` and `request` are built-in fixtures of the same kind.
- The **Backend fixture** is the worker-scoped fixture from [§4](#4-where-effect-fits): it builds a `ManagedRuntime` holding the Effect RPC client, exposes a function that runs an Effect against it, and disposes the runtime when the worker ends. Every test and setup that talks to the Backend goes through it.

The setup project, with the test-control surface in place:

1. `ResetData`, so the stage starts from the seed.
2. For each role, `IssueMagicLink({ email })` through the Backend fixture; then, in the browser, `page.goto(link)` (the verify redirect must be followed by the browser so the cookie lands on the right origin and `storageState` can capture it), wait for the role's home, `context.storageState({ path: "playwright/.auth/<role>.json" })`.

Specs then start signed in with `test.use({ storageState })` per role, one file or `describe` per role. A test that mutates data takes its own member (`CreateMember` with a `testId`-derived email, then `IssueMagicLink`), which keeps parallel workers apart; Playwright's "moderate" recipe (one account per `parallelIndex`, state file reused across runs) is the same idea one level up and can be adopted when the number of mutating tests justifies it.

The sign-in screen itself keeps one dedicated test that goes through the UI (fill, send, `Check your email`, `Open link`, landing page by role); it is the only test that must run against a dev-mode stack, because `Open link` exists only under inline delivery. Mark it with a tag (`@dev-only`) so a run against a deployed stage can skip it (`--grep-invert`). Rate limiting is skipped under inline delivery; against a deployed stage `IssueMagicLink` bypasses the limiter by design. Playwright's per-test `BrowserContext` means a cookie never leaks between tests; `storageState` is the only thing shared, and it is read-only.

**Recommendation:** as above. The Backend fixture and `IssueMagicLink` come first; nothing in the suite signs in through the UI except the test of the sign-in screen.

## 9. CI, from first principles

There is no CI in this repo yet. The decisions above were made so that adding one changes configuration, not tests.

What a run needs: Node and pnpm, the Playwright browser (`vp exec playwright install chromium --with-deps`), and a target. Three targets, in the order they become available:

| Target                          | How                                                                                                                                                                                                                          | What it proves                                                                                           | Needs                                                                                                                                                           |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Dev-mode stack in the runner | The same `webServer` block, `reuseExistingServer: !CI` so CI always starts fresh, stage `e2e_ci_${GITHUB_RUN_ID}`, local state. Linux runner, as Playwright recommends.                                                      | The app as `alchemy dev` runs it: both Workers, local D1, inline delivery. Identical to a local run.     | Cloudflare account variables if `Cloudflare.providers()` demands them for an all-local stack **[spike]**; otherwise nothing.                                    |
| 2. Pull-request preview stage   | Alchemy's CI guide: `alchemy deploy --stage pr-<n> --yes` on `pull_request`, `destroy` on close, a `GitHub.Comment` with the URL. Playwright runs with `PLAYWRIGHT_TEST_BASE_URL` set to the preview URL and no `webServer`. | Real Cloudflare: D1, Email Send, the rate limit, the service binding, `AUTH_ORIGIN` wiring, cold starts. | Scoped Cloudflare token as a repo secret (the guide provisions it as code), the remote state store, the test-control token for that stage, `@dev-only` skipped. |
| 3. Staging smoke after merge    | The deploy workflow's `staging` stage, then a `--grep @smoke` run.                                                                                                                                                           | The deployed site still signs in and renders.                                                            | Same as 2.                                                                                                                                                      |

Target 1 is what the suite is written against and should be the first workflow: `pnpm install --frozen-lockfile`, `vp run typecheck`, `vp run test`, `vp exec playwright install chromium --with-deps`, `vp run test:e2e`, upload `playwright/report` with `if: ${{ !cancelled() }}` (`ci.md`). `workers: 1`, `retries: 2`, `forbidOnly`, a `globalTimeout` under the job's `timeout-minutes`, `reporter: "html"` or `"blob"` when sharding is ever needed. The same workflow later gains target 2 as a second job, because the specs take their target from the environment.

Two things to keep true for target 2 to work without rewriting tests: no spec reads inline links from the UI except the tagged sign-in test; and the test-control surface, not the dev-mode inline path, is how a session is minted. Both are already the design in [§7.3](#73-the-test-control-surface) and [§8](#8-authentication-in-tests). Preview URLs are public (`cloudflare/compute/previews.mdx`); the test-control token is what keeps `IssueMagicLink` from being a sign-in bypass there, and Cloudflare Access on previews is the Alchemy-documented protection if the previews themselves must be private.

**Recommendation:** write the suite for target 1 and add that workflow with the first spec; plan target 2 with the deploy workflow when PR previews are wanted; treat 3 as a `--grep` of 2.

## 10. Configuration sketch

| Path                             | Role                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `playwright.config.ts`           | `testDir: "e2e"`, `fullyParallel: true`, `forbidOnly: !!CI`, `retries: CI ? 2 : 0`, `workers: CI ? 1 : undefined`, `reporter: "list"` (`html` on CI), `use: { baseURL, trace: "on-first-retry" }`, projects `setup` (`*.setup.ts`) and `chromium` (`Desktop Chrome`, `dependencies: ["setup"]`), `webServer` per [§7.2](#72-a-dedicated-e2e-stage), `outputDir: "playwright/test-results"`. |
| `alchemy.run.ts`                 | `state` chosen by `ALCHEMY_STATE` (`local` → `Alchemy.localState()`, else `Cloudflare.state()`); the test-control token binding and the stage gate for `TestControlRpcs`.                                                                                                                                                                                                                   |
| `src/api/test-control.ts`        | `TestControlRpcs`: `ResetData`, `CreateMember`, `IssueMagicLink`, with their schemas and the token middleware.                                                                                                                                                                                                                                                                              |
| `src/backend/test-control.ts`    | The handlers; mounted by `worker.ts` off production.                                                                                                                                                                                                                                                                                                                                        |
| `src/routes/__root.tsx`          | `data-hydrated` on `<body>` ([§6](#6-hydration-the-trap-the-spike-found)).                                                                                                                                                                                                                                                                                                                  |
| `e2e/fixtures.ts`                | `test`/`expect` for every spec: the Backend fixture, flows as fixtures, `goto` with the hydration wait.                                                                                                                                                                                                                                                                                     |
| `e2e/sign-in.ts`, `e2e/shell.ts` | Flow functions and locator records per screen ([§5](#5-page-objects-classes-objects-or-functions)).                                                                                                                                                                                                                                                                                         |
| `e2e/auth.setup.ts`              | `ResetData`; `IssueMagicLink` for `a@a.com` and `m1@m.com`; writes `playwright/.auth/{admin,member}.json`.                                                                                                                                                                                                                                                                                  |
| `e2e/*.spec.ts`                  | `sign-in.spec.ts` (the UI flow, `@dev-only`), `members.spec.ts` (admin table, `toMatchAriaSnapshot`), `shell.spec.ts` (sign out, `requireRole` redirects).                                                                                                                                                                                                                                  |
| `package.json`                   | `test:e2e`: `vp exec playwright test`; `test:e2e:ui`; `dev:e2e`: the e2e stage in a terminal for a fast local loop. `vp run test` stays unit-only; e2e is explicit.                                                                                                                                                                                                                         |
| `tsconfig.json`                  | `include` adds `e2e`, so `vp run typecheck` checks what Playwright's Babel transform does not.                                                                                                                                                                                                                                                                                              |
| `.gitignore`                     | `playwright/` (auth state, results, report).                                                                                                                                                                                                                                                                                                                                                |
| `.github/workflows/e2e.yml`      | Target 1 of [§9](#9-ci-from-first-principles), when CI is set up.                                                                                                                                                                                                                                                                                                                           |

Things to hold to, from `best-practices-js.md` and `locators.md`: role locators with names first, `getByLabel` for inputs, test ids never (none needed so far); web-first assertions only; no `waitForTimeout`; `toMatchAriaSnapshot` for structure, explicit assertions for logic. Playwright's Babel transform supports `paths` and `.ts` import specifiers for our `allowImportingTsExtensions` style **[spike]**; the spike imported nothing local.

### 10.1 Component tests: a temperature check, not a decision

Two candidates exist, both running components in a real Chromium through Playwright:

- **Vitest browser mode** (`@vitest/browser-playwright`, already installed; `vite-plus/test/browser*`). Test files run inside the browser under the same `vp test` runner as the unit tier, with the project's Vite config, so Astryx CSS and Effect atoms load as in the app. Locators are Playwright-style (`page.getByRole`). Effect tests work unchanged. One runner, no extra page to own.
- **Playwright's `mount` fixture** (new in 1.64, `test-components-js.md`). Tests run in Node against a "story gallery" page that our own dev server serves; stories are `*.story.tsx` files we write; Playwright's traces, fixtures and reporters apply. The gallery is application code generated by Playwright's agent skill. The previous `@playwright/experimental-ct-*` packages were removed in this release, so this is a fresh design.

Temperature: Vitest browser mode fits this repo better. It sits inside Vite+ and the Effect test idioms already in use, needs no gallery page served by `alchemy dev`, and keeps the Playwright runner for end-to-end tests only. Playwright `mount` becomes interesting if component tests want the e2e toolchain's traces and fixtures, or if stories are wanted as a design artefact. Decide with the first component test, with its own short research.

### 10.2 Playwright test agents, for the record

`vp exec playwright init-agents --loop=claude` writes agent definitions into the repo for a coding agent (`--loop` names the host: `vscode`, `claude`, `codex` or `opencode`; for Claude Code they land under `.claude/agents/`) plus the Playwright MCP server configuration those agents use to drive a browser. Three agents: a **planner** that explores the running app through the browser and writes a Markdown test plan under `specs/`; a **generator** that turns a plan into spec files under `tests/`, checking each locator against the live page; a **healer** that re-runs failing tests, patches locators or waits, and skips a test it believes covers broken functionality. They expect a `seed.spec.ts` importing `test` from `./fixtures`, which the layout above satisfies. The files are regenerated on each Playwright upgrade. Not now: the suite is small enough to write by hand, and T3 Code's own preview tools already give an agent a browser.

## 11. Questions with recommendations

Round 1 (Plannotator, 2026-10-11): runner, Effect at the edges, functions and fixtures, the hydration marker, the three-spec first round, keeping `@vitest/browser-playwright`, and "not now" for the test agents were accepted. Data isolation and CI were sent back for a first-principles treatment, which is now [§7](#7-the-server-under-test-from-first-principles) to [§9](#9-ci-from-first-principles). Round 2 accepted every recommendation that treatment raised; the blocks below record the decisions.

:::question
Q1. Runner: Playwright Test, or keep everything on Vitest with the Playwright library and `it.live`?

- [x] Playwright Test under `e2e/`, run as `vp exec playwright test`
- [ ] Vitest project with the `playwright` library and `@effect/vitest`
:::

:::question
Q2. How much Effect: none, edges only, or Effect around `page`?

- [x] Edges only: a worker fixture holding a `ManagedRuntime` and the RPC client
- [ ] None: plain Playwright until a clear need appears
- [ ] Effect around `page` as well: services, `Effect.gen` test bodies
:::

:::question
Q3. Server and data: a dedicated `e2e_$USER` stage on `WEBSITE_PORT + 100`, started by Playwright and adopted when already running, with local state?

A dedicated stage gives the suite its own server and database from day one; the `dev` stage shortcut is what would have to be unwound first ([§7.2](#72-a-dedicated-e2e-stage)).

- [x] Yes: dedicated stage, own port, local state, `reuseExistingServer: !CI`
- [ ] Dedicated stage, but keep `Cloudflare.state()` for it too
- [ ] The `dev` stage for now
:::

:::question
Q4. Test-control surface: add `TestControlRpcs` (`ResetData`, `CreateMember`, `IssueMagicLink`) to the Backend, mounted off production behind a token?

This is what makes a run repeatable, lets tests own their data in parallel, and mints sessions without mail on every target, deployed stages included ([§7.3](#73-the-test-control-surface)).

- [x] Yes, all three procedures from the start
- [ ] `IssueMagicLink` and `ResetData` now; `CreateMember` with the first mutating test
- [ ] No procedures; rely on inline delivery and the seed
:::

:::question
Q5. Gating the test-control group: stage not `production` plus a token header (`E2E_TOKEN` from an `Alchemy.Random` binding, fixed `dev` under `alchemy dev`)?

- [x] Stage gate plus token
- [ ] Stage gate only (any non-production stage, no token)
- [ ] Dev mode only (`ALCHEMY_DEV`); deployed stages never get it
:::

:::question
Q6. CI order: target 1 (dev-mode stack in the runner) as the first workflow, added with the first spec; target 2 (PR preview stages) with the deploy workflow later?

- [x] Yes, 1 now, 2 with PR previews
- [ ] Both workflows in the first round
- [ ] No workflow until PR previews exist
:::

:::question
Q7. `@vitest/browser-playwright` and `jsdom`: keep for component tests?

Temperature check in [§10.1](#101-component-tests-a-temperature-check-not-a-decision): Vitest browser mode fits this repo better than Playwright's new `mount`; decide with the first component test.

- [x] Keep, unused; decide with the first component test
- [ ] Drop both now
:::

:::question
Q8. Auth setup: `IssueMagicLink` through the Backend fixture, the browser follows the link, `storageState` per role; only the sign-in screen's own test goes through the UI?

- [x] Yes, as in §8
- [ ] UI sign-in in the setup project
:::

:::question
Q9. Scope of the first round: the three spec files plus the setup, the hydration marker, the test-control group and the `e2e` stage wiring?

- [x] Yes
- [ ] Specs and stage only; test-control group later
:::

:::question
Q10. Playwright test agents (`init-agents --loop=claude`)?

- [x] Not now; revisit when the app has more screens
- [ ] Set up now
:::
