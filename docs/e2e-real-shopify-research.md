# Research: e2e against real Shopify, and a store per checkout per environment

Research date: 2026-10-15 · Alchemy `2.0.0-beta.81`, Shopify CLI `4.9.0`. Status: phase 2 done (§6.4); phase 3 done 2026-10-15 (store names, `stores:check`, `stores:seed`; plan in `stores-plan.md`), except the main checkout's move to `mw10013-dev-shop-00`; every question answered. Phase 4 done 2026-10-15 (the e2e server is Shopify CLI on the e2e store; plan in `e2e-server-plan.md`). Stores claimed on 2026-10-15 (§6.5). The probes in §6 ran in throwaway directories outside the repository, since deleted, and changed nothing in it.

## 1. Summary

The e2e suite runs side by side with the dev server today, and passes, but it never talks to Shopify: the e2e stage binds a fake Shopify key and secret, test control signs merchant session tokens with the fake secret, and seeded `ShopSession` rows stand in for token exchanges. An e2e suite that never exchanges a token, never calls the Admin API and never receives a webhook does not test the app. The e2e stage moves onto real Shopify.

**Direction so far:**

- Every checkout gets one dev store per environment that runs on it: `mw10013-dev-shop-NN` for the dev server and `mw10013-e2e-shop-NN` for the e2e server, `NN` the worktree index (`00` for main). `NN` is the store's index; for dev and e2e it is the worktree index. Staging and production get `mw10013-staging-shop-00` and `mw10013-production-shop-00`. The current `sandbox-shop-NN` names came about by accident and are replaced (Q1, §6.5).
- The e2e server runs its own `shopify app dev` on `mw10013-e2e-shop-NN`, with a tunnel, beside the dev server's session on `mw10013-dev-shop-NN`. Both use the same app, Baton Dev (§6.3). The CLI supplies the real key and secret, so there is no secrets file.
- Specs that test the embedded app go through `admin.shopify.com` in a logged-in browser. A real token exchange needs a token that App Bridge issued; Shopify rejects tokens we sign (§6.2).
- Webhooks reach the e2e server through the tunnel. Shopify's real delivery is part of what e2e tests.
- Stores are created and reset by script with Shopify CLI (§5). They are long-lived; a reset rewrites their data, it does not recreate them.
- The e2e server logs to `.logs/e2e/` the way the dev server logs to `.logs/dev/`.

**Phases:**

1. This research.
2. Explore Shopify CLI's store commands for real: create, install, seed, reset, delete (§9). Sonnet subagents can run it.
3. Store setup and seed scripts; the dev server moves from `sandbox-shop-NN` to `mw10013-dev-shop-NN`.
4. The e2e server: `shopify app dev` on `mw10013-e2e-shop-NN`, the e2e stage on the CLI's real app, logging.
5. Admin login for Playwright and the spec groups (§7).
6. Webhook specs.

## 2. Today

- `vp run test:e2e` starts Playwright, whose `webServer` runs `vp run test:e2e:server`: `alchemy destroy --yes && exec alchemy dev`, with `ALCHEMY_STAGE=e2e-<user>[-wt-NN]`, `WEBSITE_PORT` + 100 and `E2E_TOKEN`. Every run starts from a destroyed stage and the seed.
- The dev and e2e servers each have their own stage, port, local state and Vite dependency cache. Verified 2026-10-15: all 20 specs passed in 37 s while the dev server ran under `shopify app dev` on `sandbox-shop-00`, and the dev server stayed healthy.
- `ShopifyApp` in `src/backend/stack.ts` is `None` for `test` and `e2e`, so `wireBackend` binds the fixed fake key and a random secret.
- The e2e server writes no log. Playwright's `webServer` discards the server's stdout by default and the config does not keep it; `.logs/` holds only `dev/`.
- The dev server is Shopify CLI (`vp run dev` → `app:dev` → `shopify app dev --store $SHOPIFY_DEV_STORE`), which runs `vp run dev:alchemy` with the app's key, secret and tunnel URL in its environment.

## 3. What e2e has to prove against Shopify

| Path             | What it proves                                                                                                      | What it needs                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 1. Embedded load | The admin loads our iframe, App Bridge issues an ID token, the Backend checks it and exchanges it, the page renders | The real admin, a logged-in Shopify user in Playwright, our server reachable by URL |
| 2. Admin API     | The Backend's real queries and mutations work with a real token                                                     | A real offline token for a real store; no admin page                                |
| 3. Webhooks      | Subscriptions register, Shopify signs and delivers, our handlers act                                                | A public URL (the tunnel)                                                           |

Path 1 is slow and depends on the admin; it stays a small group. Paths 2 and 3 carry most specs.

Webhooks go through the tunnel, not `shopify app webhook trigger`. Triggering sends a payload we chose to a URL we chose, which skips what e2e exists to catch: whether the TOML's subscriptions register, whether the URI resolves, HMAC on Shopify's real signature, `include_fields` trimming, and delivery itself. The flagship scenario is: a spec creates an order through the Admin API, Shopify sends `orders/create`, our handler runs, the merchant's page updates.

## 4. How Baton did it

Baton's e2e ran against the dev server and the dev store themselves, not side by side. Its AGENTS.md says to run `pnpm seed` after every e2e run because the e2e seed replaces the dev shop's data. Worth taking:

- **Admin login** (`refs/baton/scripts/lib/shopify-playwright-auth.ts`, `refs/baton/e2e/shopify-admin.setup.ts`): reads the Shopify cookies from the person's real Chrome profile, decrypts them with the "Chrome Safe Storage" key from the macOS Keychain, and writes a Playwright storage state. A `setup` project refreshes it when stale. This avoids Shopify's login, 2FA and bot checks.
- **The admin URL as base URL** for embedded specs (`refs/baton/e2e/devStore.ts`, `previewUrl`): `https://admin.shopify.com/store/<store>/apps/<handle>/app`; member and operator specs on localhost.
- **A preflight** (`refs/baton/e2e/preflight.ts`): server answering, tunnel reachable, `ShopSession` present, each failure naming its fix.
- **Store data from code** (`refs/baton/scripts/showcase-store.ts`, `refs/baton/e2e/showcaseProducts.ts`): a product table written into the store through the Admin API, keyed by handle so it can run again.
- **Billing specs** run headed and by hand only: Shopify's hosted pricing page sits behind a bot check.

## 5. Shopify facts that shape the design

From `refs/shopify-docs/docs`:

- **Dev stores, by CLI** (`apps/build/stores/development-stores.md`, `api/shopify-cli/store/`): `shopify store create dev --name --plan (basic|grow|advanced|plus) [--demo-data] [--country] [--organization-id] [--json] [--no-input]`; `store list [--type dev] --json` (each entry has `store`, `type`, `createdAt`); `store delete --store --force`. "Organizations are limited to 250 dev stores." Deletion is permanent. The organization has five stores today: `sandbox-shop-00`, `-01`, `-02`, `stress-shop-01` (dev) and `product-health-check` (client transfer).
- **A store's name** "is used to identify the store and create the store's `myshopify.com` URL". The `myshopify.com` namespace is all of Shopify's, not just ours. On 2026-10-15, `dev-shop-00`, `e2e-shop-00`, `sandbox1-dev-00` and `sandbox1-e2e-00` answered 404 (apparently free); `sandbox-shop-00` answered 200.
- **Admin GraphQL from the CLI** (`api/shopify-cli/`): `app execute --store` runs as the app (installed on the store; mutations only on dev stores). `store auth --store --scopes` stores its own online token with the scopes asked for; `store execute --store [--allow-mutations]` then runs against it. `store bulk execute` exists for large data.
- **The dev preview is per store.** `app dev clean` "restores the app's active version to the selected development store". `shopify app dev` on a dev store auto-grants the app's scopes ("Access scopes auto-granted"), so no install click.
- **Networking** (`apps/build/cli-for-apps/networking-options.md`): Cloudflare quick tunnel by default; `--tunnel-url` for our own tunnel; `--use-localhost` drops the tunnel but breaks webhooks, so it is out.
- **ID tokens** (`apps/build/authentication-authorization/id-tokens.md`): HS256 with the client secret; `exp` one minute after `iat`. Real tokens also carry `sid` (a UUID) and an undocumented `sig`.
- **Client credentials grant** (`apps/build/authentication-authorization/client-credentials-grant.md`): an app trades its client id and secret for an access token on stores in its own organization, with no browser.

## 6. What was verified

### 6.1 Side by side today (2026-10-15)

`vp run test:e2e` with the dev server running: 20 passed. See §2.

### 6.2 Self-signed ID tokens are rejected (2026-10-15)

Tokens signed with Baton Dev's real secret (pulled with `shopify app env pull` into a temp file outside the repo, deleted after, never printed) were POSTed to `https://sandbox-shop-00.myshopify.com/admin/oauth/access_token` for an offline token. The claims were copied from a real App Bridge token read in the logged-in admin: real `sub` (the staff user), and in turn the real `sid` with the real `sig`, the real `sid` without `sig`, and a fresh `sid`. Earlier attempts with guessed `sub` values and an online-token request also failed. Every attempt got `400 invalid_subject_token`, the same as a control signed with a wrong secret.

Conclusion: the token endpoint accepts only tokens Shopify issued. Test control cannot mint exchangeable tokens; a real exchange needs the admin iframe. Not done: checking our signing code against a real token's signature, which auto mode blocked as credential handling. The signing is standard HS256, and the Backend verifies real tokens the same way, so the conclusion stands with that caveat.

### 6.3 Two `shopify app dev` sessions, one app, two stores (2026-10-15)

From one scratch app directory (a copy of `shopify.app.toml`, a placeholder web server), two sessions of Baton Dev ran on `sandbox-shop-01` and `-02` at once: no refusal, no lock file, GraphiQL and the proxy on random ports when 3457 is taken, a quick tunnel each, each tunnel reaching only its own server. `.shopify/project.json` keeps one store per app, and the last session started overwrites it; harmless, since `app:dev` always passes `--store`. The CLI ran a package install in the scratch directory on its own.

Then, with URL updates on, a session on `sandbox-shop-01` ran beside the main checkout's dev server on `sandbox-shop-00`. In the logged-in admin, `sandbox-shop-00`'s iframe loaded the dev server's tunnel (and the dev log shows `exchanged shop=sandbox-shop-00`), and `sandbox-shop-01`'s iframe loaded the second session's tunnel (its server logged `GET /app`). The CLI's test `APP_UNINSTALLED` webhook reached the second server through its tunnel. Afterwards `app dev clean` restored `sandbox-shop-01`.

Conclusion: the dev and e2e servers can each hold their own store with the same app.

### 6.4 Phase 2: store commands on a throwaway store (2026-10-15)

A Sonnet subagent ran §9's steps 1 to 7 on `sandbox1-probe-01`, then deleted it. Every other store was left alone, and the repository was not changed.

- **Create** (`store create dev --name … --plan basic --organization-id … --json --no-input`): 14 s, no browser, using the CLI's existing login. It returns the domain, admin URL, plan and `demoData` as JSON. The store starts with no products or orders.
- **The plan is fixed at creation.** The store admin's Settings → Plan shows only "Basic · Development store" and a "Delete store" button. The Dev Dashboard's actions for the store are only "Log in" and "Delete store". There is no CLI command and no Admin API mutation for it. A different plan means a different store.
- **A taken name does not fail.** `--name sandbox-shop-00` created `sandbox-shop-00-tb1mkhat.myshopify.com`, with the display name `sandbox-shop-00`. A script must compare the returned `domain` with the one it expects.
- **A deleted name is not free again.** Right after deleting `sandbox1-probe-01`, creating it again gave `sandbox1-probe-01-w1bnonfi.myshopify.com`. How long a name stays reserved was not tested.
- **Install:** `shopify app dev` on the new store auto-granted the app's scopes and sent its test `APP_UNINSTALLED` webhook through the tunnel. The admin's iframe loaded this session's tunnel, and the server logged `GET /app`.
- **`store auth` needs a person.** It opens the install page of a "Shopify CLI Connector App" in the browser, which asks for customer data, staff data and "View and edit store data". Adding a scope later needs a second click ("Update data access"). The command waits on the click, 3 minutes in this run. The token it stores is an online token that lasts 24 hours (`store auth list --json` shows `acquiredAt` and `expiresAt`). It renews itself without a click: on `sandbox-shop-00`, a session authorized on Oct 10 had expired on Oct 11, and a read-only `store execute` on Oct 15 ran and renewed it for another 24 hours.
- **Seeding through `store execute`:**
  - `productCreate` makes one variant; further variants come from `productVariantsBulkCreate`.
  - `orderCreate` is denied: it needs `write_orders` with an offline token, and `store auth` issues an online one.
  - `draftOrderCreate` then `draftOrderComplete` works, given `write_draft_orders`. It made order #1001 with `test: false`.
- **Webhooks:** `orders/paid` and `orders/create` reached the session's server through the tunnel about a second after the draft order completed. Protected customer data access blocked nothing.
- **Reset:** a single `store execute` with `orderDelete`, `draftOrderDelete` and `productDelete` took 2.5 s and left 0 products, 0 orders and 0 draft orders. Customers were not checked; the draft order's email may have created one.
- **Delete:** `store delete --force` took 12 s, and `app dev clean` 3 s.
- **`--json` output** is progress events, one JSON object per line, followed by the result as one pretty-printed JSON object spanning several lines. A script parses that last object, not the last line.
- **Aside:** `sandbox-shop-01`, created in 2023, has the plan "Development legacy", and `store list` reports no plan for it.

### 6.5 Naming (2026-10-15)

- `dev-shop-00` and `e2e-shop-00` were created first, under the first answer to Q1. They are kept, unused, in case the scheme changes again.
- Probing the rest of that scheme found `dev-shop-01` and `staging-shop` taken by other people. `shopify store info --store dev-shop-01.myshopify.com` answers "Couldn't find a store with domain dev-shop-01.myshopify.com for the current account", while its password page is live. Other generic families (`dev-store-NN`, `devshop-NN`) had more numbers taken.
- Every name of the form `mw10013-<environment>-shop-NN` probed free, for dev and e2e 00 to 12 and for staging and production 00.
- **Scheme:** `mw10013-<environment>-shop-NN`. `mw10013` is the organization's handle. `<environment>` is `dev`, `e2e`, `staging` or `production`. `NN` is the store's index; for dev and e2e it is the worktree index. Staging and production use `00`, so every store has one shape and a second one, say on another plan (Q4), is `01`.
- **Claimed:** 00 to 09 for dev and e2e (main plus nine worktrees), and `00` for staging and production. With the prefix, nobody else will take a higher number, so 10 and up are claimed when needed. All 22 were created on 2026-10-15, each on `basic` with exactly its expected domain; the organization now has 29 stores. One create (`mw10013-dev-shop-05`) returned no store on the first try and succeeded on a retry, so the setup script retries a create before treating it as a failure.

## 7. The design, as it stands

**Stores.** `mw10013-dev-shop-NN` and `mw10013-e2e-shop-NN` per checkout, claimed ahead of time, kept, checked by `stores:check` (which never creates one) and reset by a seed script (Q1, Q7, §6.5). Both scripts read the store from `.env`, as `SHOPIFY_DEV_STORE` does now (an `SHOPIFY_E2E_STORE` beside it). The setup script checks the domain Shopify assigned, in case the name was taken.

**Store data.** A table in the repository (products, variants, SKUs, tags; later orders). Seeding writes it and removes what the table does not list (Q5). Seeding runs `store execute` as the Shopify CLI Connector App, which `store auth` installs on each store once, at setup (Q6). The e2e run resets `mw10013-e2e-shop-NN` before the specs; a person runs it on `mw10013-dev-shop-NN` when wanted.

**The e2e server.** `shopify app dev --config shopify.app.toml --store <e2e store>`, whose web command runs `alchemy dev` on the e2e stage at `WEBSITE_PORT` + 100. Today the web command (`vp run dev:alchemy`) hard-codes the dev stage, so it has to take the stage from the environment or the e2e server needs its own web command; phase 4 settles which. The e2e stage reads the CLI's app the way `dev` does, and the fakes leave e2e (Q11). Playwright starts it, or adopts a running one, the way `scripts/dev.ts` adopts the dev server; destroying the e2e stage before a run still gives a fresh database.

**Logging.** Alchemy's output and the CLI's (tunnel, preview URL, webhook deliveries, errors) go to `.logs/e2e/current` through `s6-log`, archives in `.logs/e2e/`, with a marker line per run. Optionally, a failed test's report gets the server's lines from its time window (Q12).

**Spec groups.**

| Group              | Base URL                    | Auth                                        | Shopify                                                    |
| ------------------ | --------------------------- | ------------------------------------------- | ---------------------------------------------------------- |
| Embedded           | `admin.shopify.com/.../app` | Shopify admin login (Baton's cookie export) | Real ID token, real exchange                               |
| Admin API, webhook | localhost                   | Test control, member sign-in                | The offline token from the embedded setup's exchange (Q10) |
| Member, operator   | localhost                   | Test control (as today)                     | None                                                       |

**Login.** Baton's Chrome cookie export, in a Playwright `setup` project (Q9).

## 8. Open risks

- **Shopify's bot checks** on an automated admin. Baton's suite ran headless against the admin with exported cookies; only the pricing page needed a headed browser.
- **Quick tunnel reliability.** Each run gets a new random URL and the tunnel sometimes fails to come up. A named Cloudflare tunnel with a fixed hostname per checkout, passed with `--tunnel-url`, is the fix if it bites (Q8).
- **Webhooks are asynchronous and the store persists.** Specs wait on effects with generous timeouts, never fixed sleeps, and assert only on data they created; a late delivery from an earlier run must not fail a spec.
- **Names are first come, first served, and do not come back.** A taken name silently becomes a suffixed domain, and a deleted store's name was not free again right away (§6.4). Claim a name once, check the domain, and never delete a store we mean to keep.
- **Credential handling under auto mode.** Steps that read a secret or a token are denied unless allowed for that step. Scripts should avoid needing it: the CLI injects the app's credentials into the server, and seeding uses the CLI's stored `store auth` token, which never passes through our scripts (Q6).

## 9. Phase 2: exploring Shopify CLI's store commands

Steps 1 to 7 ran on 2026-10-15 (§6.4). Step 8 ran the same day: `dev-shop-00` and `e2e-shop-00` exist, on `basic`, with exactly those domains. The naming then changed (§6.5), and the scheme's 22 stores were claimed instead.

Everything that can go wrong is tried on a throwaway store first; the real names are claimed last, once the plan question (Q4) is settled.

1. **Create a throwaway** non-interactively (`--name --plan basic --json --no-input`, organization `130059740`): whether it needs a browser login, how long it takes, what the JSON returns, the domain actually assigned.
2. **Change its plan:** in the throwaway's admin (Settings → Plan) or by any CLI or API route, try moving it from `basic` to another plan and back. Record whether it works, whether it costs anything, and what a dev store is offered.
3. **Name collision:** create a store with a name we know is taken (`sandbox-shop-00`), and record what Shopify does (error, or a suffixed domain); delete it if one was created.
4. **Install:** `shopify app dev` on the throwaway; confirm the auto-grant and an embedded load.
5. **Seed:** `store auth --scopes write_products,write_orders,…` then `store execute --allow-mutations` with a product create and an order create (test orders); confirm `orders/create` reaches the session's server through the tunnel.
6. **Reset:** delete everything the table does not list; measure how long a reset of a small table takes.
7. **Delete:** `store delete` on the throwaway, and `store list` afterwards.
8. **Claim the real names** on the plan Q4 settles (§6.5).

Out of scope for phase 2: the scripts themselves, the rename, and any change to the e2e stage.

## 10. Questions, with recommendations

Answered 2026-10-15 in Plannotator: every recommendation accepted. Phase 2 (§6.4) reopened Q4 and Q6; both were answered on 2026-10-15 with the recommendations.

:::question
Q1. Store names?

Store names share one namespace across all of Shopify (§6.5). The first answer, `mw10013-dev-shop-NN` / `mw10013-e2e-shop-NN`, failed on contact: `dev-shop-01` and `staging-shop` belong to other people. A suffixed domain for the one taken name was rejected as a confusing exception. A prefix tied to an app or to this repository was rejected too: stores outlive both.

- [x] `mw10013-<environment>-shop-NN` for every environment — the organization's handle, which nobody else uses; `-shop` keeps the name unambiguous next to stages, apps and Workers of the same environment
- [ ] `mw10013-<environment>-NN` — shorter, but `mw10013-staging-00` reads as a stage, an app or a Worker as easily as a store
- [ ] `mw10013-dev-shop-NN` with a suffixed domain for `dev-shop-01`

Recommended: `mw10013-<environment>-shop-NN` for every environment
:::

:::question
Q2. Does staging get its own store (`mw10013-staging-shop-00`) instead of sharing `sandbox-shop-00`?

- [x] Yes, after e2e works — staging is not blocked today
- [ ] Yes, now, with the dev and e2e stores
- [ ] No, staging stays on `sandbox-shop-00`

Recommended: Yes, after e2e works
:::

:::question
Q3. What happens to `sandbox-shop-NN`?

Baton's checkouts and the staging app use them. Moving the sandbox off them also ends the "same NN, never at once" rule between the two projects.

- [x] Leave them to Baton and staging; decide on deletion after Q2 lands
- [ ] Delete them once the sandbox has moved

Recommended: Leave them to Baton and staging; decide on deletion after Q2 lands
:::

:::question
Q4. Store plan for `mw10013-dev-shop-NN` and `mw10013-e2e-shop-NN`? (Reopened: phase 2 found the plan is fixed at creation.)

§6.4: a dev store's plan cannot change, and a deleted name does not come back right away. But a wrong plan never forces deleting these stores: a feature that needs a higher plan gets a store of its own beside them, such as `e2e-plus-shop-00`, which costs nothing. So the plan here should match what most merchants run, which `basic` does. `plus` would let a spec pass on a feature that most merchants do not have. The current stores are `basic`; `stress-shop-01` is `advanced`.

- [x] `basic`; a feature that needs a higher plan gets its own extra store
- [ ] `plus`, so every feature is available on the main stores
- [ ] `advanced`, like `stress-shop-01`

Recommended: `basic`; a feature that needs a higher plan gets its own extra store
:::

:::question
Q5. Store data: our own table, or `--demo-data`?

- [x] Our own table only — specs know exactly what is there
- [ ] `--demo-data` plus our table on top
- [ ] `--demo-data` only

Recommended: Our own table only
:::

:::question
Q6. How does seeding reach the store?

Store data only ever goes through the Admin API, as some app installed on the store, within that app's scopes. Two apps can do it, each with its own scope list:

- **The CLI's own app.** `store auth` installs the "Shopify CLI Connector App" with the scopes we choose, and `store execute` runs Admin GraphQL as it. Baton Dev's scopes are not involved. It needs one click per store, and another when a scope is added. After that its token renews itself (§6.4), so seeding and per-run resets are scriptable. Its online token is denied `orderCreate`, so orders go in as completed draft orders, which still fire `orders/create` and `orders/paid`.
- **Our app, through the Backend.** A test-control procedure uses the stage's real offline token from the embedded `setup` (Q10): no click, and `orderCreate` works. Baton did this (`/api/dev/seed`). But Baton Dev can only use scopes `shopify.app.toml` requests, so its request would grow by `write_products`, `write_orders` and `write_draft_orders`, more than its features use. On a dev store under `shopify app dev`, Shopify approves a changed request automatically, so no click.

First answered "through the Backend", on the belief that `store auth` needed a click on every run. A check the same day showed its token renews itself, so the answer changed to the CLI.

- [x] `store auth` + `store execute`: one click per store at setup, then scripted; orders as completed draft orders; Baton Dev's scopes unchanged
- [ ] Through the Backend: a test-control seed procedure with the stage's offline token; Baton Dev requests write scopes
- [ ] A script using the client credentials grant: no click, but the script handles the app secret (auto mode asks every time)

Recommended: `store auth` + `store execute`: one click per store at setup, then scripted; orders as completed draft orders; Baton Dev's scopes unchanged
:::

:::question
Q7. Reset `mw10013-e2e-shop-NN` by script per run, or recreate stores?

- [x] Reset by script before every run; never recreate routinely — slow, reinstall, the name may not come back
- [ ] Recreate when a reset is not enough

Recommended: Reset by script before every run; never recreate routinely
:::

:::question
Q8. Quick tunnel or a named Cloudflare tunnel for the e2e server?

- [x] Quick tunnel first; named tunnel per checkout if it is flaky
- [ ] Named tunnel from the start — stable hostname, more setup

Recommended: Quick tunnel first; named tunnel per checkout if it is flaky
:::

:::question
Q9. Admin login for Playwright?

- [x] Baton's Chrome cookie export — proven against Shopify's checks
- [ ] A dedicated Playwright profile, logged into by hand — simpler, more likely to be challenged

Recommended: Baton's Chrome cookie export
:::

:::question
Q10. Where do Admin API and webhook specs get their token?

The embedded `setup` does one real exchange, which leaves a real offline token in the e2e stage's `ShopSession`.

- [x] Reuse that token through the Backend; client credentials grant as the fallback
- [ ] Client credentials grant for these specs

Recommended: Reuse that token through the Backend; client credentials grant as the fallback
:::

:::question
Q11. Does any fake Shopify path stay in e2e?

- [x] No — fakes stay in unit and integ tests only
- [ ] Yes, for member and operator specs that never touch Shopify

Recommended: No — fakes stay in unit and integ tests only
:::

:::question
Q12. Logging: `.logs/e2e/` with the CLI's output included?

- [x] Yes, plus a marker line per run; attaching lines to failed tests later
- [ ] Yes, and attach lines to failed tests now

Recommended: Yes, plus a marker line per run; attaching lines to failed tests later
:::

:::question
Q13. Does `worktree:init` provision the stores?

The stores are claimed ahead of time (§6.5), so `worktree:init` only checks them, with `stores:check`, which reads and never creates: a missing store is an error (a wrong `.env`, a deleted store, the CLI on another account) and fails with the `store create` command a person runs by hand. Running it twice changes nothing.

- [x] Yes, by calling the store check, which also runs on its own
- [ ] No, store setup stays a separate manual step

Recommended: Yes, by calling the store check, which also runs on its own
:::

:::question
Q14. Same app (Baton Dev) for e2e, or a dedicated e2e app?

§6.3 shows the same app works per store.

- [x] Same app
- [ ] A dedicated "Baton E2E" app

Recommended: Same app
:::

:::question
Q15. What may phase 2 create and delete?

- [x] Create `dev-shop-00`, `e2e-shop-00` and one throwaway store; delete only the throwaway; never touch `sandbox-shop-NN`
- [ ] Throwaway stores only; claim the real names after the scripts exist

Recommended: Create `dev-shop-00`, `e2e-shop-00` and one throwaway store; delete only the throwaway; never touch `sandbox-shop-NN`
:::
