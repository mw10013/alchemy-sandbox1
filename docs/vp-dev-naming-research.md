# `vp dev` and the `dev` script

Updated 2026-10-11 · Vite+ `vp` 1.1.0 (Vite 8.3.3, Rolldown 1.2.12, via `@voidzero-dev/vite-plus-core` 1.1.0) · Alchemy `2.0.0-beta.81` · Implemented 2026-10-11.

## Summary

`package.json` has a `dev` script that runs `alchemy dev`, next to Vite+'s built-in `vp dev` that runs plain Vite. The two names look interchangeable and are not. Vite+ itself makes it worse: whenever a `dev` script exists, `vp dev` prints a note telling the caller to run the script instead. The recommendation is to rename the script so no script shadows a built-in, and make `vp run dev:start` the only documented way to start the dev server.

A trace of both commands (below) also corrects one earlier claim. `vp dev` is not an app-only fallback that works. It starts the Website in workerd with no bindings, so every route that calls the Backend, the home page included, fails on request.

## Background

Vite+ separates **built-in commands** from **package scripts** (the "Built-in Commands vs Scripts" section of `refs/vite-plus/docs/guide/run.md`):

| Command      | What it runs                                         |
| ------------ | ---------------------------------------------------- |
| `vp dev`     | The built-in Vite dev server. Cannot be overridden.  |
| `vp run dev` | The `dev` script in `package.json`, or a `dev` task. |

`vpr` is shorthand for `vp run`. The same split applies to `build`, `preview`, `lint`, `fmt`, `check`, `pack` and `test`. A same-named script never changes what the built-in does.

On 2026-10-11 the scripts that merely aliased a built-in (`build`, `check`, `test`, `test:unit`, `test:integ`, `test:browser`, `preview`, `typecheck`) were removed, and `AGENTS.md` now says to prefer the built-ins. `dev` is the one same-name script left, and it is not an alias.

## What `vp dev` does

Traced through `refs/vite-plus` (the 1.1.0 source, which matches the installed `node_modules/vite-plus/dist`). It runs three processes:

1. **Global `vp` (Rust, `crates/vp_global_cli`).**
   - `dev` is a "local CLI delegation" command. Every argument after `dev` passes through verbatim.
   - It prints the Vite+ banner on a TTY.
   - It resolves the project's Node from `devEngines.runtime` (24.21.0), downloading it if needed (`ensure_project_runtime`).
   - It then runs `node node_modules/vite-plus/dist/bin.js dev …`, adding `VP_CLI_BIN`, `VP_RAW_SUBCOMMAND` and the managed Node to `PATH`.
2. **Local vite-plus (`packages/cli`, a NAPI core).**
   - `dev` is a "synthesizable subcommand" and goes to `execute_direct_subcommand`, which says: "not through vite-task Session. No caching, no task graph, no dependency resolution."
   - It never reads `package.json` scripts or `run.tasks`. The only time it looks at scripts is to print a note (`script_note.rs`): "You are running `vp dev` as a Vite+ built-in command. If you meant to run the dev npm script, use `vpr dev` instead." This repo has a `dev` script, so the note appears on every `vp dev`.
   - It prepends pnpm 12.9.1 to `PATH`, downloading it if needed.
   - It then spawns `node node_modules/vite/dist/vite/node/cli.js dev …` (`resolver.rs`), adding `NODE_PACKAGE_MANAGER=vite-plus`, `VP_VERSION` and the runtime version variables.
3. **Vite's own CLI (vite-plus-core).**
   - `cli.command("[root]").alias("serve").alias("dev")` calls `createServer`.
   - The config function receives `{ command: "serve", mode: "development" }`.
   - No `.env` is loaded beyond Vite's own `loadEnv` and the explicit `loadEnv(mode, cwd, "WEBSITE_")` in `vite.config.ts`.
   - `defineConfig` from `vite-plus` adds three plugins, all inert outside Vitest.

vite-plus-core is upstream Vite 8 with Rolldown bundled in. Its patches are about packaging, branding (the "VITE+" banner and `[vite+]` log prefix) and one module-runner import fix. It does not change the dev server, plugins or the Environments API.

So "`vp dev` just calls Vite" holds: the project's Vite, the project's `vite.config.ts`, no task runner. What that config then does is the next section.

### What the config does under `vp dev`

`ALCHEMY_CLOUDFLARE_VITE_INJECTED` is unset, so `vite.config.ts` instantiates `cloudflare()` from `@alchemy.run/cloudflare-runtime/vite` itself:

- **It does start workerd.** `configureServer` (`dev-plugin.ts`) creates a default context with temp storage and lazy credentials from the environment. It boots workerd and runs the Website's SSR there, through `DistilledDevEnvironment`.
- **The Worker has no app bindings**, only the plugin's internal module-runner bindings. There is no `BACKEND`, no `AUTH_ORIGIN`, no D1 and no `MAGIC_LINK_DELIVERY`. `ALCHEMY_DEV` is unset, and the Backend Worker never runs.
- **It starts cleanly.** Nothing in `src/` reads `env.BACKEND` at import time, and `env.server.ts` reads bindings lazily.
- **It fails per request.** Every Backend call throws `Cannot read properties of undefined (reading 'fetch')`. That covers:
  - `serverFetch` in `backend-client.ts`, which carries all SSR RPC;
  - `routes/api.rpc.ts`, `routes/api.auth.$.ts` and `routes/api.test-control.ts`.
- **The home page fails too.** The `/` loader runs `helloAtom` and `currentMember` during SSR. This is inferred from code: `vp dev` was not run.
- **The port** comes from the config's `server: { port: WEBSITE_PORT, strictPort: true }`. `vp dev` fails if `WEBSITE_PORT` is not in `.env` or the environment.

## What `alchemy dev` does, for contrast

Traced through `node_modules/alchemy`:

- **The Website** runs in a child process (`LocalWorkerProvider.serveVite` → `startViteChild` → `ViteChildRunner.ts`).
  - The child resolves the project's `vite` (the same vite-plus-core) and calls `createServer` in-process, with the inline plugin `cloudflare({ worker: { bindings }, context })`.
  - Vite loads `vite.config.ts` normally.
  - `viteDev` sets `ALCHEMY_CLOUDFLARE_VITE_INJECTED=1` first, so the config's own `cloudflare()` is skipped.
- **Bindings** come from `materializeRuntimeBindings`: a service binding to the Backend, and D1 as `D1.local` for `dev:` ids under `.alchemy/local`.
- **The port:** the child's Vite listens on a random port on `127.0.0.1`. `WEBSITE_PORT` is served by Alchemy's own proxy (`maybeStartProxy`), from `alchemy.run.ts`'s `dev: { port, strictPort }`.
  - Inferred: the inline `server` overrides the config file's.
  - `websitePort()` still runs, because `command === "serve"`.
- **The Backend** is bundled and served in its own workerd. `ALCHEMY_DEV=true` is set on the process.

## The issue

| Command            | Runs                                                                                                                                | Runs Alchemy? |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `vp dev`           | Vite and the Website in workerd, with no bindings. Prints a note pointing at `vpr dev`.                                             | No            |
| `vp run dev`       | `alchemy dev --stage dev`, piped through `s6-log` to `logs/dev/`.                                                                   | Yes           |
| `vp run dev:start` | `scripts/dev.ts start`: adopts a running server, or runs `vp run dev` in a herdr pane, the caller's terminal or a detached process. | Yes           |

A caller who follows "prefer built-ins" reaches for `vp dev` and gets a server that boots and then fails on the first page. Vite+'s note then sends them to `vpr dev`, the raw script. That holds the terminal until it exits, and can start a second server next to an adopted one.

`AGENTS.md` currently works around this with "Start with `vp run dev:start`, not `vp run dev`". The Vite+ note contradicts it on every `vp dev`.

## Can `vp dev` be made to do the right thing?

No.

- Built-ins cannot be overridden (`execute_direct_subcommand` above), so no script, task or config changes `vp dev`.
- `vp dev` passes its arguments to Vite, so `vp dev start` would treat `start` as the project root, not a subcommand.
- The only way to make `vp dev` run Alchemy is to host Alchemy inside Vite's dev server. Alchemy only goes the other way: it drives Vite, in `Sources/Vite.ts` and the `packages/frontend-frameworks` integrations.
  - A search of `refs/alchemy` for `configureServer` and Vite integrations found no plugin that reconciles from inside `vite dev`.
  - The cloudflare-runtime plugin runs a Worker, not a stack.

## Ramifications of a rename

- **`scripts/dev.ts`** calls `vp run dev` in `runDev`, in the herdr pane command, and in its JSDoc and help text.
  - Its process detection (`SERVER_PROCESS`) matches the command line `alchemy dev --stage dev`, not the script name, so a rename does not change what `dev:stop` and `dev:status` find.
  - Playwright's `vp exec alchemy dev` passes the stage through `ALCHEMY_STAGE`, not `--stage dev`, so it stays out of reach either way.
- **The Vite+ note goes away.** It fires only when a `dev` script exists.
- **Live documents that name `vp run dev`:**
  - `README.md`. It also gives the log directory as `.log/dev` instead of `logs/dev`, and tells you to start with `vp run dev` instead of `dev:start`.
  - `AGENTS.md`.
- **Live documents that call `vp dev` the "app-only fallback":** `README.md` and `docs/website-port-runbook.md`. Both need the corrected description whichever option is chosen.
- **Dated records that name `vp run dev`:** `docs/better-auth-integration-plan.md`, `docs/alchemy-stages-and-deployments-research.md`, `docs/playwright-e2e-plan.md` and `docs/playwright-e2e-research.md`. Not rewritten.
- **Playwright** starts its own `alchemy dev` for the e2e stage (`playwright.config.ts`), so it does not depend on the `dev` script.
- **Worktrees:** the runbook goes through `dev:start`, so it is unaffected.

## Options

1. **Rename the raw script.** `dev` becomes an internal name, called only by `scripts/dev.ts`.
   - The public surface is `dev:start`, `dev:stop`, `dev:status` and `dev:logs`.
   - `vp run dev` then fails with "script not found" instead of holding a terminal, and the misleading note disappears.
2. **Rename and also block `vp dev`.** Add a guard to `vite.config.ts` that fails `vp dev` with "use `vp run dev:start`".
   - It would key off `command === "serve"`, `mode !== "test"` and `ALCHEMY_CLOUDFLARE_VITE_INJECTED` being unset.
   - Risk: Alchemy, the e2e suite and the browser tests all load this config in serve mode, so a wrong condition breaks one of them. Untested.
   - The fallback it would remove is barely usable (see above).
3. **Do nothing.** The shadowing stays, `AGENTS.md` carries the warning, and Vite+ keeps pointing at the raw script.

## Recommendation

Option 1, plus correcting how `vp dev` is described: it boots the Website in workerd without the Backend, and is not a fallback for working on pages that load data. The `AGENTS.md` rule then reads: start the dev server with `vp run dev:start`; `vp dev` runs Vite without Alchemy and the Backend.

## Decisions

Accepted 2026-10-11:

1. **The foreground script is renamed `dev:alchemy`.** It says what `vp dev` lacks, and it is not a synonym of `start`. `dev:run` read like `dev:start`, and `dev:serve` had the same problem to a lesser degree.
2. **`dev:start` gets no `--foreground` flag.** `placeServer` already runs the server in the caller's terminal when a person types `dev:start`, either without herdr or in herdr's `dev` tab.
3. **`vp dev` stays as it is, with the corrected description.**
   - Its `server` block makes it fail on `strictPort` when the checkout's `alchemy dev` already holds `WEBSITE_PORT`, instead of drifting to another port.
   - Blocking it (Option 2) remains the fallback if agents keep reaching for it after the rename.
4. **The README is fixed in the same change as the rename:** the `.log/dev` typo, `vp run dev` → `vp run dev:start`, and the `vp dev` description.

## Not verified

- `vp dev` was not run. The startup behavior and the error on `/` are from reading code.
- Whether the inline `server` from Alchemy overrides `vite.config.ts`'s `server.port`. This is inferred from Vite's merge order. The Alchemy proxy owning `WEBSITE_PORT` is verified.
- Signal handling. On a TTY, the `vp` and `bin.js` parents ignore SIGINT so that Ctrl+C reaches Vite. No SIGTERM forwarding was found, so a SIGTERM to the top `vp` pid alone may orphan Vite.
  - This does not affect `dev:stop`, which signals the `alchemy dev` processes directly.
- That vite-plus-core's pinned Vite commit (`fea5b21`) is exactly the v8.3.3 tag.
