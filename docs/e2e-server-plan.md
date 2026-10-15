# Plan: the e2e server on real Shopify, beside the dev server

Plan date: 2026-10-15 · Shopify CLI `4.9.0` · Base commit `5c1843b`.
Research: [E2E against real Shopify](./e2e-real-shopify-research.md), phase 4 (its §6.3 shows two `shopify app dev` sessions of one app running from one directory on two stores; §7 is the design). Phase 3 ([stores plan](./stores-plan.md)) gave every checkout `SHOPIFY_E2E_STORE`.

## 0. Rules for the implementer

- Follow `AGENTS.md`: Vite+ only, Effect idioms, its comment rules (no references to plans or research docs in code or comments).
- **No commits.**
- **The dev servers keep running.** The main checkout's (`mw10013-dev-shop-00`, port 3900) and `wt-01`'s (`mw10013-dev-shop-01`, port 3901) must stay up and untouched throughout. Never run `vp run dev:stop`, and never kill a `shopify app dev`, `alchemy dev`, `workerd` or `cloudflared` process you did not start. Check `vp run dev:status` before and after every e2e run.
- **Stores:** the e2e server runs only on this checkout's `SHOPIFY_E2E_STORE` (`mw10013-e2e-shop-00`). No store is created, deleted or seeded, and no `store auth` is run.
- **Never print a secret or token.** No `--verbose`, no `shopify app env pull`, no dumping a process's environment.
- **Do not touch Baton's files** (`refs/baton`), or the `wt-01` worktree.
- `vp check --fix` after code changes; each step green before the next.
- Deviations and unsolved problems go in §10, dated, by step.

## 1. Outcome

- `vp run test:e2e` starts the e2e server as Shopify CLI on this checkout's e2e store: `shopify app dev --store <SHOPIFY_E2E_STORE>`, which runs `alchemy dev` on the e2e stage (`e2e-<user>[-wt-NN]`) at `WEBSITE_PORT` + 100 with the real Baton Dev key, secret and the session's tunnel. The stage is destroyed first, as today, so every run starts from the seed.
- The e2e stage binds the CLI's real app, as `dev` does under the CLI. No fake Shopify key or secret on e2e.
- Everything the e2e server prints, the CLI's lines and Alchemy's, goes to `.logs/e2e/current` through `s6-log`, archives in `.logs/e2e/`, with one marker line per server start.
- The dev server's controller (`vp run dev`, `dev:stop`, `dev:status`) never adopts, reports or stops the e2e server.
- All 20 existing specs pass, with the dev server running. They keep their current data: the e2e database seed (`seed/test.sql`, shared with `test`) still holds the fake shop `alchemy-sandbox1.myshopify.com` with fake tokens, which the member, operator and merchant specs use without calling Shopify. Moving specs onto the real e2e store is the next phase.
- With the e2e server running, opening the app in `mw10013-e2e-shop-00`'s admin loads the e2e server's tunnel and the e2e log shows a real exchange for `mw10013-e2e-shop-00`.

## 2. Step 1: the web command serves either environment

`shopify.web.toml`'s `dev` command is shared by every `shopify app dev` session in the checkout, so it cannot name the stage. Today it is `vp run dev:alchemy`, which hard-codes `node scripts/stage.ts dev` and pipes to `.logs/dev`.

- One environment variable chooses the environment of the web command: name it after what it is (for example `SANDBOX_ENVIRONMENT`, decoded as `PerDeveloper` minus `test`, default `dev`). Decode it with Schema; no hand checks.
- `dev`: exactly today's behavior (`--stage` from `scripts/stage.ts dev`, output to `.logs/dev` through `s6-log`, echoed).
- `e2e`: `alchemy dev` on the e2e stage with output plain to stdout, not through `s6-log`: the CLI forwards the web command's output into its own, and Step 3 logs the CLI's whole output in one place, in order.
- The e2e stage is passed as `ALCHEMY_STAGE` in the environment, not `--stage`, as Playwright's server does today. Two things depend on that: `vite.config.ts` gives a server its own Vite dependency cache only when `ALCHEMY_STAGE` is set (without it the dev and e2e servers share `node_modules/.vite` and break each other's SSR), and `scripts/dev.ts` tells the dev server apart by its `--stage` argument.
- Keep the long shell one-liner readable: if the branching makes `dev:alchemy` unreadable, move it into a small script (`scripts/web.ts` or similar, Effect CLI like `scripts/stage.ts`) that `shopify.web.toml` runs, and update the TOML's comment.
- `alchemy dev` reads `WEBSITE_PORT` from the process environment before `.env`, so the e2e session overrides the port through the environment, as Playwright's server does today.

## 3. Step 2: the e2e stage uses the CLI's app

`src/backend/stack.ts`, `ShopifyApp`: `e2e` reads `shopifyCliApp` like `dev` (Some under the CLI, the fakes when the three variables are absent). `test` keeps the fakes. Update the JSDoc (stated once, on `ShopifyApp`). `TestControl` and inline magic links stay as they are on a stage with `E2E_TOKEN`.

`IssueMerchantSessionToken` now signs with the real secret; the merchant specs verify against the same binding, so nothing else changes. Note in §10 if a spec breaks.

## 4. Step 3: the e2e server command and its log

Replace `test:e2e:server` with a script that:

1. Reads `.env` (`SHOPIFY_E2E_STORE`, `WEBSITE_PORT`), checks the store with `stores:check`'s logic, and computes the e2e stage and port (`WEBSITE_PORT` + 100, as `playwright.config.ts` does; keep one source for the +100 and say so in JSDoc).
2. `alchemy destroy --stage <e2e stage> --yes` (today's fresh start).
3. Writes a marker line to the log (date, stage, store, port).
4. Runs `shopify app dev --config shopify.app.toml --store <e2e store>` with `BACKEND_PORT` and `WEBSITE_PORT` set to the e2e port and the Step 1 variable set to `e2e`, its stdout and stderr piped through `s6-log` into `.logs/e2e` with the same `s6-log` arguments as `dev:alchemy` (rotation sizes), and echoed so Playwright still sees it.
5. Stays in the foreground for Playwright's `webServer`, and on SIGTERM stops the CLI cleanly so its `alchemy dev`, `workerd` and `cloudflared` children exit. Check after a run that none of them is left (`pgrep -fl` with the e2e stage and store).

`playwright.config.ts`: the `webServer` command runs it; `env` keeps `E2E_TOKEN`; the stage and port come from the script, not the config, if that removes a duplicate. `timeout` stays 180 s unless measurements say otherwise (record them). `reuseExistingServer` and `PLAYWRIGHT_TEST_BASE_URL` keep their meaning.

The CLI with no TTY: the phase-3 runs showed `shopify app dev` works non-interactively; if it prompts here, record the prompt and find the flag.

## 5. Step 4: the dev controller ignores the e2e server

`scripts/dev.ts` finds this checkout's server as any `shopify app dev` process whose working directory is the checkout (`CLI_PROCESS`, `checkoutPids`). With the e2e server running in the same checkout, `dev:status` would report it, and `dev:stop` would stop it. Match on the store as well: the dev server's CLI command line carries `--store <SHOPIFY_DEV_STORE>`. Do the same check for any other process matcher in the file that the e2e server could satisfy. Update the JSDoc that describes how the server is found.

Test: with the e2e server running (`E2E_REUSE_SERVER=1`, Step 6), `vp run dev:status` reports only the dev server, with its own pids.

## 6. Step 5: docs

- `README.md`: the e2e paragraph: the e2e server is Shopify CLI on the e2e store, real Baton Dev credentials, logs in `.logs/e2e/current`. Keep it short; the runbook comes later.
- `AGENTS.md` "Logs": add the e2e log path beside the dev one.
- `docs/e2e-real-shopify-research.md`: status line (phase 4 done).

## 7. Step 6: verification

Run in this order and record results in §10:

1. `vp run dev:status`: healthy (before).
2. `vp check`, `vp test`.
3. `vp run test:e2e`: 20 passed. Record the server's start time and the run time. Afterwards: `.logs/e2e/current` holds the marker, the CLI's lines (tunnel, "Using URL", preview URL) and Alchemy's (plan, Website ready); no e2e process is left; `vp run dev:status` healthy.
4. `E2E_REUSE_SERVER=1`: start the e2e server on its own (the script from Step 3, in the background), then `vp run dev:status` (only the dev server), then `vp run test:e2e` against the running server (passes).
5. With that server still running, report to the reviewer that it is up and on which tunnel, and stop: the reviewer opens the app in `mw10013-e2e-shop-00`'s admin and checks the exchange in `.logs/e2e/current`. Then stop the server with SIGTERM and confirm no process is left.

## 8. Out of scope

Specs that use the real e2e store, the e2e store's data and seed, the admin login for Playwright, webhook specs, changing `seed/test.sql`, a named tunnel, committing.

## 9. File plan

| File                                      | Change                                                   |
| ----------------------------------------- | -------------------------------------------------------- |
| `package.json`                            | `dev:alchemy` by environment; `test:e2e:server` replaced |
| `shopify.web.toml`                        | Only if the web command moves into a script              |
| `scripts/` (new or edited)                | The e2e server script; possibly the web command script   |
| `src/backend/stack.ts`                    | `ShopifyApp`: `e2e` reads the CLI's app                  |
| `scripts/dev.ts`                          | Server matching by store                                 |
| `playwright.config.ts`                    | `webServer` command and env                              |
| `README.md`, `AGENTS.md`, research status | Step 5                                                   |

## 10. Deviations and issues

(The implementer records here, dated, by step.)

### 2026-10-15

**Step 1.** The web command's branch lives in `package.json`'s `dev:alchemy`, not in a script that execs: `scripts/web.ts` (Effect CLI like `stage.ts`) only decodes `SANDBOX_ENVIRONMENT` (`dev` | `e2e`, default `dev`; anything else exits non-zero) and prints it, and the bash one-liner `case`s on the printed value. A Node launcher between the CLI and `alchemy dev` would have had to forward signals to a bash pipeline; the shell keeps today's process tree. `e2e` is `exec env … ALCHEMY_STAGE=$(node scripts/stage.ts e2e) alchemy dev`, plain stdout. `shopify.web.toml`'s comment updated. `dev` behaviour is unchanged (the running dev servers were not restarted, so only the e2e path ran the new script).

**Step 2.** As written (`ShopifyApp`: `dev` and `e2e` read `shopifyCliApp`). All 20 specs pass on the real secret; none broke.

**Step 3.** `scripts/e2e-server.ts` runs `checkStores`, `alchemy destroy --stage <e2e stage> --yes`, writes the marker through `s6-log`, then spawns `shopify app dev` directly (no shell) and feeds its merged stdout and stderr to a second `s6-log`, echoing to stderr. Stdout is not echoed because Playwright shows only a webServer's stderr by default. The +100 lives in `e2ePortOf` (`scripts/lib/worktree.ts`), which `playwright.config.ts` imports; the config no longer computes the stage. Problems: Effect's `ChildProcess` does not inherit the parent environment once `env` is given, so `extendEnv: true` is needed (without it `alchemy` was NotFound). `timeout` stays 180 s: the server was answering about 18 s after the marker. SIGTERM goes to the script, whose scope closes both children; after a Playwright run and after a manual SIGTERM, no process with the e2e stage or store, nothing on port 4000 or the e2e proxy and Alchemy ports. The CLI ran without a TTY and prompted for nothing. The CLI rewrites `.shopify/project.json` to the e2e store (ignored by git, harmless since `app:dev` always passes `--store`, §6.3 of the research).

**Standalone server and `E2E_TOKEN`.** A server started by hand (`E2E_REUSE_SERVER=1`) must have `E2E_TOKEN` in its environment (`E2E_TOKEN=e2e vp run test:e2e:server`): without it the Backend serves no test control and the setup project fails with "Received empty HTTP response from RPC server". Playwright's own start supplies it.

**Step 4.** `scripts/dev.ts` matches the dev CLI by `{@link cliPattern}`: `CLI_PROCESS` followed by `--store <SHOPIFY_DEV_STORE>` ending the argument; the herdr pane finder uses the same test. Alchemy's matcher (` dev --stage dev-<user>`) already excluded the e2e server, which has no `--stage`. `serverPids` now needs `SHOPIFY_DEV_STORE` (an error naming it when unset, as `start` always did). With the e2e server running, `dev:status` reported only the dev server (pane wC:p2, tunnel evanescence-beast-pierre-pumps).

**Step 5.** README, AGENTS.md, research status done.

**Step 6.** Items 1 to 4 passed (counts in the report). A background server started by the agent harness died when its task ended (the CLI logged "The user aborted a request"); the one left running was started with `nohup`.

2026-10-15, review:

- **Vite cache by environment.** `vite.config.ts` keyed the cache on `ALCHEMY_STAGE` being set, so dev used Vite's default folder and e2e a subfolder only because of how it passed its stage. It now names a folder per server from `SANDBOX_ENVIRONMENT`: `node_modules/.vite/dev` and `node_modules/.vite/e2e`, for `vite dev` only. `SANDBOX_ENVIRONMENT` is read through one module, `scripts/lib/web.ts`, shared by `scripts/web.ts` and `vite.config.ts`. The old folders (`deps`, `deps_ssr`, `e2e-mw`, `vitest`) were removed.
- **`dev:alchemy` split.** The `case` inside one quoted bash line became three scripts: `dev:alchemy` runs `web:<environment>`, `web:dev` is the old dev line unchanged, `web:e2e` runs `alchemy dev` with the e2e stage as `ALCHEMY_STAGE`. The e2e server script no longer sets `ALCHEMY_STAGE` itself; `web:e2e` does.
- **Verified:** the main dev server restarted on the new path (`vp run dev`, healthy, logging to `.logs/dev/current`, `/` 200); `vp test` 142 passed; `vp run test:e2e` 20 passed in 34.5 s beside it; no e2e process left afterwards; `dev:status` healthy. Earlier, with the subagent's e2e server running, the app in `mw10013-e2e-shop-00`'s admin loaded the e2e tunnel and `.logs/e2e/current` showed `exchanged shop=mw10013-e2e-shop-00.myshopify.com`. `wt-01`'s dev server was not restarted and still runs the old script until its next start.
