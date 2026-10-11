# Plan: Playwright end-to-end tests on a dedicated stage, with a test-control surface

Date: 2026-10-11.
Status: approved design, not implemented. Every decision below was accepted in Plannotator on 2026-10-11; do not reopen them. Record anything that differs from this plan in [§9](#9-deviations-and-issues).
Research: [playwright-e2e-research.md](./playwright-e2e-research.md) (the why; this file is the what). Vocabulary: [glossary](./glossary.md).
Versions: Playwright `1.64.0` (installed; `playwright/test` is the runner), Vite+ `1.1.0`, Effect `4.0.1`, Alchemy `2.0.0-beta.81`, TypeScript `7.0.2`. Do not add or bump dependencies; `@playwright/test` is not needed.

## 1. Outcome

`vp run test:e2e` starts (or adopts) an `alchemy dev` stack on a dedicated `e2e_$USER` stage and port, resets its data, signs in once per role through a test-control procedure, and runs three Chromium specs against the Website: the sign-in screen, the admin members table, and the shells (sign out, role redirects). `vp run dev`, `vp run test` and the deploys behave exactly as before.

## 2. Rules the implementer must follow

- Read `AGENTS.md` first. In particular: Effect Schema for all validation, `Match` for tag dispatch, `Schema.TaggedError` for errors, `Effect.fn("name")` for reusable effects, JSDoc on declarations with the rule stated once, no `//` above declarations, no references to this plan or the research in code comments.
- Run every tool through `vp`: `vp exec playwright ...`, `vp exec alchemy ...`, `vp run <script>`. Never `npm`, `npx`, `pnpm exec`.
- Do not commit. Do not create branches. Do not touch `.env` (it holds the checkout's port and is untracked).
- Playwright idioms (`refs/playwright/docs/src/best-practices-js.md`, `locators.md`): role locators with accessible names, `getByLabel` for inputs, no test ids, web-first assertions only (`await expect(locator).toBeVisible()`, never `expect(await locator.isVisible())`), no `waitForTimeout`, no `networkidle`.
- Effect in the e2e code only at the edges: one worker-scoped fixture holding a `ManagedRuntime` ([§5.2](#52-e2efixturests)). Never wrap `page`, `expect` or locators in Effect.
- No classes in `e2e/`. Functions over `Page`, records of locators, fixtures.
- Steps are ordered so each leaves the repo green: `vp check`, `vp run typecheck`, `vp run test` pass after every step.

## 3. The pieces, in dependency order

| Step | Piece                                                                      | Files                                                                     |
| ---- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 1    | Hydration marker                                                           | `src/routes/__root.tsx`                                                   |
| 2    | Stack: state by environment, the e2e token binding, the production guard   | `alchemy.run.ts`                                                          |
| 3    | Test-control API definition                                                | `src/api/test-control.ts`                                                 |
| 4    | Backend: link capture, `Members.create`, test-control handlers, dispatcher | `src/backend/auth.ts`, `members.ts`, `test-control.ts`, `worker.ts`       |
| 5    | Website proxy route for test control                                       | `src/routes/api.test-control.ts`                                          |
| 6    | Unit tests for the test-control handlers                                   | `src/backend/test-control.test.ts`                                        |
| 7    | Playwright config, scripts, ignores, tsconfig                              | `playwright.config.ts`, `package.json`, `.gitignore`, `tsconfig.json`     |
| 8    | Fixtures, flows, setup, specs                                              | `e2e/fixtures.ts`, `e2e/screens.ts`, `e2e/auth.setup.ts`, `e2e/*.spec.ts` |
| 9    | README                                                                     | `README.md`                                                               |

## 4. Steps

### Step 1: hydration marker

`src/routes/__root.tsx`, in `RootDocument`: `const hydrated = useHydrated()` (exported by `@tanstack/react-router`; see `refs/tan-router/packages/react-router/src/ClientOnly.tsx`), and render `<body data-hydrated={hydrated ? "" : undefined}>`. The hook returns `false` on the server and on the first client render, `true` afterwards, so the server markup and the hydration render agree. Add a JSDoc line to `RootDocument`'s existing comment: the attribute marks that React has attached handlers; browser tests wait for it after a full page load, because a click before then is lost.

Verify: `vp run dev:start`, load `/sign-in`, confirm `document.body.dataset.hydrated === ""` in the console after load and that the server HTML (`curl`) has no such attribute.

### Step 2: stack

`alchemy.run.ts`:

1. **State by environment.** `state: process.env.ALCHEMY_STATE === "local" ? Alchemy.localState() : Cloudflare.state()`. Keep this a plain expression at module scope; `Alchemy.localState` is already used by `test/integ/stack.ts`. JSDoc on the stack: e2e stages keep their state under `.alchemy/` like the test harness does, so they need no state-store credentials and leave no remote rows.
2. **Test-control token.** In the stack body, after the `AuthOrigin` binding:
   ```ts
   const e2eToken = yield * Config.option(Config.String("E2E_TOKEN"));
   if (Option.isSome(e2eToken)) {
     const stage = yield * Alchemy.Stage;
     if (stage === "production")
       return yield * Effect.die(new Error("E2E_TOKEN is set on the production stage"));
     yield * backend.bind("TestControl", { env: { E2E_TOKEN: e2eToken.value } });
   }
   ```
   The token is supplied by whoever runs the tests (Playwright's `webServer.env`, later CI); the stack never generates or stores it. With no `E2E_TOKEN` in the environment (every `vp run dev` and every deploy today) nothing is bound and the Backend serves no test control. `Alchemy.Stage` is a `Context.Service<Stage, string>` (`refs/alchemy/packages/alchemy/src/Stage.ts`); if it is not in the stack body's context, use `Effect.serviceOption(Alchemy.Stage)` as `src/backend/resources.ts` does and treat `None` as not production.

Verify: `vp run dev:status` healthy after a restart, dev log shows no `TestControl` binding. `E2E_TOKEN=x ALCHEMY_STAGE=production vp exec alchemy plan` (do not deploy) dies with the message.

### Step 3: test-control API definition

`src/api/test-control.ts`, same style as `src/api/backend.ts`:

```ts
export const E2eEmail = Email.check(
  Schema.isPattern(/@e2e\.test$/u, { message: "Test members use an @e2e.test address." }),
);
export class TestControlUnauthorized extends Schema.TaggedError<TestControlUnauthorized>()(
  "TestControlUnauthorized",
  {},
) {}
export class TestControlAuth extends RpcMiddleware.Service<TestControlAuth>()("TestControlAuth", {
  error: TestControlUnauthorized,
}) {}

export const TestControlRpcs = RpcGroup.make(
  Rpc.make("ResetData", { success: Schema.Void }),
  Rpc.make("CreateMember", { payload: { email: E2eEmail, role: Role }, success: Member }),
  Rpc.make("IssueMagicLink", {
    payload: { email: Email, returnTo: Schema.optional(ReturnPath) },
    success: Schema.Struct({ link: Schema.String }),
  }),
).middleware(TestControlAuth);
```

JSDoc on the group: procedures for a test runner, served only when the Backend has the `E2E_TOKEN` binding, never on production; `ResetData` removes every Better Auth row and every `@e2e.test` member and leaves the seed members; `IssueMagicLink` is `RequestMagicLink` without the delivery condition, the limiter or the non-member silence, and fails as a defect for a non-member.

### Step 4: Backend

**`src/backend/auth.ts`.** `deliver` records the link in `pendingLinks` in both branches (inline and mailed), so a test can take it whatever the delivery mode. Rename `takeInlineLink` to `takeLink`; `RequestMagicLink` in `handlers.ts` still returns it only when `inline` is true, so the public contract is unchanged. Update the JSDoc on `Auth`: the last link per address is kept until taken, so a test-control caller can read it after a mailed delivery.

**`src/backend/members.ts`.** Add `create(email, role)`: `INSERT INTO member (email, role) VALUES (...)` then `findByEmail`, returning the `Member`; `Effect.orDie` like the others. Add a matching entry to `layerTest` (append to a local copy of the list is enough; `layerTest` takes a fixed list today, so turn it into a `Ref` only if a test needs to observe the insert).

**`src/backend/test-control.ts`.**

- `TestControlToken`: a `Context.Service<TestControlToken, string>` with `layer = Layer.effect(TestControlToken, Config.String("E2E_TOKEN"))`. It fails to build when the binding is absent; `worker.ts` uses that ([below](#srcbackendworkerts)).
- `TestControlAuthLive`: `Layer.effect(TestControlAuth, ...)` that reads `headers["x-e2e-token"]`, compares with the service value, and fails `TestControlUnauthorized` otherwise. Mirror `CurrentUserLive` in `middleware.ts` for the shape.
- `TestControlHandlers = TestControlRpcs.toLayer(...)`:
  - `ResetData`: through a `SQL.D1` client on `AuthDb` (as `members.ts` builds one): `DELETE FROM session; DELETE FROM account; DELETE FROM verification; DELETE FROM user; DELETE FROM member WHERE email LIKE '%@e2e.test'`. Check Better Auth's table names in `refs/alchemy/packages/better-auth` or the migration Action's output in `.alchemy/local/d1` before writing them; record the names in [§9](#9-deviations-and-issues).
  - `CreateMember`: `members.create`.
  - `IssueMagicLink`: `members.findByEmail`, die if `None`; `auth.api.signInMagicLink({ body: { email, callbackURL: returnTo ?? "/app", errorCallbackURL: "/sign-in" }, headers })` as `RequestMagicLink` does; then `auth.takeLink(email)`, die if `None`.

**`src/backend/worker.ts`.** Build a second RPC server for `TestControlRpcs` with `TestControlHandlers`, `TestControlAuthLive`, `RpcSerialization.layerNdjson`, provided with the same `services` context plus `TestControlToken.layer`. Build it as an `Option`: `Layer.build`/`Effect.option` around the token config, or simply `yield* Config.option(Config.String("E2E_TOKEN"))` at init and construct the server only when `Some`. In `fetch`, before the RPC branch: `if (pathname === "/api/test-control") return Option.isSome(testControl) ? yield* yield* testControl.value : yield* HttpServerResponse.empty({ status: 404 })` (use the existing `HttpServerResponse` helpers; check the exact constructor in `effect/http/HttpServerResponse`). JSDoc on the Worker's comment block: the test-control server exists only with the `E2E_TOKEN` binding, which the stack sets off production.

Verify: `vp run test` still green (tier 1 uses `Auth` through `RpcTest`; the rename touches `handlers.ts` only). `vp run dev:start`; `curl -X POST http://localhost:$(pnpm port)/api/test-control` is 404 once step 5 is in.

### Step 5: Website proxy route

`src/routes/api.test-control.ts`: a copy of the shape of `src/routes/api.rpc.ts` (`POST` forwards to `env.BACKEND.fetch` after the same `rejectRequest`; `GET` is 405). Move `rejectRequest`, `MAX_RPC_BODY_BYTES` and the schemas from `api.rpc.ts` into a shared module (`src/rpc-proxy.ts`) so the rule lives once; both routes import it. JSDoc on the new route: forwards test-control RPC; the Backend answers 404 unless the stage has the token binding, so the route exposes nothing on its own.

### Step 6: unit tests for the handlers

`src/backend/test-control.test.ts`, on `@effect/vitest` with `it.live`, the pattern of `src/backend/auth.test.ts`: `RpcTest.makeClient(TestControlRpcs)` with `TestControlHandlers`, `TestControlAuthLive`, `Layer.succeed(TestControlToken, "t")`, `Auth.layerWith({ secret })` on `Memory()`, `Members.layerTest`, `Mailer.layerTest`, and a `ConfigProvider` with `ALCHEMY_DEV: "false"` so the mailed branch is exercised. Tests:

1. A call without the header fails `TestControlUnauthorized`; with a wrong token too.
2. `IssueMagicLink` for a seeded member returns a link whose pathname is `/api/auth/magic-link/verify`, and the `SentMail` ref has one message to that address (the link was both mailed and captured).
3. `IssueMagicLink` for a non-member dies.
4. `CreateMember` returns the member with the given role; `ResetData` is covered by tier 3 (it needs D1); add a `test.todo` naming that.

### Step 7: Playwright config, scripts, ignores, tsconfig

`playwright.config.ts` at the root:

```ts
import { defineConfig, devices } from "playwright/test";
import process from "node:process";

process.loadEnvFile(".env");
const websitePort = Number(process.env.WEBSITE_PORT);
if (!Number.isInteger(websitePort))
  throw new Error("WEBSITE_PORT is not set; copy .env.example to .env");
/** The e2e stage's port. Worktrees take WEBSITE_PORT + NN with small NN, so +100 stays clear. */
const port = websitePort + 100;
const stage = `e2e_${process.env.USER ?? "unknown"}`;
const baseURL = process.env.PLAYWRIGHT_TEST_BASE_URL ?? `http://localhost:${port}`;
/** The runner supplies the token; the stack binds it to the Backend. A deployed target sets it in the environment. */
export const e2eToken = process.env.E2E_TOKEN ?? "e2e";

export default defineConfig({
  testDir: "e2e",
  outputDir: "playwright/test-results",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [["html", { outputFolder: "playwright/report" }]] : "list",
  use: { baseURL, trace: "on-first-retry" },
  projects: [
    { name: "setup", testMatch: /.*\.setup\.ts/ },
    { name: "chromium", use: { ...devices["Desktop Chrome"] }, dependencies: ["setup"] },
  ],
  webServer: process.env.PLAYWRIGHT_TEST_BASE_URL
    ? undefined
    : {
        command: "vp exec alchemy dev",
        env: {
          ALCHEMY_STAGE: stage,
          ALCHEMY_STATE: "local",
          WEBSITE_PORT: String(port),
          E2E_TOKEN: e2eToken,
        },
        url: `${baseURL}/`,
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
        gracefulShutdown: { signal: "SIGTERM", timeout: 20_000 },
      },
});
```

Notes: `alchemy dev` reads `.env` itself and the process environment wins over it, so `WEBSITE_PORT` in `env` overrides the checkout's port for this server only. `use.baseURL` is set explicitly because Playwright derives it only from the deprecated `port` field. The stack's `Website` has `strictPort: true`, so a collision fails loudly. `.env` is not a TypeScript import; `process.loadEnvFile` is Node's built-in (Baton's config does the same).

`package.json` scripts: `"test:e2e": "vp exec playwright test"`, `"test:e2e:ui": "vp exec playwright test --ui"`. Leave `test` unit-only as the speed research decided.

`.gitignore`: add `playwright/`.

`tsconfig.json`: add `"e2e"` and `"playwright.config.ts"` to `include`. Playwright compiles tests with Babel and does not type-check; `vp run typecheck` does.

`vite.config.ts`: nothing. `vp check` lints `e2e/`; keep it that way.

Verify: `vp exec playwright test --list` lists the setup and specs once step 8 exists; `vp run typecheck` and `vp check` pass.

### Step 8: fixtures, flows, setup, specs

#### `e2e/fixtures.ts`

```ts
import { test as base, expect } from "playwright/test";
import type { Page } from "playwright/test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { TestControlRpcs } from "../src/api/test-control.ts";
import { e2eToken } from "../playwright.config.ts";

type Run = <A, E>(effect: Effect.Effect<A, E, RpcClient.Protocol>) => Promise<A>;

/** The test-control client, through the Website's proxy route, as the browser would reach the Backend. */
const protocol = (baseURL: string) =>
  RpcClient.layerProtocolHttp({ url: `${baseURL}/api/test-control` }).pipe(
    Layer.provide(RpcSerialization.layerNdjson),
    Layer.provide(FetchHttpClient.layer),
  );

export const test = base.extend<{ goto: (path: string) => Promise<void> }, { backend: Run }>({
  backend: [
    async ({ baseURL }, use) => {
      const runtime = ManagedRuntime.make(protocol(baseURL!));
      const run: Run = (effect) =>
        runtime.runPromiseExit(effect).then((exit) => {
          if (exit._tag === "Success") return exit.value;
          throw new Error(Cause.pretty(exit.cause));
        });
      await use(run);
      await runtime.dispose();
    },
    { scope: "worker" },
  ],
  /** Navigates and waits for hydration; a click before the marker is lost. */
  goto: async ({ page }, use) => {
    await use(async (path) => {
      await page.goto(path);
      await page.locator("body[data-hydrated]").waitFor();
    });
  },
});
export { expect };

/** One call against the test-control group with the token header. */
export const control = <A, E>(
  f: (client: RpcClient.RpcClient<typeof TestControlRpcs>) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const client = yield* RpcClient.make(TestControlRpcs);
    return yield* f(client).pipe(RpcClient.withHeaders({ "x-e2e-token": e2eToken }));
  }).pipe(Effect.scoped);
```

Check the exact names against `refs/effect/packages/effect/src/rpc/RpcClient.ts` (`RpcClient.RpcClient<Rpcs>` type, `withHeaders`, `Protocol`) and `effect/Cause` (`pretty` or `prettyErrors`); `RpcClient.make` requires `Scope`, hence `Effect.scoped`. Importing `e2eToken` from the config is fine: the config module has no side effects beyond reading `.env`.

Also export `awaitHydration(page)` for the one place a navigation is not through `goto`: following the magic link.

#### `e2e/screens.ts`

Functions and locator records, no classes:

```ts
export const signIn = (page: Page) => ({
  email: page.getByLabel("Email"),
  send: page.getByRole("button", { name: "Send link" }),
  checkEmail: page.getByRole("heading", { name: "Check your email" }),
  openLink: page.getByRole("link", { name: "Open link" }),
});
export const shell = (page: Page) => ({
  signOut: page.getByRole("button", { name: "Sign out" }),
  members: page.getByRole("link", { name: "Members" }),
});
export const requestMagicLink = async (page: Page, email: string) => { ... fill, click, expect checkEmail visible };
export const followMagicLink = async (page: Page, link: string) => { await page.goto(link); await awaitHydration(page); };
```

#### `e2e/auth.setup.ts`

```ts
import { test as setup } from "./fixtures";
setup("reset data", async ({ backend }) => {
  await backend(control((c) => c.ResetData()));
});
for (const [role, email] of [
  ["admin", "a@a.com"],
  ["member", "m1@m.com"],
] as const)
  setup(`sign in ${role}`, async ({ backend, page }) => {
    const { link } = await backend(
      control((c) => c.IssueMagicLink({ email: Schema.decodeUnknownSync(EmailFromInput)(email) })),
    );
    await followMagicLink(page, link);
    await page.waitForURL(role === "admin" ? /\/admin$/ : /\/app$/);
    await page.context().storageState({ path: `playwright/.auth/${role}.json` });
  });
```

Make "reset data" run first: with `fullyParallel` the setup file's tests still run in order within one worker (tests in one file share a worker and run sequentially); if Playwright schedules them otherwise, `test.describe.configure({ mode: "serial" })` for the setup file is acceptable here and nowhere else.

#### Specs

- `e2e/sign-in.spec.ts`, no `storageState`: `goto("/sign-in")`, `requestMagicLink(page, "m1@m.com")`, click `openLink`, `waitForURL(/\/app$/)`, `expect(getByRole("heading", { name: "Member area" })).toBeVisible()`. Tag `{ tag: "@dev-only" }` (Playwright 1.64 test options; check `test-annotations-js.md` > Tag tests): it needs inline delivery.
- `e2e/members.spec.ts`, `test.use({ storageState: "playwright/.auth/admin.json" })`: `goto("/admin/members")`, `expect(page.getByRole("table")).toMatchAriaSnapshot(...)` with the three seed rows (omit the `Added` cells, which carry today's date: use partial matching or a regex `/\d{4}-\d{2}-\d{2}/`). A second test: `CreateMember` with `e2e-${test.info().testId}@e2e.test`, reload, expect its cell; it proves the surface and parallel-safe data.
- `e2e/shell.spec.ts`: as member, `goto("/admin")` lands on `/app` (`requireRole` sends the other role home); signed out (`test.use({ storageState: { cookies: [], origins: [] } })`), `goto("/app")` lands on `/sign-in?redirect=%2Fapp`; as admin, click `Sign out`, `waitForURL(/\/$/)`, expect `link "Sign in"`, and `context.cookies()` is empty.

Verify: `vp run test:e2e` green twice in a row (the second run adopts the running stage server and `ResetData` makes it repeatable). `vp run test:e2e -- --grep-invert @dev-only` green. `vp run dev:status` for the dev stage untouched.

### Step 9: README

Under "Validate": `vp run test:e2e` and what it does (own stage and port, resets its data, Chromium). Mention `playwright/` artefacts and `--ui`.

## 5. Credentials: what exists and what is needed

The research mentions two different "tokens"; neither is created by hand for this plan.

| Token                               | What it is                                                                                                                                         | Local run                                                                                                                                                                                                        | Later, CI                                                                                                                                                                                                    |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `E2E_TOKEN`                         | The shared secret that unlocks the test-control procedures on a stage. Plain string, chosen by the test runner, bound to the Backend by the stack. | Nothing to create: the Playwright config defaults it to `e2e` and passes it to `alchemy dev` through `webServer.env`.                                                                                            | A repository secret with a random value, set as `E2E_TOKEN` on both the deploy job (so the preview stage binds it) and the test job. Only when PR previews are built.                                        |
| Cloudflare account id and API token | What `alchemy dev` and `alchemy deploy` already use on this machine (the dev log reports "using environment variables"). Not in `.env`.            | Nothing to create: the e2e stage runs the same `alchemy dev`. With `ALCHEMY_STATE=local` the remote state store is not used. **[spike]** whether an all-local stack still reads the token; it is present anyway. | A scoped token as a repository secret. Alchemy's CI guide (`refs/alchemy/website/src/content/docs/environments/ci.mdx`) provisions it as code with a `stacks/github.ts` stack. Only with the first workflow. |

So: nothing manual now. The one unknown is the `[spike]` above; the implementer runs the e2e stage with the Cloudflare variables removed from the environment once and records the answer in [§9](#9-deviations-and-issues), because it decides whether the first CI workflow needs a Cloudflare secret.

## 6. Verification checklist

1. `vp check`, `vp run typecheck`, `vp run test` (unit and integ) pass.
2. `vp run test:e2e` passes twice in a row; the second run reports the server as reused.
3. `vp run test:e2e -- --grep-invert @dev-only` passes.
4. `vp run dev:start` for the dev stage shows no `TestControl` binding in `logs/dev/current`, and `POST /api/test-control` on the dev port answers 404.
5. `vp run build` passes.
6. `git status` shows no `playwright/` or `test-results/` artefacts.

## 7. Out of scope

CI workflows (research §9), PR preview stages, the `SentMail` procedure, per-worker accounts, component tests, Playwright's test agents. Do not add them.

## 8. File plan

| Path                                                      | Change                                                                        |
| --------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `src/routes/__root.tsx`                                   | `data-hydrated` on `<body>` from `useHydrated`                                |
| `alchemy.run.ts`                                          | state by `ALCHEMY_STATE`; `E2E_TOKEN` binding off production                  |
| `src/api/test-control.ts`                                 | `TestControlRpcs`, `TestControlAuth`, `E2eEmail`, `TestControlUnauthorized`   |
| `src/backend/auth.ts`                                     | links recorded in both delivery branches; `takeInlineLink` becomes `takeLink` |
| `src/backend/handlers.ts`                                 | uses `takeLink`                                                               |
| `src/backend/members.ts`                                  | `create`                                                                      |
| `src/backend/test-control.ts`                             | `TestControlToken`, `TestControlAuthLive`, `TestControlHandlers`              |
| `src/backend/worker.ts`                                   | optional test-control RPC server on `/api/test-control`                       |
| `src/rpc-proxy.ts`                                        | `rejectRequest` and its schemas, shared by both proxy routes                  |
| `src/routes/api.rpc.ts`                                   | imports from `src/rpc-proxy.ts`                                               |
| `src/routes/api.test-control.ts`                          | forwards `POST /api/test-control`                                             |
| `src/backend/test-control.test.ts`                        | tier 1 tests of the handlers and the token middleware                         |
| `playwright.config.ts`                                    | per step 7                                                                    |
| `e2e/fixtures.ts`, `e2e/screens.ts`                       | fixtures, flows, locator records                                              |
| `e2e/auth.setup.ts`                                       | reset, sign in per role, `storageState`                                       |
| `e2e/sign-in.spec.ts`, `members.spec.ts`, `shell.spec.ts` | the three specs                                                               |
| `package.json`                                            | `test:e2e`, `test:e2e:ui`                                                     |
| `tsconfig.json`, `.gitignore`                             | `e2e`, `playwright.config.ts`; `playwright/`                                  |
| `README.md`                                               | the e2e command                                                               |

## 9. Deviations and issues

The implementer records here, as they happen. One bullet each, dated, with the step number. Say what the plan said, what was done instead, and why; or what broke and how it was resolved or left. Keep the plan text above unchanged so the two can be compared.

- 2026-10-11, step 4, Better Auth table names: `session`, `account`, `verification`, `user` (read from the schema `BetterAuthMigrate` created in the local D1 under `.alchemy/local/d1`; `session` and `account` reference `user` with `on delete cascade`). `ResetData` runs `DELETE FROM session`, `account`, `verification`, `"user"` (quoted), then `DELETE FROM member WHERE email LIKE '%@e2e.test'`.
- 2026-10-11, step 4: the plan had `TestControlHandlers` build a `SQL.D1` client on `AuthDb` itself. Done instead through a small `TestData` service in `src/backend/test-control.ts` (`reset`), whose live layer builds the `SQL.D1` client on `AuthDb` and is provided at Worker init next to `Members.layer`. Why: step 6 builds `TestControlHandlers` in-process with no D1 binding; with the client inside the handlers layer that test could not build. The unit test provides a `TestData` that dies, and `ResetData` stays a `test.todo` there as planned.
- 2026-10-11, step 4: the Worker reads `Config.option(Config.String("E2E_TOKEN"))` at init and builds the test-control server only when `Some` (one of the plan's two options), and provides `Layer.succeed(TestControlToken, token)` with the value already read rather than `TestControlToken.layer`, which would re-read the config and put `ConfigError` in the per-request effect's type. `TestControlToken.layer` is still defined as planned.
- 2026-10-11, step 4: the Backend matches `/api/test-control` and `/api/test-control/`. Effect's `RpcClient.layerProtocolHttp` posts `""` under `prependUrl`, so the request arrives with a trailing slash; with an exact match the first e2e run failed with `Unknown request tag: ResetData` because the call fell through to the main RPC server. The Website route matches both forms already.
- 2026-10-11, step 4: `HttpServerResponse.empty({ status: 404 })` returns a response, not an Effect, so it is returned without `yield*`. `Members.create` re-reads the row with `Effect.fromOption` (an `Option` is not yieldable in Effect 4). `Members.layerTest` became a `Layer.sync` holding its own copy of the list, so `create` appends to it. `src/backend/auth.test.ts` (not in the file plan) was updated for the `takeInlineLink` to `takeLink` rename.
- 2026-10-11, step 7: `playwright.config.ts` also carries a JSDoc on its default export restating the plan's notes (port override, explicit `baseURL`, `PLAYWRIGHT_TEST_BASE_URL`).
- 2026-10-11, step 8, fixtures: a worker-scoped fixture cannot depend on `baseURL`, which is a test-scoped option in Playwright 1.64, so `backend` reads `workerInfo.project.use.baseURL`. Its first parameter must stay the `{}` pattern (Playwright parses it for dependencies), which needs an `oxlint-disable-next-line no-empty-pattern` with a one-line why. `RpcClient.RpcClient<typeof TestControlRpcs>` does not type-check (the parameter is the Rpc union, and the client's error type is separate); `control` takes `RpcClient.RpcClient<RpcGroup.Rpcs<typeof TestControlRpcs>, RpcClientError.RpcClientError>`. `Cause.pretty` exists as planned.
- 2026-10-11, step 8, setup: `fullyParallel` does spread one file's tests over workers, so `auth.setup.ts` uses `setup.describe.configure({ mode: "serial" })`, as the plan allowed.
- 2026-10-11, step 8, `shell.spec.ts`: the plan had the sign-out test run as the admin storage state. Done instead from an empty storage state, signing in its own admin session through `IssueMagicLink` and `followMagicLink`. Why: sign-out deletes the session row on the server, which would invalidate `playwright/.auth/admin.json` for `members.spec.ts` running in parallel.
- 2026-10-11, step 8, `members.spec.ts`: the aria snapshot omits row names (they contain the date) and matches each `Added` cell with `/\d{4}-\d{2}-\d{2}/`; matching is partial, so members created by the other test do not break it.
- 2026-10-11, step 8 verify and §6 item 2: "the second run reports the server as reused" does not happen with a server Playwright started: Playwright stops its own `webServer` at the end of a run, so each `vp run test:e2e` starts `alchemy dev` again (about 17 s per run here). Both consecutive runs passed; repeatability comes from `ResetData` (the `CreateMember` address is built from a stable test id and would otherwise collide on the `member` primary key). Reuse does happen when an e2e server is already listening on the port: with one started by hand, `DEBUG=pw:webserver` logged "WebServer is already available" and the suite passed in about 5 s.
- 2026-10-11, §6 item 3: `vp run test:e2e -- --grep-invert @dev-only` passes the `--` through to Playwright, which then ignores the filter (it ran all 9 tests). `vp run test:e2e --grep-invert @dev-only` applies it (8 tests, passed); the README uses that form.
- 2026-10-11, step 1 verify: checked with a throwaway Playwright script instead of the browser console: `document.body.dataset.hydrated === ""` after load; the server HTML (`curl`) has a bare `<body>`.
- 2026-10-11, §5 spike: an all-local e2e stack needs no Cloudflare credentials. Run with `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` unset and `ALCHEMY_HOME` pointed at an empty directory (no Alchemy profile or stored credentials), `ALCHEMY_STATE=local`, on a fresh stage `e2espike_mw`: `alchemy dev` created `AuthDb`, `Backend`, `Website`, `BetterAuthSecret` and ran `BetterAuthMigrate`, all local, and the full e2e suite passed against it through `PLAYWRIGHT_TEST_BASE_URL`. So the first CI workflow needs no Cloudflare secret for the e2e job. The spike stage's state and logs were removed afterwards; its local D1 file remains under `.alchemy/local/d1`.
- 2026-10-11, open issue: `scripts/dev.ts` finds "this checkout's server" by `pgrep -f "alchemy dev"` plus working directory, so an e2e server running in the same checkout matches too. `vp run dev:status` stayed correct while both ran, but `vp run dev:stop` would also SIGTERM a running e2e server, and `vp run dev:start` with no dev server could adopt it. Not changed: `scripts/dev.ts` is outside this plan.
- 2026-10-11, open issue: with links recorded in both delivery branches, a mailed link that no caller takes (every `RequestMagicLink` off dev) stays in `pendingLinks` until the next link for that address replaces it. It is one entry per member address per isolate, so it is bounded; recorded, not changed.
- 2026-10-11, review, step 4: `TestControlToken.layer` was dead code once the Worker provided the token it had already read with `Layer.succeed`; removed, the service stays.
- 2026-10-11, review, open issue `scripts/dev.ts`: fixed. It now matches `alchemy dev --stage dev` (the `dev` script's command line) instead of `alchemy dev`, so an e2e stage's server in the same checkout is neither adopted by `dev:start` nor stopped by `dev:stop`.
- 2026-10-11, review, §5 spike leftovers: the spike stage's local D1 file was moved to the Trash. The `e2e_mw` stage's state and D1 stay; the suite reuses them.
- 2026-10-11, review, §6 item 2: read "the second run passes against the same stage" rather than "reports the server as reused"; see the step 8 bullet above.
- 2026-10-11, review, step 4 reversed in part: links are no longer recorded in both delivery branches. Where a link goes is now a stage property, `MagicLinkDelivery` (`src/backend/magic-link-delivery.ts`), chosen once at the Worker's composition root from the `MAGIC_LINK_DELIVERY` binding the stack sets: inline under `alchemy dev` or with `E2E_TOKEN`, mailed otherwise, never inline on production. Inline holds the link for `take`; mailed keeps nothing, so a mailed link is never held in memory. `Auth` lost `inline` and `takeLink`; the rate limiter's dev bypass became `SignInLimiter.layerOpen`, chosen at the same root from `ALCHEMY_DEV`. `IssueMagicLink` dies on a mailed stage, with a unit test saying so. The integ stack binds inline itself. Why: a stage that hands links to a test runner should send no mail, so "capture a mailed link" was a state no stage wants.
