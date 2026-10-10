# Website port runbook

How the local dev server's port is chosen, found and kept unique per checkout.

## How it works

- Each checkout sets `WEBSITE_PORT` in its own untracked `.env`. `.env.example` is the tracked template. Main uses 3900.
- `alchemy dev` serves the Website on `WEBSITE_PORT`. Alchemy loads `.env` itself (shell variables win), so no script sources it.
- There is no default. `alchemy dev`, `vp dev` and `pnpm port` fail if `WEBSITE_PORT` is not set.
- `strictPort: true`: if the port is taken, dev fails with "Could not bind to port … (already in use)". It never moves to another port, so a checkout can't end up talking to another checkout's server.
- The Backend Worker uses `dev: { port: 0 }`, an ephemeral port. Only the Website reaches it, through the `BACKEND` service binding, so nothing needs to know its port.
- Deploys ignore all of this. Workers on Cloudflare have no port; the dev settings are only set when `ALCHEMY_DEV` is true. Staging and production need no `WEBSITE_PORT`.

## Finding the port

```sh
pnpm port                          # prints the port
open "http://localhost:$(pnpm port)"
```

`pnpm port` parses `.env` with Node's `--env-file` rather than sourcing it as shell, and prints only the port. Agents use it through `AGENTS.md`.

## Worktrees

Each worktree needs its own `.env` with a port no other checkout uses, e.g. 3900 + the worktree index (`wt-01` → 3901). The worktree setup step should write it.

## Where it lives

| File                    | Role                                            |
| ----------------------- | ----------------------------------------------- |
| `alchemy.run.ts`        | Reads `WEBSITE_PORT` in dev; sets `strictPort`  |
| `src/backend/worker.ts` | Backend on an ephemeral dev port                |
| `vite.config.ts`        | Same port for the app-only `vp dev` fallback    |
| `package.json`          | `pnpm port`                                     |
| `.env.example`          | Template                                        |
| `AGENTS.md`             | Dev server URL: `http://localhost:$(pnpm port)` |

## Known gap

Browser cookies are not separated by port. If two checkouts' servers set cookies with the same name (e.g. an auth session), signing in on one overwrites the other in the same browser profile. Use separate browser profiles or Playwright sessions per checkout if that comes up.
