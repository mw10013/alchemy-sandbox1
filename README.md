# Alchemy-sandbox1

A minimal TanStack Start app (`Website.Vite`) that calls a private Effect
backend Worker over a service binding, styled with Shopify's Polaris web components
(2.0 release candidate, light only). Both Workers are managed by Alchemy (`alchemy.run.ts`).
Created with `vp create` in the existing project directory.

Two request paths:

- **Pages and Backend-owned writes:** browser → Website → server function → Backend. Route
  loaders, `beforeLoad` guards and writes the Backend owns (the sign-in link, members) call
  TanStack server functions (`src/web/server/`), which call the Backend's methods schemaless over
  the `BACKEND` binding and forward the visitor's cookie. The Backend checks the session in
  every method.
- **Live actor data:** browser → Website → the Backend's gate → actor socket. The Backend also
  hosts Durable Objects. A browser reaches an actor (`ShopActor`, one per shop, named by its
  myshopify domain) over one WebSocket at `/api/actor/<key>`, through the Website and the
  Backend's gate, which resolves who the browser is and names it on the upgrade it forwards;
  the actor keeps that identity on the socket. Effect RPC runs on the socket; after a write the
  actor sends a notice naming the stale reactivity keys, and every browser refetches. A refused
  upgrade is closed at once with a code the page reads. The shop page's first paint comes from
  its loader, which asks the Backend, which asks the actor.

Shops, members and teams are Baton's tables (`migrations/0002_baton_schema.sql`). Three areas,
in Baton's layout:

- `/app` is the embedded App Home, the page the Shopify admin frames. It is authenticated by
  Shopify session tokens: its guards bounce the admin until it hands over an `id_token`, the
  Backend verifies it with the app's secret, exchanges it for the shop's offline access token
  (`@shopify/shopify-api`, token exchange) and keeps that in `ShopSession`. Server functions
  called from the embedded page carry App Bridge's bearer token. `/` redirects there when
  Shopify's `shop=` is in the URL.
- `/shop` and `/shop/alchemy-sandbox1.myshopify.com` are the member area (Better Auth).
- `/merchant/<shop>?token=<Shopify session token>` is the merchant page without App Bridge,
  which test control mints tokens for.

The Shopify app's key, secret and URL are the dev app's ("Baton Dev", `shopify.app.toml`) when
Shopify CLI runs the server; staging binds the "Baton Staging" app's key and secret
(`shopify.app.staging.toml`) with the Website's own URL; integ and e2e bind a fixed key, a
random secret and the Website's own URL, and the seeded `ShopSession` rows stand in for token
exchange. Never run `shopify app deploy` from this repo:
the config is Baton's, and deploy would push its webhook subscriptions at Baton's app.

## Run locally

Copy `.env.example` to `.env` first; it holds this checkout's port and Shopify dev store.

```sh
vp install
vp run dev        # start or adopt this checkout's dev server
vp run dev:status
vp run dev:logs
vp run dev:stop
vp run db:reset    # wipe and reseed the local auth database, then restart
```

The server is Shopify CLI: `vp run dev` starts `shopify app dev` (`vp run app:dev`) on this
checkout's dev store, `SHOPIFY_DEV_STORE` in `.env`, and the CLI opens a Cloudflare quick tunnel
and runs `alchemy dev` behind it with the app's key, secret and tunnel URL. `vp run dev` fails
when `SHOPIFY_DEV_STORE` is not set; there is no plain `alchemy dev` fallback. One store per
checkout: `mw10013-dev-shop-00` in the main checkout, `mw10013-dev-shop-NN` in worktree `wt-NN`
(`vp run worktree:init` writes it), because two `shopify app dev` sessions on one store overwrite
each other's app URL. `shopify` comes from Vite+'s tool manager (`shopify version`), not brew or
npm.

Each checkout also names an e2e store, `SHOPIFY_E2E_STORE` (`mw10013-e2e-shop-NN`). `vp run
stores:check` checks that both stores exist; `vp run stores:seed` writes `seed/dev-shop.ts` into
the dev store.

Open the app at the admin URL `vp run dev` and `vp run dev:status` print, in a browser signed in
to the Partner organization. For the main checkout it is
<https://admin.shopify.com/store/mw10013-dev-shop-00/apps/7c6cceb7f8f9991a543d43648b08e72d>
(`https://admin.shopify.com/store/<store>/apps/<client_id>`; the CLI prints the same URL with
`?dev-console=show`, which opens its dev console). `http://localhost:$(pnpm port)` still serves the member area and the
merchant page. `alchemy dev` runs under this checkout's dev stage
(`dev-<user>`, or `dev-<user>-wt-NN` in a worktree; `node scripts/stage.ts dev` prints it), using
local implementations where available. Dev's resources and Alchemy's state both live under
`.alchemy/` in the checkout, so dev needs no cloud access, and `vp run db:reset` removes them
together. Development logs are captured by
`s6-log` (install with `brew install s6`) in `.logs/dev`. No official
`@cloudflare/vite-plugin` or Wrangler config is needed.

`vp dev` is Vite+'s built-in and runs Vite without Alchemy. The Vite config blocks it
and points to `vp run dev`, which supplies the Backend and application bindings.

Sign in at `/sign-in` with a seeded dev account (`seed/dev.sql`): `m1@m.com` or `m2@m.com`
(members), or `a@a.com`, the operator, a Better Auth user row with `role = 'admin'`. Each
environment has one seed file (`seed/dev.sql`, `seed/test.sql` for test and e2e,
`seed/staging.sql`), which the `Seed` Action runs after Better Auth's migration, on every fresh
database. Under `alchemy dev` the magic link is shown on the page and in `.logs/dev/current`
instead of being emailed.

## Validate

```sh
vp check
vp test                    # unit, browser and integ projects
vp test --project unit     # in-process tests under test/unit/, Better Auth on an in-memory database
vp test --project integ    # deploys the Backend into workerd (test/integ) and drives it over HTTP
vp run test:e2e            # Playwright, Chromium, against the e2e-<user> stage (not part of vp test)
vp build
```

Browser tests load Polaris from Shopify's CDN in their setup, as the pages do, so `vp test`
needs network access to `cdn.shopify.com`.

Tests are Effect tests on `@effect/vitest`; the `integ` project uses `alchemy/Test/Vitest` in
dev mode, needs no running dev server and runs on this checkout's test stage (`test-<user>`, or
`test-<user>-wt-NN`), with local state under `.alchemy/`. Each integ file deploys a fresh stage
and destroys it afterwards, so every file starts from the seed alone; `NO_DESTROY=1 vp test
--project integ` keeps the stage for inspecting after a failure.

`vp run test:e2e` runs the Playwright specs under `test/e2e/` in Chromium. It destroys this
checkout's e2e stage (`e2e-<user>`, or `e2e-<user>-wt-NN`) and then starts the e2e server: Shopify
CLI (`shopify app dev`) on the checkout's e2e store (`SHOPIFY_E2E_STORE`), which runs `alchemy dev`
on that stage with Baton Dev's real key and secret and the session's tunnel, with local state under
`.alchemy/`, on `WEBSITE_PORT + 100`, so the dev server on `WEBSITE_PORT` keeps running and every
run starts from the seed alone. The server's whole output goes to `.logs/e2e/current`. `E2E_REUSE_SERVER=1` reuses a server
already on that port, keeping its data, for iterating; a server the run started is stopped at
the end. Before the specs it signs in once per role through the test-control procedures, which
the Backend serves only on a stage given an `E2E_TOKEN`. Tests never change seed rows; one that
needs to makes its own `@e2e.test` member or shop. `test/e2e/http.spec.ts` covers the Website's
HTTP behavior (guards, redirects, the auth proxy) with Playwright's `request` fixture and no
browser. `vp run test:e2e:ui` opens Playwright's
UI mode; arguments pass straight through, as in `vp run test:e2e --grep-invert @dev-only` (no
`--`). Reports, traces and saved sign-ins go to `playwright/`, which is ignored.

`vp build` builds client assets and the Cloudflare-compatible server bundle.
Alchemy loads the same Vite configuration and injects its own runtime plugin on
deployment. The config's injection guard prevents duplicate plugin instances.
The compatibility date is pinned to `2026-07-01`, supported by the bundled workerd.

## Reference sources

`scripts/refs.ts` is an Effect CLI executed directly by Node's TypeScript stripping
(Node 22.18+). It downloads source archives and first-party Shopify Markdown, rather than installing packages.

```sh
vp run refs list
vp run refs fetch tan-query tan-form
vp run refs:all
vp run refs:check
```

References include Alchemy, Vite+, TanStack Start/Router/Query/Form, Effect, the Polaris
CDN bundle, Cloudflare docs, Shopify docs, and the private Baton repository. Library tags follow exact `package.json` pins;
Baton snapshots `main` using your existing `gh` authentication (`gh auth login`).
Fetching requires `curl` and `tar`, plus `gh` for Baton.

Downloaded sources and `.ref.json` stamps live under `refs/`, which is excluded
from Git, TypeScript, linting, formatting, and the app's test discovery. Do not
import application code from refs. `check` exits nonzero for missing, stale, or
invalid copies; branch snapshots report their fetch date, not upstream freshness.
Refresh Baton explicitly with `vp run refs fetch baton`. Downloads are staged before
replacement, and a failed download leaves the existing reference intact.

Cloudflare docs snapshot the upstream `production` branch; refresh them with
`vp run refs fetch cloudflare-docs`.

Shopify docs are opt-in: `vp run refs fetch shopify-docs` downloads app build/design/launch
pages, API guides and selected Admin GraphQL resources into `refs/shopify-docs/docs/`,
with local images under `_assets/`. This ports Baton's sitemap-driven Markdown fetcher,
including webhook topics decoded from Shopify's data endpoint. `refs:all` skips this
multi-minute mirror.

Webhook topics follow the `API_VERSION` in `scripts/refs-shopify-docs.ts` (currently
`2026-10`); other API sections follow the site's `latest` pages. The stamp checks that
webhook version and reports the snapshot date; it does not verify live site freshness.
Refresh explicitly when newer docs are needed. Fetching uses the existing Effect HTTP
client and requires network access to Shopify.

Do not enable task caching for reference fetches.

## Deployment

Staging runs on Cloudflare under stage `staging`:

https://alchemy-sandbox1-website-staging-a6uwn3bzazl3yzgy.mw10013.workers.dev

The staging homepage and server snapshot were verified. Git pushes to `main`
deploy through Cloudflare Builds using `pnpm exec vp run deploy:staging`.
To authenticate on another machine, review changes, or redeploy:

```sh
vp exec alchemy profile edit --add Cloudflare
vp exec alchemy plan --stage staging
vp run deploy:staging
```

Staging's externally issued values (the Shopify app's key and secret) come from the main
checkout's untracked `.env.staging`, saved to the state store by
`vp run stage-config --stage staging`, which creates no resources; the staging deploy reads
them from there. Deploy that record before pushing code that needs a new value. See the
[stage config runbook](docs/stage-config-runbook.md).

Alchemy stores authentication in its profiles; do not put credentials in source
files. Staging uses Alchemy's shared Cloudflare state store; dev, test and e2e keep theirs
locally. A stage outside those environments fails, naming it. To inspect state, name the store:
`vp exec alchemy state list -r --backend cloudflare` (or `--backend local`). Review the plan
before running the deployment script, which auto-approves with `--yes`. Production
is reserved for a separate future instance. See
[environment research](docs/alchemy-stages-and-deployments-research.md) for details.

## Dependencies

### Changing Node or pnpm versions

`package.json` is the source of truth for the Node version (`devEngines.runtime`)
and pnpm version (`devEngines.packageManager` and `packageManager`; keep these two
pnpm declarations in sync). pnpm also records the resolved runtime and package
manager in `pnpm-lock.yaml`; those entries are generated, not edited by hand.

After changing a version in `package.json`, run:

```sh
pnpm install --lockfile-only
pnpm install --frozen-lockfile
```

Commit **both `package.json` and `pnpm-lock.yaml`** before pushing. Cloudflare's
Git integration uses `pnpm install --frozen-lockfile`, which rejects a lockfile
that does not match the version declarations—even when only Node changed.
With `devEngines.runtime.onFail: "download"`, pnpm downloads the declared Node
runtime for project commands; Cloudflare's initial Node version can differ.

### Package dependencies

All direct dependencies are exact versions from the npm `latest` tag at setup.
Alchemy's current latest is the Effect-based `2.0.0-beta.81`; Effect is `4.0.1`.
Vite is intentionally aliased to the latest Vite+ core (`1.1.0`), as scaffolded
by VP. `pnpm-lock.yaml` locks transitive dependencies; `pnpm-workspace.yaml` enables exact saves
for future additions. To add a dependency at the latest exact version:

```sh
vp add -E package-name@latest
```

One upstream peer warning remains: Alchemy's transitive `capnp-es@0.0.16` declares
TypeScript 5/6 support, while the requested latest TypeScript is `7.0.2`.
The build, typecheck, and tests work with this version; the warning is not suppressed.

References: [Alchemy + TanStack Start](https://alchemy.run/cloudflare/frontend/tanstack-start),
[VP scaffolding](https://viteplus.dev/guide/create).
