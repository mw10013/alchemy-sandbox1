# Alchemy-sandbox1

A minimal TanStack Start app (`Website.Vite`) that calls a private Effect
backend Worker over a service binding, styled with Astryx's standard neutral
theme. Both Workers are managed by Alchemy (`alchemy.run.ts`).
Created with `vp create` in the existing project directory.

The Backend also hosts Durable Objects. A browser reaches an actor (`ShopActor`, one per shop
key) over one WebSocket at `/api/actor/<key>`, through the Website and the Backend's session
check, with Effect RPC on it; after a write the actor sends a notice naming the stale reactivity
keys, and every tab refetches. SSR reads the same actor over HTTP through the binding. The
member page is `/app/shop/alchemy-sandbox1`, and `vp run test:e2e` covers two tabs on it.

## Run locally

Copy `.env.example` to `.env` first; it holds this checkout's port.

```sh
vp install
vp run dev:start   # start or adopt this checkout's dev server
vp run dev:status
vp run dev:logs
vp run dev:stop
vp run db:reset    # wipe and reseed the local auth database, then restart
```

Open `http://localhost:$(pnpm port)`. The server is `alchemy dev` under stage `dev`, using
local implementations where available and cloud resources when needed. The shared
Cloudflare state backend requires cloud access. Development logs are captured by
`s6-log` (install with `brew install s6`) in `logs/dev`. No official
`@cloudflare/vite-plugin` or Wrangler config is needed.

`vp dev` is Vite+'s built-in and runs Vite without Alchemy: the Website runs in workerd
with no bindings, so every route that calls the Backend, the home page included, fails.

Sign in at `/sign-in` with a seeded dev account (`seed/dev.sql`): `a@a.com` (admin),
`m1@m.com` or `m2@m.com` (members). Under `alchemy dev` the magic link is shown on the
page and in `logs/dev/current` instead of being emailed.

## Validate

```sh
vp check
vp test                    # unit, browser and integ projects
vp test --project unit     # in-process tests under src/, Better Auth on an in-memory database
vp test --project integ    # deploys the Backend into workerd (test/integ) and drives it over HTTP
vp run test:e2e            # Playwright, Chromium, against the e2e_<user> stage (not part of vp test)
vp build
pnpm exec astryx doctor
```

Tests are Effect tests on `@effect/vitest`; the `integ` project uses `alchemy/Test/Vitest` in
dev mode, needs no running dev server and keeps its stack under `.alchemy/` on the `test_<user>`
stage. The stack is never destroyed: a re-run redeploys it as a no-op, and `vp run db:reset`
wipes its local D1 along with dev's.

`vp run test:e2e` runs the Playwright specs under `e2e/` in Chromium. It starts `alchemy dev`
on its own stage (`e2e_<user>`), with local state under `.alchemy/`, on `WEBSITE_PORT + 100`, so
the dev server on `WEBSITE_PORT` keeps running; a server already on that port is reused, and one
it started is stopped at the end. Before the specs it resets the stage's data (Better Auth rows
and `@e2e.test` members) and signs in once per role through the test-control procedures, which
the Backend serves only on a stage given an `E2E_TOKEN`. `vp run test:e2e:ui` opens Playwright's
UI mode; arguments pass straight through, as in `vp run test:e2e --grep-invert @dev-only` (no
`--`). Reports, traces and saved sign-ins go to `playwright/`, which is ignored.

`vp build` builds client assets and the Cloudflare-compatible server bundle.
Alchemy loads the same Vite configuration and injects its own runtime plugin on
deployment. The config's injection guard prevents duplicate plugin instances.
The compatibility date is pinned to `2026-07-01`, supported by the bundled workerd.

## Reference sources

`scripts/refs.ts` is an Effect CLI executed directly by Node's TypeScript stripping
(Node 22.18+). It downloads source archives, not installed packages or Git checkouts.

```sh
pnpm refs list
pnpm refs fetch tan-query tan-form
pnpm refs:all
pnpm refs:check
```

References include Alchemy, Vite+, TanStack Start/Router/Query/Form, Astryx, Effect,
Cloudflare docs, and the private Baton repository. Library tags follow exact `package.json` pins;
Baton snapshots `main` using your existing `gh` authentication (`gh auth login`).
Fetching requires `curl` and `tar`, plus `gh` for Baton.

Downloaded sources and `.ref.json` stamps live under `refs/`, which is excluded
from Git, TypeScript, linting, formatting, and the app's test discovery. Do not
import application code from refs. `check` exits nonzero for missing, stale, or
invalid copies; branch snapshots report their fetch date, not upstream freshness.
Refresh Baton explicitly with `pnpm refs fetch baton`. Downloads are staged before
replacement, and a failed download leaves the existing reference intact.

Cloudflare docs snapshot the upstream `production` branch; refresh them with
`pnpm refs fetch cloudflare-docs`.

These package scripts also work through `vp run`; do not enable task caching for
reference fetches.

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

Alchemy stores authentication in its profiles; do not put credentials in source
files. Deployment uses Alchemy's shared Cloudflare state store. Review the plan
before running the deployment script, which auto-approves with `--yes`. Production
is reserved for a separate future instance. See
[environment research](docs/alchemy-stages-and-deployments-research.md) for details.

## Dependencies and Astryx

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

Astryx's CLI and generated `AGENTS.md` are installed:

```sh
pnpm exec astryx component Button
pnpm exec astryx template --list
pnpm exec astryx docs theme
```

References: [Alchemy + TanStack Start](https://alchemy.run/cloudflare/frontend/tanstack-start),
[Astryx setup](https://astryx.atmeta.com/docs/getting-started),
[VP scaffolding](https://viteplus.dev/guide/create).
