# Playwright CLI research

What `playwright-cli` is, how we run it, what it writes, and how to point it at the Shopify admin. The
findings come from the `refs/playwright` snapshot at v1.64.1 (the `playwright` pin in `package.json`).

## Running it

- **`vp exec playwright cli <command>`.** `vp exec` runs a binary from `node_modules/.bin`, where
  `playwright` is linked; npm and npx are not used in this repo. The CLI's own help still prints
  `Usage: npx playwright`, which is its banner, not an instruction.
- **`vp exec playwright cli --version`** reports the bundled version, so it tracks the `playwright` pin
  (1.64.1 at the time of writing).
- The command surface lives in `playwright-core`, not the test-runner package: the `cli` subcommand is
  registered in `refs/playwright/packages/playwright-core/src/cli/program.ts`, which splices `cli` out
  of `argv` and runs `refs/playwright/packages/playwright-core/src/tools/cli-client/program.ts`.

## `playwright` vs `playwright cli`

Same binary: `cli` is a subcommand that swaps in an entirely different command tree. Both spellings are
`vp exec playwright …`.

|                 | `vp exec playwright …`                                                                                                                                   | `vp exec playwright cli …`                                                                                 |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| What it runs    | the test runner, browser install, report and trace tools                                                                                                 | a stateful browser session for an agent or a person                                                        |
| State           | none: it takes a config or a URL, acts, and exits                                                                                                        | a daemon holds the browser; each command acts on the page the last one left open                           |
| Examples        | `test`, `install`, `codegen`, `show-report`, `merge-reports`, `show-trace`, `trace`, `screenshot <url> <file>`, `pdf <url> <file>`, `mcp`, `init-skills` | `open`, `goto`, `click`, `type`, `fill`, `snapshot`, `eval`, `screenshot`, `tab-list`, `requests`, `close` |
| Notable options | `--project`, `--grep`, `-c`, `--headed`, `--ui`                                                                                                          | `-s=<session>`, `--headed`, `--browser`, `--persistent`, `--profile`, `--config`, `--idle-timeout`         |

Names collide with different signatures — `open`, `screenshot` and `pdf` exist at both levels. The outer
`open <url>` and `screenshot <url> <file>` are one-shot and take a URL; the inner pair act on the open
page. Check `--help` at the level you are at.

Two neighbours that are neither: `vp exec playwright mcp` runs the MCP server, and
`vp exec playwright test --debug cli` binds a running test's browser under a `tw-…` session so
`cli attach` can drive it.

## Sessions

- `-s=<name>` names a session; the default is `default`. Name per checkout so worktrees never collide —
  baton-legacy used `{port}-{purpose}`, and `vp run port` prints ours.
- `list` shows the open browsers, `close` shuts one down, `delete-data` clears its stored profile.
- Headless by default. The idle timeout is one hour for a headless browser and absent for a headed one,
  so a forgotten session keeps a browser alive that long.

## What it writes

Everything lands in `<cwd>/.playwright-cli/` — `outputDir()` in
`refs/playwright/packages/playwright-core/src/tools/backend/context.ts` returns the cwd plus that name
(the MCP server uses `.playwright-mcp`, and an unwritable cwd falls back to the OS temp directory).
Nothing is written at the repository root.

- `page-<timestamp>.yml` — an ARIA snapshot with `[ref=eN]` handles, and `[ref=f1eN]` for elements
  inside an iframe. This is what the next command targets.
- `page-<timestamp>.png`, `page-<timestamp>.pdf` — screenshots and PDF exports.
- `console-<timestamp>.log` — page console output since the tab opened.
- `trace/` — trace snapshots written by the trace tools.

**Snapshots can carry credentials.** An embedded app frame's URL holds `hmac`, `id_token` and `session`
query parameters, so the directory is ignored (`.playwright-cli/` in `.gitignore`) rather than left to
be committed by accident.

## Cleanup

- **Nothing is removed by default.** The only pruning code is an output budget,
  `_enforceOutputBudget` in `refs/playwright/packages/playwright-core/src/tools/backend/response.ts`. It
  returns immediately while `outputMaxSize` is unset, and there is no default.
- **`vp run clean:playwright-cli`** deletes files under `.playwright-cli/` older than 24 hours. It is
  manual, as it was in baton-legacy.
- **`outputMaxSize`** is a byte cap, settable in `.playwright/cli.config.json` (or globally in
  `~/.playwright/cli.config.json`) or through `PLAYWRIGHT_MCP_OUTPUT_MAX_SIZE`. There is no CLI flag for
  it. When set, each command's response lists the directory recursively and deletes oldest-mtime-first
  until the total fits, skipping files written during that same response. It is size-based rather than
  age-based, so it overlaps the clean script without replacing it.

## Pointing it at the Shopify admin

The admin needs the exported session cookie. `vp run e2e:auth` writes it to
`playwright/.auth/shopify-admin.json` (macOS, Keychain, a person present), and the URL is the one
`playwright.config.ts` builds for the `embedded` project: `https://admin.shopify.com/store/<store>/apps/<handle>/app`,
with the store from `.env` and the handle from `shopify.app.toml`.

**1. On the command line: nothing stored in the repository.**

```sh
PLAYWRIGHT_MCP_STORAGE_STATE=playwright/.auth/shopify-admin.json \
  vp exec playwright cli -s=admin open --browser chrome \
  "https://admin.shopify.com/store/${SHOPIFY_DEV_STORE}/apps/baton-local/app"
```

`--browser chrome` selects the Chrome channel, the same browser the `install` and `embedded` e2e
projects use. `PLAYWRIGHT_MCP_STORAGE_STATE` is read by `configFromEnv` and merged over any config file,
despite the MCP-flavoured name.

**2. A local config file.** `.playwright/cli.config.json` is loaded automatically from the working
directory (`resolveCLIConfigForCLI`), with `~/.playwright/cli.config.json` as the global equivalent;
both merge under the environment and the flags.

```json
{
  "browser": {
    "browserName": "chromium",
    "launchOptions": { "channel": "chrome" },
    "contextOptions": { "storageState": "playwright/.auth/shopify-admin.json" }
  }
}
```

This was tried and removed, and it is worth knowing why. The config holds a _path_, never the cookie
itself, so committing it leaks nothing — but it hard-depends on the referenced file existing on the
machine. Committed, `open` fails for anyone who has not run `vp run e2e:auth`:

```
ENOENT: no such file or directory, open 'playwright/.auth/shopify-admin.json'
    at prepareStorageState (playwright-core)
```

and every session, including one aimed at `localhost`, would silently carry an admin login. Ignoring
`.playwright/` instead makes the file per-checkout, which is approach 1 with more moving parts. The one
thing a config can do that a command line cannot is raise `timeouts.action` (5000 ms by default; there
is no flag), so the file is worth revisiting if 5 s proves too tight through the quick tunnel.

### Reading works, clicking does not

The admin loads, and the snapshot reaches inside the embedded app's iframe — `f1eN` refs, so the app is
addressable. Clicking is where a plain session fails, for the two reasons `test/e2e/embedded/app.ts`
already documents, and the CLI has no equivalent of either guard:

- the app's `<body>` stays `inert` until `data-hydrated` appears, so a click passes every actionability
  check and is dropped by the browser;
- the Shopify CLI's Dev Console panel is an admin-document overlay that outranks the iframe in the hit
  test, so a click reports success and lands on the console instead.

Both are workable from a session — a click can be issued with `eval` against a frame ref, which runs in
that frame's context — but nothing in the CLI waits for hydration or collapses the panel.

## Which store to point it at

The dev store: `vp run dev` keeps `shopify app dev` and its quick tunnel alive, so the URL in the store's
app record is current. The e2e store's URL is a dead tunnel between runs, because the e2e server
destroys its stage before it starts one; use that store only with `vp run test:e2e:server` running.

Driving the dev store by hand mutates dev data; `vp run fixture` puts the fixture back.

## Open questions

- **`outputMaxSize`:** set a cap, or rely on `clean:playwright-cli`? Left off deliberately for now: one
  deletion policy rather than two.
- **A committed `.playwright/cli.config.json`:** worth it for `timeouts.action: 10000` alone?
- **Wiring the clean script into something:** `dev:stop` or `worktree:init`, so it is not manual.

## What this does not affect

None of it touches the test suites. `playwright test` reads `playwright.config.ts`, and Vitest drives its
own browser provider from `vite.config.ts`; `.playwright/cli.config.json` is read only by the CLI and MCP
paths.
