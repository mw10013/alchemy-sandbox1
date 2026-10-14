# Research: environments, stages, state and test infrastructure

Research date: 2026-10-14 · Alchemy `2.0.0-beta.81`. Status: every question answered 2026-10-14 (§7); implementation plan in [stages and test infrastructure plan](./stages-and-test-infrastructure-plan.md); nothing implemented.
Background: [Per-checkout dev stages](./dev-stages-research.md) (why dev has a stage per checkout and the `AuthSeed` Action), [Playwright e2e](./playwright-e2e-research.md) (the e2e stage and test control), [Vitest, Effect and Alchemy testing](./vitest-effect-alchemy-testing-research.md) (the integ harness).

## 1. Summary

Wrangler's model was one environment per role (local, staging, production), with one local database shared by dev and the e2e tests, so a test run wiped the dev seed. Alchemy's unit is the **stage**: an isolated, cheap copy of the stack with its own state, physical names and data. Dev and tests each get their own stage, so their data never touches.

This project already runs three local stages per checkout (dev, e2e, integ) side by side. What changes:

1. **Vocabulary:** an **environment** is a role (`dev`, `test`, `e2e`, `staging`); a **stage** is one copy of the stack in an environment (§2).
2. **Names:** dashes throughout; every per-developer stage is `<environment>-<user>[-<checkout>]` (§4.1).
3. **State follows resources:** local state for fully local environments, dev included; Cloudflare state for environments with cloud resources (§4.2).
4. **Unknown stages fail** instead of falling through to the test seeds (§4.3).
5. **One seed file per environment**, run by one `Seed` Action after Better Auth's migration (§4.4).
6. **Test layers:** integ stays Backend-only; Website tests at the HTTP level join e2e as Playwright `request` specs; the integ stack stops re-declaring the real stack's bindings (§4.5).
7. **Test stages start fresh every run;** within a run, tests share the seed rows and never change them (§4.6).

## 2. Concepts

### 2.1 Environment and stage

An **environment** names what a stage is for, and decides its seeds, its state store and its policy (inline magic links, test control allowed). A **stage** is one isolated copy of the stack in an environment.

| Environment          | Shape           | Stages                        |
| -------------------- | --------------- | ----------------------------- |
| `dev`                | per developer   | `dev-mw`, `dev-mw-wt-01`, …   |
| `test`               | per developer   | `test-mw`, `test-mw-wt-01`, … |
| `e2e`                | per developer   | `e2e-mw`, `e2e-mw-wt-01`, …   |
| `staging`            | shared          | `staging`                     |
| `production`, `live` | not defined yet | §4.3                          |

A shared environment has one stage, named after it. A per-developer environment has one stage per developer and checkout. Alchemy's docs file stages under an "Environments" heading, and a Wrangler environment corresponds to an environment here, not to a stage.

"Environment" overlaps with `.env`, `process.env` and a Worker's `env` bindings, so in code it is never shortened to `env` (`environmentOf(stage)`). Rejected: "kind" and "type" (generic; "type" collides with TypeScript), "role" (collides with Better Auth's user `role`), "purpose" (accurate but awkward in code).

@see `refs/alchemy/website/src/content/docs/environments/stages.mdx`, "Common stage patterns"

### 2.2 Three independent settings

| Setting         | Answers                                                   | Set by                                                                                                  |
| --------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **Stage**       | Which copy of the stack: its state record, names and data | `--stage`, `$ALCHEMY_STAGE`, `Test.make({ stage })`, or Alchemy's defaults                              |
| **Mode**        | Local (workerd and simulators) or in Cloudflare           | `alchemy dev`, `ALCHEMY_DEV=1` or `Test.make({ dev })` is local; `alchemy deploy` is Cloudflare         |
| **State store** | Where Alchemy records what it created                     | The stack's `state` layer: `Alchemy.localState()` (`.alchemy/` in the checkout) or `Cloudflare.state()` |

The stage's environment determines the other two here: dev, test and e2e are local in mode and state; staging is Cloudflare in both.

Alchemy's own defaults are `live_$USER` for `alchemy deploy`, `dev_$USER` for `alchemy dev` and `test_$USER` for `Test.make`, plus `pr-42`, `staging` and `prod`. This project names every stage explicitly instead (§4.1).

@see `refs/alchemy/website/src/content/docs/testing/test-harness.mdx`, "`stage`" and "`dev`"

### 2.3 How a stage is seeded today

On a fresh database, in dependency order:

1. **`AuthDb`** (`Cloudflare.D1.Database`) applies `migrations/`, then its `importFiles`: the data seed (`seed/<environment>.sql`, shop tables).
2. **The Backend** runs Better Auth's migration (`BetterAuthMigrate`), which creates `user` and the other Better Auth tables. Step 1 cannot insert a user because the table does not exist yet.
3. **`AuthSeed`**, an Alchemy Action, runs the auth seed (`seed/<environment>-auth.sql`, the operator). Its input carries the Backend's URL, which orders it after step 2, and the file's text and database id, so an edited file or a recreated database runs it again.

An Action is Alchemy's idiom for deploy-time work such as seeding: it runs during apply when its resolved input's hash changes. §4.4 drops step 1's seed.

@see `refs/alchemy/website/src/content/docs/infrastructure-as-code/action.mdx`

## 3. Today

| Stage                      | Started by             | Stack                                | State      | Website port         | Seeds       |
| -------------------------- | ---------------------- | ------------------------------------ | ---------- | -------------------- | ----------- |
| `dev_mw` / `dev_mw_wt01`   | `vp run dev`           | full (`alchemy.run.ts`)              | Cloudflare | `WEBSITE_PORT`       | `dev*.sql`  |
| `e2e_mw` (every checkout)  | Playwright `webServer` | full                                 | local      | `WEBSITE_PORT + 100` | `test*.sql` |
| `test_mw` (every checkout) | `vp test` (integ)      | Backend only (`test/integ/stack.ts`) | local      | none                 | `test*.sql` |

Each checkout's resource data lives in its own `.alchemy/local`, and one `.env` key, `WEBSITE_PORT`, is enough: e2e derives its port, integ runs no Website. Dev and tests already run side by side in every worktree.

Defects:

- **Dev keeps Cloudflare state for fully local resources.** Delete `.alchemy/local` (or a worktree) and the data is gone while Cloudflare's records say the database exists and `AuthSeed` already ran with that input: the next `alchemy dev` skips the seed and there is no operator. This mismatch is also the only reason dev needs a per-checkout stage name enforced by `scripts/dev-stage.ts`, and why a bare `alchemy dev` in a worktree targets main's stage.
- **`seedsFor` (`src/backend/resources.ts`) treats any unrecognised stage as a test stage.** A bare `alchemy deploy` goes to `live_mw` in Cloudflare and would get the test operator `a@a.com`; so would a `pr-42`.
- **`seedsFor("production")` lists `seed/production.sql`, which does not exist.**
- **Naming is mixed:** underscores in stages, dashes in branches and Cloudflare names; dev has a checkout suffix, e2e and integ do not.
- **Two seed paths per environment** (§2.3): two files, two re-run rules, and an ordering that has to be explained.
- **`test/integ/stack.ts` re-declares the real stack's Backend bindings by hand**, so a binding added to `alchemy.run.ts` can be missed there.
- **Test stages carry one run's changes into the next** (§4.6).

## 4. Decisions

### 4.1 Stage names: `<environment>-<user>[-<checkout>]`, dashes throughout

`createPhysicalName` (`refs/alchemy/packages/alchemy/src/PhysicalName.ts`) replaces every character outside `[a-zA-Z0-9-]` with `-` so resource names are DNS-safe. A stage `dev_mw` is already `dev-mw` in every Worker, D1 and log service name (`.alchemy/local/alchemy-sandbox1-backend-dev-mw-…`). With dashes the stage is one spelling everywhere: CLI, state keys, `.alchemy/log/`, the Cloudflare dashboard, `cf o11y` filters, grep. Dashes are also the convention for packages, branches, DNS and URLs, which is why the project and worktree names already use them.

Given up: matching Alchemy's underscore defaults (irrelevant, every stage here is named explicitly; Alchemy's own docs use `pr-42`), and double-click selecting a whole stage in a terminal.

| Checkout | Environment | Stage           |
| -------- | ----------- | --------------- |
| main     | dev         | `dev-mw`        |
| main     | test        | `test-mw`       |
| main     | e2e         | `e2e-mw`        |
| `wt-01`  | dev         | `dev-mw-wt-01`  |
| `wt-01`  | test        | `test-mw-wt-01` |
| `wt-01`  | e2e         | `e2e-mw-wt-01`  |
| —        | staging     | `staging`       |

Each part has one job:

- **environment** picks the seeds, state store and policy (§4.2, §4.3). It is the first part, so a `Schema.TemplateLiteral` decodes it.
- **user** separates people. It costs four characters and is what lets a second developer share the Cloudflare account, or Cloudflare state (§4.2), without renaming anything. It stays lowercase letters and digits (today's `StageUser` check), so it never contains the `-` separator.
- **checkout** separates worktrees, spelled exactly as the branch and folder (`wt-01`), so grepping `wt-01` finds its branch, folder, stages and resources together. Absent in the main checkout. Every per-developer environment carries it, test and e2e included, so there is one rule and nothing changes if a test environment ever moves to Cloudflare state.

Physical names are capped at 64 characters; Alchemy truncates the readable prefix and keeps a hash, so length is not a constraint.

### 4.2 State follows the resources

State is Alchemy's record of what exists. It goes wrong when the record and the things it describes can be lost separately:

| Resources  | State      | Failure                                                                                        |
| ---------- | ---------- | ---------------------------------------------------------------------------------------------- |
| local      | Cloudflare | Local data lost, record survives: seeds and Actions are skipped against an empty database (§3) |
| Cloudflare | local      | `.alchemy/` lost: cloud resources orphaned, still billing                                      |
| matching   | matching   | Nothing lost that cannot be recreated; a lost local stage costs a reseed                       |

| Environment                                     | State      |
| ----------------------------------------------- | ---------- |
| `dev`, `test`, `e2e`                            | local      |
| `staging`; `production` and `live` when defined | Cloudflare |

This does not box the project in:

- **Moving a fully local environment to Cloudflare state is cheap:** point it at `Cloudflare.state()` and its stages start fresh, rebuilt from migrations and seeds. No state is moved. The expensive move is the reverse, and an environment with cloud resources is on Cloudflare state from its first deploy.
- **The naming in §4.1 already makes Cloudflare state collision-free** across checkouts and developers, so the switch needs no new design.
- **"Run locally against cloud resources" is a different environment, not a modified dev:** Alchemy's `live_$USER` pattern, a personal cloud sandbox, added as `live` when first needed (§4.3).

The one trigger to watch: dev gaining a resource that runs live under `alchemy dev` (`Alchemy.remote()`, or a service with no local simulator). Dev moves to Cloudflare state when that resource lands. The rule is stated once, in JSDoc on the code that picks the state store.

The state layer chooses by stage: a stack's `state` is a `Layer<State, never, StackServices>`, and `StackServices` includes `Stage` (`refs/alchemy/packages/alchemy/src/Stack.ts`). That replaces today's `ALCHEMY_STATE=local` environment variable with a decision made from the stage's environment.

Verified 2026-10-14 with a probe stack whose `state` was `Layer.unwrap` over `Alchemy.Stage`:

| Run                                                        | Result                                                                                              |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `alchemy plan --stage stateprobe-cli`                      | the stack's state layer read `stateprobe-cli`                                                       |
| `Test.make({ stage: "stateprobe-mw" })`, no `state` option | the harness used the stack's own state layer, which read `stateprobe-mw` on both deploy and destroy |
| `Test.make({ state: <same layer> })`                       | `Service not found: Stage`: the harness builds its own `state` option outside the stage             |

So the stage-driven layer lives on the stack and integ files pass no `state` to `Test.make`. The harness option would not see the stage.

Side effects of local dev state:

- Retiring a worktree deletes its stages with its folder; no Cloudflare records are left behind.
- `db:reset` (`scripts/dev.ts`) no longer forgets remote records; it deletes this checkout's `.alchemy/local` and `.alchemy/state`.
- Dev needs no Cloudflare credentials.
- A bare `alchemy dev` in a worktree still defaults to Alchemy's `dev_$USER`, which §4.3 rejects, so `vp run dev` stays the only way in.

### 4.3 Unknown stages fail

A stage whose environment is not listed is a stage nobody has thought through. Seed selection and the state choice (§4.2) end in a failure naming the stage, not in `Match.orElse` to the test seeds.

- **`live` is not defined yet.** It is added, with its seed and Cloudflare state, when first needed; until then a bare `alchemy deploy` (Alchemy's `live_$USER`) fails.
- **`production` is not defined yet** either, until production work starts, so a production deploy fails as an unknown stage. The `seed/production.sql` reference that points at a missing file goes away with it. Whether production gets a seed is decided then.

### 4.4 One seed file per environment, run by one Action

The two-path split (§2.3) exists only because `importFiles` runs inside the D1 resource, before Better Auth's tables exist. One Action, `Seed` (today's `AuthSeed`, renamed because it no longer seeds only Better Auth's tables), runs each environment's single file after Better Auth's migration, when every table exists. `AuthDb` lists no `importFiles`.

| Environment   | Seed               |
| ------------- | ------------------ |
| `dev`         | `seed/dev.sql`     |
| `test`, `e2e` | `seed/test.sql`    |
| `staging`     | `seed/staging.sql` |

|                       | Before: `importFiles` + `AuthSeed`                         | After: `Seed`                                                                                                     |
| --------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Files per environment | two (`<environment>.sql`, `<environment>-auth.sql`)        | one (`<environment>.sql`)                                                                                         |
| Ordering              | migrations → data seed → Better Auth migration → auth seed | migrations → Better Auth migration → seed                                                                         |
| Re-run rule           | two hashes: `importFiles`' and the Action's input          | one: the Action's input (file text, database id)                                                                  |
| Transport             | Cloudflare's bulk D1 import API on deploy                  | the D1 query API (`d1.exec`); under `alchemy dev`, one ephemeral workerd gateway per query (`QueryDatabaseLocal`) |

Given up: the bulk import path, which a seed of a few dozen rows never needs; a large data load would want `importFiles` back. Rows stay idempotent (`INSERT OR IGNORE`) and shaped as Better Auth stores them. Dev and test seeds are separate files with separate owners and evolve independently.

### 4.5 Test layers

| Layer     | Runner                  | Environment | Proves                                                                                    |
| --------- | ----------------------- | ----------- | ----------------------------------------------------------------------------------------- |
| **integ** | Vitest + `alchemy/Test` | `test`      | The Backend's behavior against real D1, Better Auth and bindings, over its real transport |
| **e2e**   | Playwright              | `e2e`       | The Website: browser flows, and HTTP behavior without a browser                           |

- **Integ stays Backend-only.** Booting the Website means a Vite dev server and a port on every integ run, which is the e2e stage minus the browser.
- **Website HTTP tests are Playwright `request` specs on the e2e stage.** The `request` fixture sends plain HTTP with cookie handling, no browser. Targets: SSR responses, route guards (signed-out requests redirect), the auth and socket proxy routes, cookies and headers. `test/e2e/actor-upgrade.spec.ts` is already close to this.
- **Server functions are tested through the Backend methods they call**, in integ. Their URLs and wire format are TanStack internals, not an API this project owns; the pages that use them are covered in e2e.
- **Signing in is not the obstacle.** Test control's `IssueMagicLink` plus a request to the verify URL yields a session cookie without a browser, as `test/integ/auth.test.ts` does. One helper per layer makes it one line.
- **One function wires the Backend's bindings for both stacks.** The integ stack differs from the real one in three values: the auth origin (the Backend's URL versus the Website's), magic-link delivery, and the test-control token. Everything else (the Shopify binding, the seed, the binding names) is in the function, so a new binding is added once. It lives in `src/backend/` beside the seed Action, as a stack-time module the Backend bundle does not import.

### 4.6 Test stages start fresh every run

**Today.** `TestData.reset` (`src/backend/test-control.ts`, served as test control's `ResetData`) deletes by convention: every session, account and verification, and the users and members whose email ends in `@e2e.test`. e2e runs it once in `test/e2e/auth.setup.ts`; one integ test runs it. Gaps:

- **A seed row a test changed stays changed.** `INSERT OR IGNORE` never restores it, and `Seed` re-runs only when its file or database changes (§4.4).
- **Durable Object storage is never reset.** The ShopActor's state survives across runs.
- **Every new table needs a reset rule**, and a forgotten one leaks silently.

**Integ: Alchemy's pattern, `beforeAll(deploy(Stack))` plus `afterAll(destroy(Stack))` in every file.** Each file gets a fresh stage and removes it when done. A cold deploy measured 0.9 s ([test speed research](./test-speed-research.md)), and the 2.5 s workerd boot happens on every run whether the stage is reused or not, so destroying locally costs almost nothing. Alchemy's docs suggest destroying only on CI and keeping the stack locally for speed; here reuse buys no speed, so integ destroys everywhere, with `NO_DESTROY=1` (the docs' opt-out) kept for inspecting a stack after a failure.

@see `refs/alchemy/website/src/content/docs/testing/testing-a-stack.mdx`, "Deploy once with beforeAll" and the `afterAll` section

**e2e: destroy, then `alchemy dev`.** Playwright's `webServer` starts a long-running `alchemy dev`, so no harness calls `deploy` or `destroy`. A package script runs `alchemy destroy --stage e2e-…` and then `alchemy dev`, and becomes the `webServer` command. Destroying before the start also cleans up after a run that crashed. `reuseExistingServer` would keep the last run's data, so it is off by default, with an explicit opt-in for iterating against a running server.

**Within a run: the seed is read-only fixtures.** Tests in one integ file share that file's stack, and e2e runs `fullyParallel` against one server, so a global reset mid-run would pull data from under other tests. Each test makes its own data under unique names (`@e2e.test` addresses, a shop of its own); a test that needs to change a fixture makes its own copy first. `ResetData` stops being the between-runs reset and is removed once nothing needs it.

#### The `destroy` hang (investigated 2026-10-14)

An earlier session saw `afterAll(destroy(Stack))` sit at Vitest's 120 s hook timeout and removed the call; the integ stack has never been destroyed since. Nobody investigated the cause. Reproduced and isolated:

| Probe                                                 | Result                                        |
| ----------------------------------------------------- | --------------------------------------------- |
| Real integ stack, `afterAll(destroy)`                 | hangs; times out at 120 s                     |
| A stack holding only the D1 database                  | hangs, so nothing in this stack causes it     |
| `Test.make({ dev: true })` instead of `ALCHEMY_DEV=1` | hangs                                         |
| `Test.make({ sidecar: false })`                       | destroys in under 2 s                         |
| `vp test --sequence.hooks=list` (sidecar on)          | D1-only stack: 64 ms; real integ stack: 2.3 s |

**Cause: Vitest runs `afterAll` hooks in reverse order by default, and Alchemy's Vitest adapter assumes registration order.** `Test.make` in `alchemy/Test/Vitest` registers its own fallback `afterAll`, in a microtask after the file's hooks, that closes the file's scope and the dev sidecar (the child process that runs local providers under `alchemy dev` and dev-mode tests). Its comment says this runs after the user's `destroy` because "vitest runs afterAll hooks in registration order". Vitest's default `sequence.hooks` is `"stack"`, which runs after-hooks in reverse, so the sidecar closes first. `destroy` then waits on a closed sidecar and never reaches a delete: the state rows stay `created`. Alchemy's own suite runs on its Bun-based `alchemy-test` runner, which keeps registration order, so the bug does not show there.

**Fix: `sequence: { hooks: "list" }` on the integ Vitest project.** No Alchemy patch is needed. Upstream, the adapter should register its cleanup so that it runs last under Vitest's default; worth an issue.

**Local data after `destroy`.** The local D1 provider's `delete` deliberately does nothing on disk: its JSDoc says the simulator's data is keyed by the dev id and "orphaned data is reclaimed with `.alchemy`". The probe confirmed it: after destroy, the database's SQLite file stays in `.alchemy/local/d1` with its tables, and the ShopActor folder stays too. This does not weaken isolation, because the next deploy creates a new database id and so a new, empty file. The cost is files piling up in `.alchemy/local` until `db:reset`, a few hundred KB per run; `db:reset` is the cleanup, as Alchemy intends.

**The CLI's `alchemy destroy` on a local stage works** (verified 2026-10-14): `ALCHEMY_STATE=local alchemy destroy --stage e2e_mw --yes` deleted all 7 resources in 10 ms (about 9 s including CLI startup) and removed the stage's state, and the next `vp run test:e2e` rebuilt the stage from nothing and passed all 17 specs in 24 s.

## 5. Proposed changes

For the implementation plan, in dependency order:

1. **Environments as a schema.** A `Schema.TemplateLiteral`-based codec for `<environment>-<user>[-<checkout>]` plus `staging`, decoding a stage to its environment. One place that knows the environments; seed selection and the state choice match on it, and an unknown stage fails (§4.3).
2. **Stage-driven state layer** on the stacks in `alchemy.run.ts` and `test/integ/stack.ts` (§4.2), replacing `ALCHEMY_STATE`; integ files pass no `state` to `Test.make`.
3. **One seed per environment** (§4.4): merge each `seed/<environment>-auth.sql` into `seed/<environment>.sql`; rename `AuthSeed` to `Seed`; drop `importFiles` from `AuthDb`; drop the production entry.
4. **Stage derivation for every environment.** `devStageOf` in `scripts/lib/worktree.ts` takes the environment as a parameter and emits dashes; `scripts/dev.ts`, `playwright.config.ts` (running the stage script with `execFileSync` and reading its stdout) and the integ tests' `Test.make({ stage })` all take their stage from it.
5. **Shared Backend wiring** used by `alchemy.run.ts` and `test/integ/stack.ts` (§4.5).
6. **`db:reset`** deletes this checkout's local state and data only.
7. **Fresh test stages** (§4.6): `sequence: { hooks: "list" }` on the integ Vitest project; `afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack))` in every integ file; an e2e server script that destroys the stage before `alchemy dev`, used as Playwright's `webServer` command, with `reuseExistingServer` off by default. Tests that change seed rows switch to their own data; `ResetData` goes once nothing needs it.
8. **Playwright `request` specs** for the Website's HTTP behavior, with a sign-in helper.
9. **Docs and JSDoc:** README, `docs/worktrees-runbook.md`, `docs/glossary.md` (environment and stage), and the JSDoc on the seed selection, `devStageOf`, the stack and `scripts/dev.ts` move to the new names and rules.
10. **Migrate the existing stages, last, after the new stages are verified:** delete the `Alchemy-sandbox1/dev_mw/*` and `Alchemy-sandbox1/dev_mw_wt01/*` records in Cloudflare state, any leftover `Alchemy-sandbox1/dev/*` records, and the old underscore stages' `.alchemy/` files in every checkout.

## 6. Unchanged

- One `.env` per checkout with `WEBSITE_PORT`; e2e on `WEBSITE_PORT + 100`; no `.env` for tests.
- Integ runs local through `ALCHEMY_DEV=1` in the Vitest project, because the Worker's init reads it at plan time.
- Better Auth's migration stays with the Backend (`BetterAuthMigrate`); the seed waits for it through the Backend's URL.
- Worktree branches and folders `wt-NN`.

## 7. Questions

All answered 2026-10-14; every recommendation accepted.

- **The checkout suffix is on every per-developer environment** (§4.1).
- **No `live` environment yet** (§4.3).
- **Production is left out for now** (§4.3).
- **`playwright.config.ts` runs the stage script** and reads its stdout (§5 step 4).
- **The shared Backend wiring lives in `src/backend/`** beside the seed Action (§4.5).
- **Migrating the old stages is part of the same change**, as its last step (§5 step 10).
- **The first part of a stage name is its environment** (§2.1).
- **One seed file per environment, run by one `Seed` Action** (§4.4).
- **Test stages start fresh every run: harness `destroy` for integ, destroy-then-dev for e2e; the seed is read-only within a run** (§4.6).
