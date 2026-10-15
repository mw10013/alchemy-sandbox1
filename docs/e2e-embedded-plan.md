# Plan: the embedded e2e specs, in the real Shopify admin

Plan date: 2026-10-15 · Base commit `da28f0e`.
Research: [The first e2e specs against real Shopify](./e2e-specs-research.md), every question answered with its recommendation. Read its §2 to §4 first. Earlier phases: [e2e server](./e2e-server-plan.md), [stores](./stores-plan.md).

## 0. Rules for the implementer

- Follow `AGENTS.md`: Vite+ only, Effect idioms (Schema for every parse and check, `Schema.TaggedError`, `Effect.fn`), its comment rules (no references to plans or research docs).
- **No commits.**
- **The dev servers keep running** (main on 3900, `wt-01` on 3901). Never run `vp run dev:stop`; never kill a process you did not start. `vp run dev:status` before and after every e2e run.
- **No Shopify store changes:** no create, delete, seed or `store auth`.
- **Never print a secret, token or cookie.** The cookie export holds the person's Shopify login: never print its contents, never copy it outside `playwright/.auth/`, keep it mode 0600. Do not read Chrome's cookie database except through the ported code, and **do not run the export yourself**: it opens a macOS Keychain prompt a person must answer (Step 6).
- **Do not touch Baton's files** (`refs/baton`); copy and adapt what the plan names.
- `vp check --fix` after code changes; each step green before the next.
- Deviations and problems go in §9, dated, by step.

## 1. Outcome

- `playwright/.auth/shopify-admin.json` holds the person's Shopify admin cookies, exported from Chrome's `Default` profile through a Keychain prompt, refreshed by a setup project only when stale (about once a day).
- A Playwright project `embedded` runs `test/e2e/embedded/*.spec.ts` in real Chrome (`channel: "chrome"`), headless, against `https://admin.shopify.com/store/<SHOPIFY_E2E_STORE>/apps/baton-local/app`, with that storage state. Specs in a file run serially, with one admin boot per file.
- Two specs: the app loads embedded and shows the e2e store's domain; the exchange stored a real session (`shopGid` a real `gid://shopify/Shop/…`).
- The existing specs and projects run as before, without the login and without a Keychain prompt.
- `vp run test:e2e` runs everything; `vp run test:e2e:headed` the same with a visible browser.

## 2. Step 1: the cookie export

Port `refs/baton/scripts/lib/shopify-playwright-auth.ts` to `scripts/lib/shopify-admin-auth.ts`, and `refs/baton/scripts/refresh-shopify-playwright-auth.ts` to `scripts/shopify-admin-auth.ts` (an `effect/cli` command with `--profile` and `--dry-run`, wired as the package script `e2e:auth`).

Keep the behavior (research §2): the three Shopify hosts; the cookie database and its `-wal` copied into a 0700 temp directory and read with `node:sqlite`; the Keychain read of "Chrome Safe Storage" with stdin closed, a 120 s bound and its output never in an error; PBKDF2 and AES-128-CBC decryption; the atomic 0600 write; the 150 s overall deadline; macOS only; the "quit Chrome" message when no Shopify cookie is found; the freshness rule (`koa.sid` more than 5 minutes left, or the export younger than 24 hours).

Adapt: `Schema.TaggedError`, `Effect.fn`, Schema decoding of the database rows and of the profile name (no slashes), this repository's `scripts/lib/command.ts` where it fits. JSDoc states each rule once, including why the Keychain output never reaches an error.

Unit tests (`test/unit/scripts/lib/shopify-admin-auth.test.ts`) for the pure parts: decryption of a known ciphertext (build one in the test with the same key derivation), the Chrome timestamp conversion, the freshness rule at its edges, the profile name check.

## 3. Step 2: Playwright projects

`playwright.config.ts`:

- The existing magic-link setup project matches only `auth.setup.ts`; the existing `chromium` project ignores `test/e2e/embedded/**`.
- A new setup project `shopify-admin` runs `test/e2e/shopify-admin.setup.ts`: skip when the saved export is fresh, otherwise export (Baton's `shopify-admin.setup.ts`, setup timeout 180 s).
- A new project `embedded`: `testMatch` `test/e2e/embedded/**/*.spec.ts`, `dependencies: ["shopify-admin"]`, `use: { channel: "chrome", baseURL: <admin URL>, storageState: "playwright/.auth/shopify-admin.json" }`, and Baton's timeouts for it (`expect` 10 s, actions 10 s, navigation 30 s).
- The admin URL comes from `.env`'s `SHOPIFY_E2E_STORE` and the app handle, read from `shopify.app.toml` with Schema (as `scripts/dev.ts` reads `client_id`).
- With `PLAYWRIGHT_TEST_BASE_URL` set, `embedded` is left out (a deployed target has no e2e store yet).

**The test-control client must not use the project's `baseURL`.** `test/e2e/fixtures.ts`'s `backend` fixture reads `workerInfo.project.use.baseURL`; in `embedded` that is the admin. Give it the e2e server's own URL (the one `playwright.config.ts` already computes), exported from the config, for every project.

`package.json`: `test:e2e:headed` (`vp exec playwright test --headed`).

## 4. Step 3: test control reads a session

A procedure `GetShopSession({ shop })` in `src/contract/test-control.ts` and `src/backend/test-control.ts`, behind the same token middleware, returning the stored session's non-secret fields only: `shopGid`, `scope`, `accessTokenExpiresAt`; none when there is no session. Never the access or refresh token: its success schema has no field for them. Unit test beside the existing test-control tests.

## 5. Step 4: helpers and specs

`test/e2e/embedded/app.ts`, ported from `refs/baton/e2e/app.ts` and `hydration.ts`, only what the two specs use: `appFrame` (the `embedded=1` iframe that is not `chrome=window`), `gotoApp` (navigate, wait for `body[data-hydrated]` inside the frame, reload once on failure), `closeDevConsole` (the CLI's dev console overlay swallows clicks), and `openApp` (one context and page per file with the storage state). JSDoc keeps Baton's reasons.

`test/e2e/embedded/app.spec.ts`, serial, one `openApp` in `beforeAll`:

1. The app loads embedded: the frame shows the "We got here" section with `<SHOPIFY_E2E_STORE>.myshopify.com`.
2. The exchange stored a real session: `GetShopSession` for the e2e store's domain returns a `shopGid` matching `gid://shopify/Shop/<digits>` and the scope `read_orders,read_products`.

## 6. Step 5: docs

`README.md`: two or three sentences on the embedded project, `vp run e2e:auth`, the Keychain prompt and `test:e2e:headed`. The runbook comes later.

## 7. Step 6: verification

The implementer does 1 to 3 and stops; 4 needs the person at the Mac.

1. `vp check`; `vp test`.
2. `vp run test:e2e --project setup --project chromium`: the existing 20 specs pass, no Keychain prompt.
3. `vp run e2e:auth --dry-run` only if dry-run does not read the Keychain; otherwise skip and say so. Report, and stop.
4. (Reviewer, with the user.) `vp run e2e:auth`, answer the Keychain prompt; then `vp run test:e2e`: all projects pass; `.logs/e2e/current` shows the exchange for the e2e store; a second run reuses the export without a prompt; `vp run test:e2e:headed --project embedded` once to watch it.

## 8. Out of scope

The e2e store's data and seed, `store auth` on e2e stores, webhook routes and specs, the 404 webhook subscriptions, moving the existing specs off the fake shops, CI, a runbook, committing.

## 9. Deviations and issues

(The implementer records here, dated, by step.)

### Step 1 (2026-10-15)

- Ported without behavior change. Additions: `chromeMicrosToEpochMs`, `deriveKey`, `makeDecrypt` and `adminSessionFresh`'s `now` parameter are exported or injectable so the unit tests reach the edges. The profile check is the `ChromeProfile` Schema (also the `--profile` flag's schema).
- `--dry-run` also reads the Keychain (it decrypts the cookies). It was therefore not run (Step 6 item 3 skipped). No export was run at all.
- Not exercised against a real Chrome profile; only the pure parts are unit tested.

### Step 2 (2026-10-15)

- The config exports `e2eServerURL` (the server's own URL, or `PLAYWRIGHT_TEST_BASE_URL`) and `storageStatePath`. The `backend` fixture uses `e2eServerURL` and no longer reads the project's `baseURL`.
- The `setup` project now matches `auth.setup.ts` only; `chromium` ignores `**/embedded/**`. `shopify-admin` and `embedded` exist only without `PLAYWRIGHT_TEST_BASE_URL`.
- Playwright has no per-project worker count. `embedded` sets `fullyParallel: false` and its spec is serial, but two embedded files could run on two workers; with one file this does not arise. Revisit when a second file is added (a shared lock, or `--workers=1` for that project's run). `embedded` also sets `timeout: 60_000`, which the plan did not name.
- `embedded` throws at config load when `SHOPIFY_E2E_STORE` is unset.
- Not run: `shopify-admin` and `embedded` (Keychain).

### Step 3 (2026-10-15)

- `GetShopSession` answers `null` (not an Option) for no session, so the ndjson RPC encoding needs no Option transformation.
- `ShopSessions` was private to the `Shopify` layer in the Worker; it is now merged into the services the test-control handlers get (`Layer.provideMerge`), and `ShopSessions` is added to that context's type.

### Step 4 (2026-10-15)

- The spec and helpers are unrun against the real admin. Unverified guesses: the "We got here" text is found with `getByText` (it is an `s-section` heading attribute rendered in shadow DOM), and the store domain with an exact `getByText`. If either fails at the first embedded run, adjust the locator.
- The hydration marker here is `body[data-hydrated]` (the attribute is empty), not Baton's `="true"`.
- The spec reads `SHOPIFY_E2E_STORE` from `process.env`, which the config's `loadEnvFile` fills for the workers.

### Step 5 (2026-10-15)

- README paragraph added after the e2e paragraph. No runbook.

### Step 6 (2026-10-15)

- Items 1 and 2 pass. Item 3 skipped (see Step 1). Item 4 is for the reviewer.

2026-10-15, Step 6 item 4 (the user): `vp run e2e:auth` exported the cookies after the Keychain prompt (`playwright/.auth/shopify-admin.json`, mode 0600); `vp run test:e2e` passed, every project including `embedded`; `.logs/e2e/current` shows `exchanged shop=mw10013-e2e-shop-00.myshopify.com`. The dev server stayed healthy.
