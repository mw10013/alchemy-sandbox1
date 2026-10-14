# Plan: per-checkout dev stages and the operator seed

Plan date: 2026-10-14 · Alchemy `2.0.0-beta.81` · Base commit `9ff1307`.
Research: [dev stages research](./dev-stages-research.md). Every question there is answered; this plan implements the answers. Read the research first: it explains why each step exists.

## 0. Rules for the implementer

- Follow `AGENTS.md`: Vite+ only (`vp`, never npm/npx), Effect idioms (Schema, `Match`, `Effect.fn`), its comment rules (JSDoc on symbols, no references to plans or research docs in code or comments).
- **No commits, no pushes, no staging deploy.** A push to `main` deploys staging.
- **Do not touch the `wt-01` worktree** or its server.
- Run `vp check --fix` after code changes.
- Work in the step order. Each step ends green (`vp check`, the tests named in it) before the next starts.
- Anything that differs from this plan, or any problem you could not solve, goes in §7 (Deviations) or §8 (Issues), with the date and step. Do not silently change the design; if a step cannot work as written, stop that step, record why, and continue with what does not depend on it.

## 1. Outcome

- `vp run dev` runs `alchemy dev --stage dev_<user>` on the main checkout and `dev_<user>_wtNN` in worktree `wt-NN`.
- Every fresh database, on every stage, gets the operator's Better Auth `user` row from a seed file, through an Alchemy Action that runs after Better Auth's migration. No manual insert anywhere.
- `dev_*` stages get `seed/dev.sql`.
- The old shared `dev` stage is gone from Alchemy's state.

## 2. Step 1: the `AuthSeed` Action

### 2.1 Why an Action, and how it is ordered

`importFiles` on `AuthDb` runs inside the D1 resource, before `BetterAuthMigrate` creates Better Auth's tables, so it cannot insert a `user` row on a fresh database. An Action runs after whatever its input depends on.

Order: `AuthDb` → `BetterAuthMigrate` → `Backend` → `AuthSeed`. The Backend already depends on the migration: `registerMigration` binds the migration result into the host's env (`refs/alchemy/packages/better-auth/src/Migrate.ts`). `AuthSeed` takes an Output of the Backend (`backend.url`) in its input, so it runs after the Backend, hence after the migration.

Proof that an Action can seed the local simulator under `alchemy dev`: Alchemy's own test "QueryDatabaseLocal Action seeds the local simulator in dev" in `refs/alchemy/packages/alchemy/test/Cloudflare/D1/Database.local.test.ts`. Copy its shape: `Cloudflare.D1.QueryDatabase(db)` in the Action's constructor, `.pipe(Effect.provide(Cloudflare.D1.QueryDatabaseLocal))`.

@see `refs/alchemy/website/src/content/docs/infrastructure-as-code/action.mdx`, "Binding resources" and "Lifecycle"

### 2.2 Seed files

New files, same header-comment style as the existing seeds:

| File                    | Rows                                                 |
| ----------------------- | ---------------------------------------------------- |
| `seed/dev-auth.sql`     | `a@a.com`, id `user-admin`, name `Admin`             |
| `seed/test-auth.sql`    | the same row                                         |
| `seed/staging-auth.sql` | `support@mw10013.com`, id `user-admin`, name `Admin` |

Each row: `INSERT OR IGNORE INTO "user" (id, name, email, emailVerified, role, banned, createdAt, updatedAt) VALUES (…, 1, 'admin', 0, '<iso>', '<iso>');`. Dates are ISO text and booleans 0/1, as Better Auth stores them (`TestData.reset`'s insert in `src/backend/test-control.ts` is the template). Use a **fixed** ISO timestamp, not "now", so the file and its hash stay stable.

Production has no auth seed file: production is not deployed yet. Its mapping returns none and `AuthSeed` is not registered on production. Record in §8 that `seed/production.sql`, which `seedFile` already names, does not exist either.

### 2.3 Code

In `src/backend/resources.ts`:

- Replace `seedFile` with one stage → seed mapping that yields both files: the data seed (for `importFiles`) and the optional auth seed. Step 2 changes how `dev_*` stages map; you may do both in one edit, but verify each.
- Export `AuthSeed`: an `Action` whose constructor yields `Cloudflare.D1.QueryDatabase(AuthDb)` and provides `Cloudflare.D1.QueryDatabaseLocal`, and whose runner executes the auth seed's SQL.
- Export one effect (for example `seedAuth(backend)`) that both stacks call after yielding the Backend. It reads the stage, picks the auth seed file, reads the file, and registers `AuthSeed` with input `{ databaseId: <AuthDb's databaseId>, backendUrl: backend.url, sql: <file contents> }`. The file contents in the input make an edited file re-run the Action, as `importFiles` re-runs a changed file. The database id makes a recreated database re-seed.
- How the SQL runs: `client.exec(sql)` if D1's `exec` takes the whole file; otherwise split into statements and use `prepare(...).run()` or `batch`. Verify on the local simulator; note the choice in §7 if it is not `exec`.
- Read the file with Effect's `FileSystem` if it is available during stack evaluation; otherwise the way `importFiles` resolves paths. Note what you used.
- JSDoc: move the "why the seed cannot insert the operator" rule onto `AuthSeed` (it is the symbol that enforces it), and make `AuthDb`'s JSDoc `{@link AuthSeed}` it instead of naming `TestData`.

Call `seedAuth(backend)` from:

- `alchemy.run.ts`, after `const backend = yield* Backend;`
- `test/integ/stack.ts`, after its Backend.

### 2.4 Remove the old workarounds

- `src/backend/test-control.ts`: `TestData.reset` no longer inserts the operator; delete `OPERATOR` if nothing else uses it. Reset still deletes only `@e2e.test` users, so the seeded operator survives a reset. Update the JSDoc on `TestData` and the reset.
- `test/unit/backend/test-control.test.ts`: the test "ResetData … restores the operator" changes to: the operator survives `ResetData`. Read it first; if it deletes the operator and expects reset to bring it back, change it to assert the seeded operator is still there after a reset.
- `test/integ/shop-actor.test.ts`: the comment "The operator's user row comes from ResetData" now points at the seed.
- Comments that say a seed cannot insert the operator: `seed/dev.sql`, `seed/test.sql`, `seed/staging.sql` headers, `src/backend/auth.ts` (the `Auth` JSDoc, "put there by seed or test data"), `test/unit/backend/auth.test.ts` and `api.test.ts` where they describe the seeded operator. Make them accurate; link `AuthSeed` where a symbol is in scope, otherwise name it in backticks.
- `scripts/dev.ts`: `AUTH_DB_STATE` also lists `AuthSeed`'s record (`<stack>/<stage>/AuthSeed`; confirm the record name with `vp exec alchemy state list <stack>/<stage> -r` after a run), so `db:reset` re-seeds.

### 2.5 Verify step 1

- `vp check`, `vp test` (unit, browser, integ), `vp run test:e2e`. The e2e and integ stages use local state and fresh databases, so they exercise `AuthSeed` end to end; the operator sign-ins in `test/e2e/auth.setup.ts` and `test/integ/shop-actor.test.ts` must pass without the reset insert.
- In the alchemy output or logs, `AuthSeed` runs after `BetterAuthMigrate` on a fresh stage.

## 3. Step 2: seed selection for `dev_*` stages

In the mapping from 2.3: stage `dev` and any stage starting with `dev_` map to the dev seeds (`seed/dev.sql`, `seed/dev-auth.sql`); `staging` and `production` keep theirs; everything else gets the test seeds. Use `Match` with a Schema predicate for the prefix (for example `Schema.is(Schema.TemplateLiteral(["dev_", Schema.String]))`), not a hand-written `startsWith` or regex. Update the mapping's JSDoc.

Verify: `vp check`, `vp test`.

## 4. Step 3: one dev stage per checkout

### 4.1 The stage

| Checkout                          | Stage                                         |
| --------------------------------- | --------------------------------------------- |
| main checkout                     | `dev_<user>`                                  |
| linked worktree on branch `wt-NN` | `dev_<user>_wtNN` (for example `dev_mw_wt01`) |

- `<user>` is `$USER`, as for Alchemy's own default and `playwright.config.ts`. Decode it with Schema to lowercase letters and digits only; fail with a clear message otherwise (never fall back to `unknown`).
- Underscores only between parts; no dashes.

### 4.2 Code

- `scripts/lib/worktree.ts`: export an effect `devStage` built on `checkoutKind`, `currentBranch` and `worktreeIndex`/`worktreeName` (already there). The main checkout is the main checkout whatever branch it is on.
- `scripts/dev-stage.ts` (new): prints `devStage`, nothing else, non-zero exit with the message on failure. Same CLI style as the other scripts.
- `package.json`, `dev:alchemy`: compute the stage first so a failure stops the script, for example `stage=$(node scripts/dev-stage.ts) && mkdir -p ./.logs/dev && NO_COLOR=1 alchemy dev --stage "$stage" 2>&1 | s6-log …`. Keep it inside the existing `bash -o pipefail -c '…'`.
- `scripts/dev.ts`:
  - `SERVER_PROCESS` becomes `alchemy dev --stage <devStage>`, resolved once at startup. Both `serverPids` (pgrep) and `findServerPane` use it. Playwright's e2e server passes its stage through `ALCHEMY_STAGE`, so its command line has no `--stage` and stays unmatched; keep that true and keep the JSDoc saying why.
  - `AUTH_DB_STATE` is built from the stage: `Alchemy-sandbox1/<stage>/AuthDb`, `…/BetterAuthMigrate`, `…/AuthSeed`.
  - Update the file's header JSDoc where it mentions the stage.
- `README.md`: "The server is `alchemy dev` under stage `dev`" → the per-checkout stage; delete the paragraph about inserting the operator by hand (the operator now comes from the seed).
- `grep` for other uses of the literal stage `dev` (`"dev"`, `/dev/`, `--stage dev`) in `src/`, `scripts/`, `test/`, `alchemy.run.ts`, `README.md`, `AGENTS.md` and fix them. Leave `docs/` alone apart from this plan.

### 4.3 Verify step 3

- `node scripts/dev-stage.ts` on main prints `dev_mw`.
- `vp run dev` on main: the server runs under `dev_mw` (`vp run dev:status`, `.logs/dev/current`); `vp exec alchemy state list Alchemy-sandbox1/dev_mw -r` lists `AuthDb`, `BetterAuthMigrate`, `AuthSeed`, `Backend`, `Website`, and the rest.
- The operator row exists in the new local D1 (`sqlite3` on the files under `.alchemy/local/d1`, `select email, role from "user"`), and `a@a.com` signs in at `/sign-in` with the inline link and lands on the admin side. A member (`m1@m.com`) signs in too.
- `vp run dev:stop`, `vp run dev:status` and `vp run dev` again find and adopt the right server.
- `vp run db:reset`: forgets the three records, recreates the database, and the operator can sign in again.
- `vp run test:e2e` still passes with the dev server running (its server must not be adopted or stopped by `scripts/dev.ts`).
- The worktree case cannot be run here (rule 0: `wt-01` is not touched, and it does not have these changes). Check the `wt-NN` branch of `devStage` by reading the code carefully and, if it is cheap, by calling the stage function with a fake checkout; record in §8 that a real worktree run is still owed.

## 5. Step 4: remove the old `dev` stage

Only after step 3 verifies on main.

1. `vp run dev:stop`.
2. Delete each remote record listed by `vp exec alchemy state list Alchemy-sandbox1/dev -r` with `vp exec alchemy state delete <record> --no-input`. On 2026-10-14 they were `AuthDb`, `Backend`, `BetterAuthMigrate`, `BetterAuthSecret`, `ShopifyApiSecret`, `Website`, `output`. All describe local resources; nothing in Cloudflare is touched. Do **not** touch `Alchemy-sandbox1/staging`.
3. Remove the old stage's local files: the `.alchemy/local` entries whose names contain `-dev-` (not `-dev-mw-`), and the old dev D1 file. D1 files are named by hash, so if you cannot tell which one is the old dev database, remove `.alchemy/local` entirely, as `db:reset` does, and note it; the e2e and test stages recreate theirs.
4. `vp exec alchemy state list Alchemy-sandbox1` shows `dev_mw/` and `staging/`, no `dev/`.
5. `vp run dev` once more; the operator signs in.

## 6. Final checks

- `vp check`, `vp test`, `vp run test:e2e` all green.
- `git status` lists only the intended files; nothing committed.
- §7 and §8 filled in, including "none" if empty.

Owed after this plan, not part of it: a real worktree run (after the changes are committed and `wt-01` is rebased), and a staging check after the next push that `support@mw10013.com` signs in.

## 7. Deviations

Record each as: date, step, what the plan said, what was done, why.

- 2026-10-14, step 1: the plan puts `AuthSeed` and `seedAuth` in `src/backend/resources.ts`. They are in `src/backend/auth-seed.ts` (new). With `Cloudflare.D1.QueryDatabaseLocal` imported by `resources.ts`, the Backend bundle (which imports `AuthDb`) pulled in the `workerd` binary resolver and the Backend failed to boot in workerd (`t.resolve is not a function`; integ tests got 502). `AuthDb`'s JSDoc names `AuthSeed` in backticks rather than `{@link}`, because linking would need an import.
- 2026-10-14, step 1: SQL runs through `client.exec(sql)` with the whole file (as planned); the seed files are comment lines plus one single-line statement each. Files are read with Effect's `FileSystem` (`effect/FileSystem`), relative to the process cwd like `importFiles`; a read failure is `Effect.orDie` because the stack's error type is `ConfigError`.
- 2026-10-14, steps 1 and 2: done in one edit, as the plan allows. `seedsFor` (exported from `resources.ts`) returns `{ data, auth: Option }`; `production` maps to `./seed/production.sql` with no auth seed.
- 2026-10-14, step 1: `AuthSeed`'s input holds `backendUrl: backend.url.as<string>()`; `seedAuth` takes any value with an `Output<string | undefined>` `url`.
- 2026-10-14, step 1: `AuthSeed`'s state record is named `AuthSeed` (confirmed with `alchemy state list ... -r`). The `ResetData` JSDoc in `src/contract/test-control.ts` and the README test paragraph also changed (no longer "puts back the operator").
- 2026-10-14, step 3: `SERVER_PROCESS` is not `alchemy dev --stage <stage>`. The `dev:alchemy` script's shell holds `--stage "$stage"` unexpanded, and Alchemy's CLI process shows `.../alchemy/bin/cli.js dev --stage <stage>`, so `scripts/dev.ts` now matches `cli.js dev --stage <stage>` (`serverProcess`, an effect that resolves the stage once through `Effect.cached`). A stage that is a prefix of another (`dev_mw`, `dev_mw_wt01`) matches both; the existing working-directory check separates them.
- 2026-10-14, step 4: the old stage's local files were not removed separately. The earlier `vp run db:reset` (step 3 verification) had already removed all of `.alchemy/local`, which held them. `Alchemy-sandbox1/dev/output` cannot be deleted on its own (`output cannot be deleted independently`); `state list Alchemy-sandbox1` no longer shows `dev/` after the other six were deleted.

- 2026-10-14, review: the server match drops `cli.js` (Alchemy's launcher file name, which an upgrade could change) and is now ` dev --stage <stage>`; the working-directory check still separates checkouts. `dev:status`, `db:reset` and the restart found the server with it.

## 8. Issues

Record each as: date, step, the problem, what was tried, current state.

- 2026-10-14, step 3: transition. The server started before this change ran under `--stage dev`, which the new `dev:stop` pattern no longer matches. `dev:stop` freed the port (it also stops port listeners) but left that run's `alchemy dev` and `s6-log` alive, and the new server failed on `s6-log: unable to lock ./.logs/dev/lock`. Fixed by pressing Ctrl-C in its herdr pane (what `dev:stop` does for a pane). Anyone with an old-style server running must stop it by hand once.
- 2026-10-14, step 3: pre-existing hazard, not caused by this change. `vp run db:reset` removes all of `.alchemy/local`, including the e2e and integ stages' D1 files, while their local state records (`AuthDb`, `BetterAuthMigrate`, now `AuthSeed`) stay. The next `vp run test:e2e` then fails in `reset data` (`SqlError`), and integ would too. Recovered by `ALCHEMY_STATE=local vp exec alchemy state delete <stack>/<stage>/<id> --no-input` for those three records on `Alchemy-sandbox1/e2e_mw` and `Alchemy-sandbox1-test/test_mw`; both then redeployed with fresh databases, seeded by `AuthSeed` alone. Fixed in review: `db:reset` also removes `.alchemy/state` (only local-state stages live there, all with local resources); after a reset, `vp test` (80 passed) and `vp run test:e2e` (17 passed) ran clean with no manual step.
- 2026-10-14, step 3: the `wt-NN` branch of `devStageOf` was exercised only with a fake checkout (`wt-01` gives `dev_mw_wt01`, `wt-12` gives `dev_mw_wt12`, a linked worktree on another branch fails, `$USER` of `Bad.name` or unset fails). A real worktree run is still owed, after the changes are committed and `wt-01` is rebased.
- 2026-10-14, step 1: the remote path of `AuthSeed` is untested: it runs `exec` over the D1 HTTP API on staging, where a multi-line file (comment lines and a statement) goes through Cloudflare's query endpoint. Check on the next staging deploy that `support@mw10013.com` signs in. `seed/production.sql`, which `seedsFor` names for production, does not exist; production has no auth seed and `seedAuth` registers nothing there.
- 2026-10-14, final: `alchemy 2.0.0-beta.83` is out; the repo is on `beta.81`. Not touched.
