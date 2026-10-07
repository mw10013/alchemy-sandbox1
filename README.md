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

All direct dependencies are exact versions from the npm `latest` tag at setup.
Alchemy's current latest is the Effect-based `2.0.0-beta.81`; Effect is `4.0.1`.
Vite is intentionally aliased to the latest Vite+ core (`1.1.0`), as scaffolded
by VP. `pnpm-lock.yaml` locks transitive dependencies; `.npmrc` enables exact saves
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
