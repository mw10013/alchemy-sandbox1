# Worktrees runbook

How this repository's long-lived worktrees are laid out, set up and used.

## Layout

There is a fixed set of worktrees, `wt-01`, `wt-02`, …, created once and reused task after task. Each checkout runs its own dev server on its own port.

| Checkout | Branch  | Folder                 | `WEBSITE_PORT`       | herdr workspace                   |
| -------- | ------- | ---------------------- | -------------------- | --------------------------------- |
| main     | `main`  | wherever you cloned it | set in `.env` (3900) | `alchemy-sandbox1`                |
| `wt-NN`  | `wt-NN` | chosen by T3 Code      | main's port + NN     | `wt-NN`, under `alchemy-sandbox1` |

- **Folders:** `git worktree list` shows every checkout's folder, with main first. Look them up there; don't assume a path.
- **Per checkout:** `.env`, `node_modules/`, `.alchemy/` (local emulator state) and `logs/`.
- **Shared:** `refs/` exists once, in main. Each worktree has a `refs` symlink to it.
- **herdr:** each checkout's dev server runs in a `dev` tab in that checkout's herdr workspace.

## Set up a worktree

This is done once per worktree, by an agent in a T3 thread on the main checkout.

1. **Pick the next free `NN`.** `git worktree list` shows the existing ones. `main` must already contain the worktree scripts (`scripts/worktree.ts`, `scripts/dev.ts`), because a new worktree only gets committed files.
2. **Create it with T3's `t3_thread_launch` tool:**

   ```json
   {
     "title": "wt-NN",
     "workspaceStrategy": {
       "type": "worktree",
       "baseRef": "main",
       "branch": "wt-NN",
       "startFromOrigin": false
     },
     "message": "Set up this worktree: run `vp install --frozen-lockfile && vp run worktree:init`, then `vp run dev:start`, and report the result."
   }
   ```

   T3 creates the branch and folder, and starts a thread in the new worktree that runs the message. The T3 UI's **New worktree** can't do this, because it has no branch-name field.

3. **Check what the new thread reports:**
   - `pnpm port` prints main's port + NN;
   - `vp run dev:status` reports healthy;
   - herdr shows `wt-NN` under `alchemy-sandbox1`, with a `dev` tab.

`vp run worktree:init` is safe to run again; a second run only checks. If it fails, it says what to fix.

**If the launch fails, stop and tell the user.** Don't work around it, for example by creating the worktree with git: T3 decides where worktrees live, and that can change between T3 releases.

## Open a thread on a worktree

Use one of these in the T3 composer:

- the branch picker in **Current checkout** mode: choose `wt-NN`, and the thread binds to that worktree;
- **New thread in this worktree**, from an existing `wt-NN` thread;
- **Previous worktree**.

Don't use **New worktree**: it creates a throwaway worktree with a generated name.

If T3 asks "Delete the worktree too?" when you delete a thread, answer **No**.

## Dev server

Run these in the checkout whose server you mean:

```sh
vp run dev:start    # start it, or adopt the one already running
vp run dev:status   # healthy?, where it runs, port
vp run dev:logs     # tail of logs/dev/current
vp run dev:stop
```

- `dev:start` puts the server in the checkout's herdr `dev` tab and opens the workspace if needed. The scripts' `--help` explains where it runs in each case.
- Logs are always in `logs/dev/current`.
- Don't start or stop another checkout's server unless asked.

## Working across checkouts

Every checkout shares one git repository, so every branch is visible everywhere at once, with no fetch.

- **Read anything from anywhere:** `git show main:src/x.ts`, `git diff main...wt-02`, `git log wt-02`.
- **Commands can run in another checkout,** because it is just another folder: `git -C <path> status`, or `(cd <path> && vp run test)`.
- **Write and commit only in your own checkout,** to its own branch. Landing on `main` (below) is the one exception.
- **A worktree never checks out `main`.** `main` is always checked out in the main checkout, and git allows a branch in only one checkout at a time.
- **For a scratch copy of another commit,** run `git worktree add --detach /tmp/<name> <ref>`, and `git worktree remove` it afterwards. It has no `.env`, so no dev server; it is for reading and tests only.

## Keeping up with `main`, and getting work onto it

History stays linear: worktree branches are rebased, and `main` only moves by fast-forward. `wt-NN` branches are never pushed, so rebasing them is always safe.

- **Start of a task in `wt-NN`:** run `git rebase main`. With no commits of its own, the branch just moves up to `main`.
- **During a task:** commit to `wt-NN` as needed, and rebase onto `main` again whenever other work has landed.
- **Getting the work onto `main`:** this happens only when the user asks.

  1. In `wt-NN`, run `git rebase main`, then `vp check` and `vp run test`.
  2. Fast-forward `main`, from either checkout:
     - from `wt-NN`: `git -C <main checkout> merge --ff-only wt-NN`;
     - from main: `git merge --ff-only wt-NN`.

  `--ff-only` refuses rather than create a merge commit; if it does, rebase again. It also refuses if uncommitted changes in main touch the same files, and then it changes nothing.

  To land as one commit, first run `git reset --soft main && git commit` in `wt-NN`.

- **Pushing:** only from main, and only when the user asks. A push to `main` deploys staging.
- **After a rebase or landing:**
  - If `pnpm-lock.yaml` changed, run `vp install` and restart the server.
  - If `alchemy.run.ts` or config changed, restart the server.
  - Other worktrees pick up the landed work when they next rebase.

## Retire a worktree (rare)

1. `vp run dev:stop` in the worktree.
2. Close its herdr workspace.
3. From main: `git worktree remove <wt-NN folder>`, then `git branch -D wt-NN`.
4. Archive its T3 threads.
