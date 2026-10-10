# T3 Code worktrees, project actions, and where the dev server runs

Updated 2026-10-10 · T3 Code `pingdotgg/t3code` @ `aacefcd` (latest stable v0.0.45) · herdr 0.9.3 · Alchemy `2.0.0-beta.81` · vp 1.1.0 · Status: research. Nothing has been implemented yet.

## Summary of recommendations

1. **Use long-lived numbered worktrees** named `wt-01`, `wt-02`, and so on. The number is the branch name, the T3 folder name, the herdr workspace label, and the port index. They are never deleted between tasks. This is Baton's convention, and it fits T3's layout well.
2. **Create each worktree once, with an explicit branch name.** T3's composer cannot do this, but T3's own launch API can: `t3_thread_launch` with `{"type":"worktree","baseRef":"main","branch":"wt-01"}`. T3 names the folder after the branch, so it becomes `~/.t3/worktrees/alchemy-sandbox1/wt-01`. Later threads reuse it with **"New thread in this worktree"** or **"Previous worktree"**.
3. **Add a `t3.json` setup action** (`runOnWorktreeCreate: true`, `async: false`). It runs an idempotent `scripts/worktree-setup.ts`, which:
   - works out `NN` from the branch;
   - writes a per-worktree `.env` with the ports and the Alchemy stage;
   - symlinks `refs/`;
   - runs `vp install --frozen-lockfile`.

   It does **not** start the dev server.

4. **Make the dev ports configurable and strict.** `alchemy.run.ts` hard-codes Website port 3000, and the Backend uses Alchemy's default 1337. Today a second checkout silently moves to another port. Derive both ports from `.env` and set `strictPort: true`.
5. **Give each worktree its own Alchemy dev stage** (`dev-wt-01`). The stack uses `Cloudflare.state()`, which is shared remote state keyed by stack and stage. Two checkouts running `alchemy dev --stage dev` at once write to the same state.
6. **Run dev servers in herdr, not in T3 terminals.** Use one herdr workspace per checkout with a `server` tab, driven by a small `scripts/dev.ts` controller (start, stop, restart, status, logs, later reset and seed) modelled on Baton's. T3 terminals are tied to a thread and die with it, and T3 has no list of running terminals. herdr is the opposite on both counts.

---

## 1. How T3 Code handles worktrees

These points are confirmed in the T3 source and docs at `aacefcd`, unless marked inferred.

### Creating one

- The composer's workspace selector (`mod+shift+x`) offers **Current checkout**, **New worktree** and **Previous worktree**. You also choose a base branch, and a **Start from origin** switch creates the worktree from the latest origin branch instead of the local one.
- The worktree is created when the **first message is sent**. Shift-clicking several models makes one worktree per model. `Cmd+Enter` makes background threads, and each gets its own worktree.
- The default for new threads is `defaultThreadEnvMode`, which is `local` unless set. It can be set per project, per environment, or in `t3.json`.
- The server supports three launch strategies (`packages/contracts/src/orchestrationV2.ts`):
  ```ts
  { type: "root", branch? }
  { type: "existing_worktree", worktreePath, branch? }
  { type: "worktree", baseRef, branch?, startFromOrigin? }
  ```

### Where the folder goes and how it is named

```ts
// apps/server/src/vcs/GitVcsDriverCore.ts
const sanitizedBranch = targetBranch.replace(/\//g, "-");
worktreePath = path.join(parentDir, repoName, sanitizedBranch);
```

- `parentDir` is the **Settings → Storage → Worktree location** setting. The default is `~/.t3/worktrees`.
- So a path looks like `~/.t3/worktrees/alchemy-sandbox1/<branch with / changed to ->`.
- **The folder name comes from the branch name at creation time.** You control the folder by controlling the branch; you don't control the parent directory.

### Branch naming

- The composer **never sends a branch name**. The server creates a temporary `t3/<8 hex>` branch, so the folder becomes `t3-<hex>`.
- In the background it then asks a model for a name and runs `git branch -m`. The style is set in **Settings → Source Control → Worktree branch naming**: `static` with prefix `t3` (the default), `semantic`, or `custom`.
- **The folder is not renamed.** You end up with branch `t3/fix-login` in folder `t3-1a2b3c4d`.
- An explicit `branch` is accepted only through the API: the agent MCP tool `t3_thread_launch`, and scheduled tasks. Neither the UI nor the naming settings can produce `wt-01`, because the generated names are slugs from the prompt.

### Reuse, sharing and lifecycle

| Event                                                                 | What happens to the worktree                                                                                                                                                                                                                                |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New thread in this worktree / Previous worktree / `existing_worktree` | Reused. Several threads can share one worktree, and this is modelled explicitly.                                                                                                                                                                            |
| Thread **settles**                                                    | The worktree is untouched. Idle shells are closed, then the project's `runOnSettle` action runs, if any.                                                                                                                                                    |
| Thread **archived**                                                   | The worktree is untouched. **All of the thread's terminals are killed.**                                                                                                                                                                                    |
| Thread **deleted** (default settings)                                 | If it is the _only_ thread on that worktree, a confirm dialog asks "Delete the worktree too?". Otherwise nothing happens.                                                                                                                                   |
| Storage cleanup policies (Settings → Storage, all **off** by default) | Each of these can remove T3-managed worktrees: `worktreeAfterDays`, `worktreeOnMerge` (squash counts), `worktreeUnchanged` ("no commits beyond default branch") and `worktreeOnDelete`. Shared worktrees, open terminals and running threads block removal. |

- **Leave the cleanup policies off** for long-lived worktrees. `worktreeUnchanged` and `worktreeOnMerge` in particular would delete a `wt-NN` worktree right after you land it.
- **Answer "No" to the delete prompt.** A cheap safeguard is to keep one pinned "anchor" thread per worktree, so no other thread is ever the only one using it.
- `t3_worktree_handoff` moves a thread that is in the main checkout into a _new_ worktree, with a generated branch.
- T3 has **no "merge the worktree back into main"** feature. `t3_thread_merge_back` merges conversation context, not git history. Code reaches `main` through git: commit, merge, push, or open a PR.

### What exists on this Mac today

- `~/.t3/worktrees/` is empty. No thread in T3's database has a worktree.
- No project has actions (`scripts_json = []`).
- There is no `t3.json`.
- `settings.json` uses defaults for worktrees, branch naming and cleanup.

### Ways to get `wt-01` as both branch and folder

| Option                             | How                                                                                                                                                                                                                             | Result                                                                                                                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. T3 launch API (recommended)** | In a main-checkout thread, ask the agent to call `t3_thread_launch` with `workspaceStrategy: {"type":"worktree","baseRef":"main","branch":"wt-01","startFromOrigin":false}` and a first message such as "Run setup and report". | Folder `~/.t3/worktrees/alchemy-sandbox1/wt-01` and branch `wt-01`. The setup action runs, and the worktree is T3-managed, so "New thread in this worktree" works.                        |
| B. Composer, then rename           | Choose New worktree, send a message, then `git branch -m wt-01`.                                                                                                                                                                | The branch is right, but the folder stays `t3-<hex>`. Usable, but messy.                                                                                                                  |
| C. herdr or plain git creates it   | `herdr worktree create --branch wt-01 --base main --label wt-01` puts it in `~/.herdr/worktrees/alchemy-sandbox1/wt-01`. T3 then attaches with `existing_worktree`.                                                             | Works through the API. _Inferred:_ the composer may not offer a worktree T3 didn't create. It is not T3-managed, so cleanup skips it, which is safe. This also gives two worktree owners. |

Option A gives T3 ownership, a predictable path, and a setup action that runs automatically. It is a one-time step per worktree, after which everything happens in the UI.

---

## 2. Project actions (`t3.json`)

- The code calls these "project scripts"; the UI calls them **Actions**. They are stored in T3's settings (`~/.t3/userdata/settings.json`), per project or for the whole environment.
- A `t3.json` checked in at the repo root can declare them, but they are **imported** from the Actions menu ("From t3.json"), not applied automatically.
- If `t3.json` changes, import it again.

Schema (`packages/contracts/src/t3ProjectFile.ts`):

```ts
{ name, command, icon: "play"|"test"|"lint"|"configure"|"build"|"debug",
  runOnWorktreeCreate: boolean,  // first such action runs after worktree create (and on reuse)
  runOnSettle?: boolean,         // first such action runs when a worktree thread settles
  async?: boolean,               // runOnWorktreeCreate only; default true = agent starts in parallel
  previewUrl?: string, autoOpenPreview?: boolean }  // open the in-app preview when run (desktop)
```

- **Triggers:** worktree creation, settle, and manual runs (toolbar or a `script.<id>.run` keybinding). There are no hooks for archive, delete or startup.
- **Environment:**
  - Actions get `T3CODE_PROJECT_ROOT` (the main checkout) and `T3CODE_WORKTREE_PATH`.
  - Setup and settle actions also get `NO_COLOR=1` and `FORCE_COLOR=0`.
  - **No port is assigned.** T3 also removes `PORT` and every `VITE_*` variable from the environment its terminals inherit. Port assignment is our job. T3's own repo derives a port offset by hashing the worktree path; that is a convention of their repo, not a product feature.
- **Execution:**
  - The command is typed into a PTY that belongs to the thread, with the worktree as cwd.
  - Setup runs in terminal `setup-<id>`. Its output appears in a "worktree setup card". On success the shell closes; on failure it stays open.
  - **The setup action also runs when a worktree is reused**, so it must be idempotent.

### Proposed `t3.json`

```json
{
  "$schema": "https://t3.codes/schema/t3.json",
  "defaultThreadEnvMode": "local",
  "scripts": [
    {
      "name": "Setup worktree",
      "command": "node scripts/worktree-setup.ts",
      "icon": "configure",
      "runOnWorktreeCreate": true,
      "async": false
    },
    { "name": "Dev: start", "command": "vp run dev:start", "icon": "play" },
    { "name": "Dev: status", "command": "vp run dev:status", "icon": "debug" }
  ]
}
```

- `async: false` makes the agent wait until `node_modules` exists. An agent that starts too early hits missing dependencies and burns tokens.
- Nothing uses `runOnSettle`. Stopping the dev server whenever an agent finishes a turn would be disruptive.
- The setup command uses plain `node`, because `node_modules` does not exist yet. The repo's devEngines pins Node 24, which runs `.ts` natively.

### What `scripts/worktree-setup.ts` would do (idempotent, modelled on Baton's `worktree:init`)

1. **Refuse to run** if:
   - it is in the main checkout;
   - the branch is not `wt-NN`;
   - another checkout's `.env` already claims this port or stage. It finds the other checkouts with `git worktree list --porcelain`.
2. **`.env`:**
   - If missing, copy it from `$T3CODE_PROJECT_ROOT/.env` when one exists, and set the per-worktree keys:
     ```
     DEV_INDEX=01
     WEBSITE_PORT=3010
     BACKEND_PORT=3011
     ALCHEMY_STAGE=dev-wt-01
     ```
   - If present, only verify it.
   - Avoid the name `PORT`, because T3 strips it and it collides with other tools.
3. **Symlink `refs`** to `$T3CODE_PROJECT_ROOT/refs`. `refs/` is gitignored, so a new worktree has none. Change `.gitignore` from `/refs/` to `/refs` so the symlink is ignored as well.
4. Run **`vp install --frozen-lockfile`**.
5. Later, once there is a database: apply migrations or seed Alchemy's local data (see §5).
6. **Do not start the server.**

---

## 3. Ports and Alchemy state in this repo

What exists today:

- `alchemy.run.ts`:
  - `Website` uses `dev: { port: 3000 }`.
  - `Backend` has no `dev.port`, so it gets Alchemy's `DEFAULT_DEV_PORT = 1337`.
  - Alchemy's `strictPort` defaults to `false`, so both silently move to the next free port. This has already happened: `logs/dev/current` shows _"Port 1337 is in use by another process; serving on 1339 instead."_
- `vite.config.ts` sets `server: { port: 3000, strictPort: true }`.
- The `dev` script runs `alchemy dev --stage dev`, piped into `s6-log` → `logs/dev/`.

A second worktree would therefore start on unpredictable ports. A stale or other checkout's server would answer on the URL you expected, which is the worst failure mode.

### Proposed port block

| Checkout | Index | Website      | Backend      |
| -------- | ----- | ------------ | ------------ |
| main     | 0     | 3000         | 3001         |
| wt-01    | 1     | 3010         | 3011         |
| wt-NN    | NN    | 3000 + 10·NN | 3001 + 10·NN |

- Read the ports from env in `alchemy.run.ts`, falling back to the main-checkout values, and set `strictPort: true`.
- Keep `vite.config.ts`'s `server.port` in sync from the same variable. Verify which one wins when Alchemy runs Vite; `ViteChildRunner` passes its own host and port.
- The 10-port stride leaves room for future workers or Shopify-style tunnels.
- Baton binds `host: "127.0.0.1"`, because on macOS `localhost` resolves to `::1` first. Do this too if anything starts proxying to the dev server.

### Alchemy stage per worktree

- The stack uses `Cloudflare.state()`. Even in dev, Alchemy reads and writes infrastructure state in the shared Cloudflare state store, keyed by stack + stage.
- Two checkouts both on `--stage dev` share one state record. Today nothing in dev is remote-only, so the harm is limited. Once a remote-only resource exists, it will clobber.
- Local emulator data lives in each checkout's `.alchemy/local/`, so it is already per worktree.
- **Recommendation:** put `ALCHEMY_STAGE` in each checkout's `.env`: `dev` for main, `dev-wt-NN` for worktrees.
  - Alchemy resolves the stage as "`--stage` wins; otherwise `$ALCHEMY_STAGE` from process env / `--env-file`" (`node_modules/alchemy/src/Cli/commands/flags.ts`).
  - So the dev command becomes `alchemy dev --env-file .env`, with a guard that fails if `ALCHEMY_STAGE` is unset. Otherwise Alchemy falls back to `dev_<user>`.
  - Remote resources created under a worktree stage need deliberate cleanup (`alchemy destroy --stage dev-wt-NN`) if that worktree is ever retired.

---

## 4. Where to run the dev server

### What T3 terminals do

- PTYs are owned by T3's local server and keyed by (thread, terminal). They keep running when you switch threads.
- **Settle** closes only _idle_ shells. A running dev server survives.
- **Archive or delete** a thread and **all** its terminals are killed (`terminals.close({ deleteHistory: true })`), including a dev server.
- **Quitting T3 or restarting its server** sends SIGTERM to every PTY, then SIGKILL after 1 s. Only scrollback is restored afterwards, never processes. This is also true when T3 runs as a background service, on `t3 update`.
- There is **no list of running terminals**. The only signal is a per-thread "N terminal processes running" pulse in the sidebar.
- Upside: T3's port scanner links listening ports owned by T3-terminal processes to their thread, and offers them in the in-app preview.

For long-lived worktrees served by many short threads, that is a poor fit. The server ends up owned by whichever thread happened to start it. Archiving that thread, or restarting T3, kills it, and nothing shows that it was running.

### Options

|                                        | T3 thread terminal    | **herdr pane in Ghostty (recommended)**                           | Detached background process    |
| -------------------------------------- | --------------------- | ----------------------------------------------------------------- | ------------------------------ |
| Survives archive or delete of a thread | ❌                    | ✅                                                                | ✅                             |
| Survives a T3 restart or update        | ❌                    | ✅                                                                | ✅                             |
| One place to see every running server  | ❌                    | ✅ herdr sidebar: workspace `wt-NN` → tab `server`                | ❌ (pid files)                 |
| Human can watch it and press Ctrl-C    | ✅ inside that thread | ✅                                                                | ❌                             |
| Agent can start, stop and read it      | Only the logs file    | ✅ `herdr pane run / send-keys ctrl+c / read`, plus the logs file | ✅ signals, plus the logs file |
| T3 preview auto-discovery              | ✅                    | ❌ (open the URL directly or use `previewUrl`)                    | ❌                             |

### How herdr would work here (adapted from Baton's `scripts/dev.ts`)

- **Layout:** one herdr workspace per checkout:
  - main: label `alchemy-sandbox1`;
  - worktrees: `herdr workspace create --cwd ~/.t3/worktrees/alchemy-sandbox1/wt-01 --label wt-01 --no-focus`.

  Each workspace has a tab labelled `server`. herdr also lets you run the coding agent's shell or `lazygit` in other tabs of the same workspace.

- **`vp run dev:start`**, using a pid lock in `logs/dev.lock`:
  1. **Adopt** if a server for this checkout is already running. Look for an `alchemy dev` process whose cwd is this checkout (`pgrep -f` + `lsof -a -p PID -d cwd`) or a listener on `WEBSITE_PORT`. Do not rely on labels.
  2. Otherwise find the checkout's workspace (`herdr worktree list --cwd ROOT` → `open_workspace_id`), or create it. Find or create the `server` tab (`herdr tab create --workspace W --cwd ROOT --label server --no-focus`), and pick an idle pane. A pane is idle when `herdr pane process-info` reports `foreground_process_group_id === shell_pid`.
  3. Run the server: `herdr pane run <pane> "cd '<root>' && vp run dev"`.
  4. Wait until `http://127.0.0.1:$WEBSITE_PORT/` answers, or check with `herdr pane wait-output --regex 'Website\] ready' --timeout 180000`.
  5. If herdr is not running (`herdr status` fails), fall back to a detached `vp run dev` that logs to `logs/dev/`.
- **`dev:stop`**: `herdr pane send-keys <pane> ctrl+c`. After about 20 s, send SIGTERM to the pids and the port listeners. Fail if the port is still held.
- **`dev:status` / `dev:logs`**:
  - Report health, pane, ports and stage.
  - Logs come from `logs/dev/current`, which already exists per checkout. That file stays the agent's source of truth (AGENTS.md already points there). `herdr pane read --source recent-unwrapped` is a fallback.
- **Gotchas:**
  - **T3 terminals do not set `HERDR_ENV`.** Scripts must decide by checking `herdr status`, not by gating on `HERDR_ENV=1` the way Baton's `inHerdr()` does. The herdr CLI works over its socket from any shell.
  - **A long-lived `server` pane keeps the shell environment it started with.** Baton hit "`pnpm`: command not found" after a toolchain change. Launch through `zsh -lc '…'`, and check `pane read` after launch.

### Where the server would _not_ run

Not in T3 setup or settle actions. Setup runs in a thread terminal that closes on success, so it would kill the server or tie it to that thread.

---

## 5. Reset and seed (future, once there is a database)

- Baton's `dev:reset` was: stop → `rm -rf .wrangler` → migrate D1 locally → start in the same pane → seed through a local-only `POST /api/dev/seed` endpoint.
- The Alchemy equivalent is roughly this: stop → remove the emulator's persisted data under the checkout's `.alchemy/local/` → start again. The D1 resource is declared with its migrations, so Alchemy applies them on dev → seed over HTTP against `WEBSITE_PORT`.
- Verify the exact persist path and migration behaviour against `refs/alchemy` when a D1 resource is added.
- Remote reset (staging) should go through Alchemy resources or stages, not `wrangler d1 delete` plus a hand-edited config as Baton did.

---

## 6. Day-to-day flow (proposed)

1. **Once per worktree:** create it with Option A, import `t3.json` actions once, then open a herdr workspace on the folder.
2. **Start a task in `wt-01`:**
   - Open a new T3 thread with **New thread in this worktree**.
   - Bring the branch up to date with `git merge --ff-only main`, or `git rebase main`.
   - The agent runs `vp run dev:start` when it needs the server; the server appears in herdr `wt-01 › server`.
3. **Land:** in the main checkout, run `git merge --ff-only wt-01` then `git push` (the push deploys staging). The `wt-01` branch stays and is reused.
4. **Archive** finished threads freely; the worktree and server survive. **Never** let a thread deletion remove the worktree.

---

## Questions (each with my recommendation)

1. **How do worktrees get created?**
   - _Recommend Option A_: a one-time `t3_thread_launch` with `branch: "wt-NN"`, so T3 owns `~/.t3/worktrees/alchemy-sandbox1/wt-NN`.
   - Alternatives: the composer plus `git branch -m` (folder stays `t3-<hex>`), or `herdr worktree create` (a second worktree owner).
2. **How many worktrees, and is the port block OK?**
   - _Recommend_ starting with `wt-01` and `wt-02`.
   - Main uses 3000/3001, and `wt-NN` uses 3000+10·NN and 3001+10·NN, all with `strictPort: true`. This moves the Backend off 1337.
3. **Git policy in worktrees.** AGENTS.md currently says "work directly on `main`… commit to `main` and push."
   - _Recommend_ amending it: in a `wt-NN` checkout, agents commit only to `wt-NN` and never merge, push, or check out `main`.
   - Landing is a fast-forward merge done from the main checkout, by you or a main-checkout thread, and pushes go from `main` only.
   - Should agents rebase `wt-NN` onto `main` themselves at the start of a task?
4. **Alchemy stage per worktree?**
   - _Recommend yes_: `ALCHEMY_STAGE=dev-wt-NN` in `.env`, with the dev script switched to `alchemy dev --env-file .env` plus a guard.
   - The cost is a separate set of remote dev resources per worktree, once any exist.
5. **Where should the dev server run?**
   - _Recommend herdr_ (workspace per checkout, `server` tab) through a `scripts/dev.ts` controller, with a detached-process fallback.
   - Do you keep herdr running in Ghostty all day? If not, the fallback becomes the main path, and a pid-file controller without herdr would be simpler to build first.
6. **Should the setup action auto-start the dev server?**
   - _Recommend no_: start it on demand with `vp run dev:start`, so idle worktrees don't hold ports or CPU.
7. **Should `t3.json` set `defaultThreadEnvMode: "worktree"`?**
   - _Recommend no_, keep `local`. Otherwise every new composer thread makes a throwaway `t3/<hex>` worktree, which works against the long-lived model. Pick worktrees explicitly with "New thread in this worktree".
8. **T3 storage cleanup settings.**
   - _Recommend_ leaving every policy off, especially `worktreeUnchanged` and `worktreeOnMerge`.
   - Keep a pinned anchor thread per worktree so the delete prompt never appears.
9. **Is there a main-checkout `.env` today with secrets worktrees need?** Cloudflare credentials seem to live in Alchemy's profile, not in `.env`.
   - _Recommend_ that `worktree-setup.ts` copy the root `.env` when one exists and otherwise write only the per-worktree keys.
10. **Should the main checkout's server also move under the controller and herdr** (index 0, workspace `alchemy-sandbox1`)?
    - _Recommend yes_, so every server is handled the same way.

## Sources

- T3 Code, `pingdotgg/t3code` @ `aacefcd`:
  - `apps/server/src/vcs/GitVcsDriverCore.ts`
  - `apps/server/src/orchestration-v2/ThreadLaunchService.ts`, `ThreadSettlementService.ts`, `ResourceCleanupService.ts`
  - `apps/server/src/terminal/Manager.ts`
  - `apps/server/src/preview/PortScanner.ts`
  - `packages/contracts/src/t3ProjectFile.ts`, `project.ts`, `orchestrationV2.ts`, `settings.ts`
  - `packages/shared/src/projectScripts.ts`, `git.ts`
  - `apps/web/src/hooks/useThreadActions.ts`
  - `docs/user/project-settings.md`, `thread-sidebar.md`, `keybindings.md`
  - `docs/internals/terminal-runtime.md`
  - PRs #13294 (branch naming), #13673 (settle closes idle shells), #16231 (worktree location), #16290 (`runOnSettle`)
- Baton: `refs/baton/scripts/worktree.ts`, `scripts/lib/worktree.ts`, `scripts/dev.ts`, `scripts/lib/herdr.ts`, `docs/worktrees-runbook.md`, `docs/pnpm-upgrade-research.md` §10.
- herdr 0.9.3: `herdr --help` and its subcommands, plus `~/.claude/skills/herdr`.
- Alchemy: `node_modules/alchemy/src/Cloudflare/Workers/Worker.ts` (`dev.port`, `strictPort`), `ViteChild.shared.ts` (`DEFAULT_DEV_PORT = 1337`), `Cli/commands/flags.ts` (stage resolution), `Cloudflare/StateStore/State.ts`.
- Vite+: `refs/vite-plus/docs/guide/install.md` (`vp install --frozen-lockfile`).
