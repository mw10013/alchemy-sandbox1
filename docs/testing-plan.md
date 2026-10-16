# Plan: dev endpoints, a test Backend, and e2e on the live system

Implements `docs/testing-research.md` (settled, Q1–Q19). Read its §1 and §2 first; this plan does not restate the reasons.

## 0. Rules for the implementer

- Follow `AGENTS.md`: Vite+ only (`vp`, never npm or npx); `vp check --fix` after every step; Effect Schema for parsing; `Match` for tag dispatch; `Schema.TaggedError`; `Effect.fn("name")`; JSDoc rules (no `//` above a declaration, no references to this plan or the research in code).
- Do not commit unless told to. Work on `main` in the main checkout.
- Each step ends green: `vp check`, `vp test` (unit, browser, integ), and from Step 6 on `vp run test:e2e`. A step that cannot end green is recorded in §7 before moving on.
- Do not rewrite the steps. Record what you built differently, and what surprised you, in §7 as you go.
- Do not touch the `dev` or `staging` stages. A dev server may be running in this checkout; leave it alone. The e2e server runs on its own port.
- The integ suite leaks a `.alchemy/local/baton-test-…-ShopActor` directory per file per run (a known bug on `main`, out of scope). Delete the ones your runs create.

## 1. Outcome

- Production code carries one dev door, `DevRpcs` on `/api/dev`, served on `dev`, `test` and `e2e` only. No `E2E_TOKEN`, no test control, no forged identity, no token signer, no fake Shopify, no `/merchant/$key`.
- integ runs against a **test Backend**: a Worker whose entry is `test/integ/backend.ts`, built from the Backend's own wiring, adding `IntegRpcs`, the forged-caller socket route and the fake Shopify HTTP. integ files run in parallel, each on its own stage.
- e2e runs on the real e2e store only: install by an embedded load, `LoadFixture` once, sign-in through the real form, member and admin specs in parallel, each on its own data.

## 2. Spike results this plan rests on

All five spikes from the research held (2026-10-16, code reverted):

- **S4, test Backend.** Moving the Backend's `Effect.gen(...).pipe(...)` body into an exported function and its props into a shared object let a second Worker class in `test/integ/` reuse it. The whole integ suite (6 files, 21 tests) passed against it. Alchemy's generated entry exports `ShopActor` for whatever the init yields, so the test entry needs no DO export of its own. The production bundle (`.alchemy/bundles/Backend/`) had no trace of a marker string in the test entry. `wireBackend`'s parameter had to widen to `Pick<Effect.Success<typeof Backend>, "bind" | "url">`. The test entry's `setAbstractFetchFunc` took effect (the library's fetch is one global per isolate).
- **S5, a stage per integ file.** `test-<user>[-wt-NN]-<suffix>` stages, `fileParallelism: true`: all files passed on 3 parallel runs; about 51 s serial to about 22 s parallel; about 60–70 MB per workerd, 5 at peak; no port, lock, state or sidecar contention.
- **S1, install from Playwright.** An `install` setup project with the embedded project's browser settings opened the app with `gotoApp`; the session existed as soon as the page hydrated (6.5–7.4 s on a fresh stage, about 4.2 s on a reused one).
- **S2, `LoadFixture` from Playwright setup.** A Node `RpcClient` at the e2e server's localhost port answered on the first attempt once S1 had run.
- **S3, the member area on the real shop.** A `shop.spec` case passed unchanged apart from the shop key. `embedded` must depend on `install`, not `shopify-admin`: otherwise the install load and `embedded/app.spec` exchange tokens on the one session row at once.

## 3. Names and constants

| Name                      | What                                                                                                                                                                                                      |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DevRpcs`                 | The dev group, in `src/contract/dev.ts`; handlers `DevHandlers` in `src/backend/dev.ts`. Replaces `FixtureRpcs` and the e2e half of `TestControlRpcs`.                                                    |
| `/api/dev`                | Its one path, on the Backend (`/api/dev` and `/api/dev/`, as Effect's RPC client posts with a trailing slash) and on the Website (forwarder `src/web/routes/api.dev.ts`, replacing `api.dev.fixture.ts`). |
| `DEV_ENDPOINT`            | Its one binding (value `"on"`, never a numeric-looking value: workerd reads those as numbers). Replaces `FIXTURE_ENDPOINT`. Bound by `wireBackend` on `dev`, `test`, `e2e`; never `staging`.              |
| `IntegRpcs`               | The integ-only group, in `test/integ/rpcs.ts` (contract and handlers together; nothing in `src/` imports it).                                                                                             |
| `TestBackend`             | The test Worker's class and logical id, in `test/integ/backend.ts`. A distinct id keeps its bundle and logs apart from the dev server's `Backend`.                                                        |
| `SHOPIFY_API_SECRET_FAKE` | The fixed fake API secret, beside `SHOPIFY_API_KEY` in `src/backend/shopify.ts`.                                                                                                                          |

## 4. Steps

### Step 1: The shared Backend wiring

- New module `src/backend/backend.ts`: `backendProps` (everything in `Backend`'s props except `main`) and `makeBackend()` (the current `Effect.gen(...).pipe(...)` body of `Backend`, unchanged). Move the helpers it uses with it (`ActorPath`, `refuseUpgrade`, `forwardedUpgrade`, …), so neither entry imports the other's class.
- `src/backend/worker.ts` keeps only `export default class Backend extends Cloudflare.Worker<Backend>()("Backend", { ...backendProps, main: import.meta.filename }, makeBackend()) {}` and its JSDoc. Each entry must set its own `main`.
- `wireBackend`'s first parameter becomes `Pick<Effect.Success<typeof Backend>, "bind" | "url">`.
- No behaviour change. Verify: all suites green; the dev server still serves.

### Step 2: The test Backend

- `test/integ/backend.ts`: `TestBackend`, built as S4 showed: `const base = yield* makeBackend()`, then `return { ...base, fetch }`, where `fetch` serves the integ-only paths first and otherwise `yield* base.fetch`. `{ ...base, fetch }` keeps the `BackendApi` methods.
- `test/integ/stack.ts` deploys `TestBackend` instead of `Backend`; nothing else changes yet.
- Verify: integ green; `vp build` (or the dev server's rebuild) leaves `.alchemy/bundles/Backend/` without any string unique to `test/integ/backend.ts`.

### Step 3: A stage per integ file

- `src/backend/stage.ts`: a second codec, `TestFileStage`, `test-<user>[-wt-NN]-<suffix>` with `suffix` matching `^[a-z][a-z0-9]*$` (so it cannot be read as `wt-NN`). `environmentOf` accepts it as `test`. Leave `PerDeveloperStage` as it is. Add rows to `test/unit/backend/stage.test.ts` for the new shape, including a suffix that must be refused (`wt`, a leading digit).
- `test/integ/file-stage.ts` (or a function beside the codec): `fileStage(name)` = `${ALCHEMY_TEST_STAGE}-${name}`. Every integ file passes `Test.make({ providers, stage: fileStage("<name>") })`. Say on `fileStage`'s JSDoc that a file without it shares the default stage and collides with another file.
- `vite.config.ts` integ project: `fileParallelism: true`; keep `pool: "forks"`, `sequence.hooks: "list"`; update its comment.
- Verify: integ green twice in a row; record serial and parallel wall-clock in §5.

### Step 4: `DevRpcs`

- `src/contract/dev.ts`: `DevRpcs`, an `RpcGroup` of:
  - `LoadFixture` (moved from `FixtureRpcs`, unchanged).
  - `AddToFixture`: `{ shop, fixture: ShopFixtureData }`, answers `FixtureCounts` of what it added; errors `ShopNotInstalled` and a new `FixtureConflict { shop, reason }` when a member email or team or workflow name already exists in the shop. Adds only, revokes nothing. Its JSDoc states the parallel e2e rule once: e2e setup loads the fixture once; a spec adds its own data under names derived from its test id and asserts only on that data; no spec replaces the fixture or asserts on all rows.
  - `RemoveMember`: moved from test control, unchanged (remove, then revoke the member's sockets; answers `{ removed, closed }`).
  - `GetShopSession`, `PingAdmin`: moved from test control, unchanged (with `ShopSessionView`, `PingAdminAnswer`).
  - `ExpireShopSession`: `ExpireAccessToken` renamed, otherwise unchanged.
  - Group JSDoc: the Backend serves it only with `DEV_ENDPOINT`, which the stack binds on `dev`, `test` and `e2e`; anything named `Dev*` or under `/api/dev` is dev and test machinery.
  - `ShopFixtureData`, `FixtureCounts`, `ShopNotInstalled` stay in `src/contract/fixture.ts`; `FixtureRpcs` goes.
- `AddToFixture`'s write path: `Members` gains an additive counterpart of `replaceShop` (insert members, teams and team members in one batch, failing `FixtureConflict` on a clash); `ShopActor` gains `addFixture(rows)`, the insert half of `loadFixture` without its delete, in one transaction; `Fixtures.add(shop, data)` composes them like `Fixtures.load`. Payload references must resolve within the payload (`ShopFixtureData`'s own check).
- `src/backend/dev.ts`: `DevHandlers` (from `FixtureHandlers` plus the moved test-control handlers). `backend.ts` mounts it on `/api/dev` when `DEV_ENDPOINT` is bound; 404 otherwise.
- `wireBackend`: `DEV_ENDPOINT` replaces `FIXTURE_ENDPOINT` (same exhaustive `Match`).
- Website: `src/web/routes/api.dev.ts` forwards `POST` after `rejectRequest`; delete `api.dev.fixture.ts`.
- `scripts/lib/fixture.ts`: point at `/api/dev`. Split the D1 half into its own module, `scripts/lib/load-fixture.ts`: `loadFixtureWhenInstalled(url, shop, data, wait)`, the `RpcClient` plus the retry on `ShopNotInstalled`, importing neither the dev `fixture.ts` nor `stores.ts`. `applyFixture` calls it.
- Tests: move the test-control unit cases for the moved procedures into `test/unit/backend/dev.test.ts`; add `AddToFixture` unit cases (adds beside existing rows; conflict on an existing email; not installed); `test/integ/fixture.test.ts` covers `AddToFixture` against D1 and the actor. Test control still exists in this step and its e2e users are untouched.

### Step 5: integ off test control

- `test/integ/rpcs.ts`: `IntegRpcs` with `IssueMagicLink`, `ScriptShopify`, `ShopifyCalls` (moved from test control, unchanged), plus their handlers.
- `test/integ/backend.ts` serves `IntegRpcs` on `/api/integ` and the forged-caller upgrade route on `/api/integ/actor/<key>` (moved from the Backend; no token, the caller still in `x-test-caller`).
- The fake Shopify HTTP moves into the test entry: `ShopifyFake` and its layer move to `test/integ/`; the test entry installs the fake with `setAbstractFetchFunc` unconditionally. Remove `ShopifyFake` from the shared wiring and the `SHOPIFY_FAKE_HTTP` bind from `wireBackend`. The S4 caveat: the shared wiring must not install anything that the test entry's later install depends on; order is test entry last.
- Q9: `wireBackend` binds `SHOPIFY_API_SECRET_FAKE` where it bound `Alchemy.makeRandom("ShopifyApiSecret")`; delete the random. A test helper, `test/shopify-session-token.ts`, signs session tokens with the constant (the body of today's `Shopify.signSessionToken`). Unit tests and `test/integ/shop-actor.test.ts` switch to it.
- Every integ file switches its clients: `DevRpcs` at `${backendUrl}/api/dev`, `IntegRpcs` at `${backendUrl}/api/integ`; `actor-clients.ts` loses the token. `test/integ/stack.ts` returns no token.
- Verify: integ green; test control is now used by e2e only.

### Step 6: e2e on the real store

- Seed: `seed/e2e.sql` holds only the admin (`a@a.com`); `seedFileFor` maps `e2e` to it, `test` keeps `test.sql`. Update `test/seed-shops.ts`'s JSDoc (integ only).
- `test/e2e/shop-fixture.ts`: the e2e fixture, a small `ShopFixtureData` (members `m1@m.com`, `m2@m.com`; team `ops` with `m1@m.com`), and the e2e shop key from `SHOPIFY_E2E_STORE`.
- Setup chain in `playwright.config.ts` (S1–S3):
  - `install` project: `test/e2e/install.setup.ts`, depends on `shopify-admin`, with the embedded browser settings (`channel: "chrome"`, the export's `storageState`, the embedded `baseURL`, its action and navigation timeouts); `setup.setTimeout(60_000)`. One test: `gotoApp`, then `loadFixtureWhenInstalled` against the e2e server's localhost `/api/dev` with the e2e fixture. One test, so setup's parallelism cannot split install from load.
  - `setup` (sign-in) depends on `install`; `embedded` depends on `install` (not `shopify-admin`).
- Sign-in through the real form (Q10): `auth.setup.ts` fills `/sign-in`, follows the inline link the page shows, saves storage state per role; `ownMember` adds its address with `AddToFixture` and signs in the same way; the `signIn` fixture in `fixtures.ts` does the same on a page. No e2e code calls `IssueMagicLink`.
- `fixtures.ts`: the `backend` client talks to `DevRpcs` at `${e2eServerURL}/api/dev`, no header. Remove `merchant()`.
- Specs:
  - `shop.spec`, `actor-upgrade.spec`, `shell.spec`, `members.spec` use the e2e shop key, never `SEED_SHOP`.
  - `members.spec` asserts the e2e fixture's rows on the one store; its "added member" case uses `AddToFixture` with a test-id address.
  - `shell.spec` asserts the member's one shop and opens it (Q16).
  - `actor-upgrade.spec`'s not-a-member case visits a shop key with no rows (Q6).
  - `shop.spec`'s merchant cases ("the merchant resets the count", "a merchant whose Shopify session expired") move to integ (`test/integ/shop-actor.test.ts`, tokens from the test helper), until the App Home renders the shop page (Q5).
  - `embedded/app.spec` and `embedded/refresh.spec` call `GetShopSession`, `ExpireShopSession`, `PingAdmin` through `DevRpcs`.
- Q16's several-shops case: confirm `test/unit/backend/api.test.ts` covers a member of two shops (add the case if not). Extract `MemberHome`'s list from `src/web/routes/shop.index.tsx` into a component under `src/web/components/` and give it a browser test with two shops. (integ cannot call `BackendApi`: its methods cross the service binding, not HTTP.)
- Verify: `vp run test:e2e` green twice; once with `E2E_REUSE_SERVER=1` on a reused server. Record in §5 how long the chromium project takes and whether it ran in parallel.

### Step 7: Delete test control and the forged merchant

- Delete `src/contract/test-control.ts`, `src/backend/test-control.ts`, `src/web/routes/api.test-control.ts`, `src/web/routes/merchant.$key.tsx`, `test/unit/backend/test-control.test.ts`, `IssueMerchantSessionToken` and `Shopify.signSessionToken`.
- `E2E_TOKEN` goes from `alchemy.run.ts`, `wireBackend`, `playwright.config.ts` (`e2eToken`, `webServer.env`), `test/integ/stack.ts` and `backend.ts`. Magic-link delivery is inline under `alchemy dev` only (`alchemy.run.ts`); the integ stack keeps `"inline"` explicitly.
- Q12: remove `PLAYWRIGHT_TEST_BASE_URL` and the branches it guards in `playwright.config.ts`; drop `sign-in.spec`'s `@dev-only` tag.
- The stale "in dev and e2e" JSDoc on `Shopify` goes with `signSessionToken`; re-read every JSDoc that named test control, the token or the merchant route (`grep -rn "test control\|TestControl\|E2E_TOKEN\|merchant/\$key" src test scripts`).
- Docs: `docs/worktrees-runbook.md` (the `E2E_TOKEN` lines), `README.md`, any runbook naming the token or test control.
- Verify: all suites green; `grep -rn "E2E_TOKEN\|TestControl\|test-control\|signSessionToken\|IssueMerchantSessionToken" src test scripts alchemy.run.ts playwright.config.ts vite.config.ts` finds nothing.

### Step 8: The Website's own checks (Q8)

- Unit-test `rejectRequest` (`src/web/server/rpc-proxy.ts`): accepted, 415, 413, 400.
- Move the actor route's `Origin` check out of the `/api/actor/$key` handler into a function beside it; unit-test it (no `Origin`, same origin, another origin).

## 5. Verification checklist

- [ ] `vp check` clean.
- [ ] `vp test` green (unit, browser, integ), integ twice, in parallel.
- [ ] `vp run test:e2e` green twice; once with `E2E_REUSE_SERVER=1`.
- [ ] The production Backend bundle contains no string unique to `test/integ/`.
- [ ] Step 7's grep finds nothing.
- [ ] `vp run fixture` and `vp run db:reset` still load the dev fixture (through `/api/dev`).
- [ ] No `.alchemy/local/baton-test-*` directories left from your runs; no e2e server you started still running.

## 6. Done when

Every box in §5 is ticked, §7 records every deviation and issue, and nothing is committed.

## 7. Deviations and issues

For the implementer. Append as you go. Keep each entry short, dated and tagged with its step. A deviation is anything built differently from the step that specified it. An issue is anything the plan did not predict: a failing assumption, an API that differs from the sketch, a flaky test, a limit hit. Do not rewrite the steps above; this section is the record.

### Plan review

### Deviations

### Issues

### Command results

### Implementation review

## 8. Out of scope

- The `.alchemy/local/…-ShopActor` leak after an integ destroy (exists on `main`).
- Shopify products and orders in the e2e store (Q11), and order sync, which retires `PingAdmin`.
- Merchant specs in the embedded project: they wait for the App Home to render the shop page.
- Smoke tests against staging.
