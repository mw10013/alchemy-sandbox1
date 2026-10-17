# Playwright CLI: recommendation

**Two goals: drive the embedded Shopify app; stop generated files growing forever.**

For the LLM while implementing and verifying work. Optional: choose this CLI or
Chrome MCP according to the task. **Headless by default; headed when helpful.**

## 1. Automatic cleanup

**Agreed: a 100 MiB budget per checkout.**

- `.playwright-cli/` contains snapshots, screenshots, logs and traces.
- The CLI can automatically delete oldest files as commands run.
- No scheduled cleanup process needed. The budget is approximate, not a strict ceiling.
- Save important recordings elsewhere; automatic cleanup can remove old traces.
- Current manual cleanup removes files roughly 48 hours old.

## 2. Driving the app

**Implemented: `vp run browser open` opens and prepares the browser.**

It:

1. Read this checkout’s dev store and app handle.
2. Load the exported Shopify login; explain `vp run e2e:auth` if missing.
3. Open the embedded app in Chrome, with `vp run dev` running.
4. Wait until the app can handle clicks; collapse Shopify’s obstructing Dev Console.
5. Return a snapshot, ready for ordinary CLI clicks.

**`run-code` means “execute Playwright JavaScript against this open browser.”**
Use it for step 4, following the checks our e2e tests already use. Check readiness
again after navigation. Avoid JavaScript `.click()` for app controls: it can bypass
overlays and hide problems.

## 3. Settings

**Shared defaults in `.playwright/cli.config.json`:**

- The output budget.
- A 10-second action timeout: how long a click waits for its target to become ready.

That directory also keeps each checkout’s browser sessions separate, so commands
in one worktree cannot accidentally drive another’s browser. Name the session `admin`.

The opening command handles login loading. No environment variables to type manually.
Keep admin authentication out of the shared defaults.

## Live check — 2026-10-17

**Passed headlessly:** loaded the login, waited for hydration, collapsed Dev Console,
clicked Orders, clicked Next page, and confirmed the changed orders in a snapshot.
Use accessibility snapshots to verify Polaris content; DOM text checks can miss it.

The opening and readiness commands passed live. The 100 MiB budget deleted an
oversized old file in an isolated output directory and retained the current snapshot.
`vp check --fix` passed. Embedded e2e smoke tests passed: 5 tests including setup.

## Runbook

[LLM commands, retained files and recovery](playwright-cli-runbook.md).

## Sources

Verified against installed Playwright 1.64.1, its source in `refs/playwright`, and
Baton’s guards in `test/e2e/embedded/app.ts`.
[Official CLI documentation](https://github.com/microsoft/playwright-cli).
