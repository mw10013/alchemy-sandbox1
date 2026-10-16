# Shopify offline-token refresh: research

This covers porting legacy's offline-session refresh into the Backend so the Backend can call the Admin API with no merchant present. It is the first slice of the orders work (`docs/orders-slice-research.md` §0, §1.3 items 2–4, §4 slice 1). This doc holds findings and open questions only. No code has changed.

Legacy paths are relative to `refs/baton-legacy/`. Shopify's rules are quoted from `refs/shopify-docs/docs/apps/build/authentication-authorization/`: `access-tokens.md` ("Token lifetimes", "Refresh, rotation, and revocation", "How refresh token rotation works"), `implement-token-exchange.md` ("Refresh an expiring offline token") and `migrate-to-expiring-offline-access-tokens.md` ("Handle errors during the transition").

---

## 0. Where this repo stands

- `Shopify.authenticateAdmin` (`src/backend/shopify.ts`) reuses a stored session while it is active, using a 30 s buffer (`EMBEDDED_SESSION_REEXCHANGE_BUFFER_MS`). Otherwise it token-exchanges (`expiring: true`) and upserts the row unconditionally. `storedSession` already rebuilds a library `Session` from a row.
- `ShopSessions` (`src/backend/shop-sessions.ts`) has an unconditional `updateTokens` that nothing calls, and an unconditional `clearAccessToken`.
- `ShopSession` in `migrations/0001_init.sql` already stores `accessTokenExpiresAt`, `refreshToken` and `refreshTokenExpiresAt`. D1 read replication is off (`src/backend/resources.ts`), so every read sees the primary. Legacy needed `D1Primary` for exactly this reason (the JSDoc on `OrdersSyncWorkflow.makeRuntimeLayer`). Here it comes for free.
- Nothing refreshes. Every row's access token dies one hour after the merchant last opened the app.

---

## 1. What legacy does

### 1.1 The machinery (`src/lib/Shopify.ts`)

**Constants**

| Name                                                    | Value                         | Role                                                                                                                                                                                |
| ------------------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EMBEDDED_SESSION_REEXCHANGE_BUFFER_MS`                 | 30 s                          | `exchangeAndStore` reuses a stored session active beyond this. Already ported.                                                                                                      |
| `BACKGROUND_ACCESS_TOKEN_REFRESH_BUFFER_MS`             | 5 min                         | `refreshShopSessionIfExpired` refreshes when the access token is within 5 min of expiry.                                                                                            |
| `REFRESH_TOKEN_EXPIRY_BUFFER_MS`                        | 60 s                          | A refresh token this close to its 90-day expiry fails `RefreshTokenExpiredError` without calling Shopify. It absorbs clock skew plus one round trip; its JSDoc gives the reasoning. |
| `REFRESH_TOKEN_TRANSIENT_RETRIES`                       | 3                             | In-place retries of the grant, `Schedule.exponential("500 millis")` jittered.                                                                                                       |
| `REJECTED_REFRESH_TOKEN_RECOVERY_RETRIES` × `_INTERVAL` | 6 × 300 ms, jittered (~1.8 s) | How long `recoverRefreshRace` re-reads D1 waiting for a winner. It is sized to outlast a winner's Shopify round trip plus a D1 write.                                               |

**Errors** (`Schema.TaggedError`)

- `RefreshTokenExpiredError { shop, refreshTokenExpiresAt: number | null, cause }`. A number means the proactive 90-day check fired. `null` means the reactive verdict: Shopify rejected the token and no winner appeared.
- `RefreshTokenRejectedError { shop, refreshToken, cause }` is module-private. It never escapes `refreshShopSessionIfExpired`.
- `OfflineSessionNotFoundError { shop }`: no row.
- `OfflineSessionInvalidError { shop, sessionId }`: a row with no refresh token or no refresh expiry, such as a non-expiring token.
- Everything else is the catch-all `ShopifyError { message, cause }`, including an exhausted transient.

**Flow**

1. `ensureShopSession(shop)` calls `loadShopSession` (a D1 read rebuilt into a library `Session`; a row that fails to rebuild counts as absent). It fails `OfflineSessionNotFoundError` when there is no row, then calls `refreshShopSessionIfExpired`.
2. `refreshShopSessionIfExpired(session)`:
   - If there is an access token and `!session.isExpired(5 min)`, it returns the session.
   - With no refresh token or expiry, it fails `OfflineSessionInvalidError`.
   - If the refresh token expires within 60 s of `Clock` now, it fails `RefreshTokenExpiredError(expiresAt)`.
   - Otherwise it calls `refreshShopSession`, catching `RefreshTokenRejectedError` into `recoverRefreshRace`.
   - A row whose access token was cleared (after a 401) goes straight to refresh.
3. `refreshShopSession(shop, refreshToken)` calls `shopify.auth.refreshToken`.
   - It retries while `isTransientRefreshError`: no `HttpResponseError` at all (a network failure or a non-JSON body), or `HttpRetriableError` (429, 5xx).
   - It maps `isRefreshTokenRejected` to `RefreshTokenRejectedError`. That predicate is any `HttpResponseError` that is not retriable, so every 4xx except 429.
   - On success it writes the four token columns with an **unconditional** `updateShopSessionTokens`.
4. `recoverRefreshRace(shop, rejectedToken)` re-reads D1 for up to ~1.8 s.
   - A row whose `refreshToken` differs from the rejected one is the winner: a concurrent refresh, or an `/app` exchange that retired the token. It returns that row.
   - If the row still holds the rejected token, it logs `status=dead` and fails `RefreshTokenExpiredError(null)`.
   - With no row, it fails `ShopifyError`.

**Admin calls**

- `Shopify.graphql(session, query)` builds a `clients.Graphql` per call.
- On a 401 it mutates `session.accessToken = undefined` and best-effort clears the column, so the next `authenticateAdmin` exchanges instead of reusing a dead token. It still fails the current call.

### 1.2 `ShopifyAdmin.ts` and `CurrentShopifySession.ts`

`CurrentShopifySession` is a tag holding a library `Session`. `ShopifyAdmin.layerNoDeps` closes over it and offers `graphql` and `graphqlDecode(schema, query, {variables})`. `graphqlDecode` turns GraphQL `errors` and decode failures into `ShopifyError`.

The rationale for building it per call sits on `shopifyAdminLayer` in `src/lib/agent/Orders.ts`. A layer closed over a session and memoized by a long-lived `ManagedRuntime` (a DO lives for hours) would pin the token that was live at construction, and keep using it after a refresh rotated it. So every caller first calls `ensureShopSession` and then provides `ShopifyAdmin` from the session it got back. The server-function middleware provides `CurrentShopifySession` from the request's exchanged session instead (`ShopifyServerFnMiddleware.ts`).

### 1.3 Callers and what each does with each error

| Caller                                                                                                                             | Call                                              | Reaction                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `OrdersSyncWorkflow` `ensure-session` step (`ensureSessionProps`)                                                                  | `ensureShopSession`                               | `RefreshTokenExpiredError`, `OfflineSessionNotFoundError` and `OfflineSessionInvalidError` become `nonRetryable(...)`, which ends the instance; the `onError` sink records the message for the merchant. A `ShopifyError` (exhausted transient, missing row after rejection) stays a normal step failure, which the step retries. The session leaves the step as `toPropertyArray(true)` because step results must be JSON.                            |
| `ShopAgent` `fetchAndUpsertOrder` (`src/lib/agent/Orders.ts`), used by `syncOrderWebhook` and the merchant's one-order `syncOrder` | `ensureShopSession`, then per-call `ShopifyAdmin` | Nothing is caught. On the webhook path the rejection crosses the DO stub, `src/routes/webhooks.orders.ts` answers non-2xx, and Shopify retries for 4 h. `shopify-webhook.test.ts` ("an orders/edited delivery…") pins the `OfflineSessionNotFoundError` → 500 case. On the merchant path it fails the `@callable`. The socket's 20 s `defaultCallTimeout` (`ShopAgentSocketHost.tsx`) is sized to cover `ensureShopSession` plus one Admin round trip. |
| `exchangeAndStore` (`authenticateAdmin`)                                                                                           | does not call `ensureShopSession`                 | It reuses an active row (30 s) or exchanges and upserts unconditionally. It takes no notice of a background refresh in flight.                                                                                                                                                                                                                                                                                                                         |

### 1.4 How `exchangeAndStore` meets a concurrent background refresh

- In the last 5 minutes of a token's life, a background caller refreshes while an embedded load still reuses the row. They do not collide.
- In the last 30 s, or once the token has expired, both may act at once.
  - **Exchange issued first.** Shopify retires every other refresh token, so the refresh gets a 401. `recoverRefreshRace` then finds the exchange's row, provided it lands within ~1.8 s. That holds unless the first-install `fetchShopGid` runs, and on a first install there is no refresh token to race.
  - **Refresh issued first.** The exchange retires the refresh's fresh pair. If the refresh's unconditional write lands after the exchange's upsert, D1 holds the retired pair. The next background call then gets a 401 from the Admin API (clearing the token), refreshes from the retired token, gets a 401, finds no winner and reports the shop dead until the merchant opens the app again. **Legacy has a hole here.** It needs a narrow interleaving, but nothing prevents it.
  - **Why the Durable Object's single thread does not close it.** Legacy's `ShopAgent` ran one shop's webhook refreshes inside one DO, but three of the four writers of the token columns were elsewhere: the exchange ran in the app Worker's request (`exchangeAndStore`), the bulk sync's `ensure-session` ran in the Workflow's own isolate, and both wrote D1 directly. A DO serializes only the events delivered to it. Even inside one DO, the grant is an outbound `fetch`, and a DO accepts other requests while it awaits that `fetch` (input gates hold only across storage operations). So two webhooks in the same DO can both start a refresh from the same token. The single thread would serialize refresh only if every token writer went through the DO and the DO held its own lock across the grant. That is option D in §5.

### 1.5 Legacy's tests

`test/integration/shopify-offline-refresh.test.ts` runs over `shopify-test-layer.ts`, which is the real `Shopify` layer on D1 inside workerd with fake config. It stubs the library's HTTP with `setAbstractFetchFunc`, matching only `/admin/oauth/access_token`, recording each presented refresh token and scripting replies per attempt. The cases:

- `storeShopSession` rejects an invalid expiry.
- A still-valid token is returned unchanged.
- A refresh token already expired gives `RefreshTokenExpiredError(0)`. `TestClock` crossing `expiry − 60 s` gives `RefreshTokenExpiredError(expiry)`.
- `recoverRefreshRace` returns a stored winner. With no winner after the retries it fails `RefreshTokenExpiredError(null)`. With no row it fails `ShopifyError`.
- `updateShopSessionTokens` rotates the four columns and keeps `shopGid`, `shop` and `scope`.
- `refreshShopSession`:
  - success persists the new pair;
  - `401 invalid_request` becomes Rejected, with exactly one call;
  - `400 invalid_subject_token` becomes Rejected;
  - 429 then 200 retries with the **same** token;
  - 503 then 200 retries;
  - an exhausted 429 is never a rejection.
- The full path adopts a winner on a 401, and fails `RefreshTokenExpiredError(null)` on a 401 with no winner.

---

## 2. Shopify's rules against legacy

| Rule (docs)                                                                                                                                                                                                                                                          | Legacy                                                                                                                                                                                                              | Verdict                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every refresh returns a new access **and** refresh token; store both and use the new one next time.                                                                                                                                                                  | Writes all four columns.                                                                                                                                                                                            | Matches. One gap: when the response lacks `refresh_token_expires_in`, the library's `createSession` leaves `refreshToken` unset, and legacy writes `NULL`, stranding the shop. Must change (§4).                                                                                                                                                                                                      |
| The presented refresh token stays usable until the newer one is used, a new token is acquired, 30 days after its first use, or its 90-day expiry. "Don't rely on a fixed retry-window duration."                                                                     | `isTransientRefreshError` retries with the same token. Its JSDoc justifies this by "Shopify's 1-hour replay window", which the docs no longer state.                                                                | The behaviour matches. The stated reason is out of date: the rule is now "usable until the successor is used", so a retry is safe for as long as nobody has used the successor. Restate it when porting.                                                                                                                                                                                              |
| Retry network errors, timeouts, 5xx and 429 with the same token.                                                                                                                                                                                                     | Same, by library class.                                                                                                                                                                                             | Matches. A non-JSON error body (an edge 502 page) makes the library's `postResponse.json()` throw a plain `SyntaxError`, which legacy counts as transient. That is correct.                                                                                                                                                                                                                           |
| Every terminal case answers **`401 {"error":"invalid_request"}`**, so do not branch on which one it was. Any other non-OK status (a 400 for a malformed body, a 403 for bad client credentials) is `'failed'`: "the same request fails the same way, so surface it". | Every non-retriable `HttpResponseError` counts as rejected (a 401, a 400 `invalid_subject_token`, `invalid_grant`), which runs race recovery and ends in "merchant must reopen".                                    | **Diverges.** A 403 from a misconfigured secret would be reported as one dead shop at a time, after a 1.8 s wait each, instead of as a configuration defect. Proposal: 401 means rejected; 429, 5xx and network failures are transient; any other status is a defect, logged at Error. Legacy's `400 invalid_subject_token` test case is library-shaped guesswork, and the docs no longer support it. |
| Don't acquire and refresh at the same time for one store; each retires the other's result.                                                                                                                                                                           | Not prevented. Detected after the fact by `recoverRefreshRace`, which covers "exchange first" but not "refresh first, written last" (§1.4).                                                                         | **Partial.** Must change: write conditionally (§4, §5).                                                                                                                                                                                                                                                                                                                                               |
| Refresh one store at a time: "two workers refreshing the same store concurrently can leave one of them holding a token the other has already replaced."                                                                                                              | Not serialized. Two isolates refresh with the same token. Both may succeed, each writes, and the last write wins whether or not its pair survived the other's refresh. Recovery only helps the one that gets a 401. | **Diverges.** See §5.                                                                                                                                                                                                                                                                                                                                                                                 |
| Treat the 401 as final: stop retrying, and re-authenticate when the merchant next opens the app.                                                                                                                                                                     | `RefreshTokenExpiredError(null)` after recovery. The row stays, so the next `/app` load sees an inactive session and exchanges.                                                                                     | Matches. Shopify's sample deletes the token. Keeping the row is better here, because `shopGid` and the actor id live on it.                                                                                                                                                                                                                                                                           |
| A non-expiring token on the Admin API answers 403 "Non-expiring access tokens are no longer accepted".                                                                                                                                                               | Not handled.                                                                                                                                                                                                        | Not applicable. Every row here comes from an `expiring: true` exchange, and environments reset rather than migrate.                                                                                                                                                                                                                                                                                   |

---

## 3. `@shopify/shopify-api` 15.0.1 facts

- **`auth.refreshToken({ shop, refreshToken })`** (`lib/auth/oauth/refresh-token.mjs`)
  - It POSTs JSON `{client_id, client_secret, refresh_token, grant_type}` to `https://<sanitized shop>/admin/oauth/access_token`.
  - On a non-OK status it calls `throwFailedRequest(await res.json(), false, res)`:
    - 429 → `HttpThrottlingError` (with `retryAfter`);
    - ≥ 500 → `HttpInternalError`;
    - anything else → `HttpResponseError` with `response.{code, statusText, body, headers}`.
  - On success it returns `{ session }` from `createSession`. The session has `id = offline_<shop>`, `expires = now + expires_in`, `scope` from the response, and `refreshToken` / `refreshTokenExpires` **only if both** `refresh_token` and `refresh_token_expires_in` are present.
  - The library does no retrying of its own.
- **Error classes** (`lib/error.mjs`): `HttpRetriableError extends HttpResponseError`, and `HttpInternalError` and `HttpThrottlingError` extend `HttpRetriableError`. Legacy's class test is sound.
- **HTTP goes through one module-global `abstractFetch`.** The web-api adapter sets it to `fetch` at import (`adapters/web-api/index.mjs`), and `setAbstractFetchFunc` replaces it per isolate. That is the only fetch seam the library has: there is no per-instance option.
- **`Session.isExpired(ms)` / `isActive(scopes, ms)` read `Date.now()`, not Effect's `Clock`.** Legacy mixed the two: the 90-day check used `Clock` and the access-token check used `Date.now()`. The port should decide from the row's epoch-ms columns against `Clock`, so `TestClock` drives every branch.

---

## 4. What carries over, and what must change

**Unchanged**

- The state machine: load → fresh? → refresh-token present? → refresh token near expiry? → grant with transient retry → on a 401, look for a winner → dead.
- The constants: the 5 min background buffer, the 60 s refresh-expiry buffer, 3 transient retries (500 ms exponential, jittered) and the ~1.8 s recovery budget.
- The proactive versus reactive "expired" distinction, kept as a field for logs.
- `authenticateAdmin` exchanging rather than refreshing during a merchant session. Shopify says to acquire when a merchant session is present, and that is what it does today.
- Admin clients built per call from the session just ensured, never held.
- Every legacy test case except the `400 invalid_subject_token` one, which inverts (§2).

**Must change**

1. **Effect idiom.**
   - `Effect.fn` per step.
   - Errors are `Schema.TaggedError` and are exported from `src/backend/shopify.ts`, Backend-only. They do not go in `src/contract`, because no Website code sees them.
   - Status classification is a `Match` over the library error (`HttpRetriableError` → transient, `HttpResponseError` with code 401 → rejected, any other `HttpResponseError` → defect, anything else → transient).
   - The refreshed session is checked with Effect Schema (both tokens and both expiries present) before anything is written. A response missing them is a defect, and the row stays as it was.
   - There is no library `ShopifyError` wrapper. This repo's convention, set in `authenticateAdmin`, is typed errors for what a caller can act on and defects for the rest.
2. **`ShopKey`, not legacy's `Shop`.** Input is already a `ShopKey`. The library's `session.shop` is never re-decoded.
3. **`ShopSessions` writes become conditional.**
   - `rotateTokens(presented, tokens)` runs `UPDATE … WHERE shop = ? AND refreshToken = ? RETURNING shop` and answers whether it won. It replaces the unused `updateTokens`.
   - `clearAccessToken(shop, accessToken)` clears only the token that got the 401.
   - A lost `rotateTokens` re-reads and adopts the row. This closes the §1.4 hole: an exchange's unconditional upsert always beats an in-flight refresh's write, whatever order they land in.
   - `layerTest` mirrors both.
4. **Serialization**, per §5: a refresh lease on the row (Q3).
5. **Errors on the access token check use the row, not `Session`** (§3), so the clock is testable.
6. **`ShopifyAdmin` takes a shop, not a session** (Q2). `graphql(shop, …)` and `graphqlDecode(shop, schema, query, {variables})` each call `ensureShopSession` and build a client. That removes `CurrentShopifySession`, per-call layers, and session-carrying Workflow steps all at once. Legacy's pinning hazard cannot happen, because no caller ever holds a session.
7. **A 401 from the Admin API** clears the access token conditionally, then retries once through `ensureShopSession`, which now refreshes (Q6). Legacy failed the call and left recovery to the next request.

---

## 5. Concurrency

**Who can refresh one shop at once.** Several Backend isolates (webhook deliveries arrive in bursts, and `orders/paid` plus `orders/fulfilled` often arrive together), later a Workflow in the same Worker, and, racing all of them, an embedded load's exchange.

**Options**

| Option                                      | How                                                                                                                                                                                                                                                                                                                                                                                                           | For                                                                                                                                                                                         | Against                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Legacy as is                             | No lock; a 401 loser adopts the winner from D1                                                                                                                                                                                                                                                                                                                                                                | Already proven in production use                                                                                                                                                            | Concurrent refreshes from one token are what Shopify says to avoid. The last unconditional write can store a retired pair (§1.4, §2).                                                                                                                                                                             |
| B. A plus conditional writes                | `rotateTokens` compare-and-swap; the loser adopts                                                                                                                                                                                                                                                                                                                                                             | Closes the stored-retired-pair hole. Tiny.                                                                                                                                                  | Still lets two grants run concurrently, so it relies on Shopify's undocumented behaviour for sibling successors of one token.                                                                                                                                                                                     |
| C. B plus a D1 lease                        | New `ShopSession.refreshLeaseUntil` column. A refresher takes it with `UPDATE … SET refreshLeaseUntil = now + 10 s WHERE shop = ? AND (refreshLeaseUntil IS NULL OR refreshLeaseUntil <= now) RETURNING shop`. A non-holder polls the row (300 ms, jittered) until the token changes or the lease lapses, then re-evaluates. `rotateTokens` clears the lease, and a failed refresh releases it in `ensuring`. | One grant per shop at a time, as Shopify asks. The lock sits on the row it guards, D1 is single-primary here, and no new hop or transport is involved. A crashed holder costs at most 10 s. | One column (edit `0001_init`, then `cloud:reset`). Waiters poll.                                                                                                                                                                                                                                                  |
| D. Serialize through the shop's `ShopActor` | A schemaless stub method (`withRefreshLease`) or the actor doing the refresh                                                                                                                                                                                                                                                                                                                                  | Fits the two-transport design (schemaless stub methods are the existing Backend → actor path), and a DO is a natural mutex.                                                                 | The actor has no D1 and no secret, so it can only be a lease holder, which is C with an extra hop and the lock away from the data. Every refresh would wake the actor, Admin access would depend on actor availability, and a lease call for an uninstalled shop risks bringing its actor back (orders doc §3.3). |

**C's cost.** The lease is touched only on the refresh path, so a call made with a still-fresh access token pays nothing beyond the one D1 read it already makes. A refresh happens when a background call finds the access token within 5 minutes of its 1-hour expiry, and only if the shop has background work in that window. So it is at most about once an hour per active shop, and never for an idle shop.

- Each refresh adds one conditional `UPDATE` to take the lease. `rotateTokens` releases it in the write it already makes.
- A caller waits only if it arrives while another caller's refresh is running, which takes a few hundred milliseconds normally.
- The 90-day refresh-token lifetime plays no part in this: it only decides when a dormant shop needs the merchant again.

**Recommendation: C** (Q3). The 10 s lease covers the worst refresh, about 3.5 s of transient backoff plus 4 round trips. The waiter's cap is the lease plus the ~1.8 s recovery budget, so a webhook stays inside Shopify's 5 s in every normal case, and a rare overrun is retried by Shopify.

**`authenticateAdmin` with a lease held** (Q4)

- Shopify says not to acquire while refreshing.
- So when the row is inactive **and** a lease is live, `authenticateAdmin` waits on the row (the same poll, capped at the lease) and reuses the result if it is active. Otherwise it exchanges.
- Its upsert stays unconditional: an exchange is always the newest grant and retires everything else, and `rotateTokens`' compare-and-swap makes any later refresh write lose.
- An exchange never takes the lease. A merchant should not wait on a background job.

**In-isolate dedupe** (sharing one in-flight refresh per shop inside an isolate) would save a D1 poll for same-isolate callers. The lease already gives correctness, so leave it out.

---

## 6. Failure taxonomy

What `ensureShopSession` (and through it `ShopifyAdmin`) can fail with:

| Error                                                                                                                                        | Meaning                                                                                                                                                                                  | Retry?     |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `OfflineSessionMissing { shop }`                                                                                                             | No row. The app was uninstalled, or never installed here.                                                                                                                                | No         |
| `ReauthorizationRequired { shop, reason: "no-refresh-token" \| "refresh-token-expired" \| "refresh-token-rejected", refreshTokenExpiresAt }` | The row exists, but only a merchant opening the app (an exchange) can restore access. It merges legacy's `OfflineSessionInvalidError` and both `RefreshTokenExpiredError` verdicts (Q5). | No         |
| `ShopifyUnavailable { shop, cause }`                                                                                                         | Transient retries were exhausted (network, 429, 5xx), or a lease wait timed out with nothing fresh.                                                                                      | Yes, later |
| defect                                                                                                                                       | A non-401 4xx on the grant (configuration), a refreshed session missing tokens, an undecodable row. Logged at Error.                                                                     | —          |

How each caller is expected to react:

| Caller (future)                                 | `OfflineSessionMissing`                                                           | `ReauthorizationRequired`                                                                                           | `ShopifyUnavailable`       |
| ----------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `orders/*` webhook                              | 200, touch nothing (orders doc §2.3 guard; diverges from legacy's 500 on purpose) | non-2xx, logged at Warn. Shopify retries for 4 h, so a merchant reopening within that window recovers the delivery. | non-2xx; Shopify retries   |
| Bulk-sync Workflow step                         | `Effect.die`: stop, record the merchant message                                   | `Effect.die` with "Open Baton in your Shopify admin to reconnect"                                                   | typed fail: `task` retries |
| Merchant-triggered (one-order sync, start sync) | defect (a merchant is present, so a row exists)                                   | typed error rendered as the reconnect sentence; the next `/app` load exchanges anyway                               | typed error, "try again"   |
| test control `PingAdmin` (§7)                   | encoded in the answer                                                             | encoded in the answer                                                                                               | encoded in the answer      |

---

## 7. Proposed order of work

Each step ends green on `vp check` and `vp test`.

1. **Rows.**
   - Add `refreshLeaseUntil INTEGER` to `ShopSession` in `0001_init.sql`. `ShopSessionUpsert` omits it, so an exchange never touches it.
   - In `ShopSessions`: `rotateTokens` (replacing `updateTokens`), a conditional `clearAccessToken`, `acquireRefreshLease` and `releaseRefreshLease`, with `layerTest` mirroring them.
   - `cloud:reset` the deployed stages afterwards.
2. **`Shopify.ensureShopSession`.**
   - Errors (§6), the classifier, `refreshShopSession` (grant, retry, schema check, `rotateTokens`, adopt on loss), the lease and wait, `recoverRefreshRace`, and the proactive checks against `Clock`.
   - `storedSession` is reused, decoding from the row.
3. **`ShopifyAdmin` service** (`src/backend/shopify-admin.ts`): `graphql` and `graphqlDecode(shop, …)` over `ensureShopSession`, with 401 clear-and-retry-once. Its layer depends on `Shopify`. `fetchShopGid` stays as it is: it runs on a just-exchanged session that is not stored yet.
4. **`authenticateAdmin` waits on a live lease** before exchanging (Q4).
5. **Test-control surface.**
   - `ExpireAccessToken { shop, refreshToken: "keep" | "invalidate" }`: sets `accessTokenExpiresAt` to now − 1 s. `invalidate` also overwrites the refresh token with a random string Shopify will reject. It never returns a token.
   - `PingAdmin { shop }`: runs `ShopifyAdmin.graphqlDecode(shop, ShopGid)` and answers `{ ok: shopGid } | { error: tag }`.
   - `ShopSessionView` gains `refreshTokenExpiresAt` and `refreshLeaseUntil`, which together are enough to see that a rotation happened without exposing a token.
   - This is the smallest real path that runs refresh with no merchant present, and it is what the orders webhook will do.
6. **Fake Shopify HTTP for integ** (Q7), if accepted. It goes with step 5, so integ can drive `PingAdmin` end to end.

---

## 8. Testing per step

| Step                  | Unit (`test/unit/backend`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Integ (`test/integ`)                                                                                                                                                                                                                               | E2E (real Shopify)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 Rows                | `layerTest` semantics: `rotateTokens` wins only on a matching token; a lease is exclusive until it lapses; `clearAccessToken` is conditional                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | real SQL, through step 5's procedures (a `PingAdmin` after `ExpireAccessToken` rotates; a second concurrent one adopts)                                                                                                                            | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 2 `ensureShopSession` | Port every legacy case over `testShopify` + a scripted `setAbstractFetchFunc` stub (as legacy's `stubRefreshGrant`, restored in `ensuring`) + `TestClock`. Inverted: `400` → defect, `403` → defect. Added: refreshed response lacking `refresh_token_expires_in` is a defect and the row is unchanged; lost `rotateTokens` adopts the stored row; a held lease makes a second caller wait and adopt with **one** grant call; lease lapse lets a waiter take over; non-JSON 502 body is transient; access-token-null row refreshes. The fetch stub is module-global: keep these in one file, run sequentially. | covered by step 5                                                                                                                                                                                                                                  | covered by step 5                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 3 `ShopifyAdmin`      | `graphqlDecode` decodes; GraphQL `errors` fail; a 401 clears the token and retries once through a refresh (two grant/Admin calls in order); a second 401 fails                                                                                                                                                                                                                                                                                                                                                                                                                                                 | covered by step 5                                                                                                                                                                                                                                  | covered by step 5                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 4 `authenticateAdmin` | lease live + refresh lands → reuse, no exchange call; lease lapses → exchange                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | —                                                                                                                                                                                                                                                  | an embedded reload after a background refresh reuses the refreshed row: `GetShopSession.accessTokenExpiresAt` is unchanged by the load                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 5 Test control        | handler unit tests in `test-control.test.ts` (token check, encoding)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | with Q7's fake: `ExpireAccessToken` → `PingAdmin` ok → `GetShopSession` shows later expiries and no lease; `invalidate` → `PingAdmin` answers `ReauthorizationRequired` after ~1.8 s; five concurrent `PingAdmin` → all ok, fake records one grant | On the e2e store (`mw10013-e2e-shop-NN`), after the embedded setup has exchanged: (a) `ExpireAccessToken keep`, then `PingAdmin` succeeds and `GetShopSession` shows `accessTokenExpiresAt` ~1 h ahead and `refreshTokenExpiresAt` moved forward; (b) five parallel `PingAdmin` all succeed, and a second `ExpireAccessToken` + ping still works, which proves the stored pair is live; (c) `ExpireAccessToken invalidate` then `PingAdmin` answers `ReauthorizationRequired`, which confirms Shopify's real 401 shape matches the classifier; then reloading the embedded app exchanges and `PingAdmin` succeeds again. Staging: run (a) once by hand on `mw10013-staging-shop-00` after deploy, and check `cf o11y` on `baton-backend-staging`. |

---

## 9. Risks

- **Misclassifying a failure.** Treating a transient as rejected leaves a shop waiting for the merchant; treating a rejection as transient makes webhooks retry for 4 h in vain. Case (c) in the e2e is the only check against Shopify's real wire format. Keep it in the suite.
- **The lease column is new state on the hot path.** A bug that never releases it costs 10 s per shop per hour, never correctness, because waiters re-evaluate once it lapses.
- **The module-global `abstractFetch`.** A unit test that forgets to restore it leaks into other tests in the same file and worker. A fake installed in a deployed Backend must never reach a stage with a real app (Q7 binds it only where the fake app is bound).
- **Rotation semantics we cannot observe.** Whether two grants from one token return the same pair is undocumented. C makes the question moot in normal operation; B's compare-and-swap covers lease expiry.
- **A webhook's 5 s budget.** Worst case is a lease wait (≤ 10 s) plus recovery. Shopify retries, and the next delivery finds a fresh row. Acceptable, and the logs will show it if it is not.

---

## 10. Open questions

All eleven were settled on 2026-10-16. Each one took its recommendation, and Q2's rationale was strengthened on read cost.

:::question
Q1. Should this slice ship refresh, `ShopifyAdmin` and the test control, even though no product code calls them yet?

`ShopifyAdmin` is what the orders webhook and the Workflow will call. `PingAdmin` runs the real path with no merchant present, on real Shopify, before any orders code exists.

- [x] Yes: refresh + `ShopifyAdmin` + `ExpireAccessToken`/`PingAdmin`
- [ ] Refresh only; `ShopifyAdmin` comes with the orders webhook

Recommended: Yes: refresh + `ShopifyAdmin` + `ExpireAccessToken`/`PingAdmin`
:::

:::question
Q2. Should `ShopifyAdmin` take a shop and ensure the session on every call, or take a session from the caller?

**What a read costs.** `ShopSession` is keyed by `shop`, so `ensureShopSession`'s lookup reads exactly **one row**. D1 bills rows read, not queries: on Workers Paid, the first 25 billion rows a month are included and after that it is $0.001 per million (`refs/cloudflare-docs/src/content/partials/workers/d1-pricing.mdx`).

**What taking a shop adds over taking a session.** Nothing on the paths that make one Admin call per unit of work, which is where most calls are. A webhook delivery or a one-order sync needs one `ensureShopSession` read either way, as it did in legacy. Extra reads come only where one unit of work makes several Admin calls:

- the bulk sync's submit plus its poll loop: at most 60 polls at 5 s over 5 minutes, so about 60 extra rows per sync;
- the 401 retry, which adds one.

| Load                                                         | Extra rows read / month                    | Cost                                                   |
| ------------------------------------------------------------ | ------------------------------------------ | ------------------------------------------------------ |
| 1,000 shops, one bulk sync a day each (worst case, 60 polls) | ~1.8 million                               | inside the included 25 billion; $0.0018 if it were not |
| 1,000 shops, 1,000 order webhooks a day each                 | 0 extra (one read per delivery either way) | —                                                      |

**The refresh lease's writes** are billed separately. There is one `UPDATE` per refresh: at most ~720 a month per active shop, inside the included 50 million writes. The column is not indexed, so the write rewrites no index.

**What it buys.** Legacy's per-call layers, `CurrentShopifySession` and the Workflow's session-as-JSON step all go away, and no caller can hold a rotated token. That last one is the failure the read guards against: a Workflow step that carried its session across a refresh would use a token another isolate had already replaced.

**Rejected alternative.** Cache the session in isolate memory to skip the read. Shopify keeps a refreshed-away access token valid until its own expiry, but an exchange retires it at once. A cached token would then cost a 401 and a retry, and the cache would be a second copy of the row to keep correct. The saving is a fraction of a cent, so it is not worth that.

`ensureShopSession` stays public on `Shopify`.

- [x] Takes a shop (ensures per call)
- [ ] Takes a session, as in legacy

Recommended: Takes a shop (ensures per call)
:::

:::question
Q3. How should refreshes of one shop be serialized?

See §5. C is what Shopify asks for ("refresh one store at a time"), keeps the lock on the row it protects, and adds no hop. B alone still allows concurrent grants. D fits the two-transport design, but it is C plus a hop, with the lock away from the data and a risk of bringing an uninstalled shop's actor back.

- [x] C: D1 lease column + conditional `rotateTokens`
- [ ] B: conditional `rotateTokens` only, no lease
- [ ] D: lease held by the shop's actor
- [ ] A: legacy as is

Recommended: C: D1 lease column + conditional `rotateTokens`
:::

:::question
Q4. What should `authenticateAdmin` do when a background refresh is in flight?

Shopify says to acquire a new token, not refresh, during a merchant session, and not to do both at once. An exchange also repairs a dead refresh token. Its upsert stays unconditional in every option.

- [x] Wait for the lease (capped), reuse the result if it is still active, else exchange
- [ ] Ignore the lease and always exchange, as today
- [ ] Refresh instead of exchanging when the refresh token is valid

Recommended: Wait for the lease (capped), reuse the result if it is still active, else exchange
:::

:::question
Q5. Should legacy's `OfflineSessionInvalidError` and both `RefreshTokenExpiredError` verdicts become one `ReauthorizationRequired { reason }`?

Every caller reacts to them the same way: the merchant must open the app. `reason` keeps the distinction in logs. `OfflineSessionMissing` stays separate, because the webhook answers it with 200 and does nothing.

- [x] One `ReauthorizationRequired { reason }` + `OfflineSessionMissing` + `ShopifyUnavailable`
- [ ] Keep legacy's separate error classes

Recommended: One `ReauthorizationRequired { reason }` + `OfflineSessionMissing` + `ShopifyUnavailable`
:::

:::question
Q6. When an Admin API call gets a 401, should we clear the token and retry once, or clear it and fail?

Retrying is Shopify's sample's behaviour. A 401 can come from a token a concurrent exchange retired, and a refresh fixes that at once. A second 401 fails `ReauthorizationRequired`.

- [x] Clear (conditionally) and retry once through `ensureShopSession`
- [ ] Clear and fail, as legacy does

Recommended: Clear (conditionally) and retry once through `ensureShopSession`
:::

:::question
Q7. How should integ tests reach a fake Shopify?

The library builds `https://<shop>/admin/...` and its only HTTP hook is the module-global `abstractFetch`. A `ShopifyHttp` seam would install a fake through `setAbstractFetchFunc`, only on the `test` environment (fake app bound, test control on). The fake would answer the token endpoint and GraphQL from replies scripted with a test-control `ScriptShopify`, and record its calls. The same seam answers orders doc Q6.

- [x] Add the `ShopifyHttp` fake on the `test` environment, scripted via test control
- [ ] No integ for refresh; unit tests plus e2e on real Shopify only

Recommended: Add the `ShopifyHttp` fake on the `test` environment, scripted via test control
:::

:::question
Q8. Should only a 401 count as a rejected refresh token, with any other 4xx a defect?

This follows Shopify's docs, and it drops legacy's treating `400 invalid_subject_token` / `invalid_grant` as a rejection. E2E case (c) checks Shopify's real answer. If it is not a 401, revisit then.

- [x] Only 401 is rejected; other 4xx are defects (logged at Error)
- [ ] Any non-retriable 4xx is rejected, as legacy does

Recommended: Only 401 is rejected; other 4xx are defects (logged at Error)
:::

:::question
Q9. Once a refresh token is judged dead, should we clear it so later calls fail fast?

A dead row costs one grant plus about 1.8 s per attempt until the merchant opens the app or the uninstall deletes the row. Clearing it would make a single misclassification permanent.

- [x] Keep the row as is, as legacy does
- [ ] Clear the refresh token (conditionally)

Recommended: Keep the row as is, as legacy does
:::

:::question
Q10. Should the e2e refresh cases run on every e2e run?

Each run rotates the e2e store's tokens. Case (c) deliberately kills them until the embedded reload exchanges again. The cases would run serially after the embedded setup, end with a reload that restores a live session, and case (c) would never run on staging.

- [x] Yes, every run, serial, ending with a restoring reload
- [ ] Only on demand (tagged, skipped by default)

Recommended: Yes, every run, serial, ending with a restoring reload
:::

:::question
Q11. Should we keep legacy's timings and add a 10 s lease?

Legacy's are a 5 min background buffer, a 60 s refresh-expiry buffer, 3 transient retries and about 1.8 s of race recovery. The reasoning behind them still holds (§1.1), and 10 s covers the worst transient backoff.

- [x] Yes, legacy's timings plus a 10 s lease
- [ ] Change some (say which in a note)

Recommended: Yes, legacy's timings plus a 10 s lease
:::
