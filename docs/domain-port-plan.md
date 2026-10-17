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
- Every `pinned by` title that names a test ported here exists under `test/unit/domain/` byte for byte: `grep -rF "<title>" test/unit/domain/` for a sample of ten ported test titles.
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
- 2026-10-17 [Step 4] One helper, `domainBoundary(files, siblings)` in `vite.config.ts`, beside `runtimeBoundary`. Beyond the step's three groups it adds `src/domain/shop-work.ts` refusing `./billing.ts` and `src/domain/billing.ts` refusing `./shop-work.ts`, so the lint says what the map's `may import` cells say (shop work → orders, platform; billing → orders, platform). The billing override matches no file until `billing.ts` arrives.
- 2026-10-17 [Step 6] The glossary's Domain section is one table (word, meaning, context, symbol) of all 36 rows of the three nouns tables, meanings and symbols as the tables write them, plus an intro saying the full vocabulary and the map live in the context files' JSDoc. Its opening paragraph and the `src/domain/` source-layout row are in the present tense (the row lists `billing` as arriving with its slice). `legacy-port-research.md` has no status column in §3, so B's and D's "Delivers here" cells open with **Done** 2026-10-17; the status line at the top keeps "No code has changed" and gains a dated sentence after it.

- 2026-10-17 [lead fix] AGENTS.md link rule on moved JSDoc: `platform.ts`'s `{@link itemPiece}`, `{@link D1_TABLES}` and `{@link initializeSchema}` are backticked names now (none is in scope there); `orders.ts`'s `SyncOrderResult` and `OrdersSyncResult` no longer point at the Shape families table in `Domain.ts` and say instead that a `Result` is the outcomes of one write as a tagged union, that table's wording. §5's sample line now says ported test titles.

### Issues

- 2026-10-17 [Step 1] `platform.ts` keeps legacy's `{@link}`s to symbols not in scope: `itemPiece` (shop work, which platform may not import), `D1_TABLES` and `initializeSchema` (legacy backend modules, never ported here). Lint does not check `{@link}` targets, so they pass; they are moved lines and stay. Whoever reconciles them should turn them into backticks.
- 2026-10-17 [Step 2] `orders.ts` keeps two moved JSDoc lines that point at the map's Shape families table "on the map in `Domain.ts`" (`SyncOrderResult`, `OrdersSyncResult`); that table was left behind in Step 1 and the file does not exist here. Left as moved lines; whoever reconciles the shapes should reword them.
- 2026-10-17 [Step 3] The step says `unitsToMake`, `itemMatches`, `laterStepStarted`, `workflowsListFrom` and `setupFactHolds` "keep their legacy tests"; legacy `domain.test.ts` has no case naming any of them (they are exercised through workerd tests: `order-repository`, `run-repository`, `setup-facts`). Nothing was invented; they wait for the slices that port those tests.
- 2026-10-17 [Step 4] Rule `no-restricted-imports` (oxlint's eslint port), five entries in `lint.overrides`, after the three `runtimeBoundary` ones, in this order: `src/domain/**`, `src/domain/platform.ts` (siblings `orders.ts`, `shop-work.ts`, `billing.ts`), `src/domain/orders.ts` (`shop-work.ts`, `billing.ts`), `src/domain/shop-work.ts` (`billing.ts`), `src/domain/billing.ts` (`shop-work.ts`). Each is `["error", { paths: [effectBarrel], patterns: [{ group: ["**/backend/**", "**/web/**", "**/contract/**"], message }, { group: ["./<sibling>", …], message }] }]`. Which wins: with the directory override moved after the per-file ones, `platform.ts` importing `./orders.ts` passed, so when two overrides match, the later one's options replace the earlier's; the per-file overrides therefore come last and repeat the directory group. Proved with side-effect imports, then reverted (`git checkout -- src/domain`): `orders.ts` importing `../contract/shop.ts` fails with `eslint(no-restricted-imports): '../contract/shop.ts' import is restricted from being used by a pattern.` (help: "The domain imports only `effect` and its own context files."); `platform.ts` importing `./orders.ts` and `orders.ts` importing `./shop-work.ts` fail with `'./orders.ts'` / `'./shop-work.ts' import is restricted from being used by a pattern.` (help: "A context file imports only what its `may import` cell names."); also refused: `platform.ts` → `../backend/fixture.ts`, `shop-work.ts` → `../web/router.tsx` and `./billing.ts`, `orders.ts` → `effect` (`'effect' import is restricted from being used.`).
- 2026-10-17 [Step 5] `node:sqlite` silently runs only the first statement of a multi-statement `sql` call; see the spike verdict. Not fixed here: `0001_init` is out of bounds for this plan.
- 2026-10-17 [Step 6] §5's pinned-by sample: of the 87 titles named in `pinned by` cells across the three files, 2 exist under `test/unit/domain/`; the rest name workerd tests of slices A, C, E and F (as §2 expects), so a sample of ten from `test/unit/domain/` alone cannot be drawn.
- 2026-10-17 [lead fix] Out of that fix's scope and left as moved lines: `shop-work.ts` links `{@link D1_TABLES}` (4 sites) and `{@link initializeSchema}` (3 sites), neither in scope; `{@link itemPiece}` there resolves.

### Command results

- 2026-10-17 [Step 1] `vp check`: 207 files formatted, 164 linted, green. `vp test`: 31 files / 275 tests passed, 28.3 s.
- 2026-10-17 [Step 2] `vp check`: 209 files formatted, 166 linted, green. `vp test`: 32 files / 282 tests passed, 24.7 s.
- CHECKPOINT: Steps 1–2 ready to merge (db9dd05)
- 2026-10-17 [Step 3] `vp check`: 168 files linted, green. `vp test`: 33 files / 352 tests passed, 27.9 s.
- 2026-10-17 [Step 4] `vp check`: 211 files formatted, 168 linted, green. `vp test`: 33 files / 352 tests passed, 25.2 s.
- 2026-10-17 [Step 5] Probe green (1 test, 11 ms), then reverted. After `vp install`: `vp check` green, 211 formatted / 168 linted; `vp test` 33 files / 352 tests passed, 26.1 s.
- 2026-10-17 [Step 6] `vp check`: 211 formatted / 168 linted, green. `vp test`: 33 files / 352 tests passed, 23.3 s.

### Spike verdict (Step 5)

2026-10-17, about 15 minutes of work. Dependency tried: `@effect/sql-sqlite-node` 4.0.1 (`vp add -D`), on `node:sqlite` `DatabaseSync`; Node v24.21.0 (the unit project's), SQLite 3.53.4. No native build. Reverted afterwards: the probe test, the `migrations` export in `shop-actor.ts`, `package.json` and `pnpm-lock.yaml`; `vp install` re-run, then `vp check` green and `vp test` 33 files / 352 tests, 26.1 s.

- **Passed.** A unit test under `test/unit/backend/` built `SqliteClient.layer({ filename: ":memory:" })`, ran the actor's own `migrations` record (imported from `shop-actor.ts`: the module loads in Node, `alchemy/Cloudflare` and `@effect/sql-sqlite-do` imports included) through `@effect/sql-sqlite-node/SqliteMigrator.run`, and then, inside `sql.withTransaction`: two `ShopOrder` upserts with `insert … on conflict (id) do update set … where excluded.updatedAt >= ShopOrder.updatedAt returning id`, two `OrderLineItem` rows by `insert or replace`, and one replaced. Outside it: an older `updatedAt` returns no row and leaves the row; a newer one returns its id; the `ShopOrder_open_idx` predicate returns only the open order, and `explain query plan` reads `SCAN ShopOrder USING INDEX ShopOrder_open_idx`; `json_extract(productTags, '$[0]')` reads the tag; a transaction that fails after an insert leaves nothing. `pragma foreign_keys` is `1` by default under `node:sqlite`, as the DO enforces them.
- **Differs from the DO.** One: the Node client prepares each `sql` call as one statement (`DatabaseSync.prepare`), and SQLite compiles only the first statement of a script and drops the rest **silently**. `0001_init` is one template holding every `create`, so under Node the migration "succeeds" having made `ShopOrder` alone (the first probe failed later on `no such table: OrderLineItem`). The DO's `sql.exec` runs the whole script. The probe got past it by providing the migrator a `SqlClient` proxy that strips `--` comments and runs each `;`-separated statement of an argument-free template on its own (a naive split on `;` breaks on a comment ending in `;`).
- **Verdict: unit.** The orders plan's repository tests go to `test/unit/backend/` over `@effect/sql-sqlite-node` (added as a devDependency in that plan's own step), on one condition it must settle first: either `0001_init` becomes one `sql` call per statement (no table changes; runs the same in the DO), or the unit layer splits scripts as the probe did. The first is simpler and removes the silent-drop trap for every later migration. The probe's code is not kept in the repo; its shape is above.

### Implementation review

2026-10-17, lead, at `be46570`. Re-run: `vp check` green (211 files formatted, 168 linted); `vp test` 33 files / 352 tests passed in 23.9 s. `git merge-tree` of `wt-01` with `main` (`b8d1106`) has no conflict.

Checks:

- Moved lines: each `src/domain/*.ts` compared token by token with its legacy file (whitespace collapsed, so the formatter's reflow at width 100 drops out). What differs: import lines, the map and `@module` in the header, the duplicate notes (platform), `closedReasonText` after `ClosedReason` (shop work), and the formatter's trailing commas and parentheses. Nothing else.
- Titles: every `describe`/`it` title in legacy `domain.test.ts` exists under `test/unit/domain/` byte for byte, except the six billing ones (slice G). A sample of ten titles found with `grep -rF`, all in `shop-work.test.ts`. The five `syncOrder` row titles match the table's cells joined with `|`. Of the 80 `pinned by` titles in the three files, only 2 name a test ported here (both found); the other 78 name workerd tests that arrive with slices A, C, E and F. §5's "sample of ten pinned titles" therefore cannot be drawn from `pinned by` cells.
- Lint: `import "../contract/shop.ts"` in `orders.ts` and `import "./orders.ts"` in `platform.ts` each failed `vp check` with `eslint(no-restricted-imports): '<spec>' import is restricted from being used by a pattern.`; reverted. `grep` for `../backend`, `../web`, `../contract` imports under `src/domain/` is empty.

Fixed by the lead:

- Nothing needed fixing.

Needs a decision:

- `0001_init` under `@effect/sql-sqlite-node`: the Node client runs only the first statement of a multi-statement `sql` call and drops the rest without an error (Spike verdict). Unit repository tests need `0001_init` split into one `sql` call per statement (no table change) or a statement-splitting test layer. Recommendation: split the migration, in the orders plan's step that adds the dependency.
- Moved JSDoc that breaks the AGENTS.md link rule: `platform.ts` links `itemPiece`, `D1_TABLES` and `initializeSchema`, which are not in scope; `orders.ts` (on `SyncOrderResult`, `OrdersSyncResult`) points at "the Shape families table on the map in `Domain.ts`", which was left behind. Kept as moved lines; either turn the links into backticks and drop the `Domain.ts` pointer now, or leave them until their slices arrive.
- `FixtureTask.name` and `instructions` now use `TaskName` and `TaskInstructions`: trimmed on decode, branded, capped at 64 and 500 characters, where the contract's `Name` refused untrimmed text with no cap. The root `fixture.ts` still decodes. Confirm the trim-instead-of-refuse change is wanted.
- `platform.test.ts` holds new tests, not ported ones (legacy had none for platform); confirm keeping them.
- The glossary's Domain section names symbols that do not exist here yet (`ShopAgent.*`, `useLiveQuery`); its intro says they arrive with their slices.
- Step 4 added two overrides beyond the step (`shop-work.ts` refuses `./billing.ts`; `billing.ts` refuses `./shop-work.ts`), so the lint matches the map's `may import` cells. The billing one matches no file until slice G.
- §5's `pinned by` sample (see Checks): change that check to sample ported test titles, or accept it as written now.

## 8. Out of scope

- Reconciling the duplicates between `src/domain/platform.ts` and `src/contract/` (`Shop` vs `ShopKey`, `Email`, the connection constants). That happens when the first consumer of each moves, in the slice that moves it; until then both exist and the JSDoc notes say so.
- `billing.ts` (slice G) and legacy's `Screen.ts` tables (slice J).
- The spec checker, rules lint and vocabulary audits (Q4).
- Row-testing the `runActions`, `taskActions` and `reconcileItem` matrices (slice F, with the repositories they drive).
