# Plan: Shopify offline-token refresh and `ShopifyAdmin`

Plan date: 2026-10-16 · `@shopify/shopify-api` 15.0.1 · Base commit `6702c86`.

Research: [Shopify offline-token refresh research](./shopify-offline-refresh-research.md). Every question in its §10 is settled, and this plan implements those decisions. Read the research first, §1 to §6 in particular. §2 lists where Shopify's documented rules differ from legacy, §5 explains the lease, and §6 sets out the failure taxonomy.

## 0. Rules for the implementer

- **Follow `AGENTS.md`.**
  - Vite+ only (`vp`, never npm or npx).
  - Effect idioms: Effect Schema for every parse and check, `Match` for tag dispatch, `Schema.TaggedError`, `Effect.fn("name")`.
  - The comment rules: JSDoc on the symbol, a rule stated once, `{@link}` to symbols in scope, and no references to plans or research docs in code or comments.
  - Effect's idiom guide is in `refs/effect/ai-docs/src` and `refs/effect/LLMS.md`.
- **Read before you write.** Match the surrounding code: `src/backend/shopify.ts`, `src/backend/shop-sessions.ts` and `src/backend/test-control.ts` set the style. Legacy's implementation is `refs/baton-legacy/src/lib/Shopify.ts` (`refreshShopSession`, `recoverRefreshRace`, `refreshShopSessionIfExpired`, `ensureShopSession`), and its tests are `refs/baton-legacy/test/integration/shopify-offline-refresh.test.ts`.
- **Never edit anything under `refs/`.**
- **No commits and no pushes.** A push to `main` deploys staging.
- **Do not reset or deploy staging** (`vp run cloud:reset --stage staging …`). Local stages may be reset (`vp run db:reset`), and integ stages deploy fresh per file.
- **No Shopify-side changes:** no `shopify app deploy`, no store auth, no edits to `shopify.app*.toml`.
- **Never print a token.** No test-control procedure returns an access token or a refresh token, and no log line contains one.
- **Run `vp check --fix` after code changes.** Each step ends green (`vp check`, and the tests it names) before the next starts.
- **Record every difference.** Anything that differs from this plan, and any problem you could not solve, goes in §11 with the date and step. Do not silently change the design. If a step cannot work as written, stop that step, record why, and carry on with whatever does not depend on it.

## 1. Outcome

- `Shopify.ensureShopSession(shop)` returns a usable offline `Session`. It refreshes the access token through the `refresh_token` grant when the token is within 5 minutes of expiry, and at most one refresh per shop runs at a time (a D1 lease). Token writes are compare-and-swap. On a 401 it adopts a concurrent winner, and it fails with a typed error a caller can act on.
- A new `ShopifyAdmin` service: `graphql(shop, query, options)` and `graphqlDecode(shop, schema, query, options)`. Each call ensures the session, builds a client, and on an Admin 401 clears the token and retries once.
- `Shopify.authenticateAdmin` waits for an in-flight refresh before exchanging.
- Test control gains `ExpireAccessToken` and `PingAdmin`, and `GetShopSession` shows the refresh expiry and the lease.
- On the `test` environment, a fake Shopify HTTP layer, scripted through test control, lets integ drive refresh end to end.
- E2E on the real e2e store proves refresh, concurrency and the dead-token verdict against Shopify itself.

## 2. Decisions this plan implements

These are research §10, all taking the recommendation:

| Q   | Decision                                                                                                                                                                   |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Ship refresh, `ShopifyAdmin` and the test control now, with no product caller yet.                                                                                         |
| 2   | `ShopifyAdmin` takes a shop and ensures the session on every call. `ensureShopSession` stays public on `Shopify`.                                                          |
| 3   | Serialize with a D1 lease column plus a compare-and-swap `rotateTokens`.                                                                                                   |
| 4   | `authenticateAdmin` waits for a live lease (capped), reuses the result if it is active, and otherwise exchanges. Its upsert stays unconditional. It never takes the lease. |
| 5   | Errors are `OfflineSessionMissing`, `ReauthorizationRequired { reason }` and `ShopifyUnavailable`. Everything else is a defect.                                            |
| 6   | An Admin 401 conditionally clears the access token and retries once through `ensureShopSession`. A second 401 fails `ReauthorizationRequired`.                             |
| 7   | The `ShopifyHttp` fake on the `test` environment is installed with `setAbstractFetchFunc` and scripted through test control.                                               |
| 8   | Only a 401 on the grant counts as a rejection. 429, 5xx, network failures and non-JSON bodies are transient. Any other HTTP status is a defect, logged at Error.           |
| 9   | A dead verdict leaves the row as it is.                                                                                                                                    |
| 10  | The e2e refresh cases run on every e2e run, serially, ending with an embedded reload that restores a live session.                                                         |
| 11  | Legacy's timings, plus a 10 s lease (see §3).                                                                                                                              |

## 3. Constants

They live in `src/backend/shopify.ts`, each with a JSDoc giving its reason (see research §1.1, and legacy's JSDoc for the 60 s buffer):

| Name                                        | Value                                                                                                                                                                |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EMBEDDED_SESSION_REEXCHANGE_BUFFER_MS`     | 30 s (exists)                                                                                                                                                        |
| `BACKGROUND_ACCESS_TOKEN_REFRESH_BUFFER_MS` | 5 min                                                                                                                                                                |
| `REFRESH_TOKEN_EXPIRY_BUFFER_MS`            | 60 s                                                                                                                                                                 |
| `REFRESH_TOKEN_TRANSIENT_RETRIES`           | 3, `Schedule.exponential("500 millis").pipe(Schedule.jittered)`, run as `Effect.retry({ schedule, times: 3, while: isTransient })` (all three exist in Effect 4.0.1) |
| `REFRESH_LEASE_MS`                          | 10 s                                                                                                                                                                 |
| `REFRESH_POLL_INTERVAL`                     | `"300 millis"` jittered. Used both by a lease waiter and by race recovery.                                                                                           |
| `REJECTED_REFRESH_TOKEN_RECOVERY_RETRIES`   | 6 (~1.8 s)                                                                                                                                                           |

Restate legacy's transient-retry rationale in Shopify's current terms: the presented refresh token stays usable until its successor is used, so a retry with the same token is safe. Do **not** cite a "1-hour replay window" (research §2).

## 4. Step 1: the row

### 4.1 Schema

In `migrations/0001_init.sql`, add `refreshLeaseUntil integer` to `ShopSession`, after `refreshTokenExpiresAt`. Edit `0001_init` in place; never add a second migration. Add a short SQL comment, in the file's style: the lease serializes refresh-token grants for one shop, and it is not indexed.

The seed files (`seed/*.sql`) name their columns, so they need no change. Confirm this with `grep -n "INSERT" seed/*.sql`.

### 4.2 `ShopSessions` (`src/backend/shop-sessions.ts`)

- `ShopSessionRow` gains `refreshLeaseUntil: Schema.NullOr(Schema.Number)`. `ShopSessionUpsert` omits it, as it omits the plan columns, so neither an exchange nor `upsert` ever touches it. Update the `ShopSessionUpsert` JSDoc to match.
- **Replace `updateTokens` with `rotateTokens`.** It rewrites the four token columns and sets `refreshLeaseUntil = NULL`, `WHERE shop = ? AND refreshToken = ?` (the presented token), `RETURNING shop`. It answers `boolean`: whether it won. Rename `ShopSessionTokens` if the name no longer fits, and record that.
- **`clearAccessToken(shop, accessToken)`** clears the token only `WHERE shop = ? AND accessToken = ?`. It answers nothing. Its only caller is new (Step 3), and nothing calls it today: confirm with `grep -rn clearAccessToken src test`.
- **`acquireRefreshLease(shop, now, until)`** runs `UPDATE ShopSession SET refreshLeaseUntil = ? WHERE shop = ? AND (refreshLeaseUntil IS NULL OR refreshLeaseUntil <= ?) RETURNING shop`, and answers `boolean`.
- **`releaseRefreshLease(shop, until)`** sets `refreshLeaseUntil = NULL WHERE shop = ? AND refreshLeaseUntil = ?`. Matching on `until` means a holder never releases a lease someone took after its own lapsed.
- **`layerTest`** mirrors all four with the same conditions. Its `upsert` inserts a new row with `refreshLeaseUntil: null` and leaves an existing row's lease alone.
- **`RETURNING` works through `alchemy/SQL/D1`** (checked at review): `@effect/sql-d1` runs every statement with `.all()` and answers `results`, so `sql\`UPDATE … RETURNING shop\``yields the updated rows. "Won" is "one row came back"; decode the rows with Effect Schema, as`find` does.

**Tests (unit, new `test/unit/backend/shop-sessions.test.ts`)**, over `layerTest`:

- `rotateTokens` wins only with the matching token, and it clears the lease;
- a lost `rotateTokens` changes nothing;
- the lease is exclusive until it lapses, and is re-takeable after it lapses;
- `releaseRefreshLease` with a stale `until` is a no-op;
- `clearAccessToken` is conditional.

The real SQL is covered by integ in Step 6.

## 5. Step 2: `ensureShopSession` (`src/backend/shopify.ts`)

### 5.1 Errors

They are exported from `src/backend/shopify.ts`, Backend-only, as `Schema.TaggedError`:

```ts
OfflineSessionMissing   { shop: ShopKey }
ReauthorizationRequired { shop: ShopKey,
                          reason: Schema.Literals(["no-refresh-token","refresh-token-expired","refresh-token-rejected"]),
                          refreshTokenExpiresAt: Schema.NullOr(Schema.Number) }
ShopifyUnavailable      { shop: ShopKey, cause: Schema.Defect() }
```

`Schema.Literals` takes an array and `Schema.Defect` is a function in Effect 4 (checked at review). A lease wait that times out fails `ShopifyUnavailable` with a plain `Error` naming the timeout as its cause.

A module-private `RefreshTokenRejected { shop, refreshToken }` never escapes `ensureShopSession`. Do not put the refresh token into any log or any exported error.

Each error's JSDoc states how a caller reacts (research §6). For example, `ReauthorizationRequired`: only a merchant opening the app restores access; a webhook answers non-2xx; a Workflow step dies.

### 5.2 Classifying a grant failure

Write it with `Match` over the rejection (`unknown`):

- `HttpRetriableError` (429, 5xx) → transient;
- `HttpResponseError` with `response.code === 401` → rejected;
- any other `HttpResponseError` → defect (`Effect.die`), logged at Error with the code and the body's `error` field (never the request body);
- anything else (a network failure, a `SyntaxError` from a non-JSON body) → transient.

Check the order: `HttpRetriableError` extends `HttpResponseError`, so it must be matched first.

### 5.3 The flow

Decide from the row's epoch-ms columns against `Clock.currentTimeMillis`, **not** from `Session.isExpired`, which reads `Date.now()` (research §3). Write one row-level freshness check, `accessToken` non-null **and** `accessTokenExpiresAt` non-null **and** `accessTokenExpiresAt − buffer > now`, used here with the 5 min buffer and by `authenticateAdmin` with the 30 s buffer (Step 4). A row with a token but a null expiry is not fresh: every row here comes from an `expiring: true` exchange, so a null expiry is not "never expires".

```
ensureShopSession(shop):
  row ← shopSessions.find(shop)                       none → OfflineSessionMissing
  if row.accessToken && row.accessTokenExpiresAt - 5 min > now → session(row)
  if !row.refreshToken || row.refreshTokenExpiresAt == null
      → ReauthorizationRequired("no-refresh-token")
  if row.refreshTokenExpiresAt - 60 s <= now
      → ReauthorizationRequired("refresh-token-expired", refreshTokenExpiresAt)
  until ← now + 10 s
  if acquireRefreshLease(shop, now, until):
      refresh(shop, row.refreshToken) ensuring releaseRefreshLease(shop, until)
  else:
      waitForRefresh(shop, row.refreshToken)   // poll find() every 300 ms (jittered):
        // token differs and the row is fresh → return it
        // lease lapsed (refreshLeaseUntil null or <= now) → loop to ensureShopSession once more
        // give up after REFRESH_LEASE_MS + recovery budget → ShopifyUnavailable

refresh(shop, presented):
  { session } ← auth.refreshToken({ shop, refreshToken: presented })
                retry while transient, 3 times, exponential 500 ms jittered
                exhausted transient → ShopifyUnavailable
                401 → RefreshTokenRejected → recoverRefreshRace
  decode session → { accessToken, expires, refreshToken, refreshTokenExpires } all present
                   (Effect Schema; missing → defect, row untouched)
  won ← rotateTokens(presented, encoded tokens)
  won → session ; lost → adopt: find(shop) and return its session (fresh by construction)

recoverRefreshRace(shop, rejected):
  up to 6 × 300 ms jittered: find(shop)
    none → OfflineSessionMissing
    refreshToken ≠ rejected → return session(row)       // a winner: refresh or exchange
  then log Warning "status=dead" (shop only) → ReauthorizationRequired("refresh-token-rejected", null)
```

**Notes**

- Bound the "loop once more" after a lapsed lease to one retry, so it cannot spin. Record your choice.
- `storedSession` already builds a `Session` from a row. Reuse it, or factor out a row → `Session` function that both `storedSession` and `ensureShopSession` call.
- Log a refresh at Info with `shop=` only: `Shopify.ensureShopSession: refreshed shop=…`. Legacy's convention is the event plus `shop=`.
- `scope` is not rewritten by a refresh. `rotateTokens` writes only the token columns. Add a test that `scope` survives.

### 5.4 Tests

Unit, in a new `test/unit/backend/shopify-refresh.test.ts`.

**Harness**

- Use `testShopify(rows)` (`test/unit/backend/layers.ts`) and a scripted stub installed with `setAbstractFetchFunc` from `@shopify/shopify-api/runtime`. Model it on legacy's `stubRefreshGrant`: record each presented refresh token and reply per attempt. Always restore the original in `Effect.ensuring` or `afterEach`.
- Keep every fetch-stubbing test in this one file (the stub is module-global). The `unit` project sets no `isolate: false`, so Vitest gives each file its own module graph (checked at review); the stub cannot leak across files, only across tests in one file.
- **Clocks.** `it.effect`'s `TestClock` starts at epoch 0, but the library stamps a refreshed session's `expires` and `refreshTokenExpires` with real `Date.now()`. So:
  - the branches that never reach the stub (fresh token, no refresh token, refresh token expired, crossing `expiry − 60 s` with `TestClock.adjust`) run under `it.effect` with row times relative to `TestClock`;
  - every test that reaches the stub runs under `it.live`, with row times relative to `Date.now()`, as the existing Backend unit tests do. Between two sleeps the code awaits the stub's real promise, and a single `TestClock.adjust` can return before the next sleep is registered, which makes it flaky. The retry, recovery and lease waits are each under ~2 s live, inside the unit project's default 5 s timeout.
  - Do not add a test that waits out a full lease (≥ 10 s) live; a lapsed lease is a row whose `refreshLeaseUntil` is already in the past.

**Port these from legacy**, with names following this repo's tests:

- a fresh token is returned unchanged with no fetch;
- a refresh token already expired → `ReauthorizationRequired("refresh-token-expired")` with no fetch;
- crossing `expiry − 60 s` → the same;
- a successful grant rotates and persists the new pair, and keeps `shopGid` and `scope`;
- `401 invalid_request` → recovery: with a winner in the row it adopts it; with no winner it fails `ReauthorizationRequired("refresh-token-rejected", null)` after the budget, with exactly one grant call; with no row it fails `OfflineSessionMissing`;
- 429 then 200 retries with the same token;
- 503 then 200 retries;
- an exhausted 429 → `ShopifyUnavailable`, never a rejection.

**Inverted from legacy**

- `400 {"error":"invalid_subject_token"}` → defect.
- `403` → defect.

**Added**

- a non-JSON 502 body is transient;
- a response missing `refresh_token_expires_in` → defect, and the row is unchanged;
- a lost `rotateTokens` (another write changed `refreshToken` in between, done in the stub's reply) adopts the stored row;
- a row with `accessToken = null` and a valid refresh token refreshes;
- `refreshToken = null` → `ReauthorizationRequired("no-refresh-token")`;
- a held lease: a second caller waits and adopts the first caller's result, with **one** grant call in total (two fibers, the stub's reply gated on a `Deferred`);
- a lapsed lease is taken over;
- the lease is released after a failed grant.

## 6. Step 3: `ShopifyAdmin` (new `src/backend/shopify-admin.ts`)

- `class ShopifyAdmin extends Context.Service<…>()("app/ShopifyAdmin")` with `layer` depending on `Shopify` and `ShopSessions`.
- **Methods**
  - `graphql(shop, query, options?: { variables })` → `{ data: unknown }`. GraphQL `errors` are a defect, unless you find a typed failure is needed. Record which.
  - `graphqlDecode(shop, schema, query, options)` → `A`, where a decode failure is a defect.
  - The error channel is §5.1's three errors.
- **Each call:** `ensureShopSession(shop)` → `new api.clients.Graphql({ session })` → `request`. `Shopify` must expose what `ShopifyAdmin` needs to build a client (for example a `graphqlClient(session)`, or the cached `api`). Keep the library out of `ShopifyAdmin`'s public types.
- **What the library's GraphQL client throws** (15.0.1 `clients/admin/graphql/client.mjs` and `clients/common.mjs` `throwFailedRequest`, checked at review). `request` never returns an `errors` field; it throws:
  - GraphQL errors on a 200 → `GraphqlQueryError` (extends `ShopifyError`, not `HttpResponseError`) → defect;
  - 401 → `HttpResponseError` with `response.code === 401` → clear and retry (below);
  - 429 / 5xx → `HttpThrottlingError` / `HttpInternalError` (both `HttpRetriableError`) → `ShopifyUnavailable`;
  - a network failure (no response) → `HttpRequestError` → `ShopifyUnavailable`;
  - any other status → `HttpResponseError` → defect.
    `HttpMaxRetriesError` appears only when `retries > 0`. The client's `retries` defaults to 0 (`@shopify/graphql-client` `createGraphQLClient`); leave it at 0, since `ShopifyAdmin`'s caller owns retrying. The client reads `abstractFetch` when it is constructed, so a stub installed before the call is the one it uses. `new Graphql({ session })` throws `MissingRequiredArgument` without an access token; `ensureShopSession` always returns one. Match the classes in this order (`HttpRetriableError` before `HttpResponseError`).
- **On an `HttpResponseError` with code 401:** `clearAccessToken(shop, session.accessToken)`, then retry once from `ensureShopSession`, which now refreshes. A second 401 → `ReauthorizationRequired("refresh-token-rejected", null)`.
- **JSDoc** says why it takes a shop: a session is never held, so a rotated token can never be used (the research's Q2 rationale, without citing the doc).
- **Leave `fetchShopGid` in `Shopify`:** it runs on a just-exchanged session that is not stored yet.
- **Wire `ShopifyAdmin.layer`** into the Backend's layers in `src/backend/worker.ts`, and add it to the `services` context that test control receives (`Effect.context<… | ShopifyAdmin>()`); `TestControlHandlers` then yields it like the other services. `test/unit/backend/test-control.test.ts` builds the handlers itself, so it must provide `ShopifyAdmin` too.

**Tests (unit, `test/unit/backend/shopify-admin.test.ts`):**

- `graphqlDecode` decodes;
- GraphQL `errors` fail as specified;
- a 401 clears the token and retries once through a refresh (assert the call order: Admin 401 → grant → Admin 200);
- a second 401 fails `ReauthorizationRequired`.

The same fetch stub serves `/admin/api/*/graphql.json`. If keeping one file per stub is needed for isolation, merge this into Step 2's file and record that.

## 7. Step 4: `authenticateAdmin` waits on a live lease

In `authenticateAdmin`:

- replace `session.isActive(undefined, EMBEDDED_SESSION_REEXCHANGE_BUFFER_MS)` with Step 2's row-level freshness check against `Clock` (30 s buffer), so the freshness check and the lease read one clock. `isActive(undefined, …)` ignores scope, so nothing else changes; the existing `authenticateAdmin` tests run under `it.live` with 2100 expiries and are unaffected. `storedSession` (or its replacement) must hand back the row, for `refreshLeaseUntil`;
- when the stored session is **not** fresh **and** `refreshLeaseUntil > now`, wait using the same poll as `waitForRefresh`, capped at the lease's remaining time;
- if the row turns active, return it with no exchange;
- otherwise exchange as today. The upsert stays unconditional; an exchange never takes the lease.
- Update its JSDoc: Shopify forbids acquiring and refreshing at once for one store, so it waits, and an exchange retires every other token, so its write is unconditional, and a refresh's compare-and-swap write loses to it.

**Tests (unit):**

- a live lease, with a refresh landing during the wait → no exchange call (the stub records none to the token-exchange grant), and the refreshed row is returned;
- a lease that lapses with nothing fresh → an exchange happens.

Write the stub to tell the exchange grant from the refresh grant by `grant_type` in the body.

## 8. Step 5: the fake Shopify HTTP on the `test` environment

- **Binding.** In `src/backend/stack.ts` `wireBackend`, bind `SHOPIFY_FAKE_HTTP: "1"` (a new `backend.bind("ShopifyFake", …)`) **only when the stage's environment is `test`**. Use `environmentOf`, matched exhaustively. `dev` and `e2e` never get it, even when they have no CLI app. The JSDoc says why: the fake must never sit in front of a real app.
- **New module `src/backend/shopify-fake.ts`.**
  - It holds a per-isolate script: a queue of replies per route, `token` (`/admin/oauth/access_token`) and `graphql` (`/admin/api/<version>/graphql.json`), plus a log of calls (`route`, `grant_type`, and the presented refresh token **as a hash or index, never the token itself**).
  - Recognise the routes with Effect Schema (for example `Schema.TemplateLiteralParser` over the URL's pathname split, as `worker.ts` decodes `ActorPath`), not a hand-written regex (AGENTS.md).
  - Installing it calls `setAbstractFetchFunc` with a function that serves `https://*.myshopify.com/...` from the script and fails loudly on anything unscripted (a 599 or a defect: never a real network call).
  - When the queue for a route is empty, the token route defaults to a 200 with fresh tokens (unique per call, `expires_in` 3600, `refresh_token_expires_in` 7776000). The fake has no D1, so the graphql route's default cannot read the row's `shopGid`: answer a fixed `{ data: { shop: { id: "gid://shopify/Shop/0" } } }` (or one derived from the request's host), and have the integ assert that value. Record whether the defaults are needed.
- **A service, not a bare module global.** Expose it as `ShopifyFake` (a `Context.Service`) whose `layer` reads `SHOPIFY_FAKE_HTTP` with `Config.option`: when set it builds the script and calls `setAbstractFetchFunc` while the layer builds; when unset the service holds nothing and installs nothing. Provide it in the Worker's layer chain beside `Shopify.layer`, so it is built in the Worker's init, once per isolate, before any request. The Worker's init also runs at plan time in Node (`ALCHEMY_DEV`), where the binding is absent, so nothing is installed there. Test control yields `ShopifyFake` from the `services` context to script and read it. The module ships in every Backend bundle; it is inert without the binding, and its JSDoc says so.
- **Workerd isolate reuse in local integ:** record whether one test file's calls always reach the same isolate (they should: local workerd runs one isolate per Worker). If not, the in-memory script fails, and you should record what you did instead (for example scripting through a D1 table in the integ database only).
- **Test control** (`src/contract/test-control.ts` plus `src/backend/test-control.ts`):
  - `ScriptShopify { replies: Array<{ route: "token" | "graphql", status: Int, body: Unknown }> }` **replaces** both queues and clears the call log, so replies a failed test left unconsumed never leak into the next test. `ShopifyCalls {}` answers the call log and clears it.
  - Both exist on every stage that has test control, but die unless `SHOPIFY_FAKE_HTTP` is set (a defect naming the reason).
- Document the procedures in the `TestControlRpcs` JSDoc list, in its style.

## 9. Step 6: test control for refresh, then integ and e2e

### 9.1 Procedures

- **`ExpireAccessToken { shop, refreshToken: Literals("keep","invalidate") }` → `{}`.** It sets `accessTokenExpiresAt = now − 1000`. `invalidate` also sets `refreshToken` to `"shprt_invalid_" + crypto.randomUUID()`. Add a `ShopSessions` method for it (`expireAccessToken`); it is test-only in purpose, so say so in its JSDoc.
- **`PingAdmin { shop }` → `{ ok: string } | { error: "OfflineSessionMissing" | "ReauthorizationRequired" | "ShopifyUnavailable", reason?: string }`.** It runs `ShopifyAdmin.graphqlDecode(shop, ShopGidResponse, query ShopGid { shop { id } })` and returns `shop.id` as `ok`. `ShopGidResponse` is the existing schema in `src/backend/shopify.ts` (there is no `ShopGid` schema in `src/contract`); export it, or share the query and schema with `fetchShopGid`. Encode the result as a tagged union schema, not as an RPC failure, so a test can assert on it directly. Use `Match.tags` to map the errors.
- **`ShopSessionView`** gains `refreshTokenExpiresAt` and `refreshLeaseUntil`, and still has no token fields.

### 9.2 Integ (new `test/integ/shopify-refresh.test.ts`)

Each file deploys its own stage. Use the seeded `seed-shop.myshopify.com`. Its seeded tokens are fakes, which is fine with the fake HTTP. Model the file on `test/integ/auth.test.ts` for the harness and the test-control client. Every test starts with its own `ScriptShopify` (an empty `replies` when it wants the defaults), which resets the fake.

1. `ExpireAccessToken keep` → `PingAdmin` ok (the fake's default `shop.id`) → `GetShopSession` shows `accessTokenExpiresAt` about now + 1 h, `refreshTokenExpiresAt` about now + 90 d, and `refreshLeaseUntil` null. `ShopifyCalls` shows one token call (`refresh_token`) and one graphql call.
2. `ExpireAccessToken keep` → `ScriptShopify` a 401 `invalid_request` → `PingAdmin` answers `ReauthorizationRequired` (`refresh-token-rejected`) after ~1.8 s, and the row's expiry is unchanged.
3. `ExpireAccessToken keep` → `ScriptShopify` a 503, then the default → `PingAdmin` ok, with two token calls.
4. `ExpireAccessToken keep` → five concurrent `PingAdmin` → all ok, and `ShopifyCalls` shows **exactly one** refresh. This is the real-SQL test of the lease and of `rotateTokens`.
5. `GetShopSession` for `other-shop` is unaffected throughout.

### 9.3 E2E (real Shopify, a new spec in `test/e2e/embedded/`, serial, after the embedded app has loaded and exchanged)

Use `process.env.SHOPIFY_E2E_STORE`, as `app.spec.ts` does. Read `docs/shopify-stores-runbook.md` and `test/e2e/fixtures.ts` for the `backend` / `control` helpers. Open the app in `beforeAll` with `openApp` (`test/e2e/embedded/app.ts`), so the spec's own load has exchanged and a real row exists, and reload with `gotoApp(page)`.

**Embedded files must not run at once.** Locally `workers` is unset, and the `embedded` project's `fullyParallel: false` serializes tests only within a file, so `app.spec.ts` and this spec could run in two workers on the same store row: an `app.spec.ts` load in the middle of this spec would exchange and break steps 3 and 4. Set `workers: 1` on the `embedded` project in `playwright.config.ts` (Playwright's `TestProject.workers`, present in 1.64), with a comment saying why.

1. `ExpireAccessToken keep` → `PingAdmin` returns the store's `gid://shopify/Shop/…`. `GetShopSession.accessTokenExpiresAt` is about now + 1 h, and `refreshTokenExpiresAt` is non-null and more than 60 s ahead. Do **not** assert that it moved forward: Shopify says using a refresh token "can shorten" its successor's lifetime (`access-tokens.md`, "Token lifetimes"). Record the before and after values in §11.
2. `ExpireAccessToken keep` → five parallel `PingAdmin` → all ok. Then `ExpireAccessToken keep` → `PingAdmin` ok again, which proves the stored pair is live.
3. Reload the embedded app: `GetShopSession.accessTokenExpiresAt` is unchanged, so the refreshed row was reused and no exchange happened.
4. `ExpireAccessToken invalidate` → `PingAdmin` answers `ReauthorizationRequired`. This confirms Shopify's real answer is a 401. If it answers a defect instead, record the real status and body in §11; that reopens research Q8.
5. Reload the embedded app → the exchange restores the session, and `PingAdmin` is ok. This step must always run, even after a failure in step 4. Serial mode skips every remaining test in the file after a failure, so a final test is not enough: do it in `test.afterAll`, before the context closes.

How to run the e2e (the e2e server under `shopify app dev`) is in the runbook and `package.json` (`test:e2e`, `test:e2e:server`). If it cannot run in your session (no Shopify login, no CLI), record that in §11 and mark §10's e2e box "not run". Do not fake it.

## 10. Verification checklist

- [x] `vp check` green.
- [x] `vp test` green (unit, browser, integ).
- [x] `vp run test:e2e` green, including the new refresh spec (or recorded as not run, with the reason).
- [x] No token value in any test-control answer, error, or log line (grep the dev and e2e logs for `shpat_` and `shprt_`; the seeded fakes in the seed files and tests are expected).
- [x] `SHOPIFY_FAKE_HTTP` is bound only on `test`. Check with a unit test of the binding choice, or by reading `wireBackend`'s `Match`.
- [x] Nothing committed or pushed. Staging not reset or deployed. No Shopify-side command run.

## 11. Deviations and issues

### Plan review (2026-10-16, before implementation)

Checked against the code at `6702c86` and the installed packages. No §2 decision changed. Edits:

- §3: named the Effect 4 retry API (`Schedule.exponential(…).pipe(Schedule.jittered)`, `Effect.retry({ schedule, times, while })`).
- §4.2: `RETURNING` confirmed (`@effect/sql-d1` answers `.all().results`); `layerTest.upsert` sets the lease to null on insert.
- §5.1: `Schema.Literals([...])` takes an array; `Schema.Defect()` is a function; a lease-wait timeout's cause.
- §5.3: one row-level freshness check against `Clock`, shared with Step 4; a null expiry is not fresh.
- §5.4: `TestClock` starts at epoch 0 while the library stamps expiries with `Date.now()`, and `adjust` races the stub's real promises, so stub-reaching tests run `it.live`; unit files are module-isolated.
- §6: what the GraphQL client really throws (`GraphqlQueryError`, `HttpRequestError`, `HttpRetriableError`, `HttpResponseError`; no returned `errors`), its `retries` default (0), and the test-control unit test needing `ShopifyAdmin`.
- §7: `authenticateAdmin` moves off `Session.isActive` (`Date.now`) to the shared check, so freshness and the lease use one clock.
- §8: `ShopifyFake` is a service built in the Worker's layer chain (init runs at plan time too); routes decoded with Schema; graphql default cannot read D1; `ScriptShopify` replaces rather than appends.
- §9.1: `PingAdmin` uses the existing `ShopGidResponse`, not a nonexistent contract `ShopGid`.
- §9.2: each integ test resets the fake.
- §9.3: `workers: 1` on the `embedded` project (otherwise `app.spec.ts` races this spec on the store row); no "refresh expiry moved forward" assertion (Shopify: a refresh "can shorten" it); restore in `afterAll`, since serial mode skips the rest after a failure.

For the implementer. Append as you go. Keep each entry short, dated, and tagged with its step. A deviation is anything built differently from the step that specified it. An issue is anything you saw that the plan did not predict: a failing assumption, an API that differs from the sketch, a flaky test, a limit hit. Do not rewrite the steps above; this section is the record.

### Deviations

- 2026-10-16, Step 1: `ShopSessions.rotateTokens` takes `(shop, presented, tokens)` and `ShopSessionTokens` no longer has `shop` (the shop is a separate argument). Also added `ShopSessions.expireAccessToken(shop, accessTokenExpiresAt, refreshToken | undefined)` here rather than in Step 6, with its `layerTest` mirror, since the Step 1 service is where the row methods live.
- 2026-10-16, Step 2: the fetch stub lives in a shared helper `test/unit/backend/shopify-stub.ts` (`withShopifyStub`), not inline, so Steps 3 and 4 reuse it; each test file still stubs only within its own module graph. A lapsed-lease waiter is sent round `ensureShopSession` once (`takeovers = 1`); a second lapse fails `ShopifyUnavailable`. The 'crossing expiry - 60 s' case is two `it.effect` assertions (59_999 ms still grants through the stub; 60_000 ms is expired).
- 2026-10-16, Step 3: `Shopify` exposes `adminRequest(shop, session, query, variables)` (the library client stays inside `Shopify`) and a new exported `AdminUnauthorized { shop }` error, which only `ShopifyAdmin` consumes (it clears the token it already holds from the session, so the error carries none). `SHOP_GID_QUERY` and `ShopGidResponse` are exported from `shopify.ts` and shared by `fetchShopGid` and (Step 6) `PingAdmin`. GraphQL `errors` are a defect (no typed failure was needed). The Admin tests live in their own file `shopify-admin.test.ts`, not merged: each Vitest file has its own module graph, so the stub cannot leak.
- 2026-10-16, Step 4: `storedSession` is removed; its job is split into `sessionOf(row)` (row to `Session`) and a direct `shopSessions.find`, since `authenticateAdmin` now reads the row itself. The two Step 4 tests are in `shopify-refresh.test.ts` (they share its stub).
- 2026-10-16, Step 5: the `SHOPIFY_FAKE_HTTP` binding's value is `"on"`, not `"1"` (see Issues). The call log carries a stable label per refresh token (`refresh-1`, `refresh-2`, reset by `ScriptShopify`), the plan's 'hash or index'. Test control's `ScriptShopify`/`ShopifyCalls` and the `ShopifyFake` service land here as planned; the `ShopifyFake` unit test (`shopify-fake.test.ts`, 4 tests) is an addition. `TestControlHandlers` also needs `ShopifyFake` and (Step 6) `ShopifyAdmin` in its unit-test layer.
- 2026-10-16, Step 6: `PingAdmin`'s answer schema (`PingAdminAnswer`), `ShopifyFakeReply` and `ShopifyFakeCall` are exported from `src/contract/test-control.ts`. `PingAdmin` and `ExpireAccessToken` have unit tests in `test-control.test.ts` (a stubbed Admin call; an invalidated token answers `ReauthorizationRequired` after the 1.8 s recovery). The e2e spec restores the session in `test.afterAll` and asserts the restoring `PingAdmin` there, as the plan asked. No other deviation.

### Issues

- 2026-10-16, Step 2: none beyond the plan's predictions; the stub-reaching tests pass on `it.live` with explicit timeouts (8 s for the 1.8 s recovery case, 12 s for the exhausted 429 whose backoff is about 3.5 s).
- 2026-10-16, Step 5: binding `SHOPIFY_FAKE_HTTP: "1"` broke every Backend request on the `test` stage in workerd (`Uncaught exception ... remote.jsg.Error: [object Object]`, a 500 from test control): the runtime reads a numeric-looking env binding as a number and `Config.String` refuses it. Bisected by disabling the layer, the install and the Config read in turn; only the value mattered. Changed to `"on"`; recorded in `wireBackend`. Also: I ran `pkill -f workerd` once while debugging, which may have stopped other workerd processes of this checkout; no dev or e2e server was knowingly running.
- 2026-10-16, Step 5/6: one local workerd isolate served every call of an integ file: a script set by one `ScriptShopify` request was seen by later `PingAdmin` and `ShopifyCalls` requests, and five concurrent pings produced one grant, so the in-memory script needed no D1 fallback.
- 2026-10-16, Step 6 e2e: Shopify's real answer to a garbage refresh token is 401, so research Q8 stands (the `invalidate` test got `ReauthorizationRequired / refresh-token-rejected`; the Backend log shows `status=dead`, and no 4xx defect). Refresh-token expiry on the e2e store, before and after the first refresh: `1799914789826` then `1799914794330` (it moved forward 4.5 s, i.e. about 90 days from the grant, not shortened). Five parallel pings produced the expected refreshes (one per `ExpireAccessToken`) in the Backend log. A reload after the refreshes left `accessTokenExpiresAt` unchanged (no exchange). The library logs `[shopify-api/INFO] Creating new session` on every grant, with the shop only.

### Command results

- 2026-10-16, Step 1: `vp check --fix` pass; `vp test --project unit` pass (13 files, 144 tests). The existing api and test-control unit tests gained `refreshLeaseUntil: null` in their row literals.
- 2026-10-16, Step 2: `vp check --fix` pass; `vp test --project unit` pass (new `shopify-refresh.test.ts`: 23 tests).
- 2026-10-16, Step 3: `vp check --fix` pass; `vp test --project unit` pass (15 files, 173 tests; `shopify-admin.test.ts` adds 6).
- 2026-10-16, Step 4: `vp check --fix` pass; `vp test --project unit` pass (15 files, 175 tests).
- 2026-10-16, Step 5: `vp check --fix` pass; `vp test --project unit` pass (16 files, 179 tests); `vp test --project integ` pass (3 files, 12 tests) after the value fix (it failed 3 files / 12 tests with `"1"`).
- 2026-10-16, Step 6 (before e2e): `vp check` pass; `vp test` pass (23 files, 213 tests): unit 16 files / 183 tests, browser 3 / 13, integ 4 / 17 (new `shopify-refresh.test.ts`: 5 integ tests green on real SQL and the fake HTTP).
- 2026-10-16, e2e: `vp run test:e2e` pass, 28 passed (1.1 m), including the 5 new `refresh.spec.ts` tests; run in the background, no retry needed. A second run of only `refresh.spec.ts` (`vp exec playwright test test/e2e/embedded/refresh.spec.ts`, json reporter) also passed, 6 passed (including the shopify-admin setup).
- 2026-10-16, final: `vp check` pass (141 files, no warnings); `vp test` pass, 23 files / 213 tests (unit 183, browser 13, integ 17). Log grep: `grep -rE 'shpat_|shprt_' .logs/dev .logs/e2e` found nothing.

### Implementation review (2026-10-16, after implementation)

Read the full diff against §2–§9 and the research. Confirmed: the classifier matches `HttpRetriableError` before `HttpResponseError` and rejects only a 401, both in the grant and in `adminRequest`; the compare-and-swap and lease conditions agree between the SQL and `layerTest`; the lease is released in `Effect.ensuring` and held through race recovery; every wait is bounded (recovery 6 polls; lease wait capped at lease + recovery budget; one takeover); decisions read `Clock` (the only `Date.now()` left is `signSessionToken`'s JWT claims, as before, and the library's own expiry stamps); no token reaches a log, an exported error or a test-control answer (the fake labels refresh tokens); `SHOPIFY_FAKE_HTTP` is bound only on `test`, by an exhaustive `Match`. All §11 deviations accepted: each keeps the plan's design and none touches a §2 decision. The `"on"` value is a real runtime constraint, correctly documented once on `wireBackend`.

Fixes made by the reviewer:

- `ShopifyFake`'s JSDoc restated the numeric-binding rule that `wireBackend` already states; removed the restatement.
- `ShopifyAdminError` was `EnsureShopSessionError | ShopifyUnavailable`, where the second is already in the first; now an alias of `EnsureShopSessionError`.
- `refresh.spec.ts` `afterAll` closed the context only if the reload succeeded; it now closes it in `finally`.

Reviewer command results: `vp check` pass (141 files); `vp test` pass, 23 files / 213 tests (unit 183, browser 13, integ 17); after the fixes, `vp check --fix` pass and `vp exec playwright test test/e2e/embedded/refresh.spec.ts` pass, 6 (5 refresh + admin setup). The Backend log showed one refresh for the five parallel pings.

Follow-up (2026-10-16, user accepted the reviewer's recommendations): `vp run db:reset` run on the dev stage so its D1 has `refreshLeaseUntil`; the dev server restarted and answers 200. A second Admin 401 keeps reason `refresh-token-rejected` (no new reason; research Q5's list stands). The hand-run staging check (research §8: one `ExpireAccessToken keep` + `PingAdmin` on `mw10013-staging-shop-00`, then `cf o11y` on `baton-backend-staging`) waits for the user's commit, `cloud:reset --stage staging` and push.

## 12. Out of scope

- Webhooks, the orders slice, the bulk Workflow;
- any product caller of `ShopifyAdmin`;
- staging reset and deploy (the user does this: commit, `cloud:reset --stage staging`, push);
- migrating non-expiring tokens;
- in-isolate session caching (rejected in research Q2).

## 13. File plan

| File                                                                                          | Change                                                                                                                |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `migrations/0001_init.sql`                                                                    | `refreshLeaseUntil`                                                                                                   |
| `src/backend/shop-sessions.ts`                                                                | row field, `rotateTokens`, conditional `clearAccessToken`, lease methods, `expireAccessToken`, `layerTest`            |
| `src/backend/shopify.ts`                                                                      | constants, errors, classifier, `ensureShopSession`, `authenticateAdmin` lease wait, client builder for `ShopifyAdmin` |
| `src/backend/shopify-admin.ts`                                                                | new: `ShopifyAdmin`                                                                                                   |
| `src/backend/shopify-fake.ts`                                                                 | new: the fake HTTP for `test`                                                                                         |
| `src/backend/stack.ts`                                                                        | `SHOPIFY_FAKE_HTTP` on `test` only                                                                                    |
| `src/backend/worker.ts`                                                                       | `ShopifyAdmin.layer`, fake install, test-control services                                                             |
| `src/contract/test-control.ts`, `src/backend/test-control.ts`                                 | `ExpireAccessToken`, `PingAdmin`, `ScriptShopify`, `ShopifyCalls`, `ShopSessionView` fields                           |
| `test/unit/backend/shop-sessions.test.ts`, `shopify-refresh.test.ts`, `shopify-admin.test.ts` | new                                                                                                                   |
| `test/unit/backend/test-control.test.ts`                                                      | new procedures (token check, encoding)                                                                                |
| `test/integ/shopify-refresh.test.ts`                                                          | new                                                                                                                   |
| `test/e2e/embedded/refresh.spec.ts`                                                           | new                                                                                                                   |
| `playwright.config.ts`                                                                        | `workers: 1` on the `embedded` project                                                                                |

## 14. Order of work and stopping points

Steps 1 → 2 → 3 → 4 → 5 → 6.

- Step 4 depends only on Steps 1 and 2.
- Step 5 does not depend on Steps 3 and 4.
- Stop and report if Step 1's `RETURNING` check fails with no workable alternative, or if the fake HTTP cannot be made to reach `ensureShopSession` in workerd. Then finish what does not depend on it.

The plan is complete when §10 is checked and §11 records every deviation and command result.
