# Plan: a dev store and an e2e store per checkout, set up and seeded by script

Plan date: 2026-10-15 · Shopify CLI `4.9.0` · Base commit `108dd82` plus the uncommitted research doc.
Research: [E2E against real Shopify](./e2e-real-shopify-research.md), phase 3. Its questions are settled (§10 there), and its §6.4 and §6.5 record how the CLI behaves and how the stores are named. Read those first.

## 0. Rules for the implementer

- Follow `AGENTS.md`: Vite+ only (`vp`, never npm/npx), Effect idioms (Schema for every parse and check, `Match`, `Schema.TaggedError`, `Effect.fn`), and its comment rules (JSDoc on symbols, a rule stated once, no references to plans or research docs in code or comments).
- **No commits.**
- **Stores:** never delete a store, and never create one outside the scheme in §2. Never run anything against `sandbox-shop-NN`, `dev-shop-00`, `e2e-shop-00`, `stress-shop-01` or `product-health-check`. Steps 1 to 3 run no mutation against any store; Step 4 is the user's, with the reviewer.
- **The dev server:** do not stop, restart or reconfigure the main checkout's running dev server, and do not edit the main checkout's `.env`; Step 4 does both. Do not touch the `wt-01` worktree.
- **Never print a secret or token.** No `--verbose`, no `shopify app env pull`.
- **Do not touch Baton's files** (`refs/baton`). Copy what this plan names into this repository, adapting it to this repository's conventions.
- Run `vp check --fix` after code changes. Each step ends green (`vp check`, `vp test --project unit`) before the next starts.
- Anything that differs from this plan, or any problem you could not solve, goes in §9 with the date and step. If a step cannot work as written, stop that step, record why, and continue with what does not depend on it.

## 1. Outcome

- Every checkout's `.env` names two stores: `SHOPIFY_DEV_STORE=mw10013-dev-shop-NN` and `SHOPIFY_E2E_STORE=mw10013-e2e-shop-NN`, `NN` the worktree index (`00` for main). `vp run worktree:init` writes both in a worktree, and verifies both on a second run.
- `vp run stores:check` verifies that this checkout's two stores exist as dev stores on `basic` with exactly their expected domains. It only reads: every store is claimed ahead of time, and a missing one fails with the command to create it by hand.
- `vp run stores:seed` writes the showcase table (Baton's showcase shop: products, variants, SKUs, tags, three open orders) into this checkout's dev store through `shopify store execute`, and brings a store that drifted back to the table. It refuses any store that is not a dev store of the scheme.
- After Step 4, the main checkout's dev server runs on `mw10013-dev-shop-00`, seeded, and the app loads embedded in its admin.
- Nothing changes for the e2e server yet; `SHOPIFY_E2E_STORE` is only written and set up. The e2e store's table is designed with the e2e specs, later.

## 2. Step 1: store names, as one Schema

In `scripts/lib/worktree.ts`, replace `DevStore` and its helpers with a store-name codec for the scheme `mw10013-<environment>-shop-NN`:

- `<environment>` is one of `dev`, `e2e`, `staging`, `production`. This is the stores' own list, not `Environment` from `src/backend/stage.ts`: `test` has no store, and `production` has a store before it has a stage.
- `NN` is two digits, the store's index; for `dev` and `e2e` it is the worktree index.
- A codec between the name and `{ environment, index }`, built with Schema (a template literal parser or a pattern plus transformation, as `DevStore` was); no hand parsing. JSDoc states the scheme once, with the reason for the prefix: store names share one namespace across all of Shopify, generic names are taken, and the organization's handle keeps ours unique.
- Helpers to encode a checkout's dev and e2e store names from an index, and to read `SHOPIFY_DEV_STORE` and `SHOPIFY_E2E_STORE` from a `.env`'s text, as `devStoreOf` does today.

Unit tests in `test/unit/scripts/lib/worktree.test.ts` (the `unit` project includes `test/unit/**`): round trips for each environment, index `00` and `09`; rejections for `dev-shop-00`, `sandbox-shop-00`, `mw10013-test-shop-00`, `mw10013-dev-shop-0`, `mw10013-dev-shop-100`.

## 3. Step 2: `worktree:init` and `.env`

`scripts/worktree.ts`:

- Writes and verifies `SHOPIFY_E2E_STORE` beside `SHOPIFY_DEV_STORE`, the same way: a new `.env` gets both; an existing one is verified, and a missing key is appended (the existing catch-up rule, now for both keys).
- The claim check refuses an e2e store another checkout's `.env` already holds, as it does for the dev store.
- An existing `.env` holding a `sandbox-shop-NN` value fails as today ("fix it by hand"), with a message naming the expected new value. No automatic migration: two `.env` files are affected, main's and `wt-01`'s, and each is fixed once by hand (main's in Step 4).
- After the `.env` step, it runs the store check of Step 3 for this worktree's two stores, so a worktree whose store is missing fails at once.
- Module JSDoc: update the steps list and the example (`wt-01` runs on `mw10013-dev-shop-01`).

`.env.example`: `SHOPIFY_DEV_STORE=mw10013-dev-shop-00` and `SHOPIFY_E2E_STORE=mw10013-e2e-shop-00`, with a comment pointing at the scheme by rule, not by doc (`NN` the worktree index). `scripts/dev.ts`: the missing-store message names the new scheme.

## 4. Step 3: `stores:check` and `stores:seed`

A new `scripts/stores.ts` with two `effect/cli` subcommands, wired as package scripts `stores:check` and `stores:seed` (both `node --env-file=.env scripts/stores.ts …`, like `dev`), and its logic in `scripts/lib/stores.ts` so `worktree:init` can call setup.

**Shopify CLI calls.** One helper runs `shopify` with stdin closed (no prompt can wait) and parses `--json` output. The CLI prints progress events, one JSON object per line, then the result as one pretty-printed object over several lines: parse that last object, never the last line. Decode every result with Schema.

**`stores:check`** for this checkout's `SHOPIFY_DEV_STORE` and `SHOPIFY_E2E_STORE`:

1. Decode both names with Step 1's codec; a value outside the scheme fails.
2. `shopify store list --type dev --json`. A store that exists must be `type: dev` and `plan: basic`; anything else fails naming the store.
3. A missing store fails, naming the `shopify store create dev` command a person runs to create it. Nothing is created.
4. Print one line per store: `ok    <name> exists`.

**`stores:seed [--store <name>]`**, default this checkout's `SHOPIFY_DEV_STORE`:

1. The store must decode with Step 1's codec, with environment `dev`. Every other store is refused; `e2e` gets its own table later.
2. **Store auth preflight:** `shopify store auth list --json` must list the store with every scope the seed needs (`read_products`, `write_products`, `read_orders`, `write_orders`, `read_draft_orders`, `write_draft_orders`). If not, fail with the exact command to run: `shopify store auth --store <domain> --scopes <those scopes>`, and that it opens a browser page a person approves once per store.
3. Port Baton's showcase seeding: `refs/baton/scripts/lib/showcase-store.ts` (`showcaseStore` and its queries and mutations) and its table `refs/baton/e2e/showcaseProducts.ts` (`SHOWCASE_PRODUCTS`, `skuOf`). Keep the behavior: products written with `productSet` by handle, products not in the table archived, leftover open orders not in the table cancelled, the three showcase orders created through `draftOrderCreate` and `draftOrderComplete` when missing, every step skipped when the store already matches. The table goes to `seed/shopify/showcase.ts` (products and orders together); the logic to `scripts/lib/stores.ts`. Adapt to this repository: `Schema.TaggedError` for the error, `Effect.fn` for named effects, Schema decoding of every result, this repository's `runCommand` (`scripts/lib/command.ts`).
4. Prints what it did, one line per product and order.

Unit tests for whatever is pure: the result parsing (progress lines then a pretty-printed object), and the table's own invariants (unique handles, unique SKUs).

## 5. Step 4: move the main checkout's dev server (the user, with the reviewer)

Not for the implementer. In order:

1. `vp run dev:stop`.
2. Main `.env`: `SHOPIFY_DEV_STORE=mw10013-dev-shop-00`, add `SHOPIFY_E2E_STORE=mw10013-e2e-shop-00`.
3. `vp run stores:check`: both `exists`.
4. `vp run dev`: the CLI installs Baton Dev on the new store ("Access scopes auto-granted") and the summary prints the new admin URL.
5. `shopify store auth --store mw10013-dev-shop-00.myshopify.com --scopes …`: the user approves the browser page once.
6. `vp run stores:seed`, then again: the second run reports every product and order already as the table says.
7. In the logged-in admin, open the app on `mw10013-dev-shop-00`: the iframe loads the dev server's tunnel, and the dev log shows `exchanged shop=mw10013-dev-shop-00.myshopify.com`. The store's products page lists the showcase products.
8. `wt-01` moves in its own thread: fix its `.env` by hand, `vp run worktree:init`, the same checks on `mw10013-dev-shop-01`.

## 6. Step 5: docs

- `README.md`: the dev store paragraph and the admin URL; a short note on `stores:check`, `stores:seed` and the one-time `store auth`.
- `docs/worktrees-runbook.md`: the layout table gains the e2e store; both columns use the scheme.
- `docs/e2e-real-shopify-research.md`: status line (phase 3 done).
- `test/unit/web/server/shopify-urls.test.ts` uses `sandbox-shop-00` as sample data; leave it.

## 7. Verification checklist

- [ ] `vp check` and `vp test` green; `vp run test:e2e` green (the e2e server is unchanged).
- [ ] In a scratch copy of the logic, or by reading: `worktree:init` on a fresh worktree would write both keys and call setup (not run by the implementer: no worktree is created for this).
- [ ] `vp run stores:check` from the main checkout with the main `.env` unchanged fails on `sandbox-shop-00` being outside the scheme, with a clear message. (Read-only; run it.)
- [ ] `vp run stores:seed --store mw10013-e2e-shop-00` and `--store sandbox-shop-00` are refused before any Shopify call. (Run them.)
- [ ] `vp run stores:seed --store mw10013-dev-shop-09` with no store auth for that store fails at the preflight with the exact `store auth` command, and no mutation ran. (Run it.)
- [ ] Step 4 items 3 to 7, by the user and reviewer.

## 8. Out of scope

The e2e store's table and seeding, the e2e server and its logs, the admin login for Playwright, staging's and production's stores (installing apps on them), deleting any store, the `wt-01` move, committing.

## 9. Deviations and issues

(The implementer records here, dated, by step.)

2026-10-15, Step 1: no deviation. `StoreOf(environment)` (a `StoreName` restricted to one environment) is exported besides the codec, for the `.env` readers and for Step 3.

2026-10-15, Step 2: no deviation. Not run: `worktree:init` itself (no worktree was created), so the e2e claim check, the append of a missing `SHOPIFY_E2E_STORE` and the call to setup are verified by reading and the type check only. The README and runbook name `mw10013-dev-shop-00` for the main checkout before Step 4 moves it.

2026-10-15, Step 3:

- The scope preflight counts `write_X` as `read_X`. Shopify's `write_X` includes `read_X` and the CLI lists only the scopes it was asked for (the existing `sandbox-shop-00` session lists three `write_` scopes), so asking for all six strictly would reject a session that works. The printed `store auth` command still asks for all six.
- Every CLI call also passes `--no-input`, so none can open a browser.
- `stores:check` checks the dev store against the scheme before it reads `SHOPIFY_E2E_STORE`, so a `.env` still on `sandbox-shop-00` fails on that value, not on the missing e2e key.
- `store create`'s result shape (`store.domain`) comes from `shopify store create dev --json-schema`, not from a run. Creation, the retry and the domain comparison were not run (no store mutation allowed). The retry covers any failure of the create, not only "no store"; if a failed create had in fact made the store, the retry would create a suffixed one and the domain check would then stop, leaving it for a person.
- The seed's read and write paths were ported from Baton but not run against a store: no dev store of the scheme has store auth yet. Step 4 item 6 is the first real run.
- The preflight checks that a session lists the scopes, not that it has not expired; an expired session renews itself on the first call.
- `vp run stores:seed --store X` takes the flag without `--`.

2026-10-15, review: the create retry was a blind `Effect.retry`, which after a create that failed but made the store would create again and get a suffixed duplicate. Now a failed create reads the store list again and creates once more only when the store is still missing. Also fixed "an dev store" in the setup failure message.

2026-10-15, decision after review: `stores:setup` became `stores:check`, which only reads. The stores are claimed ahead of time, so a missing one is an error (a wrong `.env`, a deleted store, the CLI on another account), and creating one would hide it and spend a name that never comes back. The create path, its retry and the suffix handling are gone; a missing store fails with the `store create` command to run by hand. Entries above that mention setup, creation or the retry describe the code before this change.

2026-10-15, Step 4 (main checkout): `.env` moved to `mw10013-dev-shop-00` with `SHOPIFY_E2E_STORE=mw10013-e2e-shop-00`; `stores:check` reported both; `vp run dev` answered in 27.7 s with the new admin URL; the user approved `store auth` once; the first `stores:seed` created 8 products and 3 orders (#1001 to #1003).

2026-10-15, Step 4, bug found and fixed: the second seed run cancelled #1001, which on a new store is the seed's own `showcase-board` order. The port kept Baton's rule "cancel the leftover order #1001", which named a stray order on Baton's store. The seed now cancels every open order without the `showcase` tag, never by number. A third run recreated `showcase-board` as #1004; a fourth changed nothing (every product "already as the table says", every order "already open").

2026-10-15, Step 4, embedded load: in the logged-in admin, the app on `mw10013-dev-shop-00` loaded the dev server's tunnel in its iframe, and the dev log shows `Shopify.authenticateAdmin: exchanged shop=mw10013-dev-shop-00.myshopify.com`. Not done: the `wt-01` move (item 8), in its own thread.

2026-10-15, decision after Step 4: "showcase" is gone from the names. The table moved from `seed/shopify/showcase.ts` to `seed/dev-shop.ts` (the dev shop's seed, beside `seed/dev.sql`), exporting `products` and `orders`; the GraphQL operations are `Seed…`. Orders carry the marker `seed` (was `showcase`) and the identities `seed-board`, `seed-journal`, `seed-clock-and-blanket`, which the seed needs to tell its three orders apart; the three orders stay because help screenshots are taken against them. Products carry no seed marker: their tags are real workflow tags. The README paragraph is down to the two commands; the details wait for a runbook. On `mw10013-dev-shop-00` the next seed cancelled the three `showcase` orders (#1002 to #1004) and created #1005 to #1007; the run after changed nothing. One seed run failed on a renamed GraphQL operation (a search-and-replace had turned `ShowcaseProducts` into `DevShop.Products`), fixed before the store was touched.

## 10. File plan

| File                                                      | Change                                                 |
| --------------------------------------------------------- | ------------------------------------------------------ |
| `scripts/lib/worktree.ts`                                 | Store-name codec and `.env` readers replace `DevStore` |
| `scripts/worktree.ts`                                     | Both store keys; calls the store check; JSDoc          |
| `scripts/lib/stores.ts` (new)                             | CLI helper, check, seed logic                          |
| `scripts/stores.ts` (new)                                 | `check` and `seed` subcommands                         |
| `seed/dev-shop.ts` (new)                                  | The dev shop table, ported from Baton                  |
| `scripts/dev.ts`                                          | Missing-store message                                  |
| `package.json`                                            | `stores:check`, `stores:seed`                          |
| `.env.example`                                            | Both store keys                                        |
| `test/unit/scripts/lib/*.test.ts` (new)                   | Codec, parsing and table tests                         |
| `README.md`, `docs/worktrees-runbook.md`, research status | Step 5                                                 |
