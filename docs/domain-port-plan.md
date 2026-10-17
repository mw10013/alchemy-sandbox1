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

### Plan review (2026-10-17, lead)

Checked against this checkout at `7ab5028` and `refs/baton-legacy/`. Baseline before any change: `vp check` green (205 files formatted, 162 linted), `vp test` 30 files / 270 tests passed in 31 s. §2's line counts and import lists hold (Platform 581, Orders 489, ShopWork 4,253, `domain.test.ts` 1,416; ShopWork imports 9 names from Orders and 7 from Platform). What is wrong or missing, and the change to each step:

- **All steps, imports.** This repo's lint refuses the `effect` barrel (`effectBarrel` in `vite.config.ts`). Legacy's `import { Schema, SchemaGetter, Struct } from "effect"` becomes one `import * as X from "effect/X"` per module; uses (`Schema.…`) stay byte for byte. Legacy tests import `vitest` and `@effect/vitest/utils`; ported tests import `describe`/`it`/`assert` from `@effect/vitest` like the rest of `test/unit/`, and `deepStrictEqual`/`strictEqual` from `@effect/vitest/utils` stay if they resolve. No `@/` alias exists here; imports are relative.
- **All steps, formatting.** Legacy formats at `printWidth: 80`, this repo at oxfmt's default (100), so `vp check --fix` reflows code lines (JSDoc comment text is left alone). The reviewer diff in §5 therefore compares the new file with a copy of the legacy file formatted by this repo's formatter, not with the raw legacy file.
- **Step 1, map.** Legacy `Domain.ts`'s top JSDoc holds more than the context table and Shared words: shape families, the word rules, the "where a stored name is not the word" list and the Screens table, several of which describe `scripts/rules-lint.ts` and `pnpm spec check`, which do not port (Q4). The map ports the context table, its paragraph (rewritten to say the direction is the `may import` cell and `vp check` enforces it), and Shared words, as the step says; the other blocks are left behind and listed under Deviations.
- **Step 1, tests.** Legacy `domain.test.ts` has **no** case for `formatNumber`, `formatKilobytes`, `retentionCutoff`, `userIsAdmin` or `BoundedId`, and "the limits" cases (`membersAtCeiling`, `openOrdersAtCeiling`, `seatEventValue`) test `Billing.ts`, which is slice G. Change: `platform.test.ts` gets a few new, plainly titled cases for those five pure helpers (new titles, not ported; recorded as a deviation); the three billing cases are not ported and go with `billing.ts`.
- **Step 1, duplicates.** Confirmed: contract `Email` (`src/contract/auth.ts`), `ShopKey` (`src/contract/shop.ts`), and `CONNECTION_CLOSE_FORBIDDEN`, `CONNECTION_CLOSE_REVOKED`, `CONNECTION_CLOSE_DISPLACED` (`src/contract/shop-actor.ts`, same values). Legacy's `CONNECTION_*_HEADER` constants (`x-baton-*`) have no counterpart: the contract has one `CONNECTION_HEADER` (`x-actor-connection`) instead; note that on them. `ConnectionRole` overlaps the contract's `ConnectionCaller`; `InvalidatedMessage` overlaps `Notice`; note both the same way.
- **Step 2, tests.** Legacy `domain.test.ts` has no `syncOrder`, `orderIsOpen`/friends or `BulkOperation` cases. The `syncOrder` action rows are tested in legacy `run-actions.test.ts` ("Domain.syncOrder actions"), purely, over the parsed table: each row's title is its five cells joined with `|`, and each `any` expands to every word of its column. Change: port that describe as `it.each` over the five rows written out, titles exactly the cells joined with `|`, the expansion written as data. `capProperties` and "the orders index's sync state" (`OrdersSyncStatus`) port from `domain.test.ts`. No `orderIsOpen` or `BulkOperation` case exists; none is invented. The sources, endings and invariant tables' `pinned by` titles are workerd tests (slice A); their cells stay as they are.
- **Step 2, fixture.** Legacy `LineItemProperty` is identical to the contract's (`key: String`, `value: NullOr(String)`). The contract re-exports it; `src/backend/fixture.ts` keeps importing it from the contract.
- **Step 3, fixture.** `WorkflowState` is identical in both; import and re-export it. Legacy's task fields are `TaskName` and `TaskInstructions` (branded, **trim on decode**, length-capped), where the contract's `Name` refuses untrimmed text and has no cap; legacy's `step` is a bare `Schema.Number`, weaker than the contract's. Change: `FixtureTask.name` and `instructions` take `TaskName` and `TaskInstructions` if `fixture.ts` still decodes and `src/backend/fixture.ts` compiles; `step` keeps the contract's own check. The semantic shift (trim instead of refuse) is recorded as a deviation.
- **Step 3, `closedReasonText`.** It is pure (`Match` only, no React; `MemberRun.tsx` lines around its JSDoc). Port it with its JSDoc into `shop-work.ts` after `ClosedReason`: the one block of added lines in that file.
- **Step 3, tests.** Port everything else in `domain.test.ts` except the three billing cases above. The `taskActions` cases in `domain.test.ts` are pure and port; only the matrix-row tests in `run-actions.test.ts` wait for slice F.
- **Step 4, config.** Lint config is the `lint` block in `vite.config.ts` (no `.oxlintrc.json` here). An override's `no-restricted-imports` replaces the base options, so each `src/domain/` override carries `effectBarrel` again, as `runtimeBoundary` does. Oxlint matches overrides by glob, so the `platform.ts` and `orders.ts` groups are per-file overrides that also repeat the directory group; the implementer confirms which override wins when two match.
- **Step 5, driver.** `@effect/sql-sqlite-node` 4.0.1 runs on `node:sqlite` (`DatabaseSync`), not better-sqlite3: no native build, no `allowBuilds` entry. `@effect/sql-sqlite-wasm` 4.0.1 also exists. The migration record is `migrations` in `shop-actor.ts`, not exported today; the probe exports it and the revert removes the export.
- **Step 6.** No change.
- **§5.** The `test/unit/fixture.test.ts` named there exists (as does `test/unit/contract/fixture.test.ts`); both must stay green.

### Deviations

- 2026-10-17 [Step 1] The map's paragraphs and tables ported from legacy `Domain.ts`: the "Vocabulary." intro, the Contexts paragraph (rewritten: an importer names the context file; the `may import` cell is the direction and `vp check` enforces it; no barrel, no `rules-lint`), the context table (file column `shop-work.ts`, `orders.ts`, `` `billing.ts` (arrives later) ``, `platform.ts`), the "Shop work is downstream" paragraph and Shared words. Left behind: the first JSDoc block's bullets (where a rule is stated, `rules-lint`'s refusals, which word a site speaks), Shape families, the word rules ("What a word must pass"), "Where a stored name is not the word", the Screens table and its closing paragraph (`ORDERS_SHOW_LABEL`, `workflowsListStates.ts`).
- 2026-10-17 [Step 1] The map and Platform's vocabulary are one top-of-file JSDoc ending in `@module` (as `src/contract/fixture.ts` does): legacy had the map in `Domain.ts` above `export *` and Platform's vocabulary as an untagged block above its import. The map comes first, then a blank line, then "Vocabulary, platform." unchanged.
- 2026-10-17 [Step 1] Duplicate notes name the sibling as "the contract's `X`" with no file name (AGENTS.md: a symbol in backticks, never a file name): `Shop` (`ShopKey`), `Email`, `ConnectionRole` (`ConnectionCaller`), the four `CONNECTION_*_HEADER` (one `CONNECTION_HEADER`, `x-actor-connection`), `CONNECTION_CLOSE_FORBIDDEN`/`REVOKED` (one note on their shared JSDoc), `CONNECTION_CLOSE_DISPLACED`, `InvalidatedMessage` (`Notice`). `Shop` had no JSDoc and got a one-line one; the rest are a new last paragraph.
- 2026-10-17 [Step 1] `test/unit/domain/platform.test.ts` is new, not ported (legacy has no case for these): describes `formatNumber`, `formatKilobytes`, `retentionCutoff`, `userIsAdmin`, `BoundedId`, one `it` each ("groups digits the en-US way and prints no fraction", "prints whole kilobytes of 1,024 bytes", "is the retention window in days before now", "only the admin role is an admin", "an id is non-empty and at most 128 characters"). Legacy's `membersAtCeiling`, `openOrdersAtCeiling` and `seatEventValue` cases test `Billing.ts` and are not ported; they go with `billing.ts`.
- 2026-10-17 [Step 2] `orders.ts`'s top-of-file vocabulary block gains `@module`, as `platform.ts`'s does; otherwise only the import lines change (plus the formatter's reflow).
- 2026-10-17 [Step 2] `src/contract/fixture.ts` imports `LineItemProperty` from `../domain/orders.ts` and re-exports it with `export { LineItemProperty }`; the contract's own definition and its one-line JSDoc are deleted (the schemas were identical, so nothing else changed). `src/backend/fixture.ts` is unchanged.
- 2026-10-17 [Step 2] Ported tests call the functions by name (`capProperties`, `syncOrder`, `retentionCutoff`, `ShopLimits`, `OrdersSyncStatus`) instead of `Domain.…`, since there is no barrel; describe and it titles are legacy's byte for byte, including the `Domain.` prefix in describe titles. The `capProperties` helper's JSDoc says `ShopLimits.maxPropertiesBytesPerItem` without `Domain.`.
- 2026-10-17 [Step 2] "Domain.syncOrder actions" is a `for` loop of `it` over `SYNC_ROWS`, as legacy's is, not `it.each` (keeps the title a plain string, no `$` interpolation). Each row carries `title`, `action` (`tag`, `note`) and `fixtures` written out (4, 2, 2, 4, 4 inputs); the five titles were checked against the table by splitting its rows as `cellsOf` does.
- 2026-10-17 [Step 2] "the orders index's sync state" keeps only its first assertion (`OrdersSyncStatus`'s fields). The second, `OrdersIndexData.fields.syncState === OrdersSyncStatus`, reads `OrdersIndexData` in shop work, which arrives in Step 3; Step 3 adds it back to this test (importing `shop-work.ts` from `orders.test.ts`, or moving the case to `shop-work.test.ts`).
- 2026-10-17 [Step 3] Legacy `ShopWork.ts` opens with two JSDoc blocks before its import (the vocabulary, then the note on action tables and lists, which attached to the import). They are one top-of-file block here, the second as its last paragraph, ending in `@module`. Imports are `effect/Match`, `effect/Schema`, `effect/SchemaGetter`, `effect/Struct`, `./orders.ts`, `./platform.ts`; no other line changed but the formatter's.
- 2026-10-17 [Step 3] `closedReasonText` and its JSDoc moved from legacy `MemberRun.tsx` into `shop-work.ts` right after `ClosedReason`; `Domain.ClosedReason`/`Domain.ConnectionRole` became `ClosedReason`/`ConnectionRole`, also in its `{@link}`.
- 2026-10-17 [Step 3] `src/contract/fixture.ts` imports and re-exports `WorkflowState` (identical) from `../domain/shop-work.ts`; `FixtureTask.name` is `TaskName` and `instructions` is `TaskInstructions`. Semantic shift: the contract's `Name` refused untrimmed text and had no cap; these trim on decode, brand, and cap (64 and 500 characters). `step`, `team`, `stepsAreDense` and `referencesResolve` are unchanged. The root `fixture.ts` still decodes and `src/backend/fixture.ts` compiled with no change (it reads the decoded fields as strings).
- 2026-10-17 [Step 3] `test/unit/domain/shop-work.test.ts` is legacy `domain.test.ts` minus `capProperties` (Step 2) and the three billing describes. `Domain.X` became `ShopWork.X`, `Orders.X` or `Platform.X` (namespace imports, one per context file) in code and comments, never in a string: named imports would collide with the test's own local helpers (`multiMatchItems`, for one, wraps the function it is named after). `closedReasonText` is `ShopWork.closedReasonText`. A title check over all three test files finds every legacy describe/it title but the six billing ones.
- 2026-10-17 [Step 3] "the orders index's sync state" moved whole, both assertions, from `orders.test.ts` to `shop-work.test.ts`, since its second assertion reads `OrdersIndexData`; the title exists once.
- 2026-10-17 [Step 3] The `runActions`, `taskActions` and `reconcileItem` matrices are not row-tested here: legacy's `run-actions.test.ts` drives repositories in workerd and comes with slice F. Their `pinned by` cells are unchanged.

### Issues

- 2026-10-17 [Step 1] `platform.ts` keeps legacy's `{@link}`s to symbols not in scope: `itemPiece` (shop work, which platform may not import), `D1_TABLES` and `initializeSchema` (legacy backend modules, never ported here). Lint does not check `{@link}` targets, so they pass; they are moved lines and stay. Whoever reconciles them should turn them into backticks.
- 2026-10-17 [Step 2] `orders.ts` keeps two moved JSDoc lines that point at the map's Shape families table "on the map in `Domain.ts`" (`SyncOrderResult`, `OrdersSyncResult`); that table was left behind in Step 1 and the file does not exist here. Left as moved lines; whoever reconciles the shapes should reword them.
- 2026-10-17 [Step 3] The step says `unitsToMake`, `itemMatches`, `laterStepStarted`, `workflowsListFrom` and `setupFactHolds` "keep their legacy tests"; legacy `domain.test.ts` has no case naming any of them (they are exercised through workerd tests: `order-repository`, `run-repository`, `setup-facts`). Nothing was invented; they wait for the slices that port those tests.

### Command results

- 2026-10-17 [Step 1] `vp check`: 207 files formatted, 164 linted, green. `vp test`: 31 files / 275 tests passed, 28.3 s.
- 2026-10-17 [Step 2] `vp check`: 209 files formatted, 166 linted, green. `vp test`: 32 files / 282 tests passed, 24.7 s.
- CHECKPOINT: Steps 1–2 ready to merge (db9dd05)
- 2026-10-17 [Step 3] `vp check`: 168 files linted, green. `vp test`: 33 files / 352 tests passed, 27.9 s.

### Spike verdict (Step 5)

### Implementation review

## 8. Out of scope

- Reconciling the duplicates between `src/domain/platform.ts` and `src/contract/` (`Shop` vs `ShopKey`, `Email`, the connection constants). That happens when the first consumer of each moves, in the slice that moves it; until then both exist and the JSDoc notes say so.
- `billing.ts` (slice G) and legacy's `Screen.ts` tables (slice J).
- The spec checker, rules lint and vocabulary audits (Q4).
- Row-testing the `runActions`, `taskActions` and `reconcileItem` matrices (slice F, with the repositories they drive).
