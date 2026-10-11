# `vp dev` and the `dev` script

Updated 2026-10-11 · Vite+ `vp` with Vitest 5.0.3 · Alchemy `2.0.0-beta.81` · Not implemented; parked for a later session.

## Summary

`package.json` has a `dev` script that runs `alchemy dev`, next to Vite+'s built-in `vp dev` that runs plain Vite. The two names look interchangeable and are not. The recommendation is to rename the script so no script shadows a built-in, and make `vp run dev:start` the only documented way to start the dev server.

## Background

Vite+ separates **built-in commands** from **package scripts** (the "Built-in Commands vs Scripts" section of `refs/vite-plus/docs/guide/run.md`):

| Command      | What it runs                                         |
| ------------ | ---------------------------------------------------- |
| `vp dev`     | The built-in Vite dev server. Cannot be overridden.  |
| `vp run dev` | The `dev` script in `package.json`, or a `dev` task. |

The same split applies to `build`, `preview`, `lint`, `fmt`, `check`, `pack` and `test`. A same-named script never changes what the built-in does.

On 2026-10-11 the scripts that merely aliased a built-in (`build`, `check`, `test`, `test:unit`, `test:integ`, `test:browser`, `preview`, `typecheck`) were removed, and `AGENTS.md` now says to prefer the built-ins. `dev` is the one same-name script left, and it is not an alias.

## The issue

| Command            | Runs                                                                       | Runs Alchemy? |
| ------------------ | -------------------------------------------------------------------------- | ------------- |
| `vp dev`           | Plain Vite. The README and the port runbook call it the app-only fallback. | No            |
| `vp run dev`       | `alchemy dev --stage dev`, piped through `s6-log` to `logs/dev/`.          | Yes           |
| `vp run dev:start` | `scripts/dev.ts start`, which launches `vp run dev` detached.              | Yes           |

A caller who follows the rule "prefer built-ins" reaches for `vp dev` and gets a server with no Backend Worker, no service binding, no D1 and no auth. A caller who runs `vp run dev` gets the right server but holds the terminal until it exits, and may start a second one next to an adopted one.

`AGENTS.md` currently works around this with "Start with `vp run dev:start`, not `vp run dev`".

## Can `vp dev` be made to do the right thing?

No, on current evidence.

- Built-ins cannot be overridden, so no script, task or config changes `vp dev`.
- `vp dev` passes its arguments to Vite, so `vp dev start` would treat `start` as a project root, not a subcommand.
- The only way to make `vp dev` run Alchemy is to host Alchemy inside Vite's dev server, as `@cloudflare/vite-plugin` does for Wrangler. Alchemy goes the other way: `alchemy dev` loads and drives the Vite config. A search of `refs/alchemy` found no Vite plugin that performs dev reconciliation from inside `vite dev`.

`vp dev` is therefore always Vite alone, and the repo treats that as a deliberate fallback (`vite.config.ts` sets the same port for it).

## Ramifications

- **`scripts/dev.ts`** calls `vp run dev` in several places (`runDev`, the herdr pane command, and its comments and help text). Its process detection matches the command line `alchemy dev --stage dev`, not the script name, so a rename should not change what it finds. Verify this when implementing, because `dev:stop` and `dev:status` depend on it.
- **Documents that name `vp run dev`:** `README.md`, `AGENTS.md`, `docs/better-auth-integration-plan.md`, `docs/alchemy-stages-and-deployments-research.md` and `docs/playwright-e2e-plan.md`. The last three are dated records and would not be rewritten.
- **Playwright** starts its own `alchemy dev` for the e2e stage (see `playwright.config.ts`), so it does not depend on the `dev` script.
- **Worktrees:** the runbook goes through `dev:start`, so it is unaffected.

## Options

1. **Rename the raw script.** `dev` becomes an internal name such as `dev:run`, called only by `scripts/dev.ts`. The public surface is `dev:start`, `dev:stop`, `dev:status` and `dev:logs`. `vp run dev` then fails with "script not found" instead of blocking a terminal. `vp dev` stays the documented app-only fallback.
2. **Rename and also block `vp dev`.** Add a guard to `vite.config.ts` that fails `vp dev` with "use `vp run dev:start`". Not recommended: Alchemy, the e2e suite and the browser tests all load this config in serve mode, so a guard is easy to get wrong, and the fallback is useful. Untested.
3. **Do nothing.** The shadowing stays and `AGENTS.md` carries the warning.

## Recommendation

Option 1. Name candidates for the script: `dev:run` (the shortest), `dev:serve`, `dev:alchemy`. The `AGENTS.md` rule then reads: start the dev server with `vp run dev:start`; `vp dev` is app-only Vite, without Alchemy.

## Open questions

- Which name for the foreground script?
- Should `dev:start` take a `--foreground` flag, since a foreground start is the only reason anyone would need the raw script directly?
