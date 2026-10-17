# Plan: dev endpoints, a test Backend, and e2e on the live system

Implements `docs/testing-research.md` (settled, Q1–Q19). Read its §1 and §2 first; this plan does not restate the reasons.

## 0. Rules for the implementer

- Follow `AGENTS.md`: Vite+ only (`vp`, never npm or npx); `vp check --fix` after every step; Effect Schema for parsing; `Match` for tag dispatch; `Schema.TaggedError`; `Effect.fn("name")`; JSDoc rules (no `//` above a declaration, no references to this plan or the research in code).
- Do not commit unless told to. Work on `main` in the main checkout.
- Each step ends green: `vp check`, `vp test` (unit, browser, integ), and `vp run test:e2e` at the end of Step 1, Step 5 and every step from Step 6 on. A step that cannot end green is recorded in §7 before moving on.
- A step that adds or deletes a route under `src/web/routes/` regenerates `src/web/routeTree.gen.ts` (`vp build`) before `vp check`.
- Never run `vp run db:reset` or restart the dev server: both act on the `dev` stage.
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
- Split `makeBackend()` in two exports: the `Effect.gen` body, and `provideBackend(effect)`, the `.pipe(Effect.provide(...))` chain; `makeBackend()` is `provideBackend(body)`. The test entry (Step 5) runs its own handlers inside the same `provideBackend`, so they get the very service instances the body has. Two builds would not do: `IssueMagicLink` takes the link from the `MagicLinkDelivery` that Better Auth wrote it into, and `ScriptShopify` must script the fake the library calls.
- `src/backend/worker.ts` keeps only `export default class Backend extends Cloudflare.Worker<Backend>()("Backend", { ...backendProps, main: import.meta.filename }, makeBackend()) {}` and its JSDoc. Each entry must set its own `main`.
- `wireBackend`'s first parameter becomes `Pick<Effect.Success<typeof Backend>, "bind" | "url">`.
- No behaviour change. Verify: all suites green; the dev server still serves.

### Step 2: The test Backend

- `test/integ/backend.ts`: `TestBackend`, built as S4 showed: `const base = yield* makeBackend()`, then `return { ...base, fetch }`, where `fetch` serves the integ-only paths first and otherwise `yield* base.fetch`. `{ ...base, fetch }` keeps the `BackendApi` methods.
- `test/integ/stack.ts` deploys `TestBackend` instead of `Backend`; nothing else changes yet.
- Verify: integ green, and integ now bundles into `.alchemy/bundles/TestBackend/`. `.alchemy/bundles/Backend/` is the production bundle; the dev server's rebuild or an e2e run writes it (`vp build` builds the Website only). Once it is rebuilt after this step, it has no string unique to `test/integ/backend.ts`.

### Step 3: A stage per integ file

- `src/backend/stage.ts`: a second codec, `TestFileStage`, `test-<user>[-wt-NN]-<suffix>` with `suffix` matching `^[a-z][a-z0-9]*$` and not `wt` (so it cannot be read as `wt-NN`). `environmentOf` accepts it as `test`. Leave `PerDeveloperStage` as it is. Add rows to `test/unit/backend/stage.test.ts` for the new shape, including suffixes that must be refused (`wt`, a leading digit, a dash).
- `test/integ/file-stage.ts` (or a function beside the codec): `fileStage(name)` = `${ALCHEMY_TEST_STAGE}-${name}`. Every integ file passes `Test.make({ providers, stage: fileStage("<name>") })`, with a name that fits the suffix: the file's name without its dashes (`shopactor`, `socketfacts`, `shopifyrefresh`). Say on `fileStage`'s JSDoc that a file without it shares the default stage and collides with another file.
- `vite.config.ts` integ project: `fileParallelism: true`; keep `pool: "forks"`, `sequence.hooks: "list"`; update its comment.
- Verify: integ green twice in a row; record serial and parallel wall-clock in §7.

### Step 4: `DevRpcs`

- `src/contract/dev.ts`: `DevRpcs`, an `RpcGroup` of:
  - `LoadFixture` (moved from `FixtureRpcs`, unchanged).
  - `AddToFixture`: `{ shop, fixture: ShopFixtureData }`, answers `FixtureCounts` as `LoadFixture` does (the shop's rows after the write, read back, never echoed from the input); errors `ShopNotInstalled` and a new `FixtureConflict { shop, reason }` when a member email, team name, workflow name, workflow tag or order number already exists in the shop (each is unique in its table). Adds only, revokes nothing. Its JSDoc states the parallel e2e rule once: e2e setup loads the fixture once; a spec adds its own data under names derived from its test id and asserts only on that data; no spec replaces the fixture or asserts on all rows.
  - `RemoveMember`: from test control, unchanged (remove, then revoke the member's sockets; answers `{ removed, closed }`).
  - `GetShopSession`, `PingAdmin`: from test control, unchanged (with `ShopSessionView`, `PingAdminAnswer`, which move to `src/contract/dev.ts`; test control imports them from there).
  - `ExpireShopSession`: `ExpireAccessToken` renamed, otherwise unchanged.
  - "From test control" means copied in this step: e2e still calls test control's own procedures until Step 6, and Step 7 deletes them. Share the handler bodies rather than keeping two copies.
  - Group JSDoc: the Backend serves it only with `DEV_ENDPOINT`, which the stack binds on `dev`, `test` and `e2e`; anything named `Dev*` or under `/api/dev` is dev and test machinery.
  - `ShopFixtureData`, `FixtureCounts`, `ShopNotInstalled` stay in `src/contract/fixture.ts`; `FixtureRpcs` goes.
- `AddToFixture`'s write path: `Members` gains an additive counterpart of `replaceShop` (insert members, teams and team members in one batch, D1's only atomic unit; it counts the shop's rows last, as `replaceShop` does); `ShopActor` gains `addFixture(rows)`, the insert half of `loadFixture` without its delete, in one transaction that first reads for a clashing workflow name, tag or fixture order id and fails with nothing written; `ShopActors` and its `layerTest` gain the same method. `Fixtures.add(shop, data)` composes them like `Fixtures.load`: `ShopNotInstalled` check; a read of D1 for clashing emails and team names (`FixtureConflict` before anything is written); the actor's `addFixture`; then the D1 batch, whose unique indexes are the backstop for a race (a constraint failure there is a defect). As with `load`, each store is atomic on its own. Payload references must resolve within the payload (`ShopFixtureData`'s own check), so a spec adds a team only with its own members. Update `FixtureCounts`'s JSDoc to name both procedures.
- `src/backend/dev.ts`: `DevHandlers` (from `FixtureHandlers` plus the moved test-control handlers). `backend.ts` mounts it on `/api/dev` when `DEV_ENDPOINT` is bound; 404 otherwise.
- `wireBackend`: `DEV_ENDPOINT` replaces `FIXTURE_ENDPOINT` (same exhaustive `Match`).
- Website: `src/web/routes/api.dev.ts` forwards `POST` after `rejectRequest`; delete `api.dev.fixture.ts`.
- `scripts/lib/fixture.ts`: point at `/api/dev`. Split the D1 half into its own module, `scripts/lib/load-fixture.ts`: `loadFixtureWhenInstalled(url, shop, data, wait)`, the `RpcClient` plus the retry on `ShopNotInstalled`, importing neither the dev `fixture.ts` nor `stores.ts`. `applyFixture` calls it.
- Docs naming `/api/dev/fixture`, `FixtureRpcs` or `FIXTURE_ENDPOINT`: `docs/glossary.md`, `docs/shopify-stores-runbook.md`.
- Tests: copy the test-control unit cases for the copied procedures into `test/unit/backend/dev.test.ts`; add `AddToFixture` unit cases (adds beside existing rows; conflict on an existing email; not installed); `test/integ/fixture.test.ts` covers `AddToFixture` against D1 and the actor (including a clash on a workflow name, which writes nothing). Test control still exists in this step and its e2e users are untouched.

### Step 5: integ off test control

- `test/integ/rpcs.ts`: `IntegRpcs` with `IssueMagicLink`, `ScriptShopify`, `ShopifyCalls` (from test control, unchanged), plus their handlers, and the `ShopifyFakeReply` and `ShopifyFakeCall` schemas. `ScriptShopify` and `ShopifyCalls` leave test control now (only integ calls them, and test control can no longer reach the fake). `IssueMagicLink` stays in test control too until Step 7, because e2e signs in with it until Step 6.
- `test/integ/backend.ts` serves `IntegRpcs` on `/api/integ` and the forged-caller upgrade route on `/api/integ/actor/<key>` (moved from the Backend; no token, the caller still in `x-test-caller`). It does so inside `provideBackend` (Step 1), adding `ShopifyFake`'s layer there, so its handlers share the body's services. Remove `TestActorPath`, `testControlCaller` and the upgrade route from the Backend.
- The fake Shopify HTTP moves into the test entry: `ShopifyFake` and its layer move to `test/integ/`; the test entry installs the fake with `setAbstractFetchFunc` unconditionally, with no `SHOPIFY_FAKE_HTTP` check. Remove `ShopifyFake` from the shared wiring and the `SHOPIFY_FAKE_HTTP` bind from `wireBackend`. `test/unit/backend/shopify-fake.test.ts` follows the module (record its new path in §7). The S4 caveat: the shared wiring must not install anything that the test entry's later install depends on; order is test entry last.
- Q9: `wireBackend` binds `SHOPIFY_API_SECRET_FAKE` where it bound `Alchemy.makeRandom("ShopifyApiSecret")`; delete the random. A test helper, `test/shopify-session-token.ts`, signs session tokens (the body of today's `Shopify.signSessionToken`), with the key and secret as optional inputs defaulting to `SHOPIFY_API_KEY` and `SHOPIFY_API_SECRET_FAKE`: unit tests sign with another secret or key to prove a refusal. `TEST_SHOPIFY_APP` in `test/unit/backend/layers.ts` uses the two constants. Unit tests and `test/integ/shop-actor.test.ts` switch to it.
- Every integ file switches its clients: `DevRpcs` at `${backendUrl}/api/dev`, `IntegRpcs` at `${backendUrl}/api/integ`; `actor-clients.ts` loses the token. `test/integ/stack.ts` returns no token and passes none.
- Verify: integ green; e2e green; test control is now used by e2e only.

### Step 6: e2e on the real store

- Seed: `seed/e2e.sql` holds only the admin (`a@a.com`); `seedFileFor` maps `e2e` to it, `test` keeps `test.sql`. Update the header comment of `seed/test.sql` and `test/seed-shops.ts`'s JSDoc (integ only).
- `test/e2e/shop-fixture.ts`: the e2e fixture, a small `ShopFixtureData` (members `m1@m.com`, `m2@m.com`; team `ops` with `m1@m.com`), the e2e shop key from `SHOPIFY_E2E_STORE` (the embedded specs' own copies go), and `E2eEmail`, moved from test control's contract. A spec's address derives from `test.info().testId` and `test.info().retry`, so a retry or a reused server's earlier add never clashes; `ownMember` lets a `FixtureConflict` fail the test instead of ignoring it.
- Setup chain in `playwright.config.ts` (S1–S3):
  - `install` project: `test/e2e/install.setup.ts`, depends on `shopify-admin`, with the embedded browser settings (`channel: "chrome"`, the export's `storageState`, the embedded `baseURL`, its action and navigation timeouts); `setup.setTimeout(60_000)`. One test: `gotoApp`, then `loadFixtureWhenInstalled` against the e2e server's localhost `/api/dev` with the e2e fixture, waiting at most 30 s, inside the test's timeout. One test, so setup's parallelism cannot split install from load.
  - `setup` (sign-in) depends on `install`; `embedded` depends on `install` (not `shopify-admin`).
- Sign-in through the real form (Q10): `auth.setup.ts` fills `/sign-in`, follows the inline link the page shows, saves storage state per role; `ownMember` adds its address with `AddToFixture` and signs in the same way; `shell.spec`'s own admin sign-in does the same on its page. The `signIn` fixture signed in on the `request` context, which a form cannot reach: `http.spec` instead uses the member's storage state (`test.use({ storageState })`, which the `request` fixture honours), and the fixture goes. No e2e code calls `IssueMagicLink`.
- `fixtures.ts`: the `backend` client talks to `DevRpcs` at `${e2eServerURL}/api/dev`, no header. Remove `merchant()`.
- Specs:
  - `shop.spec`, `actor-upgrade.spec`, `shell.spec`, `members.spec` use the e2e shop key, never `SEED_SHOP`.
  - `members.spec` asserts the e2e fixture's rows on the one store, each row present, never the row count (parallel specs add members); its "added member" case uses `AddToFixture` with a test-id address.
  - `shell.spec` asserts the member's one shop and opens it (Q16).
  - `actor-upgrade.spec`'s not-a-member case visits a shop key with no rows (Q6).
  - `shop.spec`'s merchant cases ("the merchant resets the count", "a merchant whose Shopify session expired") leave e2e for integ (`test/integ/shop-actor.test.ts`, tokens from the test helper), until the App Home renders the shop page (Q5). The reset is already covered there ("roles: a merchant resets…"). Add the expired case to "the gate" test: a token signed with a past expiry closes with 4401. The Website's `Expired` page (`src/web/server/shop.ts`) then has no test until the App Home renders the shop page; record that in §7.
  - `embedded/app.spec` and `embedded/refresh.spec` call `GetShopSession`, `ExpireShopSession`, `PingAdmin` through `DevRpcs`.
- Q16's several-shops case: confirm `test/unit/backend/api.test.ts` covers a member of two shops (add the case if not). Extract `MemberHome`'s list from `src/web/routes/shop.index.tsx` into a component under `src/web/components/` and give it a browser test with two shops. (integ cannot call `BackendApi`: its methods cross the service binding, not HTTP.)
- Verify: `vp run test:e2e` green twice; once with `E2E_REUSE_SERVER=1` on a reused server. Record in §7 how long the chromium project takes and whether it ran in parallel.

### Step 7: Delete test control and the forged merchant

- Delete `src/contract/test-control.ts`, `src/backend/test-control.ts`, `src/web/routes/api.test-control.ts`, `src/web/routes/merchant.$key.tsx`, `test/unit/backend/test-control.test.ts`, `IssueMerchantSessionToken` and `Shopify.signSessionToken`.
- `E2E_TOKEN` goes from `alchemy.run.ts`, `wireBackend`, `playwright.config.ts` (`e2eToken`, `webServer.env`), `test/integ/stack.ts` and `backend.ts`. Magic-link delivery is inline under `alchemy dev` only (`alchemy.run.ts`); the integ stack keeps `"inline"` explicitly.
- Q12: remove `PLAYWRIGHT_TEST_BASE_URL` and the branches it guards in `playwright.config.ts`; drop `sign-in.spec`'s `@dev-only` tag.
- The stale "in dev and e2e" JSDoc on `Shopify` goes with `signSessionToken`; re-read every JSDoc that named test control, the token or the merchant route (`grep -rn "test control\|TestControl\|E2E_TOKEN\|merchant/\$key" src test scripts`).
- Docs: `docs/worktrees-runbook.md` (the `E2E_TOKEN` lines), `docs/glossary.md` (the Backend, Group and Merchant rows), any runbook naming the token or test control (`README.md` names neither today).
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
- [ ] `vp run fixture` still loads the dev fixture (through `/api/dev`), against a dev server running the new code. `db:reset` calls the same `applyFixture`, so it is not run (it resets the `dev` stage). If the running dev server predates the change and answers 404, record it in §7 and leave the check to the reviewer; do not restart it.
- [ ] No `.alchemy/local/baton-test-*` directories left from your runs; no e2e server you started still running.

## 6. Done when

Every box in §5 is ticked, §7 records every deviation and issue, and nothing is committed.

## 7. Deviations and issues

For the implementer. Append as you go. Keep each entry short, dated and tagged with its step. A deviation is anything built differently from the step that specified it. An issue is anything the plan did not predict: a failing assumption, an API that differs from the sketch, a flaky test, a limit hit. Do not rewrite the steps above; this section is the record.

### Plan review

2026-10-16, against e3355e1. Changes to the steps above:

- §0: e2e also at the end of Steps 1 and 5, which change the Backend that e2e runs; regenerate `routeTree.gen.ts` after a route change; never `db:reset` or restart the dev server.
- Step 1: `makeBackend` split into the body and `provideBackend`, so the test entry's handlers share the body's service instances (`MagicLinkDelivery`'s inline links, the fake's queues).
- Step 2: the bundle check names where each bundle comes from; `vp build` does not build the Backend.
- Step 3: the suffix rule refuses `wt` explicitly (the pattern alone admits it); file names lose their dashes to fit it.
- Step 4: `AddToFixture` answers counts as `LoadFixture` does (`FixtureCounts` is never an echo); conflicts also on workflow tags and order numbers (unique in their tables); the write order and atomicity spelled out (D1 has no transaction; a pre-read, the actor's transaction, then the batch). "Moved" procedures are copies until Step 7, since e2e uses test control until Step 6. `ShopSessionView` and `PingAdminAnswer` move to the dev contract. Docs that name the old path added.
- Step 5: `ScriptShopify` and `ShopifyCalls` leave test control here, or `TestControlHandlers` cannot build without `ShopifyFake`; `IssueMagicLink` stays there until Step 7. The fake's schemas move with `IntegRpcs`; its unit test follows it. The token helper takes key and secret, because unit tests sign with wrong ones on purpose.
- Step 6: `http.spec` signed in on the `request` context, which the real form cannot reach: it uses the member's storage state instead. `E2eEmail` moves to `test/e2e/`. Test-id addresses include the retry. `members.spec` asserts presence, never counts. The install's fixture wait fits its 60 s timeout. The expired-merchant case lands as a gate case in integ; the Website's `Expired` page is left untested.
- Step 7: `docs/glossary.md` added; `README.md` names neither the token nor test control.
- §5: `db:reset` is not run (it resets `dev`); `vp run fixture` covers the shared path.

### Deviations

- 2026-10-16, Step 2: `TestBackend` is built as `provideBackend(Effect.gen(... yield* backendBody ...))` from the start, not `yield* makeBackend()`: the same thing, in the shape Step 5 needs for its handlers to share the body's services.
- 2026-10-16, Step 3: `fileStage` lives in `test/integ/file-stage.ts` and validates the whole name with `TestFileStage` (a bad name or a missing `ALCHEMY_TEST_STAGE` fails at import). `environmentOf` decodes `TestFileStage` with `decodeUnknownOption`, not `Schema.is`: the codec's `Type` is the parts struct, so `is` would test a string against it.
- 2026-10-16, Step 4: `FixtureConflict` lives in `src/contract/fixture.ts` beside `ShopNotInstalled` (the step named no home). The shared handler bodies are `devProcedures` in `src/backend/dev.ts`; `TestControlHandlers` serves `RemoveMember`, `GetShopSession`, `ExpireAccessToken` and `PingAdmin` from it. `ShopActor.addFixture` answers `{ _tag: "Added", counts } | { _tag: "Conflict", reason }` rather than failing (its stub methods are schemaless); `ShopActors.addFixture` turns `Conflict` into `FixtureConflict` with `Match`. The D1 pre-read is `Members.identityNames(shop)` (the shop's emails and team names, compared in memory, so no `IN` list nears D1's 100-parameter limit); the additive batch is `Members.addToShop`. `Members.layerTest` now keeps team names per shop, so its counts are read back as the real ones are. `ShopActors.layerTest` takes a fourth array, `added`. `loadFixtureWhenInstalled` takes `wait: Duration` (zero: no retry) and carries the "wait … not installed yet" line. The binding's logical id is `Dev` (was `Fixture`).
- 2026-10-16, Step 5: integ's `AddMember` calls became `AddToFixture` with one member (`addToFixture` in `actor-clients.ts`, beside the `dev` and `integ` clients). `socket-facts`' hibernation case needed the added member's id for a forged caller, which `AddToFixture` does not answer; it now signs the member in and opens the socket through the gate, comparing `MemberWhoAmI` before and after the hibernation (the expired-session case still uses the forged route). `IssueMagicLink`'s body is copied into `test/integ/rpcs.ts` rather than shared: `src/` cannot import `test/`, and test control's copy goes in Step 7. `ShopifyFake`'s `make` is now `Effect.sync` and installs on every build; the test entry provides its layer inside `provideBackend`, so it builds after the shared layers. `backend.ts` exports `forwardedUpgrade`, `isUpgrade` and `upgradeRequired` for the forged-caller route. `Shopify.signSessionToken` stays (test control's `IssueMerchantSessionToken` still uses it for e2e until Step 7). `SHOPIFY_API_SECRET_FAKE` is `"fake-api-secret"`, bound as `Redacted`. `test-control.test.ts` lost its "ScriptShopify and ShopifyCalls are defects" case, and the fake's "without the binding" case went with the binding. The fake's unit test is now `test/unit/integ/shopify-fake.test.ts`.
- 2026-10-16, Step 6: `E2E_SHOP`, `MEMBER` and `e2eFixture` live in `test/e2e/shop-fixture.ts` beside `E2eEmail`; the test-id address is `testEmail(name)` in `fixtures.ts` (`<name>-<testId>-<retry>@e2e.test`), which `ownMember` and `members.spec` use. The form sign-in is one helper, `signInWithForm` in `screens.ts` (fill `/sign-in`, click "Open link", wait for `/shop` or `/admin`), used by `auth.setup`, `ownMember`, `shell.spec` and `shop.spec`'s admin. `ownMember` opens its context with an empty `storageState` explicitly: `browser.newContext()` inherits the file's `test.use` state, and a signed-in member on `/sign-in` is not what the form test means. The `install` and `embedded` projects share `embeddedUse()` in `playwright.config.ts`. The two-shop browser test renders the extracted `MemberHomePage` in a TanStack memory router (`createMemoryHistory`), since its links navigate through `useRouter`; no browser test had a router before. `api.test.ts` had no two-shop case: `myShops` now runs on its own member rows (a member of `seed-shop` and `other-shop`), through a new `memberRows` option on its `TestBackend`, because adding the row to the shared list changed `listMembers`' answer.
- 2026-10-16, Step 7: the test helper's `signSessionToken` (Step 5, `test/shopify-session-token.ts`) is renamed `mintSessionToken`, or Step 7's grep finds the helper the plan keeps. `devProcedures` in `src/backend/dev.ts` is no longer exported and lost its JSDoc: it existed to share bodies with test control. `alchemy.run.ts` delivers inline exactly under `alchemy dev` (`ALCHEMY_DEV ? "inline" : "mailed"`); the integ stack still passes `"inline"`. Stale JSDoc also fixed outside the grep's words: `rejectRequest` ("test control, the fixture"), the `/api/dev` forwarder ("the fixture RPC", "mounts the fixture"), and `Shopify`'s note that no token verifies under the fakes (a test's now does). `docs/worktrees-runbook.md` also says every run now needs the admin login, and what a reused server keeps.
- 2026-10-16, Step 8: the `Origin` check is `isCrossSiteUpgrade(request)` in its own module, `src/web/server/actor-upgrade.ts`, not in the route file: the route imports `env.server.ts` (`cloudflare:workers`), which a Node unit test cannot load. Its rule moved to the function's JSDoc; the route links it. Tests: `test/unit/web/server/actor-upgrade.test.ts` (no `Origin`, same origin, three other origins) and `test/unit/web/server/rpc-proxy.test.ts` (accepted twice, 415 three ways, 413, 400 four ways).

### Issues

- 2026-10-16, Step 4: renaming `api.dev.fixture.ts` made the running dev server's Website log "Failed to load url /src/web/routes/api.dev.fixture.ts" until `vp build` regenerated `routeTree.gen.ts`; it recovered on its own. The dev server also re-planned on the `stack.ts` edit: its `/api/dev` answers `GetShopSession` (probed read-only), so the `Dev` binding is live there without a restart.
- 2026-10-16, Step 5: the running dev server re-plans on every `stack.ts` edit, so removing `Alchemy.makeRandom("ShopifyApiSecret")` deleted that record from the `dev` stage's state at once (`[ShopifyApiSecret] deleted` in `.logs/dev/current`); the dev server kept serving (it runs under the CLI, which binds the real secret). Not a restart and not `db:reset`, but it did change `dev` state.
- 2026-10-16, Step 6: the Website's `Expired` page (`src/web/server/shop.ts`) has no test now: the expired merchant is a gate case in integ (4401), and no e2e spec opens a merchant page until the App Home renders the shop page. The running dev server re-planned on the `seed.ts` edit (`[Seed] skipped`, `dev.sql` unchanged) and kept serving.
- 2026-10-16, Step 7: deleting the test-control modules made the running dev server's Backend log two "Bundle error … Build failed with 2 errors" while the imports still named them (20:32:13, 20:32:18); it rebuilt on the next edit (`[Backend] Updated`, `[Seed] skipped`) and kept serving (`/` 200). The `dev` stage never had a `TestControl` binding, so nothing was deleted from its state.
- 2026-10-16, Steps 6–8: `.alchemy/bundles/Backend/` keeps every past build's chunks (786 files), so a plain `grep -r` there finds test control and the fake in stale chunks. The bundle check below walks the import graph from `worker.js` instead. `.alchemy/bundles/TestBackend/` has no `worker.js` after a destroy; its newest entry chunk served as the positive control.

### Command results

- 2026-10-16, Step 1: `vp check` clean. `vp test` 27 files, 238 tests passed (65 s). `vp run test:e2e` 29 passed (1.3 m). The dev server rebuilt the Backend from the new entry (`[Backend] Updated` in `.logs/dev/current`) and still serves: `/` 200, `POST /api/dev/fixture` 415 (reached `rejectRequest`).
- 2026-10-16, Step 2: `vp check` clean. `vp test --project integ` 5 files, 20 tests passed (52.5 s); the bundle is now `.alchemy/bundles/TestBackend/`. `.alchemy/bundles/Backend/`, last rebuilt by the dev server after Step 1 (no production change since), has no `TestBackend` string in any file newer than `src/backend/worker.ts`; the TestBackend bundle's entry does. `vp test --project unit --project browser` 22 files, 218 tests passed.
- 2026-10-16, Step 3: `vp check` clean. integ serial (`--no-file-parallelism`): 5 files, 20 tests passed, 56.0 s (57.4 s wall). integ parallel, twice in a row: 5 files, 20 tests passed each, 22.3 s (24.2 s wall) and 21.2 s (22.7 s wall). `vp test --project unit --project browser` 22 files, 234 tests passed (16 new stage rows).
- 2026-10-16, Step 4: `vp build` (route renamed) then `vp check` clean. `vp test` 28 files, 264 tests passed (25.6 s; integ in parallel, `fixture.test.ts` now with two `AddToFixture` cases). Dev server: `POST /api/dev/` `GetShopSession` answered `null` for an unknown shop.
- 2026-10-16, Step 5: `vp check` clean. `vp test` 28 files, 262 tests passed (25.4 s); integ alone 5 files, 22 tests (24.0 s, parallel). `vp run test:e2e` 29 passed (1.3 m). `.alchemy/bundles/Backend/`, rebuilt by that e2e run, has no file containing `TestBackend`, `x-test-caller`, `ScriptShopify`, `IntegRpcs`, `api/integ`, `ShopifyFake`, `SHOPIFY_FAKE_HTTP` or the fake's "unscripted request"; the TestBackend bundle's entries do. `grep` finds no `test-control` import or `e2eToken` under `test/integ/`: test control is used by e2e only.
- 2026-10-16, Steps 1–5 cleanup: `.alchemy/local` had `baton-backend-dev-mw-2oycnkw2dwssujvz`, `baton-backend-e2e-mw-{7s64s6ifzf4z4rec,mdsr6b4n2z4abqwo,mlhcm4ji4hxgwhnt}` (`-ShopActor`) before; the 36 `baton-test-…-ShopActor` and 2 `baton-backend-e2e-…-ShopActor` directories these runs added are deleted, leaving the starting list. No e2e server left running.
- 2026-10-16, Step 6: `vp check` clean. `vp test` 29 files, 264 tests passed (23.8 s; the gate test now has the expired-token case; `MemberHomePage.test.tsx` 2 cases). `vp run test:e2e` 28 passed twice (1.5 m, then 1.1 m); no spec calls test control. Second run's JSON timings: `install` 6.6 s; `setup` 1.1 s (2 tests); `chromium` 17 tests in 8.0 s wall (17.1 s summed) on all 6 workers, in parallel, beside `embedded` (7 tests, 18.5 s wall, 1 worker). With `vp run test:e2e:server` started by hand and `E2E_REUSE_SERVER=1`: 28 passed (53.4 s), then 28 passed again (37.2 s) on the same server (the second install reloads the fixture over the first run's additions); server then stopped with SIGTERM.
- 2026-10-16, Step 7: `vp build` (two routes deleted) then `vp check` clean. `vp test` 28 files, 254 tests passed (23.0 s). `vp run test:e2e` 28 passed (1.3 m), with no `E2E_TOKEN` in the server's environment. Step 7's grep finds nothing (exit 1).
- 2026-10-16, Step 8: `vp check` clean; `vp test --project unit test/unit/web/server` 3 files, 31 tests passed.
- 2026-10-16, §5 checklist (Steps 6–8 done): `vp check` clean. `vp test` 30 files, 269 tests passed (22.9 s); integ again alone, 5 files, 22 tests passed (20.3 s, parallel). `vp run test:e2e` 28 passed twice (1.1 m, 1.0 m). With a server started by `vp run test:e2e:server` and `E2E_REUSE_SERVER=1`: 28 passed (39.0 s); the server was then stopped. Production bundle: the current `Backend` build (`worker.js` and the 10 chunks it imports, transitively) has none of `TestBackend`, `x-test-caller`, `ScriptShopify`, `IntegRpcs`, `api/integ`, `ShopifyFake`, `SHOPIFY_FAKE_HTTP`, "unscripted request", `TestControl`, `test-control`, `E2E_TOKEN`, `IssueMerchantSessionToken`, `signSessionToken`, `IssueMagicLink`, `x-e2e-token`, and does have `api/dev`, `DEV_ENDPOINT`, `AddToFixture`; the newest `TestBackend` entry chunk has `TestBackend`, `x-test-caller`, `api/integ` and "unscripted request". Step 7's grep finds nothing. Then `devProcedures` was unexported (no behaviour change): `vp check` clean, `vp test` 269 passed, `vp run test:e2e` 28 passed (1.1 m). `vp run fixture` not run (left to the reviewer).
- 2026-10-16, Steps 6–8 cleanup: `.alchemy/local` had the same four `-ShopActor` directories as before Step 1 (`baton-backend-dev-mw-2oycnkw2dwssujvz`, `baton-backend-e2e-mw-{7s64s6ifzf4z4rec,mdsr6b4n2z4abqwo,mlhcm4ji4hxgwhnt}`); the 35 `baton-test-…-ShopActor` and 8 `baton-backend-e2e-…-ShopActor` directories these runs added are deleted, leaving that list. No e2e server left running; both dev servers untouched.

### Implementation review

2026-10-16, the uncommitted working tree on e3355e1. The diff matches the steps and the research; no decision was reopened.

Verification, run by the reviewer: `vp check` clean. `vp test` 30 files, 269 tests passed (22.7 s); integ again alone, 5 files, 22 tests (20.3 s, parallel). `vp run test:e2e` 28 passed twice (1.1 m, 1.2 m). A server started by `vp run test:e2e:server`, then `E2E_REUSE_SERVER=1 vp run test:e2e`: 28 passed (1.1 m); server stopped. The production `Backend` build (`worker.js`, 11 files by import) has no test-only string and has `api/dev`, `DEV_ENDPOINT`, `AddToFixture`. Step 7's grep, and a wider one (`test control`, `merchant/$key`, `FIXTURE_ENDPOINT`, `api/dev/fixture`, `FixtureRpcs`, `SHOPIFY_FAKE_HTTP`, `PLAYWRIGHT_TEST_BASE_URL`, `@dev-only`), find nothing. `vp run fixture` against the running dev server: store ok, shop ok (7 members, 8 teams, 8 workflows, 42 orders, 47 line items). The 13 `-ShopActor` directories these runs left are deleted; no e2e server is running.

Deviations: all accepted as built. Each fills a gap the step left open (where `FixtureConflict` lives, how the actor reports a clash across a schemaless stub, how `fileStage` validates) or follows from a corrected step (`provideBackend` from Step 2 on; `mintSessionToken`, so Step 7's grep stays meaningful; the `Origin` check in its own module, which a Node test can load). `socket-facts`' hibernation case now opens its socket through the gate rather than as a forged caller; it still proves what it is named for.

Issues:

- Step 4 and Step 7, the dev server's transient load and bundle errors: accepted; it recovered on its own each time.
- Step 5, `ShopifyApiSecret` deleted from `dev` state and the `Fixture` binding renamed `Dev` there: accepted. Any running dev server re-plans on a `stack.ts` edit, so the code change carries it; the CLI binds the real secret on `dev`, so nothing served changed.
- Step 6, the Website's `Expired` page: partly closed. Added a `ShopPage` browser case for an `Expired` loader answer (`test/browser/web/components/ShopPage.test.tsx`). What stays untested is the server function's branch that chooses `Expired` (`src/web/server/shop.ts`), until the App Home renders the shop page.
- Steps 6–8, stale chunks in `.alchemy/bundles/Backend/`: accepted; the bundle check walks the import graph from `worker.js`, as above.

Also fixed: two JSDoc paragraphs left with unwrapped long lines (`environmentOf` in `stage.ts`, `seedFileFor` in `seed.ts`).

## 8. Out of scope

- The `.alchemy/local/…-ShopActor` leak after an integ destroy (exists on `main`).
- Shopify products and orders in the e2e store (Q11), and order sync, which retires `PingAdmin`.
- Merchant specs in the embedded project: they wait for the App Home to render the shop page.
- Smoke tests against staging.
