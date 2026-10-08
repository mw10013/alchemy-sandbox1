# Alchemy: dev, staging, and production

Updated 2026-10-08 · Alchemy `2.0.0-beta.81` · Development validated; staging deployed and HTTP response verified; Git integration connected. First Git-triggered deployment awaits verification.

## Accepted target

**Use `dev`, `staging`, and `production`. No personal initials are necessary.**

Stages identify separate infrastructure/state instances. **The command determines whether resources run locally or remotely—not the stage name.**

| Environment | Command | Where the app runs |
| --- | --- | --- |
| Development | `vp run dev` | Your machine; remote supporting resources only when needed |
| Staging | `vp run deploy:staging` | Separate Cloudflare Worker, deployed from `main` |
| Production, later | `vp run deploy:production` | Separate Cloudflare Worker, deployed from protected `production` branch |

## Package scripts

The package uses these scripts:

```json
{
  "scripts": {
    "dev": "alchemy dev --stage dev",
    "deploy:staging": "alchemy deploy --stage staging --yes",
    "deploy:production": "alchemy deploy --stage production --yes"
  }
}
```

This is an excerpt, not a replacement for the whole package file. Replace the existing `dev` script, remove `dev:worker` and the ambiguous bare `deploy` script, and keep unrelated scripts. Do not add `dev:app`.

**Use `vp run dev` for the Alchemy workflow.** `vp dev` remains Vite+'s built-in dev-server fallback; it does not run the package's `dev` script or Alchemy infrastructure reconciliation.

For one-off Alchemy operations, use `vp exec alchemy …`. Do not enable task caching for provisioning, deployment, or teardown commands.

## What development actually means

Running `vp run dev` (`alchemy dev --stage dev`) does two jobs:

1. Starts the development app/server on your machine and watches for code changes.
2. Reconciles supporting resources: local implementations where available, real cloud resources where no local implementation exists.

**No separate deploy is needed to create those remote supporting resources.** The dev command manages them with your configured cloud credentials. Missing credentials or permissions can prevent development from starting.

```text
vp run dev
  ├─ app/server → runs on your machine
  ├─ emulatable supporting service → local simulator
  └─ live-only supporting service → created/updated in Cloudflare
                                      tracked under stage dev
```

Remote supporting resources belong to `dev`, not staging or production. Reconciliation reuses tracked resources. Stopping the dev server does not guarantee their deletion: they can persist, incur costs, and require deliberate cleanup.

`Alchemy.remote()` can opt an emulatable resource into real cloud execution. Bindings/access must support the selected resource combination. Do not make the app's Worker remote for this local development workflow.

### Does dev create a Cloudflare website deployment?

**Not by default.** A locally implemented Website/Worker runs on your machine. Selecting stage `dev` does not publish another website, although remote supporting resources can exist in Cloudflare.

The current stack uses `Cloudflare.state()`, so Alchemy development can contact Cloudflare for infrastructure-management state even when app resources are emulated. Remote state is not a remotely hosted app.

### Safety rules

- **Never deploy to `dev` or run `alchemy dev` against staging/production.** Switching local/live implementations within a stage can replace resources.
- A shared `dev` stage is appropriate for the current single-developer setup. If multiple developers later share the account/stack, isolate their stages with workspace names such as `dev-a` and `dev-b`, or separate accounts/backends.
- Preserve the stack name `Alchemy-sandbox1`, the `Website` logical ID, and `Cloudflare.state()`.
- Do not delete the shared `alchemy-state-store` or resources belonging to other stacks.

## Naming

Explicit `--stage` overrides `ALCHEMY_STAGE` and the default `dev_<user>` / `live_<user>` stage names.

Keep generated Worker names initially:

```text
alchemy-sandbox1-website-staging-<suffix>
alchemy-sandbox1-website-production-<suffix>
```

A different stage selects another tracked instance; it does not rename an existing Worker. The account's `workers.dev` subdomain is separate from stage naming. Use a custom domain for public branding.

## Next steps

### 1. Package scripts applied

The agreed package-script changes are applied. No Cloudflare website deployment is needed before starting development.

### 2. Development validated

```sh
vp run dev
```

The local development workflow has been validated by the operator. Supporting resources reconcile under `dev`.

### 3. Staging created

```sh
# Review proposed staging resources:
vp exec alchemy plan --stage staging

# Initial creation with operator approval:
vp exec alchemy deploy --stage staging
```

The reviewed plan contained only `[Website] create`, with no updates or deletions. Deployment was applied with `--yes` under explicit operator authorization and succeeded.

- Worker: `alchemy-sandbox1-website-staging-a6uwn3bzazl3yzgy`
- URL: <https://alchemy-sandbox1-website-staging-a6uwn3bzazl3yzgy.mw10013.workers.dev>
- HTTP verification returned the app's “Hello, Alchemy.” page and a server snapshot. Browser interaction testing remains separate.
- The build emitted a non-blocking warning about chunks larger than 500 kB.

### 4. Git integration connected; validate the first build

The operator connected the staging Worker to `mw10013/alchemy-sandbox1`. The saved configuration shows:

- Branch: `main`
- Deploy command: `pnpm exec vp run deploy:staging`
- Separate build command: none
- Root directory: `/`
- API token: `Workers Builds - 2026-05-31 17:29`

Preview builds were unchecked before submission. The saved Production settings screenshot does not expose that setting; confirm the persisted value in Preview Builds. Keep previews off.

The selected token displays a warning about missing email-routing read/write and artifacts read/write permissions. Do not broaden access merely to suppress the warning. Review actual deployment requirements as a follow-up, or add specific required permissions if the first build fails with an authorization error.

Cloudflare installs repository dependencies before executing the deploy command. `pnpm exec` resolves the project-local `vp` supplied by the `vite-plus` dependency; do not rely on a global `vp` installation. CI must have credentials and access to the same Alchemy state backend so it updates the existing staging Worker.

The initial script commits were pushed before Git was connected. Push this documentation update to test the new integration. Confirm a Git build logs stage `staging`, loads shared state, updates the existing Worker rather than creating a new one, and serves the app at the recorded URL. Build success has not yet been verified. Update README links. Cloudflare's label “Production” for the Worker's primary branch does not change its role as our staging environment.

### 5. Add production later

Create a separate `production` instance/Worker and connect the protected `production` branch with `pnpm exec vp run deploy:production` as the Git integration deploy command. Keep runtime data, secrets, and domains separate from staging.

## Sources

- [Vite+ run docs](https://viteplus.dev/guide/run) and [local reference](../refs/vite-plus/docs/guide/run.md); [binary execution](https://viteplus.dev/guide/vpx) documents `vp exec`.
- [Alchemy local development](https://alchemy.run/environments/local-development): local implementations, automatic live-only resources, and `remote()`.
- [Installed dev command](../node_modules/alchemy/src/Cli/commands/dev.ts) and [stage resolution](../node_modules/alchemy/src/Cli/commands/flags.ts).
- [Installed deployment/approval implementation](../node_modules/alchemy/src/Cli/commands/deploy.ts).
- [Current stack](../alchemy.run.ts) and [package scripts](../package.json).
