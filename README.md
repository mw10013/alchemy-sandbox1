# Alchemy-sandbox1

A minimal TanStack Start app with an Effect-powered `/api/health` endpoint,
Astryx's standard neutral theme, and one Alchemy-managed Cloudflare Worker.
Created with `vp create` in the existing project directory.

## Run locally

```sh
vp install
vp run dev
```

Open http://localhost:3000 and click **Test backend**. Local development uses
Alchemy's Cloudflare runtime plugin (workerd); no cloud resources or credentials
are required. No official `@cloudflare/vite-plugin` or Wrangler config is needed.

## Validate

```sh
vp check
vp run typecheck
vp run test
vp run build
pnpm exec astryx doctor
```

`vp run build` builds client assets and the Cloudflare-compatible server bundle.
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

Deployed to Cloudflare using the `default` OAuth profile, stage `live_mw`:

https://alchemy-sandbox1-website-live-mw-zl2qcdtfjxhdlfbx.mw10013.workers.dev

The live homepage, `/api/health`, and interactive backend button were verified.
To authenticate on another machine or redeploy:

```sh
vp exec alchemy profile edit --add Cloudflare
vp run deploy
```

Alchemy stores authentication in its profiles; do not put credentials in source
files. Deployment also provisions Alchemy's Cloudflare state store. Review the
plan before confirming. `vp run dev:worker` runs Alchemy-managed development and
can access/provision real cloud resources; use `vp run dev` for offline development.

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
