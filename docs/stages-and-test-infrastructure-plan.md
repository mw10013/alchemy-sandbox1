# Plan: environments, dashed stages, state that follows resources, one seed, fresh test stages

Plan date: 2026-10-14 · Alchemy `2.0.0-beta.81` · Base commit `699f3ad`.
Research: [stages and test infrastructure research](./stages-and-test-infrastructure-research.md). Every question there is answered; this plan implements the answers. Read the research first, all of it: it explains why each step exists, and §4.6 records the `destroy` hang's cause and the probes that established it.

## 0. Rules for the implementer

- Follow `AGENTS.md`: Vite+ only (`vp`, never npm/npx); Effect idioms (Schema for parsing and validation, `Match` for dispatch, `Schema.TaggedError`, `Effect.fn`); its comment rules (JSDoc on symbols, `{@link}` only to symbols in scope, no references to plans, research docs or their section numbers in code or comments).
- **No commits, no pushes, no deploys.** A push to `main` deploys staging. Never run `alchemy deploy` or `alchemy destroy` against `staging` or any stage in Cloudflare state.
- **Destroying local stages is allowed:** any `dev-…`, `test-…` or `e2e-…` stage, and the old `e2e_mw` and `test_mw` stages. Their data is local and rebuilt from seeds.
- **Do not touch the `wt-01` worktree** (`~/.t3/worktrees/alchemy-sandbox1/wt-01`), its files or its server. Step 0 says what to do about its Cloudflare state records.
- Run `vp check --fix` after code changes.
- Work in step order. Each step ends green (`vp check`, plus the checks it names) before the next starts.
- Record anything that differs from this plan in §16 (Deviations), and any problem you could not solve in §17 (Issues), with the date and step. Do not silently change the design. If a step cannot work as written, stop that step, record why, and continue with the steps that do not depend on it.

## 1. Outcome

- Vocabulary in code and docs: an **environment** (`dev`, `test`, `e2e`, `staging`) is a role; a **stage** is one copy of the stack in an environment. In code it is never shortened to `env`.
- Every per-developer stage is `<environment>-<user>[-<checkout>]`, with dashes: `dev-mw`, `dev-mw-wt-01`, `test-mw`, `e2e-mw-wt-01`. The shared stage is `staging`. `production` and `live` are not defined; any stage outside these fails, naming the stage.
- The stage's environment picks the state store: local for `dev`, `test` and `e2e`; Cloudflare for `staging`. `ALCHEMY_STATE` is gone.
- Each environment has one seed file, run by one `Seed` Action after Better Auth's migration. `AuthDb` lists no `importFiles`; the `*-auth.sql` files are gone.
- `alchemy.run.ts` and the integ stack wire the Backend through one shared function.
- Every integ file deploys a fresh stage and destroys it afterwards. Every e2e run destroys its stage before starting `alchemy dev`. Tests never change seed rows.
- Playwright `request` specs cover the Website's HTTP behavior without a browser.
- No `dev_mw` (or `dev`) records remain in Cloudflare state.

## 2. Target shape

New and changed modules, so each step knows where things go:

| Module                                               | Holds                                                                                                          | Imported by                                                  |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `src/backend/stage.ts` (new)                         | `Environment`, the stage name codec, `environmentOf`, `UnknownStage`                                           | `seed.ts`, `stack.ts`, `scripts/lib/worktree.ts`, unit tests |
| `src/backend/seed.ts` (replaces `auth-seed.ts`)      | `seedFileFor(environment)`, the `Seed` Action, `seed(backend)`                                                 | `stack.ts`                                                   |
| `src/backend/stack.ts` (new)                         | `stageState` (the stack's `state` layer) and `wireBackend` (the Backend bindings both stacks share)            | `alchemy.run.ts`, `test/integ/stack.ts`                      |
| `src/backend/resources.ts`                           | `AuthDb` without `importFiles` and with no stage logic; `seedsFor` and `Seeds` removed                         | unchanged importers                                          |
| `scripts/lib/worktree.ts`                            | `stageOf(environment, user, checkout, branch)` and `stage(environment)`, replacing `devStageOf` and `devStage` | `scripts/stage.ts`, `scripts/dev.ts`                         |
| `scripts/stage.ts` (replaces `scripts/dev-stage.ts`) | CLI: `node scripts/stage.ts <dev\|test\|e2e>` prints that environment's stage for this checkout                | `package.json`, `playwright.config.ts`, `vite.config.ts`     |

`stage.ts` must stay bundle-safe: the Backend bundle may import it indirectly in future, so it imports only `effect` modules. `seed.ts` and `stack.ts` are stack-time modules. The Backend bundle (`src/backend/worker.ts` and what it imports) must not import them. `seed.ts` pulls in `QueryDatabaseLocal`, whose `workerd` resolver broke the Backend boot when `resources.ts` imported it; `auth-seed.ts`'s JSDoc records that history.

## 3. Step 0: retire the old dev stages' Cloudflare records (before any code change)

The research put this last. It has to come first. Once step 4 lands, the stack's state layer rejects `dev_mw` as an unknown stage, so no CLI command run from this checkout can address those records any more.

1. Stop this checkout's dev server: `vp run dev:stop`.
2. List, read-only: `vp exec alchemy state list Alchemy-sandbox1 -r`. Copy the output into §16.
3. Delete every `Alchemy-sandbox1/dev_mw/<id>` record, and any `Alchemy-sandbox1/dev/<id>` record, one at a time: `vp exec alchemy state delete Alchemy-sandbox1/dev_mw/<id> --no-input`. The `output` record cannot be deleted on its own; it disappears once the others are gone (seen in the dev-stages work). Confirm with `state list`.
4. `Alchemy-sandbox1/dev_mw_wt01/*` belongs to `wt-01`. Check whether its server is running (`lsof -nP -iTCP:3901 -sTCP:LISTEN`). If nothing is listening, delete those records the same way. If its server is running, leave them and record that in §17: they then have to be deleted from `wt-01` before it moves to the new code.
5. Leave the local underscore stages (`.alchemy/state/*/e2e_mw`, `test_mw`, `.alchemy/local`); step 11 removes them.

Verify: `state list Alchemy-sandbox1 -r` shows no `dev_mw/` and no `dev/` (and no `dev_mw_wt01/`, unless step 4 kept it). `staging/` is untouched.

## 4. Step 1: environments and stage names (`src/backend/stage.ts`)

1. `Environment`: `Schema.Literals(["dev", "test", "e2e", "staging"])`. `PerDeveloper`: the subset `dev`, `test`, `e2e`.
2. A stage name codec over `{ environment, user, checkout }` for per-developer stages: `checkout` is an optional worktree index (1 to 99, encoded `wt-NN`), and `user` is lowercase letters and digits (move today's `StageUser` check here, so the user part never contains `-`). Encoding gives `dev-mw` or `dev-mw-wt-01`. Use `Schema.TemplateLiteral` / `TemplateLiteralParser` if it expresses both shapes cleanly; otherwise build a `Schema.String` → struct transformation with `SchemaTransformation`, as `WorktreeBranch` in `scripts/lib/worktree.ts` does. No hand-written regexes beyond the pattern checks Schema itself takes.
3. `environmentOf(stage: string)`: `staging` gives `staging`, a per-developer stage gives its environment, and anything else fails with `UnknownStage` (`Schema.TaggedError`, carrying the stage). Its JSDoc states the rule once: an environment not listed is one nobody has thought through, so it fails rather than falling back; `live` and `production` are added when they are designed.
4. Unit tests, `test/unit/backend/stage.test.ts`: round-trips for `dev-mw`, `dev-mw-wt-01`, `test-mw-wt-12`, `e2e-mw`; `staging`; and failures for `dev_mw`, `dev-mw_wt01`, `production`, `live-mw`, `pr-42`, `dev-Bad-wt-01`, `dev-mw-wt-00`, `dev-mw-wt-100`.

Verify: `vp check`, `vp test --project unit`.

## 5. Step 2: stage derivation for every environment

1. `scripts/lib/worktree.ts`: `devStageOf` becomes `stageOf(environment, user, checkout, branch)`, building the name through the codec from step 1. It keeps its current failures: a `$USER` that is not lowercase letters and digits, or a linked worktree on a branch that is not `wt-NN`. `devStage` becomes `stage(environment)`. Update the module and symbol JSDoc to the new names.
2. `scripts/dev-stage.ts` becomes `scripts/stage.ts`, taking the environment as a required positional argument (`effect/cli` `Argument`, decoded with `PerDeveloper`). It prints the stage and nothing else, and exits non-zero with the reason on stderr.
3. `package.json` `dev:alchemy`: `stage=$(node scripts/stage.ts dev)`.
4. `scripts/dev.ts`: import `stage` from the worktree module and use `stage("dev")`; its own cached `stage` constant takes another name (`devStage`, say) so the two do not collide. Update the JSDoc that names `dev_<user>` and `dev_<user>_wtNN`. The server match ` dev --stage <stage>` stays: `dev-mw` is a prefix of `dev-mw-wt-01`, and the working-directory check still separates them.

Verify: `node scripts/stage.ts dev` prints `dev-mw`; `test` prints `test-mw`; `e2e` prints `e2e-mw`; `staging` and no argument both fail. Exercise the worktree branch with a fake checkout, as the dev-stages work did, and record the outputs in §16: `stageOf("dev", "mw", { linked: true }, "wt-01")` gives `dev-mw-wt-01`; branch `main` in a linked worktree fails; user `Bad.name` fails.

## 6. Step 3: one seed per environment (`src/backend/seed.ts`)

1. Merge each auth seed into its data seed: `seed/dev-auth.sql` into `seed/dev.sql`, `test-auth.sql` into `test.sql`, `staging-auth.sql` into `staging.sql`. Keep every row byte-for-byte; keep `INSERT OR IGNORE`. Rewrite each file's header comment: it is the environment's one seed, run by the `Seed` Action after Better Auth's migration, so it may fill both Baton's and Better Auth's tables; rows are idempotent and shaped as Better Auth stores them. Delete the three `*-auth.sql` files.
2. `src/backend/seed.ts` replaces `src/backend/auth-seed.ts`:
   - `seedFileFor`: `Match` over `Environment`; `dev` gives `./seed/dev.sql`, `test` and `e2e` give `./seed/test.sql`, `staging` gives `./seed/staging.sql`. Exhaustive, so a new environment is a type error until its seed is chosen.
   - `Seed`: today's `AuthSeed` Action renamed, same body (`d1.exec` of the whole file, `QueryDatabaseLocal`), same input (`databaseId`, `backendUrl`, `sql`).
   - `seed(backend)`: today's `seedAuth`. It reads the stage, takes `environmentOf` (an `UnknownStage` dies, naming the stage: the stack's error channel is `ConfigError`), reads the file and registers `Seed`. Every listed environment has a seed, so the "no seed" branch goes.
   - Carry the JSDoc over and reword it: why it is an Action (ordering after the Backend, which waits for Better Auth's migration), what re-runs it (file text, database id), and why it lives apart from `AuthDb` (`QueryDatabaseLocal` and the Backend bundle).
3. `src/backend/resources.ts`: remove `isDevStage`, `Seeds` and `seedsFor`. `AuthDb` becomes a plain `Cloudflare.D1.Database("AuthDb", { migrations: "./migrations", readReplication: { mode: "disabled" } })`. Rewrite its JSDoc: migrations only, seeding is the `Seed` Action's job (name it in backticks; do not import `seed.ts` for a link).
4. Update callers (`alchemy.run.ts`, `test/integ/stack.ts`) to `seed` for now; step 4 moves the call into `wireBackend`.

Verify: `vp check`; `vp test --project integ` (still on the old `test_mw` stage until step 6; that is expected). The integ tests that sign in as `a@a.com` and as seeded members pass, which proves the merged seed ran after Better Auth's tables existed.

## 7. Step 4: shared Backend wiring and the stage-driven state layer (`src/backend/stack.ts`)

1. `stageState`: `Layer.unwrap` over an Effect that reads `Alchemy.Stage`, takes `environmentOf` (dying with the stage named on `UnknownStage`) and matches: `dev`, `test`, `e2e` give `Alchemy.localState()`; `staging` gives `Cloudflare.state()`. Its JSDoc states the rule from the research once: state lives where the resources live; a per-developer environment that gains a resource running live under `alchemy dev` (`Alchemy.remote()`, or a service with no local simulator) moves to `Cloudflare.state()` when that resource lands. It also says that `Test.make`'s own `state` option is built without the stage, so integ files pass none and the harness uses this layer from the stack.
2. `wireBackend(backend, { authOrigin, delivery, e2eToken })`: registers the seed (`seed(backend)`) and binds `AuthOrigin`, `MagicLinkDelivery`, `Shopify` (the fixed fake key plus `Alchemy.makeRandom("ShopifyApiSecret")`) and, when `e2eToken` is some, `TestControl`. It returns nothing the stacks do not need. Keep the binding names and the logical id `ShopifyApiSecret` exactly as today: renaming them recreates resources on staging.
3. `alchemy.run.ts`: `state: stageState`. Keep its policy where it is: the website-URL auth origin, the delivery rule (inline under `alchemy dev` or with `E2E_TOKEN`) and the `E2E_TOKEN` read. Drop the two `stage === "production"` guards and the JSDoc sentences that state them ("It is refused on the production stage", "Production never delivers inline"): `production` is not a listed environment, so `stageState` fails on it before the body runs and the guards cannot fire. They come back, matched on the environment, when production is designed. Drop the `deploy:production` script from `package.json` for the same reason. Then call `wireBackend`. Rewrite the stack JSDoc: drop the `ALCHEMY_STATE` paragraph, and say the state store follows the stage's environment (`{@link stageState}`).
4. `test/integ/stack.ts`: `state: stageState`; `wireBackend(backend, { authOrigin: backend.url, delivery: "inline", e2eToken: Option.some(INTEG_E2E_TOKEN) })`. Its JSDoc keeps the reasons it differs (no Website, the Backend as its own origin, inline links, test control on) and drops the restated binding list.
5. Remove every `ALCHEMY_STATE` use: `alchemy.run.ts`, `playwright.config.ts` (step 7 rewrites that config anyway) and the JSDoc in `scripts/dev.ts`.

Verify: `vp check`; `vp exec alchemy plan --stage staging` shows **no changes** to `Backend`, its bindings, `ShopifyApiSecret` or `BetterAuthSecret`; the only changes are `AuthDb` (`importFiles` removed, an **update**: the D1 provider's `diff` replaces only on account, name, jurisdiction or location hint), `AuthSeed` removed and `Seed` added. Record the plan output in §16. **Do not deploy.** If anything else changes, stop and record it in §17. `vp exec alchemy plan --stage live_mw` fails naming `live_mw`.

## 8. Step 5: dev on `dev-mw` with local state

1. `scripts/dev.ts` `db:reset`: drop `authDbState` and its `alchemy state delete` loop; dev's records are local now. The reset stops the server, removes `.alchemy/local` and `.alchemy/state`, and starts the server. Rewrite the module JSDoc and the `LOCAL_STATE` JSDoc: every local-state stage (dev, test, e2e) lives there, and removing it with `.alchemy/local` is what keeps records and data in step. Update the command description.
2. `vp run dev`. The server runs `alchemy dev --stage dev-mw` with state under `.alchemy/state/Alchemy-sandbox1/dev-mw`.

Verify:

- `vp run dev:status` reports the server.
- Sign in at `http://localhost:$(pnpm port)/sign-in` as `a@a.com` (admin) and as `m1@m.com`; the link shows on the page.
- `vp exec alchemy state list Alchemy-sandbox1 -r` shows no `dev-mw/` in Cloudflare state.
- `vp run db:reset` restarts with a fresh database, and the operator can sign in again.

## 9. Step 6: integ stages are fresh per file

1. `vite.config.ts`, integ project: `sequence: { hooks: "list" }`, with a `//` comment on the line saying why: `alchemy/Test/Vitest` registers its sidecar cleanup after the file's own `afterAll` hooks and expects registration order, and Vitest's default (`"stack"`) runs after-hooks in reverse, so `destroy` would wait on a closed sidecar. Add `ALCHEMY_TEST_STAGE` to the project's `env`, from `execFileSync("node", ["scripts/stage.ts", "test"])` (trimmed through Schema, not by hand). Compute it only when the config is loaded for tests (`mode === "test"`), so `vp build` and `vp run dev` do not spawn it. The harness reads `ALCHEMY_TEST_STAGE` as its default stage (`defaultStage` in `alchemy/Test/Core`), so no test file names a stage.
2. Each of `test/integ/auth.test.ts`, `shop-actor.test.ts` and `socket-facts.test.ts`: add `afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack))` and take `afterAll` and `destroy` from `Test.make`. Replace the "Never destroyed …" JSDoc on `stack` with the rule: each file deploys a fresh stage and destroys it; `NO_DESTROY=1` keeps it for inspecting after a failure. Say the reason (the seed is the only data a file starts with) without citing versions.
3. `atBackend` in `auth.test.ts` exists because a redeploy kept the previous run's port in `AUTH_ORIGIN`. With a fresh deploy per file that may no longer happen. Check by logging the issued link's origin against `backendUrl` once. If they now match, remove `atBackend` and its JSDoc; if not, keep it and correct its JSDoc. Record which in §16.

Verify: `vp test --project integ` passes twice in a row. After each run, `.alchemy/state/Alchemy-sandbox1-test/` has no stage directory. The second run's deploy logs show `created`, not a no-op. Record both run times in §16.

## 10. Step 7: e2e destroys its stage, then starts `alchemy dev`

1. `package.json`: a script `test:e2e:server` that destroys the e2e stage and then replaces itself with `alchemy dev`, so the signal Playwright sends reaches `alchemy dev`: `bash -c 'alchemy destroy --yes && exec alchemy dev'`. It reads the stage from `ALCHEMY_STAGE`, which Playwright sets. If `vp run`'s wrapper keeps Playwright's shutdown signal from reaching `alchemy dev`, find a shape that works and record it. The destroy must also succeed when the stage has no state yet (the first run, and every run after `db:reset`): `alchemy destroy` plans from the state store, so an empty store should converge on nothing. Check that case first; if it fails instead, record it in §17 and find a guard that does not mask a real destroy failure.
2. `playwright.config.ts`:
   - `stage` from `execFileSync("node", ["scripts/stage.ts", "e2e"])`.
   - `webServer.command: "vp run test:e2e:server"`.
   - `env`: `ALCHEMY_STAGE`, `WEBSITE_PORT` and `E2E_TOKEN`; no `ALCHEMY_STATE`.
   - `reuseExistingServer: process.env.E2E_REUSE_SERVER === "1"`. Rewrite the JSDoc: a reused server keeps the last run's data, so reuse is opt-in for iterating, and every other run starts from a destroyed stage.
3. The dev server's process match (` dev --stage dev-mw`) must not match the e2e server, which carries its stage in the environment. Confirm with `vp run dev:status` while an e2e run is going.

Verify:

- `vp run test:e2e` passes twice in a row. Both runs log the e2e stage's resources as `deleted`, then `created`.
- After each run, no `alchemy dev` for `e2e-mw` is still running (`pgrep -fl "alchemy"`, and check that port `WEBSITE_PORT + 100` is free).
- With the dev server running, `vp run dev:status` reports only the dev server during an e2e run.

## 11. Step 8: tests never change seed rows; retire `ResetData`

1. Audit every spec and integ test for writes to seeded rows: the shops, `mem-1` to `mem-3`, `team-1`, the operator, and the seeded members' Better Auth users and sessions. A test that needs to change such a row makes its own instead: an `@e2e.test` member, or a shop of its own as `socket-facts.test.ts` does. Record each change in §16. Signing in as a seeded user (which creates a session) is not a change to a seed row.
2. `test/e2e/auth.setup.ts`: remove the `reset data` setup, now that the stage is fresh every run. Update the `describe.configure({ mode: "serial" })` comment if its reason changes.
3. `test/integ/shop-actor.test.ts`, "the gate": it calls `ResetData` before signing in. Find what it relied on: sessions from earlier tests in the same file, which share its stack. Make the test independent of them, for example by asserting only on credentials it creates. Record what it needed.
4. If nothing calls `ResetData` any more, remove it: the RPC in `src/contract/test-control.ts`, its handler, the `TestData` service and layer in `src/backend/test-control.ts`, its wiring in `src/backend/worker.ts`, its case in `test/unit/backend/test-control.test.ts`, and the JSDoc that mentions it. If something still needs it, keep it, narrow its JSDoc to that use, and record why in §16.

Verify: `vp test` and `vp run test:e2e` pass, each twice.

## 12. Step 9: Website HTTP specs

1. A fixture in `test/e2e/fixtures.ts` that signs a seeded or `@e2e.test` user in without a browser: `IssueMagicLink` through test control, then a `request.get` of the link with redirects off, keeping the session cookie in the request context. It goes beside the existing `backend` fixture.
2. `test/e2e/http.spec.ts`, using only the `request` fixture (no `page`). Find the paths in `src/web/routes/` rather than guessing:
   - a signed-out request to the member area redirects to sign-in;
   - a signed-in member's request to the member area returns HTML;
   - a member's request to the admin area is sent to the member area (the HTTP counterpart of `shell.spec.ts`'s browser case);
   - the auth proxy route answers `get-session` with the member's email.

   Add one assertion per behavior. Do not assert on server-function URLs or their wire format, which TanStack owns.

Verify: `vp run test:e2e` passes; the new specs run without opening a page (check in the Playwright report).

## 13. Step 10: docs and JSDoc

1. `README.md`: the dev stage (`dev-<user>`, `dev-<user>-wt-NN`, `node scripts/stage.ts dev`); dev's state is local, so "The shared Cloudflare state backend requires cloud access" goes; the seed (`seed/dev.sql`, the `Seed` Action, one file per environment); the test paragraphs (integ deploys a fresh `test-…` stage per file and destroys it, `NO_DESTROY=1`; e2e destroys `e2e-…` before each run, `E2E_REUSE_SERVER=1`, no reset step; HTTP specs). Remove the "never destroyed" sentence and the `ResetData` description.
2. `docs/glossary.md`: add **Environment** and **Stage** with the definitions from §1 and the naming rule.
3. `docs/worktrees-runbook.md`: stage names, and retiring a worktree. Its stages are all local now, so deleting the folder removes them; no Cloudflare records are left.
4. Grep for `dev_`, `e2e_`, `test_`, `wtNN`, `ALCHEMY_STATE`, `AuthSeed`, `seedAuth`, `-auth.sql`, `seedsFor`, `devStage` and `production` across `src`, `test`, `scripts`, `package.json`, `README.md`, `AGENTS.md` and the runbooks. Fix every hit (the README's `production` branch of the Cloudflare docs snapshot is not a stage; leave it). Leave research and plan docs alone: they are history.

Verify: the grep finds nothing outside `docs/*-research.md` and `docs/*-plan.md`.

## 14. Step 11: clean local leftovers

1. `vp run db:reset`. It removes `.alchemy/local` and `.alchemy/state` (taking the old `e2e_mw` and `test_mw` state and every orphaned simulator file) and restarts dev on `dev-mw`.
2. Remove the old underscore stages' log directories under `.alchemy/log/` (`dev`, `dev_mw`, `e2e_mw`, `test_mw`). Look first, and delete only those.

Verify: `ls .alchemy/state/*/` shows only dashed stages; `vp exec alchemy state list Alchemy-sandbox1 -r` shows only `staging/` (plus `dev_mw_wt01/` if step 0 had to keep it).

## 15. Final checks

- `vp check` passes.
- `vp test` passes twice in a row (unit, browser, integ), with no test stage left in `.alchemy/state` after either run.
- `vp run test:e2e` passes twice in a row, each run starting from a destroyed stage.
- The dev server runs on `dev-mw`, and the operator and a member can sign in.
- `vp exec alchemy plan --stage staging` shows only the changes listed in step 4. Nothing deployed.
- `git status` lists only the intended files. Nothing is committed.
- §16 and §17 filled in, writing "none" where empty.

Owed after this plan, not part of it:

- `wt-01`: after these changes are committed and `wt-01` is rebased, delete its `dev_mw_wt01` Cloudflare records if step 0 kept them, then run dev there and check it gets `dev-mw-wt-01` on `WEBSITE_PORT` 3901.
- Staging, after the next push to `main`: the deploy updates `AuthDb` (no `importFiles`), drops the `AuthSeed` record and runs `Seed` with the merged `seed/staging.sql`, all idempotent rows. Check that `support@mw10013.com` can still sign in.
- Whether to report the Vitest hook-order assumption in `alchemy/Test/Vitest` upstream is the user's call.

## 16. Deviations

Record each as: date, step, what the plan said, what was done, why.

- **2026-10-14, step 0.** `state list Alchemy-sandbox1 -r` before any deletion:

  ```
  Alchemy-sandbox1/dev_mw/AuthDb
  Alchemy-sandbox1/dev_mw/AuthSeed
  Alchemy-sandbox1/dev_mw/Backend
  Alchemy-sandbox1/dev_mw/BetterAuthMigrate
  Alchemy-sandbox1/dev_mw/BetterAuthSecret
  Alchemy-sandbox1/dev_mw/ShopifyApiSecret
  Alchemy-sandbox1/dev_mw/Website
  Alchemy-sandbox1/dev_mw/output
  Alchemy-sandbox1/staging/AuthDb
  Alchemy-sandbox1/staging/AuthSeed
  Alchemy-sandbox1/staging/Backend
  Alchemy-sandbox1/staging/BetterAuthMigrate
  Alchemy-sandbox1/staging/BetterAuthSecret
  Alchemy-sandbox1/staging/ShopifyApiSecret
  Alchemy-sandbox1/staging/Website
  Alchemy-sandbox1/staging/output
  ```

  The seven `dev_mw` records were deleted one at a time and `output` went with them. There were no `dev/` and no `dev_mw_wt01/` records, so nothing of `wt-01`'s was kept or deleted (its port 3901 was not listening). Nothing is owed in Cloudflare state for `wt-01`.

- **2026-10-14, step 1.** The `wt-NN` codec moved into `src/backend/stage.ts` as `Checkout`, so the rule lives once: `scripts/lib/worktree.ts` drops `WorktreeBranch` and `MAX_INDEX` (no other users) and builds `worktreeIndex`/`worktreeName` on `Checkout`. `PerDeveloperStage` is a `Schema.Union` of two `TemplateLiteralParser`s (`<env>-<user>` and `<env>-<user>-<checkout>`) decoded to `{ environment, user, checkout: Option<number> }`.
- **2026-10-14, step 2.** `scripts/stage.ts` takes `Argument.Literals("environment", PerDeveloper.literals)` rather than `Argument.String` piped through `Argument.withSchema(PerDeveloper)`: `withSchema` needs a codec whose encoded side is `string`, and `PerDeveloper`'s is the literal union (type error). On a bad or missing argument `effect/cli` prints its help to stdout and the error to stderr, exit 1, as `dev-stage.ts` did. `stageOf` with a fake checkout: `("dev","mw",{linked:true},"wt-01")` gives `dev-mw-wt-01`; `("dev","mw",{linked:true},"main")` fails "a linked worktree must be on a wt-NN branch to name a stage, got \"main\""; `("dev","Bad.name",{linked:false},"main")` fails "$USER must be lowercase letters and digits to name a stage, got \"Bad.name\""; `("test","mw",{linked:false},"feature")` gives `test-mw`; `("e2e","mw",{linked:true},"wt-12")` gives `e2e-mw-wt-12`. In a linked worktree with both a bad branch and a bad user, the branch is now reported first.
- **2026-10-14, step 3.** The verify said integ would still run on `test_mw`. It cannot: `seed` rejects `test_mw` through `environmentOf`. Step 3 was verified with `ALCHEMY_TEST_STAGE=test-mw vp test --project integ` (12 passed), ahead of step 6 setting it.
- **2026-10-14, step 4.** `vp exec alchemy plan --stage staging`:

  ```
  Plan: 3 to update, 2 tasks
  [AuthDb] update
  [Backend] update
  [Backend/AuthDb] noop
  [Backend/AuthEmail] noop
  [Backend/AuthOrigin] noop
  [Backend/MagicLinkDelivery] noop
  [Backend/ShopActor] noop
  [Backend/Shopify] noop
  [Backend/SignInLimit] noop
  [BetterAuthSecret] noop
  [ShopifyApiSecret] noop
  [Website] update
  [Website/BACKEND] noop
  [AuthSeed] drop [action]
  [Seed] run [action]
  ```

  `Backend` and `Website` show `update`, which the plan said should not happen; see §17. Every binding, `BetterAuthSecret` and `ShopifyApiSecret` are `noop`. The same plan from `HEAD` (a temporary detached worktree, removed afterwards) shows `Backend` update, `Website` update, `AuthDb` noop and `AuthSeed` run, so this work's own delta is exactly `AuthDb` update, `AuthSeed` drop, `Seed` run. The final-check plan after steps 5 to 11 is identical. `plan --stage live_mw` fails with `UnknownStage: stage "live_mw" belongs to no known environment`.

- **2026-10-14, step 4.** `alchemy state list|read|delete` without `--backend` now fails: the CLI loads the stack's `state` layer with the stage `placeholder`, which `stageState` rejects. The steps' `state list` checks were run as `alchemy state list Alchemy-sandbox1 -r --backend cloudflare` (and `--backend local`), and the README says so.
- **2026-10-14, step 4.** `wireBackend` takes the Backend as `Effect.Success<typeof Backend>` through `import type`, so `stack.ts` adds no runtime import of the Worker module beyond what the stacks already have.
- **2026-10-14, step 5.** The step 5 `db:reset` already removed the old `e2e_mw` and `test_mw` local state, which step 11 meant to do; step 11's `db:reset` then found only dashed stages.
- **2026-10-14, step 6.** The issued link's origin matched `backendUrl` (`http://localhost:57340` both), so `atBackend` and its JSDoc were removed. The same reused-stack workaround in `signIn` in `test/integ/actor-clients.ts` was removed too, and `authOrigin`'s JSDoc no longer claims a reused stack's port. Integ run times: 34.9 s and 37.1 s (Vitest duration; 36 s and 39 s wall), each with `created` on every deploy and `deleted` on every destroy, and no `Alchemy-sandbox1-test` directory under `.alchemy/state` afterwards.
- **2026-10-14, step 7.** `bash -c 'alchemy destroy --yes && exec alchemy dev'` under `vp run` works: Playwright's shutdown stops `alchemy dev`, no e2e process is left and `WEBSITE_PORT + 100` is free after each run. `alchemy destroy` on a stage with no state logs `Plan: no resources` and exits 0. So the first run after a state wipe logs no `deleted` (stage empty); every later run logs `5 to delete` then `5 to create`. `dev:status` during an e2e run reported only the dev server. A stale orphan `alchemy dev` from 2026-10-13 (`ALCHEMY_STAGE=e2e_mw`, ppid 1, not listening) from the old e2e setup was found and stopped.
- **2026-10-14, step 8.** Audit: no spec or integ test changes a seed row. Writes go to `@e2e.test` members, sessions the test created, and Durable Object state, which is not seeded. The gate test called `ResetData` because `ResetData` once inserted the operator's user row; the seed does that now, so the gate test needed nothing from it and the call was dropped. `auth.setup.ts` lost the reset and its `describe.configure({ mode: "serial" })`, whose only reason was running the reset before the sign-ins. `ResetData` was removed throughout (RPC, handler, `TestData` and its layer, Worker wiring, the unit test's stub layer and `it.todo`, and the JSDoc on `E2eEmail` and `TestControlRpcs`). Code that existed only because the integ stack survived between runs was dropped as well: `socket-facts.test.ts`'s pre-clean `RemoveMember` and its comment, and in `shop-actor.test.ts`'s RemoveMember test the `Effect.ignore` on `AddMember` and the trailing re-add. The e2e `ownMember` keeps its `Effect.ignore` (a Playwright retry reuses the worker-indexed name).
- **2026-10-14, step 9.** The fourth spec could not be written as planned: the Website's auth proxy route forwards only `GET /api/auth/magic-link/verify` and `POST /api/auth/sign-out`, so `get-session` through the Website is 404 by design. The spec asserts that allow-list (`get-session` is 404 for a signed-in member) instead. The fixture is `signIn(email: string)`, test-scoped over `request` and `backend`. It decodes the address with `EmailFromInput` and expects the verify response's 302. The specs use an empty `storageState`. A trace of the four specs shows only `APIRequestContext` calls, with no context or page.
- **2026-10-14, step 10.** Some grep hits were kept: `devStage` in `scripts/dev.ts` is the name step 2 asks for; `production` in `stage.ts` (the rule's JSDoc) and `stage.test.ts` (a rejected input) are intended; `production` in `scripts/refs.ts` is the Cloudflare docs branch, like the README's. Fixed outside the listed files: `docs/website-port-runbook.md` ("Staging and production need no `WEBSITE_PORT`") and the "never sets on production" JSDoc on `TestControlRpcs` and the Backend.
- **2026-10-14, step 11.** `.alchemy/log/probe-mw` (the research probe's) is not in the step's list and was left.
- **2026-10-14, final checks.** `vp check` passes; `vp test` passed twice (93 tests, 14 files) with no test stage left in `.alchemy/state`; `vp run test:e2e` passed twice (20 tests); dev runs on `dev-mw` and `a@a.com` and `m1@m.com` signed in; `state list --backend cloudflare` shows only `Alchemy-sandbox1/staging/` for this project; nothing committed or deployed.

## 17. Issues

Record each as: date, step, the problem, what was tried, current state.

- **2026-10-14, step 4.** The staging plan shows `Backend` and `Website` as `update`; the plan expected no change there. Cause: staging was last deployed from `b642c76` (`origin/main`), and the unpushed `699f3ad` changed Backend and Website code. Planning `HEAD` alone gives the same two updates. All their bindings are `noop`. Not stopped on, because the change does not come from this work; the next push deploys those code updates along with the `AuthDb`/`Seed` changes.
- **2026-10-14, step 9.** Once, after several e2e runs, the dev server answered every SSR request with 500: `ERR_FILE_NOT_FOUND_IN_OPTIMIZED_DEP_DIR` for `node_modules/.vite/deps_ssr/react-dom_server.js?v=…`. The dev and e2e servers in one checkout share Vite's optimized-deps cache, and the e2e server's re-optimization replaced the files the dev server had loaded. `vp run dev:stop && vp run dev` fixed it. It did not recur in the final checks (two e2e runs with dev running). It is probably older than this work, since dev and e2e have always shared the checkout. A per-stage Vite `cacheDir` would separate them; not attempted.
