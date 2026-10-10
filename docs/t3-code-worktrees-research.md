# Long-lived worktrees with T3 Code and herdr

Updated 2026-10-10 · T3 Code `pingdotgg/t3code` @ `50647de` (installed: Nightly `0.0.46-nightly.20261010.2922`) · herdr 0.9.3 · Alchemy `2.0.0-beta.81` · Status: decisions made. `scripts/worktree.ts`, `scripts/dev.ts` and the `refs fetch` guard are implemented and tested on main (not yet committed). No worktree exists yet.

Companion: [website-port-runbook.md](website-port-runbook.md) (how `WEBSITE_PORT` works today).

## Summary of recommendations

1. **A fixed set of long-lived worktrees named `wt-01`, `wt-02`, …** `wt-NN` is the branch, the folder name and the herdr workspace label, and `NN` is the port offset. Each of those is already scoped to the project, so Baton's `wt-01` can't collide with ours (§2). Worktrees are created once and reused task after task. Nothing creates them on demand.
2. **T3 owns the folder; we choose the branch.** One call per worktree to `t3_thread_launch` with `{"type":"worktree","baseRef":"main","branch":"wt-NN","startFromOrigin":false}` creates `~/.t3/worktrees/alchemy-sandbox1/wt-NN` on branch `wt-NN`. The T3 UI can't do this because it never lets you type a branch name. Any agent in a main-checkout thread can make the call.
3. **No T3 project actions.** The launched thread bootstraps itself as its first message: `pnpm install --frozen-lockfile && pnpm worktree:init`. `init` is idempotent. It refuses to run in the main checkout or on any branch other than `wt-NN`. Then it:
   - copies `.env` from main and sets `WEBSITE_PORT` to main's port + NN;
   - symlinks `refs`.
4. **New threads reach a worktree through the composer's branch picker.** Pick branch `wt-NN` and the draft re-binds to that worktree. This works because the picker reads `git worktree list`.
5. **Dev servers run in herdr**, one workspace per checkout with a `dev` tab, driven by `scripts/dev.ts` (`dev:start | stop | status | logs`), a port of Baton's controller. Baton's "local" names become "dev" here.

### What changed since the previous version of this doc

The earlier draft was written before the port work. These parts were wrong or are now outdated:

| Earlier draft                                                       | Now                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Port block 3000 + 10·NN; separate `BACKEND_PORT`                    | Already implemented: `WEBSITE_PORT` in `.env`, main is 3900, `strictPort: true`. Backend uses `dev: { port: 0 }` (ephemeral), so only one port per checkout. `wt-NN` → 3900 + NN.                                                          |
| `alchemy.run.ts` hard-codes port 3000                               | Reads `Config.Port("WEBSITE_PORT")` only when `ALCHEMY_DEV` is set.                                                                                                                                                                        |
| `t3.json` setup action with `runOnWorktreeCreate`                   | Dropped by choice. Without actions, worktree creation runs nothing except `git submodule update` (no `.gitmodules` here) and a `gh-merge-base` git config line.                                                                            |
| "The composer may not offer a worktree T3 didn't create" (inferred) | Wrong. The **branch picker** lists every `git worktree list` entry and re-binds to its path. Only the **Previous worktree** shortcut is limited to worktrees recorded on T3 threads.                                                       |
| AGENTS.md says commit to `main`                                     | Already updated: "In a linked worktree, commit to that worktree's branch and never check out `main` there."                                                                                                                                |
| Verified at `aacefcd`                                               | Re-verified at `50647de`. Nothing on branch naming, worktree location or the picker changed. The only related commit, `6266af3`, makes `t3_thread_launch` reject a `baseRef` that doesn't resolve; it isn't in your installed nightly yet. |

The rest of the earlier draft still holds: the T3 terminal lifecycle, the reasons for herdr, and that T3 strips `PORT` and `VITE_*` from terminals.

---

## 1. T3 Code facts that drive the design

All points below were confirmed in source at `50647de`. "Inferred" means it follows from git's own behaviour.

### Folder location

```ts
// apps/server/src/vcs/GitVcsDriverCore.ts:3407-3430
worktreePath = path.join(parentDir, basename(projectRoot), branch.replace(/\//g, "-"));
// new branch:      git worktree add -b <branch> <path> <baseRef>
// existing branch: git worktree add <path> <ref>
```

- `parentDir` comes from **Settings → Storage → Worktree location** (`worktreesDirectory`). An empty value, which is the default and what you have, means `~/.t3/worktrees`.
- So `wt-01` lands in `~/.t3/worktrees/alchemy-sandbox1/wt-01`. You can change the parent folder, but nothing else about the path.

### Branch names

**Takeaway: T3 can create `wt-01` exactly, but only when an agent asks it to.** In any main-checkout T3 thread, tell the agent "create worktree `wt-01`". The agent calls T3's `t3_thread_launch` tool, and T3 creates branch `wt-01`, folder `~/.t3/worktrees/alchemy-sandbox1/wt-01`, and a thread in it (§3, step 1). You don't run git by hand.

- The **New worktree** button in the T3 UI can't do this. It has no branch-name field: it makes a random `t3/<hex>` branch, and a model renames it later, while the folder keeps the random name.
- The agent route fails if branch `wt-01` already exists. Each worktree is created once, so that's fine.

### Reaching an existing worktree from the UI

- **Branch picker, in Current checkout mode:** it lists branches together with their `git worktree list` paths. Picking `wt-01` re-binds the draft to `~/.t3/worktrees/alchemy-sandbox1/wt-01`, and the first message launches as `existing_worktree`. This works for worktrees made by plain `git worktree add` too.
- **Previous worktree:** jumps to the worktree of the most recently updated, non-archived thread that has one. It is convenient, but it only knows about worktrees T3 recorded on a thread.
- **"New thread in this worktree"** from an existing worktree thread's menu.

### Lifecycle

| Event                                                                | Effect on the worktree                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Thread settles or is archived                                        | Untouched. Archiving kills **all of that thread's terminals**.                                                                                                                                                                                                                                             |
| Thread deleted, and it was the **only** thread referencing that path | The UI asks "Delete the worktree too?". **Yes** runs `git worktree remove --force`, for any path, including worktrees T3 didn't create. The branch stays.                                                                                                                                                  |
| Storage cleanup policies                                             | All off by default: `worktreeAfterDays`, `worktreeOnMerge`, `worktreeUnchanged`, `worktreeOnDelete`. You have none set. They only consider worktrees referenced by T3 threads and inside managed folders, and they skip worktrees that are shared, have open terminals or sessions, or have local changes. |

- `worktreeUnchanged` ("no commits beyond default branch") and `worktreeOnMerge` would delete `wt-NN` right after every landing, so **keep them off**.
- If you ever delete the last thread on a worktree, T3 asks "Delete the worktree too?". Answer **No**. You don't delete old threads, so no policy is needed.

### Environment

- **Terminals** strip `PORT`, `VITE_*`, `T3CODE_*` and `ELECTRON_*`. **Agent processes** are not stripped; they inherit the T3 server's environment, and their cwd is `thread.worktreePath ?? project root`.
- Nothing in T3 reads `.env`. Our scripts load it with `node --env-file` / Alchemy's own `.env` loading, so neither path above matters to us.
- Neither T3 terminals nor agents have `HERDR_ENV` set, unless T3 itself was launched from inside herdr. So scripts must not use `HERDR_ENV` to decide whether herdr is available (see §4).

### Current state on this Mac

- `~/.t3/worktrees/` is empty.
- `git worktree list` shows only main.
- No T3 thread has a `worktreePath`.
- Project `alchemy-sandbox1` has `scripts_json = []`.
- Settings use defaults: worktree location `~/.t3/worktrees`, naming `static`/`t3`, every cleanup policy off.
- `newWorktreesStartFromOrigin` defaults to `true`. That only affects the composer; the launch call passes `startFromOrigin: false` explicitly.
- herdr has workspace `alchemy-sandbox1` with a default tab `1` and a `dev` tab. `dev:start` created both while it was being tested; the server is stopped.

---

## 2. Naming conventions

| Thing                    | Main checkout                      | Worktree `NN` (01–99)                               |
| ------------------------ | ---------------------------------- | --------------------------------------------------- |
| Branch                   | `main`                             | `wt-NN` (two digits)                                |
| Folder                   | `~/Documents/src/alchemy-sandbox1` | `~/.t3/worktrees/alchemy-sandbox1/wt-NN` (T3 picks) |
| `WEBSITE_PORT`           | 3900 (whatever main's `.env` says) | main's port + NN → 3901, 3902, …                    |
| herdr workspace label    | `alchemy-sandbox1` (project name)  | `wt-NN`, grouped under `alchemy-sandbox1`           |
| herdr tab for the server | `dev`                              | `dev`                                               |
| T3 bootstrap thread      | n/a                                | titled `wt-NN`                                      |
| Alchemy dev stage        | `dev`                              | `dev` for now (question 5)                          |

- **Namespaces:** each name only has to be unique inside its own scope.
  - Branch: the git repo.
  - Folder: T3 nests it under the project name.
  - herdr label: herdr groups the workspaces for a repo's worktrees under that repo's main workspace. `herdr workspace close --group` closes the main workspace and the worktree workspaces under it. Baton already works this way: workspace `baton`, with `wt-01` and `wt-02` under it, each recorded with `repo_root` `~/Documents/src/baton`.
  - So `wt-01` here and Baton's `wt-01` sit in different groups.
- **herdr starts from a blank slate:** this project's old workspace was deleted on 2026-10-10. `dev:start` opens main's workspace (`alchemy-sandbox1`) before any worktree's, so the worktree workspaces have a group to sit under. On the first run, check that `wt-01` appears under `alchemy-sandbox1` in herdr's sidebar.

- **Port derivation:** `init` reads `WEBSITE_PORT` from the main checkout's `.env` and adds `NN`. Only main's number is chosen by hand.
- **No overlap with Baton:** Baton uses 3800 + NN, so the two projects can't collide below 100 worktrees.
- **Duplicate check:** `init` reads every other checkout's `.env`, found with `git worktree list --porcelain`, and refuses if one already claims the port.

### Baton's "local" names, mapped to "dev"

Baton calls the developer's machine environment `local`. Here it is `dev`, matching `alchemy dev --stage dev`, `logs/dev/` and the `dev` script.

| Baton                                                                          | Here                                                                              |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `logs/local-worker.log`, `logs/local-cli.log`                                  | `logs/dev/current`, already written by `s6-log` (rotations in `logs/dev/`)        |
| `ENVIRONMENT: "local"`, `getDatabaseName("local")`, `resetLocal`, `queryLocal` | stage `dev`; name future helpers `resetDev` / `queryDev`                          |
| `baton-d1-local`, `baton-kv-local`, `baton-local` app                          | Alchemy derives resource names from the stage; nothing to name by hand            |
| `summarize` output line `local:`                                               | `dev:`                                                                            |
| playwright session suffix `$(pnpm port)-localdev`                              | `$(pnpm port)-dev`, if we add Playwright sessions                                 |
| `PORT`                                                                         | `WEBSITE_PORT`. Avoid `PORT`: T3 strips it from terminals and other tools read it |
| `pnpm worktree:init`, `pnpm dev:start` …                                       | same names                                                                        |

---

## 3. Bootstrapping a worktree (one time per `wt-NN`)

### Step 1: create it via T3 (from any main-checkout thread)

Ask the agent to call:

```json
t3_thread_launch {
  "title": "wt-01",
  "workspaceStrategy": { "type": "worktree", "baseRef": "main", "branch": "wt-01", "startFromOrigin": false },
  "message": "Bootstrap this worktree: run `pnpm install --frozen-lockfile && pnpm worktree:init`, then `pnpm dev:start`, and report the result."
}
```

- The result is branch `wt-01` and folder `~/.t3/worktrees/alchemy-sandbox1/wt-01`, with a thread already bound to it. That thread is where you watch the bootstrap.
- `startFromOrigin: false` bases the worktree on local `main`, so it includes local commits.
- The scripts and the `.gitignore` fix have to be committed to `main` before launch: a new worktree only contains committed files. Before the `/refs` fix, the `refs` symlink showed as untracked in a test worktree.
- **Alternative with the same result:** plain `git worktree add -b wt-01 ~/.t3/worktrees/alchemy-sandbox1/wt-01 main`, then open a thread on it through the branch picker. It is equally valid, and T3 treats the folder as managed because it's under `~/.t3/worktrees`. It skips the bootstrap thread, so you run `init` yourself.

### Step 2: `pnpm worktree:init` (as built)

The behaviour is documented in the JSDoc of `scripts/worktree.ts`. It differs from Baton's `init` in three ways:

- It reads `NN` from the branch instead of taking `--index`.
- It takes the base port from main's `.env`.
- It does not run `pnpm install`. It is an Effect CLI, so it needs `node_modules` before it can run, which is why the launch message installs first.

It was tested in a throwaway `wt-99`:

- The first run wrote `.env` with `WEBSITE_PORT=3999` and created the `refs` link.
- The second run only verified both.
- In main it refuses.

**Not copied (stays per checkout):** `.alchemy/` (local emulator state, bundles, logs), `logs/`, `node_modules/`, `dist/`, `.tanstack/`, `.wrangler/`.

### Step 3: verify

From inside `wt-NN`:

- `pnpm port` prints `39NN`.
- `pnpm dev:start` makes `http://localhost:39NN` answer.
- herdr shows `wt-NN` grouped under `alchemy-sandbox1`, with a `dev` tab.

### Retiring a worktree (rare)

1. Stop its server.
2. Close its herdr workspace.
3. `git worktree remove ~/.t3/worktrees/alchemy-sandbox1/wt-NN`, then `git branch -D wt-NN`.
4. Archive or delete its T3 threads.
5. If it had its own Alchemy stage: `alchemy destroy --stage <stage>`.

---

## 4. Dev server in herdr: `scripts/dev.ts`

**Why herdr and not T3 terminals:** a T3 terminal belongs to one thread. Archiving that thread or restarting T3 kills the server, and nothing lists running terminals. herdr survives both, and it is the one place to watch, Ctrl-C and read every checkout's server. herdr is running now: `herdr status` reports server 0.9.3.

### As built

The behaviour is documented in the JSDoc and `--help` of `scripts/dev.ts`. The package scripts are `dev:start`, `dev:stop`, `dev:status` and `dev:logs`, and `reset` waits for a D1 resource. It differs from Baton's controller in five ways:

- **Tab `dev`.** There are no "rename the caller's tab" rules. A person typing `dev:start` inside the `dev` tab gets the server in the foreground; everyone else gets an idle pane in the `dev` tab.
- **herdr is detected with `herdr status server --json`, not `HERDR_ENV`.**
- **Workspaces:**
  - Main's workspace is opened with `herdr workspace create --cwd <main> --label alchemy-sandbox1`.
  - A worktree's is opened with `herdr worktree open --workspace <main ws> --path <wt> --label wt-NN`.
  - herdr refuses `worktree open` on the main checkout (`linked_worktree_source`). A worktree must be opened from the main workspace, so main's workspace is opened first if needed.
- **Stop** sends Ctrl-C to the pane. If needed, it then sends SIGTERM to the `alchemy dev` processes, every process below them, and any port listener. That covers the Backend's `workerd` on its ephemeral port.
- **Background** is a detached `pnpm dev`. Its output goes to `logs/dev/` through `s6-log`, as always.

### Tested on main (2026-10-10)

| Case                         | Result                                                                                              |
| ---------------------------- | --------------------------------------------------------------------------------------------------- |
| Start from a blank herdr     | Created workspace `alchemy-sandbox1`, tab `dev`, pane; answering after 22 s.                        |
| Start again                  | Adopted the running server.                                                                         |
| `status` / `logs`            | Report healthy, with the pane and port; `logs` tails `logs/dev/current`.                            |
| Stop                         | Took 1 s; no `alchemy dev`, `workerd`, `s6-log` or `pnpm dev` left; the pane is back at its prompt. |
| herdr missing from `PATH`    | Background start, answering after 9 s; stop left nothing behind.                                    |
| Starting a worktree's server | **Not yet tested** (step 3 of the implementation order).                                            |

- A new herdr workspace comes with a default tab `1`, which is left for you. The `dev` tab is added next to it.
- Alchemy's own output says `updated (local)`. That is Alchemy's word for its local emulator, not one of our names.

### Gotchas carried over from Baton

- **A long-lived `dev` pane keeps the shell environment it started with.** `pnpm dev` re-reads `.env` through Alchemy, so ports and stage are safe. Toolchain `PATH` changes still need a fresh pane.
- **Port leaks after a signalled stop** (see `stop` above).
- **Browser cookies are shared across ports** (see the port runbook's known gap).

---

## 5. Git flow in a worktree (Baton's, which AGENTS.md already partly encodes)

1. **Start of task, in `wt-NN`:** `git merge --ff-only main`.
2. **Pick up newer `main` mid-task:** `git rebase main` in `wt-NN`, resolving conflicts there.
3. **Land, from the main checkout:** `git merge --ff-only wt-NN`. If that fails, rebase `wt-NN` again. Push **only `main`**, which deploys staging. Never push `wt-NN`.
4. **Rebase, not squash.** A squash merge leaves `wt-NN` diverged. For a single commit, run `git reset --soft main && git commit` inside `wt-NN` first.
5. **After a rebase or fast-forward:**
   - dependency changes: install, then restart the server;
   - `alchemy.run.ts` or config changes: restart the server.
6. **Agents in a worktree never:**
   - merge into `main` or push;
   - run `refs fetch`;
   - touch another checkout's server;
   - edit `WEBSITE_PORT`.

Steps 1–6 belong in a `docs/worktrees-runbook.md`, with a one-line pointer in AGENTS.md.

---

## Decisions (from review, 2026-10-10)

1. **Create worktrees with `t3_thread_launch`.** Plain `git worktree add` into the same folder is the fallback.
2. **Bootstrap with a script:** `scripts/worktree.ts init`.
3. **herdr labels:** main workspace `alchemy-sandbox1`, worktree workspaces `wt-NN` grouped under it, the same layout as Baton (§2).
4. **Start with two worktrees:** `wt-01` and `wt-02`.
5. **Alchemy stage:** every checkout stays on `--stage dev`. Revisit when the stack gets a remote-only resource.
6. **`dev:start` creates the herdr workspace;** `init` has no herdr dependency.
7. **Main's server also goes through `dev:start`.**
8. **The herdr tab is named `dev`.** It is the same word as `pnpm dev`, `dev:start` and `logs/dev/`.
9. **`refs fetch` refuses to run in a linked worktree.** Through the symlink it would write into main's `refs/`. Done.
10. **No thread policy.** You don't delete old threads. Answer "No" if T3 ever asks to delete a worktree. Cleanup policies stay off.
11. **Implementation order:**
    1. ✅ `scripts/worktree.ts`, the refs guard and the `.gitignore` fix. Built, but not committed yet.
    2. ✅ `scripts/dev.ts` and the `dev:*` scripts, tested on main.
    3. Launch `wt-01`, run `init` and `dev:start`, and check that both servers run side by side.
    4. Write `docs/worktrees-runbook.md` and add a pointer to it in AGENTS.md.
    5. Set up `wt-02` the same way.

## Sources

- **T3 Code** `pingdotgg/t3code` @ `50647de`:
  - `apps/server/src/vcs/GitVcsDriverCore.ts` (3136-3199, 3407-3546, 3869-3890)
  - `apps/server/src/orchestration-v2/ThreadLaunchService.ts` (366-525, 635-645) and `ProviderTurnStartService.ts` (460-482)
  - `apps/server/src/worktreesDirectory.ts`
  - `apps/server/src/storageCleanup.ts`
  - `apps/server/src/terminal/Manager.ts` (1250-1328)
  - `apps/server/src/project/ProjectSetupScriptRunner.ts`
  - `apps/server/src/mcp/WorktreeMcpService.ts`, `mcp/toolkits/project/handlers.ts`
  - `apps/web/src/components/BranchToolbar.logic.ts`, `BranchToolbarBranchSelector.tsx`, `ChatView.tsx`
  - `apps/web/src/hooks/useThreadActions.ts`, `apps/web/src/worktreeCleanup.ts`
  - `packages/contracts/src/settings.ts`, `orchestrationV2.ts`; `packages/shared/src/git.ts`, `projectScripts.ts`
- **Baton**, `~/Documents/src/baton`:
  - `scripts/worktree.ts`, `scripts/lib/worktree.ts`, `scripts/dev.ts`, `scripts/lib/herdr.ts`, `scripts/lib/d1.ts`
  - `docs/worktrees-runbook.md`, `AGENTS.md`
- **herdr 0.9.3:** `herdr status`, `herdr workspace list`, `herdr worktree list|open --help`.
- **This repo:** `alchemy.run.ts`, `vite.config.ts`, `src/backend/worker.ts`, `package.json`, `docs/website-port-runbook.md`; `node_modules/alchemy/src/Cli/commands/flags.ts` (stage resolution).
