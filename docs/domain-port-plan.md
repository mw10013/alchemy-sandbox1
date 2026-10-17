# Plan: the domain port (slices B and D)

Implements `docs/legacy-port-research.md` slices B (platform dialect) and D (shop work domain), under its decisions Q3, Q4, Q12 and Q13. Read that doc's §0 and §3 first; this plan does not restate the reasons.

This is a move, not a rewrite. Three pure legacy files become three files under `src/domain/`, with their JSDoc tables and their pure tests. No symbol is renamed, no rule reworded, no table edited, except where a step says so.

Legacy paths are relative to `refs/baton-legacy/`.

## 0. Rules for the implementer

- Follow `AGENTS.md`: Vite+ only (`vp`, never npm or npx); `vp check --fix` after every step; Effect Schema for parsing; `Match` for tag dispatch; `Schema.TaggedError`; `Effect.fn("name")`; JSDoc rules (no `//` above a declaration, no references to this plan, the research or any `docs/` file in code).
- Do not commit unless told to. Work in `wt-01` on its `wt-01` branch. Merging into `main` is done from the main checkout when told.
- Each step ends green: `vp check` and `vp test` (unit, browser, integ). e2e is not affected by this plan and is not run.
- Do not touch the `dev` or `staging` stages, `migrations/`, or `src/backend/shop-actor.ts`'s `0001_init`. Nothing here changes a table.
- Do not rewrite the steps. Record what you built differently, and what surprised you, in §7 as you go.
- Legacy's identifiers, rule tables and test titles are kept byte for byte unless a step says otherwise. A reviewer diffs each new file against the legacy range it came from and expects moved lines.
- Legacy's `Domain` barrel is gone (Q3). Importers name the context file: `src/domain/orders.ts`, never a re-export.
- `src/domain/` imports only `effect` and its sibling context files in the direction the map allows (§3). Nothing under `src/domain/` imports from `src/backend/`, `src/web/` or `src/contract/`.

## 1. Outcome

- `src/domain/platform.ts`, `src/domain/orders.ts` and `src/domain/shop-work.ts` hold legacy's `Platform.ts`, `Orders.ts` and `ShopWork.ts`, each opening with its vocabulary JSDoc and carrying every rule table.
- `src/contract/` imports its order, line-item and workflow shapes from `src/domain/` instead of defining its own (`LineItemProperty`, `WorkflowState`, the fixture's order fields).
- Legacy's pure domain tests run as unit tests under `test/unit/domain/`, with their titles unchanged.
- The spike in Step 5 has an answer, recorded in §7: whether the actor's repositories can be unit-tested over an in-process SQLite `SqlClient` layer.
- The glossary gains its domain-nouns section.

## 2. What this plan rests on

From the research (`legacy-port-research.md`) and a read of the legacy files on 2026-10-17:

- `Platform.ts` (581 lines) imports only `effect`. `Orders.ts` (489) imports `effect` and `retentionCutoff`, `ShopLimits`, `SqliteBoolean` from `Platform.ts`. `ShopWork.ts` (4,253) imports `effect`, nine names from `Orders.ts` and seven from `Platform.ts`. Nothing in the three reaches outside `src/lib/domain/`. So the move is mechanical, in the order platform, orders, shop work.
- `Billing.ts` is not in this plan (slice G). It imports only `Platform.ts`, so leaving it behind breaks nothing.
- Legacy's pure tests of these files are `test/integration/domain.test.ts` (1,416 lines, about 63 cases). It imports the barrel and one React helper, `closedReasonText` from `src/components/MemberRun.tsx`. `spec.test.ts`, `rules-lint.test.ts` and `run-actions.test.ts` depend on the spec tooling or workerd and are not ported here (Q4; the matrices get their real pins with slice F).
- "Pinned by" cells in the tables name an `it("…")` title. Without the checker, the rule is: a title in a cell is the title of a test somewhere under `test/`, byte for byte, as a string literal. A cell saying `(none yet)` has no test yet.

## 3. Names and constants

| Name                      | What                                                                                                                                                                                                                                                                                                            |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/domain/platform.ts`  | Legacy `src/lib/domain/Platform.ts`. The dialect: ids, `ShopLimits`, `WorkflowLimits`, `EpochMillis`, `SqliteBoolean`, `BoundedId`, formatting helpers, the connection and invalidation tables.                                                                                                                 |
| `src/domain/orders.ts`    | Legacy `src/lib/domain/Orders.ts`. What Shopify says about an order: `ShopOrder`, `OrderLineItem`, `LineItemProperty`, `OrderState`, `syncOrder` and its tables, `capProperties`, `BulkOperation`, `SyncState`.                                                                                                 |
| `src/domain/shop-work.ts` | Legacy `src/lib/domain/ShopWork.ts`. The core: runs, tasks, workflows, positions, issues, `runActions`, `taskActions`, `reconcileItem`, setup facts, the `*_LABEL` maps.                                                                                                                                        |
| The map                   | The context table from legacy `src/lib/Domain.ts` (context, kind, about, whose words, file, may import), moved to the JSDoc at the top of `platform.ts` since there is no barrel. Rows: shop work → orders, platform; orders → platform; billing (arrives with slice G) → orders, platform; platform → nothing. |
| `test/unit/domain/`       | The pure domain tests: `platform.test.ts`, `orders.test.ts`, `shop-work.test.ts`, split from legacy's `domain.test.ts` by the file under test.                                                                                                                                                                  |
| `no-restricted-imports`   | The oxlint rule in `vp check`'s config that enforces the map's import direction inside `src/domain/` and refuses `src/backend`, `src/web`, `src/contract` from it.                                                                                                                                              |

## 4. Steps

### Step 1: `src/domain/platform.ts`

- Create `src/domain/platform.ts` from legacy `src/lib/domain/Platform.ts`, whole. Keep the vocabulary JSDoc ("Vocabulary, platform", the nouns table) at the top.
- Prepend, above the vocabulary, the map: the context table from the top of legacy `src/lib/Domain.ts`, with the `file` column pointing at the three files here and a fourth row for billing marked as arriving later. Keep legacy's "Shared words" table beneath it. The map's first paragraph says the import direction is the `may import` cell and that `vp check` enforces it (Step 6).
- Symbols this repo already has elsewhere stay where they are for now and are not duplicated by name: legacy's `Shop` is this repo's `ShopKey` (`src/contract/shop.ts`); legacy's `Email` is `src/contract/auth.ts`'s. Port them under their legacy names anyway, unchanged, so `orders.ts` and `shop-work.ts` compile verbatim; a later step (§8) reconciles the duplicates once their callers exist. Say so on each duplicate's JSDoc, in one line, naming the sibling with backticks.
- Legacy's connection constants (`CONNECTION_*_HEADER`, `CONNECTION_CLOSE_*`) overlap this repo's `src/contract/shop-actor.ts`. Port them; do not delete the contract's. Note the overlap the same way.
- Tests: `test/unit/domain/platform.test.ts` with the `Platform` cases from legacy `test/integration/domain.test.ts` (the ones that import only platform symbols): `formatNumber`, `formatKilobytes`, `retentionCutoff`, `userIsAdmin`, `BoundedId`, the limits. Titles unchanged. Import from `../../../src/domain/platform.ts`.
- Verify: `vp check` green; `vp test` green.

### Step 2: `src/domain/orders.ts`

- Create `src/domain/orders.ts` from legacy `src/lib/domain/Orders.ts`, whole, importing `retentionCutoff`, `ShopLimits`, `SqliteBoolean` from `./platform.ts`. Keep the vocabulary JSDoc and the four tables on `syncOrder` (actions and invariant rules 1–18), `OrderState`, `orderIsOpen` and the rest unchanged.
- `src/contract/fixture.ts`: replace its own `LineItemProperty` with an import from `src/domain/orders.ts`, and re-export it from the contract so existing importers (`src/backend/fixture.ts`) keep working. If legacy's schema differs from the contract's (field names, caps), keep legacy's and record the difference in §7; the fixture file `fixture.ts` at the root must still decode.
- Tests: `test/unit/domain/orders.test.ts` with the `Orders` cases from legacy `domain.test.ts`: the `syncOrder` cases (legacy reads the actions table from the source with the spec tooling; here write the rows out as `it.each` data, one row per table line, with the row's text as the title so the table and the test still read the same), `capProperties`, `orderIsOpen` and friends, the `BulkOperation` decode.
- Verify: green. This step is the handoff point for the orders plan: once Steps 1 and 2 are merged to `main`, `docs/orders-slice-plan.md` Step 2 can start.

### Step 3: `src/domain/shop-work.ts`

- Create `src/domain/shop-work.ts` from legacy `src/lib/domain/ShopWork.ts`, whole: the 4,253 lines, the nine vocabulary tables, every rule table (`OrderIssue`, `RunState`, `ClosedReason`, `runIsBlocked`, the four on `reconcileItem`, the `runActions` and `taskActions` matrices, `SetupFacts`), the `*_LABEL` maps. Imports become `./orders.ts` and `./platform.ts`.
- `src/contract/fixture.ts`: `WorkflowState` and `FixtureTask`'s step and task fields take their schemas from `shop-work.ts` where legacy defines them (`WorkflowState`, the task shape), re-exported as above. Do not change the fixture's own structural checks (`stepsAreDense`, `referencesResolve`).
- Tests: `test/unit/domain/shop-work.test.ts` with the rest of legacy `domain.test.ts`. The one React import, `closedReasonText` from `MemberRun.tsx`, is a label function: port it as a pure function into `shop-work.ts` beside `ClosedReason` if it has no React in it, or drop those assertions and record which in §7.
- `taskStateOf`, `orderPosition`, `orderIssues`, `runIsBlocked`, `unitsToMake`, `itemMatches`, `matchedWorkflows`, `laterStepStarted`, `currentTasks`, `workflowsListFrom`, `setupFactHolds` each keep their legacy tests. The `runActions`, `taskActions` and `reconcileItem` matrices are **not** row-tested here: legacy's `run-actions.test.ts` drives repositories in workerd and comes with slice F. Say so in §7 and leave their `pinned by` cells as they are.
- Verify: green. Expect the type check to be the slow part; `shop-work.ts` is a large module.

### Step 4: Import-direction lint

- Add to the oxlint config that `vp check` runs a `no-restricted-imports` rule (or the nearest equivalent the installed oxlint supports; check `refs/vite-plus` for how `vp check` reads lint config) with these groups:
  - from any file under `src/domain/`: refuse `../backend/*`, `../web/*`, `../contract/*` and any `@/` alias into them;
  - from `src/domain/platform.ts`: refuse `./orders.ts`, `./shop-work.ts`, `./billing.ts`;
  - from `src/domain/orders.ts`: refuse `./shop-work.ts`, `./billing.ts`.
- Prove it bites: add a forbidden import, see `vp check` fail, remove it. Record the exact rule name and config shape in §7.
- Verify: green.

### Step 5: The repository-test spike (Q12)

A one-hour, time-boxed spike. Its code is reverted; its result is recorded in §7 and decides where the orders plan's repository tests go.

- Question: can code written against Effect's `SqlClient` (as `src/backend/shop-actor.ts`'s `loadFixture` is, and as legacy's `OrderRepository` is) run unchanged in a Node unit test over an in-process SQLite layer?
- Try, in this order, stopping at the first that works:
  1. `@effect/sql-sqlite-node` (better-sqlite3 under it) with `SqliteClient.layer({ filename: ":memory:" })`;
  2. `@effect/sql-sqlite-bun` is not an option (Node runs the tests);
  3. a wasm driver, if Effect 4 ships one (check `refs/effect/packages/`).
- The probe: a unit test that builds the layer, runs the actor's `0001_init` SQL from `shop-actor.ts` (export the migration record for the probe; revert if the spike fails), inserts one `ShopOrder` and two `OrderLineItem` rows inside `sql.withTransaction`, and reads them back with the `ShopOrder_open_idx` predicate. The partial index, `returning id`, `on conflict ... where excluded.updatedAt >= ShopOrder.updatedAt`, `json_extract` if any, and `insert or replace` are the SQLite features legacy's SQL uses; the probe must exercise each once.
- Record in §7: the dependency and version added, what passed, what differed from the DO's SQLite (if anything), and the verdict: **unit** (the orders plan's repository tests go to `test/unit/backend/` over this layer) or **integ** (they go through `IntegRpcs`).
- Add no dependency permanently in this step. If the verdict is unit, the orders plan adds the dependency in its own step.

### Step 6: Glossary and docs

- `docs/glossary.md`: add the "Domain" section the file promises, seeded from the nouns tables of the three files (the word, its meaning in one line, its context, and the symbol), with a line saying the full vocabulary lives in each context file's JSDoc. Fix the source-layout row for `src/domain/` from "arrives with the legacy port" to present tense.
- `docs/legacy-port-research.md` §3: mark B and D's status.
- Verify: `vp check` green.

## 5. Verification checklist

- `vp check` and `vp test` green after every step; the final run recorded in §7 with counts.
- `git diff --stat` against the legacy files: the three domain files are almost entirely moved lines (a reviewer diffs `src/domain/orders.ts` against `refs/baton-legacy/src/lib/domain/Orders.ts` and sees only the import lines and the duplicate notes change).
- Every `pinned by` title that names a test ported here exists under `test/unit/domain/` byte for byte: `grep -rF "<title>" test/unit/domain/` for a sample of ten.
- `grep -rn "from \"\.\./backend\|from \"\.\./web\|from \"\.\./contract" src/domain/` is empty, and Step 4's rule refuses it.
- The root `fixture.ts` still decodes through `ShopFixtureData` (`vp run fixture` is not run; the unit test `test/unit/fixture.test.ts` covers it).

## 6. Done when

- The three files exist with their tables, the unit tests pass, the lint rule bites, the spike verdict is in §7, and `wt-01` is ready to merge with no conflict against `main`'s `src/backend/` or `src/web/`.

## 7. Deviations and issues

For the implementer. Append as you go. Keep each entry short, dated and tagged with its step. A deviation is anything built differently from the step that specified it. An issue is anything the plan did not predict: a failing assumption, an API that behaves differently, a test that cannot be written as described. Command results go under their own heading with the counts and times.

### Deviations

### Issues

### Command results

### Spike verdict (Step 5)

### Implementation review

## 8. Out of scope

- Reconciling the duplicates between `src/domain/platform.ts` and `src/contract/` (`Shop` vs `ShopKey`, `Email`, the connection constants). That happens when the first consumer of each moves, in the slice that moves it; until then both exist and the JSDoc notes say so.
- `billing.ts` (slice G) and legacy's `Screen.ts` tables (slice J).
- The spec checker, rules lint and vocabulary audits (Q4).
- Row-testing the `runActions`, `taskActions` and `reconcileItem` matrices (slice F, with the repositories they drive).
