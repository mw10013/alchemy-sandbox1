# Worktrees runbook

How this repository's long-lived worktrees are laid out, set up and used.

## Layout

There is a fixed set of worktrees, `wt-01`, `wt-02`, …, created once and reused task after task. Each checkout runs its own dev server (`shopify app dev`, which runs `alchemy dev`) on its own port and its own Shopify dev store.

| Checkout | Branch  | Folder                 | `WEBSITE_PORT`       | `SHOPIFY_DEV_STORE`   | `SHOPIFY_E2E_STORE`   | herdr workspace                   |
| -------- | ------- | ---------------------- | -------------------- | --------------------- | --------------------- | --------------------------------- |
| main     | `main`  | wherever you cloned it | set in `.env` (3900) | `mw10013-dev-shop-00` | `mw10013-e2e-shop-00` | `alchemy-sandbox1`                |
| `wt-NN`  | `wt-NN` | chosen by T3 Code      | main's port + NN     | `mw10013-dev-shop-NN` | `mw10013-e2e-shop-NN` | `wt-NN`, under `alchemy-sandbox1` |

- **Folders:** `git worktree list` shows every checkout's folder, with main first. Look them up there; don't assume a path.
- **Per checkout:** `.env`, `node_modules/`, `.alchemy/` (local data and Alchemy state for every local stage), `.logs/` and `.shopify/` (the CLI's record of the store). `vp run worktree:init` writes `WEBSITE_PORT`, `SHOPIFY_DEV_STORE` and `SHOPIFY_E2E_STORE` into a worktree's `.env`, makes sure both stores exist (`vp run stores:setup`) and refuses a port or store another checkout holds: two `shopify app dev` sessions on one store overwrite each other's app URL.
- **Stages:** each checkout has its own dev, test and e2e stage, `<environment>-<user>` in main and `<environment>-<user>-wt-NN` in a worktree (`dev-mw-wt-01`). `node scripts/stage.ts dev` prints the checkout's dev stage. They are all local, under the checkout's `.alchemy/`.
- **Shared:** `refs/` and each deployed stage's `.env.<stage>` (today `.env.staging`) exist once, in main. `vp run worktree:init` gives each worktree a symlink to each.
- **herdr:** each checkout's dev server runs in a `dev` tab in that checkout's herdr workspace.

## Configure the project action (once)

Do this in T3 before creating worktrees. Open a thread in **alchemy-sandbox1**, then open **Thread details** using the top-right panel toggle. Under **Workspace**, click **Add project script**. This opens **Add Action** for the thread's project.

1. Set **Name** to `Bootstrap worktree` and paste this **Command**:

   ```sh
   if [ "$T3CODE_WORKTREE_PATH" != "$T3CODE_PROJECT_ROOT" ]; then
     vp install --frozen-lockfile &&
     vp run worktree:init &&
     vp run dev &&
     vp run dev:status
   fi
   ```

2. Enable **Run automatically on worktree creation** and **Wait for it to finish before the agent starts**. Leave the settle and automatic preview options off; no keybinding or preview URL is needed.
3. Click **Save action**. Reopen it to confirm the command and both switches were saved. It should be the project's only worktree setup action.

T3 runs this action in the worktree's terminal before starting the agent. The guard skips the main checkout. Keep the thread's permission setting on **Auto**. See [the research](worktree-bootstrap-environment-research.md#manual-project-action-setup) for configuration details and rationale.

## Set up a worktree

This assumes the project action above has been saved. Create each worktree once, from a T3 thread on the main checkout.

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
     "message": "Review the Bootstrap worktree action result and report the dev URL, health, port, and Herdr placement. Report any setup failure."
   }
   ```

   T3 creates the named branch and folder, runs the setup action, and starts the agent after setup succeeds. Keep `workspaceStrategy.branch` explicit; use this launch instead of the UI's **New worktree** option.

3. **Check what the new thread reports:**
   - `pnpm port` prints main's port + NN;
   - `vp run dev:status` reports healthy;
   - herdr shows `wt-NN` under `alchemy-sandbox1`, with a `dev` tab.

Before seeding the new worktree's dev store, a person authorizes it once with `shopify store auth`; see [Shopify stores](./shopify-stores-runbook.md).

`vp run worktree:init` is safe to run again; a second run only checks. If it fails, it says what to fix.

**If the launch fails, stop and tell the user.** Don't work around it, for example by creating the worktree with git: T3 decides where worktrees live, and that can change between T3 releases.

If setup fails, inspect the setup terminal's output. If no setup action ran, check the project action configuration before trying again.

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
vp run dev         # start it, or adopt the one already running
vp run dev:status   # healthy?, where it runs, port
vp run dev:logs     # tail of .logs/dev/current
vp run dev:stop
```

- `dev` puts the server in the checkout's herdr `dev` tab and opens the workspace if needed. The scripts' `--help` explains where it runs in each case.
- Logs are always in `.logs/dev/current`.
- Don't start or stop another checkout's server unless asked.

## Working across checkouts

Every checkout shares one git repository, so every branch is visible everywhere at once, with no fetch.

- **Read anything from anywhere:** `git show main:src/x.ts`, `git diff main...wt-02`, `git log wt-02`.
- **Commands can run in another checkout,** because it is just another folder: `git -C <path> status`, or `(cd <path> && vp test)`.
- **Write and commit only in your own checkout,** to its own branch. Landing on `main` (below) is the one exception.
- **A worktree never checks out `main`.** `main` is always checked out in the main checkout, and git allows a branch in only one checkout at a time.
- **For a scratch copy of another commit,** run `git worktree add --detach /tmp/<name> <ref>`, and `git worktree remove` it afterwards. It has no `.env`, so no dev server; it is for reading and tests only.

## Keeping up with `main`, and getting work onto it

History stays linear: worktree branches are rebased, and `main` only moves by fast-forward. `wt-NN` branches are never pushed, so rebasing them is always safe.

- **Start of a task in `wt-NN`:** run `git rebase main`. With no commits of its own, the branch just moves up to `main`.
- **During a task:** commit to `wt-NN` as needed, and rebase onto `main` again whenever other work has landed.
- **Getting the work onto `main`:** this happens only when the user asks.

  1. In `wt-NN`, run `git rebase main`, then `vp check` and `vp test`.
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
3. From main: `git worktree remove <wt-NN folder>`, then `git branch -D wt-NN`. Its stages are all local, so removing the folder removes them; nothing is left in Cloudflare state.
4. Archive its T3 threads.
