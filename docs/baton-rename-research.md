# Research: rename this repository to Baton

Research date: 2026-10-15 · Base commit `10dea97`. Settled 2026-10-16; not started.
Prerequisite: [staging store plan](./staging-store-plan.md) done and pushed, so staging has a known-good baseline (the deploy and the embedded load on `mw10013-staging-shop-00` both verified) to check the rename against.

## 1. Goal

This repository becomes **Baton**: GitHub repository, local folder, Alchemy stacks, Cloudflare resources, package and UI names. The old Baton repository is renamed out of the way and stays readable as a reference under `refs/`.

Why now: the name is still shallow (about 30 lines outside `docs/`), every deployed stage holds only seed data, and renaming an Alchemy stack recreates all its resources. Later, staging or production would hold real data, and the rename would become a data migration.

## 2. Where the name lives today

### 2.1 Code and config (about 30 lines)

| Place                                | Today                                                                                                                                                                                   | Effect of the change                                                                            |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `alchemy.run.ts` stack               | `Alchemy-sandbox1`                                                                                                                                                                      | New stack: every resource is recreated (§3).                                                    |
| `src/backend/stack.ts` `StageConfig` | `Alchemy-sandbox1-config`                                                                                                                                                               | New record; the old one is orphaned unless destroyed first. Its JSDoc already warns about this. |
| `test/integ/stack.ts`                | `Alchemy-sandbox1-test`                                                                                                                                                                 | Local only; integ stages are created per run.                                                   |
| `package.json` `name`                | `alchemy-sandbox1`                                                                                                                                                                      | Cosmetic.                                                                                       |
| `shopify.web.toml` `name`            | `alchemy-sandbox1`                                                                                                                                                                      | Cosmetic (the CLI's process label).                                                             |
| `shopify.app.staging.toml`           | `application_url` and the redirect URL on `alchemy-sandbox1-website-staging-…`                                                                                                          | Must point at the new staging Worker, then `shopify app deploy --config staging`.               |
| UI titles                            | `__root.tsx`, `HomePage.tsx`, `MemberBar.tsx`, `app.tsx` say `Alchemy-sandbox1`                                                                                                         | Become `Baton`.                                                                                 |
| Fake shop                            | `alchemy-sandbox1.myshopify.com` in `seed/{dev,staging,test}.sql`, `src/contract/shop.ts`, `test/e2e/members.spec.ts`; `shpat_fake_alchemy_sandbox1` in `test/unit/backend/api.test.ts` | Free to rename (Q5).                                                                            |
| `scripts/refs.ts`                    | `baton` entry, repository `mw10013/baton`                                                                                                                                               | Repository and folder name change (Q3).                                                         |
| `scripts/refs-shopify-docs.ts`       | User agent `alchemy-sandbox1/refs-shopify-docs`                                                                                                                                         | Cosmetic.                                                                                       |
| `AGENTS.md`, `README.md`             | Title, staging URL, log filter service name                                                                                                                                             | Updated with the new staging names.                                                             |

The Shopify apps need no rename: they are already "Baton Dev" (`handle = "baton-local"`) and "Baton Staging". The real stores are `mw10013-<environment>-shop-NN`.

### 2.2 Docs (about 140 mentions)

Research and plan docs record history and get deleted when they go stale. Runbooks are living instructions: `worktrees-runbook.md` (herdr workspace `alchemy-sandbox1`, T3 project name), `stage-config-runbook.md` (`Alchemy-sandbox1-config` in the error text) and `shopify-stores-runbook.md`. See Q6.

### 2.3 Deployed (Cloudflare account, checked 2026-10-15)

- Workers: `alchemy-sandbox1-website-staging-a6uwn3bzazl3yzgy`, `alchemy-sandbox1-backend-staging-6xyg27mi6n7cjci7`. Shared: `alchemy-state-store` (Alchemy's state store for the whole account; its rows are keyed by stack name, so it stays).
- D1: `Alchemy-sandbox1-AuthDb-staging-nni7q2mdz5whuhgq`.
- The Backend's Durable Objects (`ShopActor`) live inside the Backend Worker.
- The Workers Builds Git connection is attached to the **Website Worker**, on repository `mw10013/alchemy-sandbox1`, branch `main`, deploy command `pnpm exec vp run deploy:staging` ([deployments research](./alchemy-stages-and-deployments-research.md) §4).
- Nothing in the account belongs to the old Baton: no `baton*` Workers and no `baton*` D1 databases. Its `wrangler.jsonc` names (`baton`, `baton-staging`, `baton-d1-staging`) were never deployed, so nothing clashes.

### 2.4 Local, per checkout

- `.alchemy/state/Alchemy-sandbox1/` and `.alchemy/local/alchemy-sandbox1-*` (dev, test and e2e stages, all local state and workerd data). Only seed data and a dev store's `ShopSession`, which the next embedded load exchanges again.
- `.shopify/` is keyed by the app's `client_id`, not the repository name: unaffected.

### 2.5 Outside the repository

- GitHub: `mw10013/alchemy-sandbox1` (this repository) and `mw10013/baton` (the old one, **public**, last push 2026-10-10; `scripts/refs.ts` marks it `private: true`, which only changes how it is fetched).
- Folders: `~/Documents/src/alchemy-sandbox1` (main), `~/.t3/worktrees/alchemy-sandbox1/wt-01`, and an old Baton checkout at `~/Documents/src/baton`.
- T3 project `alchemy-sandbox1`, whose worktrees live under `~/.t3/worktrees/alchemy-sandbox1/`.
- herdr workspace labelled `alchemy-sandbox1`.
- Claude Code memory, keyed by folder path: `~/.claude/projects/-Users-mw-Documents-src-alchemy-sandbox1/` (and one for wt-01).
- The old Baton's Shopify configs: its `shopify.app.toml` has the same `client_id` as this repository's dev app (one app, now "Baton Dev"), and its staging config is an empty skeleton. No production app exists yet, so the name "Baton" is free for production later.

## 3. Why destroy-and-recreate, not migrate

Alchemy keys state by stack name, and the stack name is the first part of every physical name (`<stack>-<resource>-<stage>-<suffix>`). A new stack name means a new state tree, so Alchemy creates fresh resources and knows nothing of the old ones. `renamedFrom` exists, but only for a resource's id inside one stack, not for the stack itself.

So the old stacks must be destroyed **while the code still says `Alchemy-sandbox1`**. If the name changes first, the old Workers, D1 and state rows are orphaned and must be deleted by hand. Every stage holds only seed data, so recreating loses nothing.

Losing the Website Worker also removes the Workers Builds connection (§2.3). It is reattached to the new Website Worker, which only exists after a first deploy from the laptop.

## 4. Proposed sequence

Each phase ends in a checkable state. The user does the steps marked (you); the agent does the rest.

**Phase A: tear down under the old name** (main checkout, old code). Done 2026-10-16: wt-01 removed; staging and the `Alchemy-sandbox1-config/staging` record destroyed; account checked clean; main's `.alchemy/` deleted.

1. Remove wt-01 (Q4): stop its dev server, `git worktree remove`, delete branch `wt-01`, close its herdr workspace.
2. Staging: `vp exec alchemy destroy --stage staging` (Workers, D1, state rows). Then the config record: `vp exec alchemy destroy --config stacks/stage-config.ts --stage staging`. Check: the account lists no `alchemy-sandbox1-*` Workers and no `Alchemy-sandbox1-*` D1.
3. Local: stop the dev server and delete `.alchemy/` in main (only seed data there).

From here until Phase D, staging is down. Its Workers Builds connection is gone with its Worker, so a push during this window deploys nothing.

**Phase B: rename outside the code** (you). Progress 2026-10-16: both GitHub renames done and `baton-legacy` archived; the old checkout is renamed (step 5).

The folder move (step 6) is the last thing the thread that started the rename does, because its own working folder moves out from under it. T3 records a project by path, so the old project then points at a missing folder: archive it and continue in a new thread in a new project on `~/Documents/src/baton`. Copy, do not move, the Claude memory folder: the running session keeps writing its transcript under the old path. A fresh clone is not an option: `.env`, `.env.staging`, `.shopify/` and `refs/` are untracked and would have to be rebuilt.

4. GitHub: rename `mw10013/baton` → `mw10013/baton-legacy` (Q1), then `mw10013/alchemy-sandbox1` → `mw10013/baton`. GitHub refuses the second rename while the first name is taken. Archive the old repository (Q2).
5. Old local checkout: `~/Documents/src/baton` → `~/Documents/src/baton-legacy`, `git worktree repair` (its herdr worktrees `~/.herdr/worktrees/baton/wt-01` and `wt-02` point at it), and `git remote set-url`.
6. This checkout: move `~/Documents/src/alchemy-sandbox1` → `~/Documents/src/baton`, then `git remote set-url origin https://github.com/mw10013/baton.git`. Copy the Claude memory folder (`memory/`) to `-Users-mw-Documents-src-baton`. Create the new T3 project for `~/Documents/src/baton`, add its "Bootstrap worktree" action, and archive the old project (Q7). Close the old herdr workspace.

**Phase C: rename in the code** (agent, in `~/Documents/src/baton`)

7. Everything in §2.1 except the staging URLs, which do not exist yet. `scripts/refs.ts`: the old repository's new name and folder (Q3); then `vp run refs fetch <name>` and delete the old `refs/baton`.
8. Living docs per Q6.
9. `vp check --fix`, `vp test`, `vp run test:e2e`. These recreate the local stages under the new name, which also verifies that local works.

**Phase D: bring staging back** (laptop, then Workers Builds)

10. `vp run stage-config --stage staging` writes the `Baton-config` record from `.env.staging`.
11. `vp exec alchemy plan --stage staging` shows only creates, then `vp run deploy:staging`. Note the new Website URL.
12. Put the new URL into `shopify.app.staging.toml`, `README.md` and `AGENTS.md` (the log filter uses the Website service's new name). `shopify app deploy --config staging` (you approve the release).
13. (you) Workers Builds: on the new Website Worker, connect repository `mw10013/baton`, branch `main`, deploy command `pnpm exec vp run deploy:staging`, the same API token. Previews off.
14. Embedded load on `mw10013-staging-shop-00` (you): the app opens, and staging's logs show a fresh token exchange, since the new D1 has no `ShopSession` yet. The Shopify store, the app install and the seeded products survive, because they live in Shopify.
15. Commit; push. Check: Workers Builds runs and its deploy is a no-op plan against the state from step 11.

**Phase E: after** (optional)

16. Recreate wt-01 through T3 in the new project (`t3_thread_launch`, as in the worktrees runbook).
17. Delete the `sandbox-shop-NN` stores, which carry nothing after the staging store plan.

## 5. Risks

- **Phase A runs against the old code.** If the code is renamed first, step 2 targets a stack with no state and destroys nothing. The plan's guard: Phase C does not start until the account check in step 2 passes.
- **Workers Builds ordering.** Reattaching before the new Website Worker exists is impossible. Pushing the rename commit before step 13 deploys nothing; after step 13 it deploys normally.
- **Token warning.** The Workers Builds token already shows a permissions warning; it worked before, so reuse it unchanged.
- **Shopify CLI link.** `.shopify/` and the app tomls are keyed by `client_id`, so the folder move does not unlink the apps. If `shopify app dev` asks to relink after the move, answer with the existing Baton Dev app.

## 6. Questions

All settled 2026-10-16 (two rounds): every question took the recommendation, except Q7, settled on a new T3 project.

:::question
What should the old Baton repository be called?

- [x] baton-legacy

Recommended: baton-legacy
:::

:::question
Archive the old repository on GitHub after the rename?

- [x] Archive

Recommended: Archive
:::

:::question
What should the local reference folder be called, and what happens to the "Baton's X" comments?

- [x] refs/baton-legacy, and leave the comments for now

Recommended: refs/baton-legacy, and leave the comments for now
:::

:::question
What should happen to wt-01?

- [x] Remove it in Phase A and recreate it in Phase E

Recommended: Remove it in Phase A and recreate it in Phase E
:::

:::question
What should the made-up shop in the seed data be called?

This is not a Shopify store; no store by that name exists anywhere. It is a placeholder string. The seed SQL that fills each stage's database on deploy (`seed/dev.sql`, `seed/test.sql`, `seed/staging.sql`) inserts a fake `ShopSession` row for a shop named `alchemy-sandbox1.myshopify.com`, with fake tokens (`shpat_fake_alchemy_sandbox1`), plus two members (`m1@m.com`, `m2@m.com`) and a team on it. That row is what the member area (`/shop/alchemy-sandbox1.myshopify.com`) and the members e2e spec run against, without a real install. In code it is the constant `SANDBOX_SHOP` in `src/contract/shop.ts`, which the member navigation links to. A second placeholder, `other-shop.myshopify.com`, sits next to it and needs no change.

Because it embeds the old name, it gets renamed with everything else; the only question is the new string (and the constant becomes `SEED_SHOP`).

- [x] seed-shop.myshopify.com — says what it is, and cannot be mistaken for a real store; pairs with other-shop
- [ ] baton.myshopify.com — shortest, but reads like the app's real store

Recommended: seed-shop.myshopify.com
:::

:::question
How far should the rename reach into `docs/`?

- [x] Runbooks, README and AGENTS only

Recommended: Runbooks, README and AGENTS only
:::

:::question
How should the T3 project move?

Settled: a new T3 project for `~/Documents/src/baton`, and the old `alchemy-sandbox1` project is archived. Its worktrees then go under `~/.t3/worktrees/baton/`. The new project needs the "Bootstrap worktree" project action again (worktrees runbook, "Configure the project action"), before wt-01 is recreated in Phase E. Work after Phase B continues in a new thread in the new project.

- [x] Create a new project for ~/Documents/src/baton and archive the old one

Recommended: Create a new project for ~/Documents/src/baton and archive the old one
:::

:::question
Lowercase or capitalised name in `alchemy.run.ts`?

Every Alchemy stack is declared with a name, and that name becomes the first part of every Cloudflare resource name. Today it is written with a capital A, `Alchemy.Stack("Alchemy-sandbox1", …)` in `alchemy.run.ts`, and likewise `Alchemy-sandbox1-config` and `Alchemy-sandbox1-test`. Cloudflare then shows:

- Workers, lowercased by Alchemy: `alchemy-sandbox1-website-staging-a6uwn3bzazl3yzgy`
- D1, case kept: `Alchemy-sandbox1-AuthDb-staging-nni7q2mdz5whuhgq`

So today one name appears in two spellings in the dashboard. Writing it lowercase removes that.

- [x] baton (and baton-config, baton-test) — one spelling everywhere: `baton-website-staging-…`, `baton-AuthDb-staging-…`, matching the repo and package name
- [ ] Baton (and Baton-config, Baton-test) — keeps today's capitalisation, so D1 shows `Baton-AuthDb-…` while Workers show `baton-…`

Recommended: baton (and baton-config, baton-test)
:::
