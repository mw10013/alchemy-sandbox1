# Plan: the orders slice (A)

Implements `docs/orders-slice-research.md` (settled, Q1–Q12) under `docs/legacy-port-research.md` (slice A; decisions Q5, Q6, Q8, Q15, Q20). Read the research's §0 and §1–§3 first; this plan does not restate the reasons.

Legacy paths are relative to `refs/baton-legacy/`.

## 0. Rules for the implementer

- Follow `AGENTS.md`: Vite+ only (`vp`, never npm or npx); `vp check --fix` after every step; Effect Schema for parsing; `Match` for tag dispatch; `Schema.TaggedError`; `Effect.fn("name")`; JSDoc rules (no `//` above a declaration, no references to this plan, the research or any `docs/` file in code).
- Do not commit unless told to. Work on `main` in the main checkout.
- Each step ends green: `vp check`, `vp test` (unit, browser, integ), and `vp run test:e2e` at the end of every step from Step 3 on. A step that cannot end green is recorded in §7 before moving on.
- A step that adds or deletes a route under `src/web/routes/` regenerates `src/web/routeTree.gen.ts` (`vp build`) before `vp check`.
- Step 2 edits the actor's `0001_init` in place. That step ends with one `vp run db:reset` on this checkout's `dev` stage; no other step resets or restarts the dev server. Staging is reset only in Step 9, when told.
- Legacy is the spec, not the source. Pure code and SQL port verbatim with their JSDoc tables; everything touching the agents SDK, `ManagedRuntime`, `@callable`, D1 sessions or `useLiveQuery` is rewritten to this repo's shape. Keep legacy's names for domain words and for the rules' test titles.
- Each legacy callable lands as one of three things, and nothing else (`legacy-port-research.md` Q5): a **server function** for a read a page needs on first render, a **procedure** on the socket for a live read or a browser write, a **stub method** for anything the Backend or the Workflow does to the actor.
- A write that changes what a screen shows calls `notify` with the keys it invalidates, and only when something changed (legacy rule 17).
- Logging follows legacy's form: one string message `<operation>: shop=<shop> key=<value>: <detail>`, structured fields in `Effect.annotateLogs`, `shop` in both. SQL is lowercase keywords and positional parameters. Step 9 writes both rules into `AGENTS.md`.
- Do not rewrite the steps. Record what you built differently, and what surprised you, in §7 as you go.
- The integ suite leaks a `.alchemy/local/baton-test-…-ShopActor` directory per file per run (known, out of scope). Delete the ones your runs create.

## 1. Outcome

- A shop's orders live in its `ShopActor`: stored by webhook, by the merchant's "Sync open orders" (a Cloudflare Workflow in the Backend running a Shopify bulk operation), and by "Sync from Shopify" on one order. Rows older than retention are swept.
- `/webhooks/*` lands on the Website, is forwarded raw to the Backend, and is checked there: compliance no-ops, `app/scopes_update`, `app/uninstalled` (session and members deleted, actor destroyed), `orders/*`.
- A thin merchant orders screen at `/app/orders` lists the stored orders, refetches on the actor's notice, and carries the two sync buttons. `/app/orders/from-shopify` answers the admin-link extension.
- `PingAdmin` is gone; the e2e refresh spec proves the refresh through a real order sync.
- Every background path checks the shop's session before touching the actor, so an uninstalled shop's actor is never recreated.

## 2. What this plan rests on

- **The domain handoff.** `src/domain/orders.ts` and `src/domain/platform.ts` come from `docs/domain-port-plan.md` Steps 1–2 in `wt-01`. Step 1 of this plan needs neither. Step 2 and everything after import `ShopOrder`, `OrderLineItem`, `LineItemProperty`, `syncOrder`, `SyncAction`, `capProperties`, `BulkOperation`, `bulkOperationCompleted`, `SyncState`, `OrdersSyncResult`, `SyncOrderResult`, `retentionCutoff` and `ShopLimits` from them. If the merge has not happened when Step 2 starts, stop and say so; do not copy the files into `main`.
- **What exists** (research §0.1): `ensureShopSession` and `ShopifyAdmin.graphqlDecode`; `ShopActor.transaction()` on the sync scheduler; `ShopActors` with `revoke`, `snapshot`, `loadFixture`, `addFixture`; `ShopSessions.find`, `updateScope`, `remove`; `DevRpcs` on `/api/dev`; the test Backend with `IntegRpcs` and `ShopifyFake`; `mintSessionToken` with `SHOPIFY_API_SECRET_FAKE`.
- **Alchemy Workflows** (`refs/alchemy/website/src/content/docs/cloudflare/compute/workflows.mdx`): `Cloudflare.Workflow<T>()(name, Effect.gen(...))` whose outer generator resolves dependencies and returns `Effect.fn` body; `Cloudflare.Workflows.task(name, effect, {retries, timeout})`, `sleep(name, duration)`; a Worker yields the class in its construction phase and gets `create({id, params})` and `get(id).status()`; `Effect.die` is terminal, `Effect.fail` retries by the step policy; every step and sleep name is a replay key. It runs locally under `alchemy dev`.
- **The actor's HTTP client.** Alchemy's Worker bridge provides `FetchHttpClient.layer`. Whether the Durable Object runtime provides it too is checked in Step 5; if not, the stream uses `fetch` through `Effect.tryPromise` and `Stream.fromReadableStream`.

## 3. Names and constants

| Name                                          | What                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/backend/webhooks.ts`                     | `Webhooks` service: `validate` (405, 401, 400 as responses; `{shop: ShopKey, topic, payload, webhookId}` on success), `handle` (the logging combinator), the topic dispatch, the payload schemas (`OrderWebhookPayload`, `OrderEditWebhookPayload`, `ScopesUpdatePayload`), `orderRef`.                                          |
| `src/web/routes/webhooks.$.ts`                | The Website forwarder: `POST` → `env.BACKEND.fetch(request)` untouched; any other method 405. No `rejectRequest`, no `Origin` check: HMAC is the credential.                                                                                                                                                                     |
| `src/backend/orders.ts`                       | `Orders` service in the Backend: `fetchOrder(shop, orderId)` (`orderSyncQuery`, `OrderSyncResponse`, `null` means gone), `syncOrderFromWebhook`, `syncOrder` (one order), `beginOpenOrdersSync`. The sweep is the actor's, not this service's.                                                                                   |
| `src/backend/order-sync.ts`                   | Legacy `OrderSync.ts`: `OrderNode`, `LineItemNode`, `toShopOrder`, `toOrderLineItems`, `orderSyncQuery`, `OrderSyncResponse`, `orderSyncVariables`. Verbatim.                                                                                                                                                                    |
| `src/backend/shop-actor/orders.ts`            | The actor's `OrderRepository` subset over `SqlClient`: `upsertOrder`, `getOrder`, `getOrderUpdatedAt`, `countOpenOrders`, `markOrdersLimited`, `clearOrdersLimited`, `listOrders` (run-free), `getSyncState`, `setSyncError`, `setSyncErrorIfEmpty`, `clearSyncError`, `lastSweepAt`, `sweepExpiredOrders`. Legacy SQL verbatim. |
| `src/backend/shop-actor/orders-stream.ts`     | Legacy `ShopAgentOrdersStream.ts`: `runOrdersStream`, `OrdersStreamCounts`, the NDJSON schemas and `addLine`. Nearly verbatim.                                                                                                                                                                                                   |
| `src/backend/orders-bulk.ts`                  | Legacy `OrdersBulkRepository.ts` over `ShopifyAdmin`: `submit`, `findById`, `cancel`, `bulkOrdersQueryText`, the three GraphQL documents.                                                                                                                                                                                        |
| `src/backend/orders-sync-workflow.ts`         | `OrdersSyncWorkflow`, a `Cloudflare.Workflow`; params `{ shop: ShopKey }`.                                                                                                                                                                                                                                                       |
| `src/backend/orders-sync-constants.ts`        | `ORDER_SYNC_WINDOW_DAYS` 30, `BULK_GIVE_UP_MS` 300 000, `BULK_POLL_INTERVAL_MS` 5 000, `SYNC_STALE_MS` 600 000, `GAVE_UP_MESSAGE`.                                                                                                                                                                                               |
| `SyncState.workflowId`, `SyncState.startedAt` | Two nullable columns added to the actor's `0001_init` (Q4). Together they are the in-flight record; `startedAt` older than `SYNC_STALE_MS` is stale and is cleared on the next start.                                                                                                                                            |
| Stub methods on `ShopActor`                   | `orderVersion`, `storeOrder`, `beginSync`, `syncFailed`, `streamOrders`, `syncEmpty`, `listOrders`, `getOrder`, `destroy`. Wrapped by `ShopActors`.                                                                                                                                                                              |
| `ORDERS_KEY`, `SYNC_KEY`                      | Reactivity keys in `src/contract/shop-actor.ts`: the orders list, the sync status.                                                                                                                                                                                                                                               |
| `MerchantListOrders`, `MerchantSyncStatus`    | Two socket procedures (live reads) in `MerchantRpcs`.                                                                                                                                                                                                                                                                            |
| `CONNECTION_CLOSE_UNINSTALLED`                | 4410, in `src/contract/shop-actor.ts`: the actor is gone; the browser must not reconnect.                                                                                                                                                                                                                                        |
| `listOrders`, `syncOpenOrders`, `syncOrder`   | Server functions in `src/web/server/orders.ts` and the `BackendApi` methods they call, each taking the merchant's session token as `authenticateAdmin` does.                                                                                                                                                                     |
| `GetOrder`, `ListOrders`, `ActorExists`       | `IntegRpcs` reads. `ActorExists` answers whether the actor has storage without creating it (a `getByName` plus a method that only reads `SyncState`; the research's "exists" probe). If a stub call must create, answer by the socket-tag probe or log instead, and record it.                                                   |
| `ShopifyFake` bulk route                      | `route: "bulk"` reply in `ShopifyFakeReply`: the JSONL body served at the URL the fake's `bulkOperation` answer names.                                                                                                                                                                                                           |

## 4. Steps

### Step 1: Webhook ingress, compliance, `app/scopes_update`

No domain import; can start before the domain merge.

- `src/backend/shopify.ts`: `validateWebhook(request)` over the lazily built `shopifyApi` (`api.webhooks.validate({ rawBody, rawRequest })`), porting legacy `Shopify.ts` L944–1003: non-POST 405, bad HMAC 401, missing headers 400, each as an `HttpServerResponse` the caller returns; success decodes `X-Shopify-Shop-Domain` with `ShopKey`, parses the body as JSON. Rejections log at Debug (the URL is public).
- `src/backend/webhooks.ts`: `Webhooks` with `handle(handler)`, legacy's combinator (L1594: "Webhook received" at Info under `annotateLogs({shop, topic})`, failures logged at Error and re-raised so the response is non-2xx), and the dispatch by topic with `Match`: the three compliance topics answer 200 (legacy `webhooks.compliance.ts` and its JSDoc on `shop/redact`, verbatim reasoning); `app/scopes_update` decodes `{ current: string[] }` and calls `ShopSessions.updateScope`; `app/uninstalled` and `orders/*` are wired in Steps 3–4 and answer 200 without acting until then. An unknown topic answers 404.
- `src/backend/backend.ts`: a `/webhooks/` branch beside `/api/auth`, before the 404.
- `src/web/routes/webhooks.$.ts`: the forwarder (§3). Regenerate the route tree.
- Pin the tomls: a unit test reads `shopify.app.toml?raw` and `shopify.app.staging.toml?raw` and asserts the subscriptions and `include_fields` (legacy `shopify-webhook.test.ts`: "requests read_orders and read_products only"; "subscribes to create, paid, edited, cancelled, and fulfilled only"). Keep the toml comment on `updated_at`.
- Tests. Unit (`test/unit/backend/webhooks.test.ts`): legacy's `validateWebhook` titles ("returns shop, topic, and parsed payload for a valid webhook"; "fails with a 401 ResponseError for an invalid HMAC" and the 405 and 400 cases; "succeeds for a shop with no stored offline session"); the `handleWebhook` titles; a `signWebhook(topic, shop, body)` helper beside `mintSessionToken` in `test/shopify-webhook.ts` computing the HMAC with `SHOPIFY_API_SECRET_FAKE`. Integ (`test/integ/webhooks.test.ts`, stage `webhooks`): a signed POST to `/webhooks/compliance` answers 200 and an unsigned one 401; `app/scopes_update` rewrites `scope` (read back with `GetShopSession`). e2e: `shopify app webhook trigger --topic customers/redact --address <tunnel>/webhooks/compliance --client-secret …` answered 200 once by hand; record the command in §7, do not automate it.
- Verify: green. Staging keeps 404ing until Step 9; that is expected.

### Step 2: Actor order storage

Needs the domain merge.

- `src/backend/shop-actor.ts` `0001_init`: add `workflowId text` and `startedAt integer` to `SyncState`, both nullable. Everything else unchanged. End the step with `vp run db:reset`.
- `src/backend/shop-actor/orders.ts`: the repository subset (§3) from legacy `OrderRepository.ts`, each method with its JSDoc. `upsertOrder` keeps its `afterWrite` parameter, generic in `A` and `E`, with no caller (the reconcile seam; say so). `countedAt` is never in its `SET` list (rule 7); pin that with the legacy test "a sync rewrites every column but countedAt". `listOrders` is the run-free read: rows and items, newest first by `processedAt`, keyset cursor, `limit`; no counts strip, no filters, no search (they come with slice F).
- The actor builds the repository once per activation over its `sql`, and every multi-statement method runs under `transaction()`.
- Stub methods: `orderVersion({orderId, updatedAt})` → `"stale" | "fetch" | "refused"` (the probe, then the ceiling for a new order; a refusal marks `ordersLimitedAt`); `storeOrder({order, lineItems})` → `{written, fresh, changed, refused}` (maps through `toShopOrder`/`toOrderLineItems`, upserts, then the sweep if due, `notify([ORDERS_KEY])` when changed or swept); `getOrder({orderId})`; `listOrders({limit, cursor})`. All typed on the actor's class so `ShopActors` wraps them with no schema on the wire.
- `src/contract/shop-actor.ts`: `ORDERS_KEY`, and `MerchantListOrders` (payload `{limit, cursor}`, success the page) in `MerchantRpcs`; its handler reads the repository.
- `IntegRpcs`: `GetOrder`, `ListOrders`.
- Tests. Unit: `syncOrder` is tested in the domain plan; here `toShopOrder`/`toOrderLineItems` with `capProperties` (legacy `OrderSync` cases) and an `OrderNode` decode of a recorded Shopify response (save one under `test/unit/backend/fixtures/`). The repository: if the domain plan's spike verdict (`domain-port-plan.md` §7) is **unit**, add the SQLite dependency it names and port legacy `order-repository.test.ts`'s `upsertOrder`, `upsertOrder columns`, `sweepExpiredOrders`, `retention` and `sync state` blocks as unit tests over the in-process layer, titles unchanged; if **integ**, the same cases run through `IntegRpcs` on the test stage. Integ (`test/integ/orders.test.ts`, stage `orders`): `storeOrder` then `GetOrder`; the version guard (older skipped, equal rewritten, newer replaces items); ceiling refusal sets `ordersLimitedAt` (lower the ceiling with a test-only limit the way legacy's `withMaxOpenOrders` does, or store 2,501 rows by `AddToFixture`; record which); a merchant socket receives `ORDERS_KEY` on a change and nothing on a same-version rewrite; a multi-statement write completes (the `MixedScheduler` regression).
- Verify: green; `db:reset` done; the dev fixture still loads (`vp run fixture` is what `db:reset` runs).

### Step 3: `orders/*` webhooks end to end

- `src/backend/order-sync.ts` (verbatim from legacy `OrderSync.ts`) and `src/backend/orders.ts`'s `fetchOrder` and `syncOrderFromWebhook`: decode the payload (`orderRef`: an edit has `updatedAt: null` and always fetches; a missing GID or a bad `updated_at` is a 400); `ShopSessions.find(shop)`, **no session means 200 and no actor call**; `actors.orderVersion`; if `"fetch"`, `ShopifyAdmin.graphqlDecode(OrderSyncResponse, orderSyncQuery, orderSyncVariables)`; `null` means gone, logged, 200; else `actors.storeOrder`. Log `hasNextPage` truncation as legacy does. The topic decides nothing (rule 1).
- Wire `orders/*` in `Webhooks`' dispatch.
- Tests. Unit: `orderRef` cases; the handler over layers (no session → no actor call; stale → no fetch; `null` → 200). Integ: signed `orders/create` for the seeded shop with the order scripted into `ShopifyFake` (`route: "graphql"`), then `GetOrder`; `ShopifyCalls` shows one GraphQL call, and none when the version is stale; legacy titles "skips a delivery whose updated_at is not newer than the row" and "an orders/edited delivery resolves the order from order_edit.order_id and always fetches". e2e: deferred to Step 7, with the screen that shows the result.
- Verify: green.

### Step 4: Uninstall teardown

- `ShopActor.destroy()`: close every socket with `CONNECTION_CLOSE_UNINSTALLED`, `state.storage.deleteAlarm()`, `state.storage.deleteAll()`, `state.abort("uninstalled")`. Expect the stub call to reject when the abort lands; `ShopActors.destroy` treats that rejection as success (legacy's `"destroyed"`), everything else propagates. Record the error shape Alchemy's stub surfaces in §7.
- `app/uninstalled` handler: `ShopSessions.remove(shop)` (unconditional, cascades members and teams), then `actors.destroy(shop)`. A destroy failure propagates (non-2xx, Shopify retries). The billing flush is a named seam: a one-line JSDoc on the handler saying where it goes. This handler is the one background path that must **not** apply the "no session, touch nothing" guard (research §3.4).
- Browser: `src/web/client/actor-connection.ts` maps 4410 to a terminal outcome (no retry), with a line of copy on the member and merchant pages.
- Tests. Unit: handler order and error mapping over layers (the abort rejection counts as success, other errors propagate); the close-outcome table in `test/unit/web/client/actor-connection.test.ts` gains 4410. Integ: seed a shop with an order and a member socket; signed `app/uninstalled`: the socket closes 4410, `GetShopSession` is null, the `Member` rows are gone, `GetOrder` is none; a signed `orders/create` afterwards makes no actor call (`ActorExists` false, or `ShopifyCalls` empty and the log line). Legacy title "uninstall deletes the shop row, its members and teams, and destroys the object". e2e: none (uninstalling the e2e app breaks `shopify app dev`); the staging check is in Step 9.
- Verify: green.

### Step 5: Open-orders bulk sync

- `src/backend/orders-bulk.ts` from legacy `OrdersBulkRepository.ts`, over `ShopifyAdmin` (a shop, never a session). `src/backend/orders-sync-constants.ts`.
- `src/backend/orders-sync-workflow.ts`: `OrdersSyncWorkflow`. Outer generator yields `ShopifyAdmin`, `ShopSessions`, `ShopActors` and the bulk repository. Body, in tasks named as legacy's steps: `ensure-session` (a `ShopSessions.find`; none means `Effect.die`, the shop is gone); `run-bulk-orders-query` (`submit(bulkOrdersQueryText(now))`, `now` taken inside the task); the loop `wait-for-bulk-orders-N` (`sleep`, `BULK_POLL_INTERVAL_MS`) and `poll-bulk-orders-N` (`findById`; a missing operation dies) while elapsed is under `BULK_GIVE_UP_MS` and the operation is active (CREATED, RUNNING, CANCELING); on give-up `cancel-bulk-orders` (failure swallowed) then fail with `GAVE_UP_MESSAGE`; on FAILED or EXPIRED fail without cancelling; then `completedBulkUrl` (`url ?? partialDataUrl`) → `on-orders-stream` calling `actors.streamOrders(shop, {url})`, or `on-orders-sync-empty` calling `actors.syncEmpty(shop)`. Any failure runs the sink task `on-orders-sync-error` → `actors.syncFailed(shop, {message})` with legacy's `sinkMessage`. Session-shaped errors (`ReauthorizationRequired`, `OfflineSessionMissing`) die; `ShopifyUnavailable` fails and retries by the step policy (set `retries` explicitly on the two Shopify tasks: limit 3, exponential, 2 seconds).
- Actor stub methods: `beginSync({workflowId, now})` in one transaction: a fresh `SyncState.startedAt` (under `SYNC_STALE_MS`) answers `InFlight`; a stale one is cleared; the ceiling answers `Refused` and marks `ordersLimitedAt`; otherwise clear `lastError` and `ordersLimitedAt`, record `workflowId` and `startedAt`, `notify([SYNC_KEY])`, answer `Started`. `streamOrders({url})`: one `syncedAt`, `runOrdersStream` (`src/backend/shop-actor/orders-stream.ts`), then the sweep, then clear the tracking columns, `notify([ORDERS_KEY, SYNC_KEY])`; returns the counts. `syncEmpty()`: clear tracking, notify `SYNC_KEY`. `syncFailed({message})`: `setSyncErrorIfEmpty`, clear tracking, notify `SYNC_KEY`.
- Backend: `Orders.beginOpenOrdersSync(shop)`: `ShopSessions.find` (none → `ShopNotInstalled`-style failure), `const id = crypto.randomUUID()`, `actors.beginSync(shop, {workflowId: id, now})`; on `Started`, `workflow.create({ id, params: { shop } })`; if the create fails, `actors.syncFailed` with the message and re-fail. Answers `OrdersSyncResult`. The Backend yields `OrdersSyncWorkflow` in its construction phase; the test Backend inherits it through `backendBody`.
- `MerchantSyncStatus` procedure: `{ inFlight, lastError }` (legacy `OrdersSyncStatus`); the `SYNC_KEY` notice refetches it.
- Check in `alchemy dev` that the Workflow class is deployed with the Backend and runs locally; record the stack output in §7.
- Tests. Unit: `bulkOrdersQueryText` ("the sync query is fixed: open, unfulfilled, created in the last 30 days"); the stream fold over an in-memory `HttpClient` layer with legacy `shop-agent-orders-stream.test.ts`'s titles (fold, 250 cap, 8 KB cap, parent mismatch, undecodable line, partial failure keeps rows, one `syncedAt`, fresher webhook row survives); `beginSync`'s rules over the repository (fresh row refuses, stale row is cleared, ceiling refuses). Integ: `ShopifyFake` gains the bulk route; `ScriptShopify` with a `bulkOperationRunQuery` reply, two `bulkOperation` polls (RUNNING then COMPLETED with the fake URL), and the JSONL body; call the Backend's `beginOpenOrdersSync` through a new `IntegRpcs` `SyncOpenOrders` (integ has no merchant page), then poll `ListOrders` until the rows appear; a second call while fresh answers `InFlight`; legacy titles from `orders-sync-workflow.test.ts` that apply ("completes: ensure-session -> bulk COMPLETED -> on-orders-stream"; "…reaches on-orders-sync-empty"; "refuses a second sync while one is tracked as running"; "a tracking row older than ten minutes is deleted on the next press"; "a failed sync's banner is the merchant sentence, and the callback never overwrites it"). The give-up path is unit-tested with a stubbed clock, not run for five minutes.
- Verify: green.

### Step 6: One-order sync and the retention sweep

- `Orders.syncOrder(shop, orderId)`: the webhook path without the probe; answers `Stored | Gone` (`SyncOrderResult`).
- The sweep: `sweepExpiredOrders` and `lastSweepAt` are in the repository since Step 2; `storeOrder` and `streamOrders` already run it when due (`sweepIntervalMs`). This step pins it: the sweep deletes `Run` rows too (the tables exist and are empty, the SQL ports as is).
- Tests. Unit: sweep batch and chunking; `Gone` mapping. Integ: the sweep deletes rows older than 365 days (insert with an old `processedAt` through `AddToFixture`'s `placedDaysAgo`, then a `storeOrder` with `lastSweepAt` null); the rate limit (a second write inside the interval sweeps nothing).
- Verify: green.

### Step 7: The orders screen and the extension landing

- `BackendApi`: `listOrders({sessionToken, limit, cursor})`, `syncOpenOrders({sessionToken})`, `syncOrder({sessionToken, orderId})`, each decoding the token through `Shopify.authenticateAdmin`'s path to a `ShopKey` before touching the actor. `src/web/server/orders.ts`: the three server functions over them, inputs decoded with Schema.
- `src/web/routes/app.orders.tsx`: the merchant orders screen under `/app` (the App Home guards already apply). Loader: `listOrders` (first page). Component: an `s-table` with legacy's columns minus the run ones: Order (name, linking to the Shopify admin with legacy `adminOrderUrl`), Placed, Payment, Status, Items; the two buttons "Sync open orders" (toast on `InFlight` and `Refused`, legacy copy) and, per row, "Sync from Shopify"; the sync banner from `MerchantSyncStatus`. Live: the merchant socket (`?token=`, already gated) with `MerchantListOrders` seeded from the loader's data and `ORDERS_KEY`; `MerchantSyncStatus` on `SYNC_KEY`. Layout only through parts under `src/web/components/screen/`; add the parts the table and the banner need, named as legacy's (`Screen.ts` parts table) and recorded in §7.
- `/app` App Home: replace "We got here" with a link to Orders.
- `src/web/routes/app.orders.from-shopify.tsx`: reads `?id=` and redirects to `/app/orders` (the order page comes with slice F; until then the list with the order's row is the target; record it).
- `PingAdmin` retires: `test/e2e/embedded/refresh.spec.ts` proves the refresh by pressing "Sync from Shopify" on a stored order after `ExpireShopSession`, and reading `GetShopSession`'s new expiry. Delete `PingAdmin` and `PingAdminAnswer` from `DevRpcs`.
- Tests. Browser: the screen renders a page of orders, the empty state, the `InFlight` toast, the banner (handlers stubbed as `test/browser/shop-actor.ts` does). Integ: the `BackendApi` methods refuse a bad token and answer rows for a good one; a member socket is refused `MerchantListOrders`. e2e (`test/e2e/embedded/orders.spec.ts`, in the `embedded` project, `workers: 1`): the spec creates its own order on the e2e store through the `draftOrderCreate` + `draftOrderComplete` helpers in `scripts/lib/stores.ts` (run as a child process, as the fixture's store half does), tagged with `testEmail`-style uniqueness; the orders screen shows it after the webhook; `orderCancel` then the row shows cancelled; "Sync open orders" lists it. The one-time `shopify store auth` on the e2e store with order write scopes is a human step: add it to `docs/shopify-stores-runbook.md` and ask for it in §7 before the spec can run.
- Verify: green, including e2e.

### Step 8: Fixture and dev data

- `AddToFixture` and `LoadFixture` already write `ShopOrder` rows; make sure the rows they write pass the same `ShopOrder` schema the repository now decodes (the fixture writes `countedAt: 0`; the repository must read it as a stored value and never touch it).
- `vp run fixture` on the dev stage, then open `/app/orders` in the dev store and see the fixture's orders.
- Verify: green.

### Step 9: Staging, `AGENTS.md`, docs

- `AGENTS.md`: add the logging form and the SQL style (§0) under a "Logging" and a "SQL" heading, each two or three lines.
- Staging, when told: `vp run cloud:reset --stage staging --confirm staging` (the `SyncState` columns), push, open the staging app, press "Sync open orders" on `mw10013-staging-shop-00` (3 orders), see them listed; then uninstall Baton Staging from the store, check `cf o11y` on `baton-backend-staging` for the teardown log lines, reinstall from the Dev Dashboard and see an empty list. Record the log lines in §7.
- `docs/legacy-port-research.md` §3: mark A's status. `docs/glossary.md`: add `Webhook`, `Sync`, `Order` rows to the domain section if the domain plan's Step 6 has not already.
- Verify: `vp check` green.

## 5. Verification checklist

- `vp check`, `vp test`, `vp run test:e2e` green at the end; counts and times in §7.
- The production bundle (`.alchemy/bundles/Backend/`, walked from `worker.js`) contains no `IntegRpcs`, `ShopifyFake` or `SyncOpenOrders` string.
- Every `pinned by` title ported from legacy's `Orders.ts` tables exists under `test/` byte for byte: sample ten with `grep -rF`.
- `grep -rn "countedAt" src/backend/shop-actor/orders.ts` shows it only in `SELECT` lists and the JSDoc, never in a `SET`.
- A webhook for a shop with no `ShopSession` creates no `.alchemy/local/…-ShopActor` storage on the test stage.
- The dev store: an order placed in the Shopify admin appears on `/app/orders` within a few seconds; cancelling it updates the row.

## 6. Done when

- §1 holds on the dev stage and, when told, on staging; every step is green; §7 is filled in; `PingAdmin` is gone; staging no longer 404s webhooks.

## 7. Deviations and issues

For the implementer. Append as you go. Keep each entry short, dated and tagged with its step. A deviation is anything built differently from the step that specified it. An issue is anything the plan did not predict: a failing assumption, an API that behaves differently, a test that cannot be written as described. Command results go under their own heading with the counts and times.

### Plan review (2026-10-17, lead)

Checked every step against this repo, `refs/baton-legacy/` and Alchemy's Workflow source (`refs/alchemy/packages/alchemy/src/Cloudflare/Workflows/`). Outcome, names, order and steps unchanged; these are the corrected details each step is built to.

General

- §0 "Do not commit": superseded for this run; the lead commits each green step on `main`.
- SQL style: legacy's "positional parameters" are Effect's tagged templates (`sql\`select … where id = ${id}\``, `sql.in`, `sql.literal(OPEN)`), lowercase keywords; no `sql.unsafe`, no `?`. The existing uppercase SQL in `shop-actor.ts` (fixture) is left as is.
- Legacy tests all live in `refs/baton-legacy/test/integration/`; "legacy title" means a title there, ported byte for byte.
- No `build` script in `package.json`: "regenerate the route tree" is `vp build` (Vite+ command) or whatever regenerates `routeTree.gen.ts`; record what worked.

Step 1

- `api.webhooks.validate` (web-api adapter; `rawRequest` is a web `Request`) returns `topic` as `topicForStorage(header)`: `ORDERS_CREATE`, `ORDERS_EDITED`, `APP_UNINSTALLED`, `APP_SCOPES_UPDATE`, `CUSTOMERS_REDACT`, `CUSTOMERS_DATA_REQUEST`, `SHOP_REDACT`. The `Match` dispatch matches these, not `orders/create`. The Backend's `HttpServerRequest` must be turned back into a web `Request` with the body read once.
- Missing-headers 400 covers all five headers the library requires: HMAC, topic, shop domain, API version, webhook id. `signWebhook` sets all five.
- Legacy titles: "fails with a 405 ResponseError for a non-POST request", "fails with a 400 ResponseError when required webhook headers are missing"; `handleWebhook`: "fails with the rejection ResponseError without running the handler", "runs the handler with the validated result and returns its Response", "re-raises a handler failure so Shopify retries". Legacy's toml test reads only `shopify.app.toml` and pins no `include_fields`; the plan's wider test (both tomls, `include_fields`) stands, legacy titles reused.
- Unknown topic 404: kept (new; legacy routed by URI).

Step 2

- `ordersLimitedAt` and `lastSweepAt` are `ShopUsage` columns, not `SyncState`'s (`SyncState` is `id, lastError`).
- Legacy `upsertOrder<A = void, E = never>({order, lineItems, afterWrite?})` does its own probe and, for a new order only, the ceiling read (`openOrdersAtCeiling(countOpenOrders())`) and `markOrdersLimited` inside its transaction, then `syncOrder`. `storeOrder` relies on that; it does not re-probe.
- `listOrders` in legacy is run-entangled (`{limit, cursor, q, show, team, teams}` → `OrdersPage`). The run-free read is new: keep legacy's cursor `${processedAt}:${id}`, `order by processedAt desc, id desc`, `limit + 1`. `getOrder` answers the order and its items, run-free (legacy's `OrderDetail` carries runs).
- Repository tests: wt-01's spike verdict (`domain-port-plan.md` §7) is still empty. Read it when Step 2 starts. Legacy describe names are `OrderRepository.upsertOrder`, `OrderRepository.upsertOrder columns`, `OrderRepository.sweepExpiredOrders`, `OrderRepository retention`, `OrderRepository sync state`.
- "Equal rewritten" is the `storeOrder` path; the webhook probe skips an equal version (Step 3).
- Ceiling test: legacy's `withMaxOpenOrders` (`test/integration/open-order-ceiling.ts`) has no counterpart here. Choose and record.

Step 3

- `orderRef` follows legacy: a missing `admin_graphql_api_id` builds `gid://shopify/Order/${id}`, and a bad or missing `updated_at` is `null` (fetch). Only a payload that decodes as neither shape is a 400. Legacy answered non-2xx there too.
- The probe skips `updatedAt <= stored`.
- Call shape: `ShopifyAdmin.graphqlDecode(shop, OrderSyncResponse, orderSyncQuery, { variables: orderSyncVariables(orderId) })`. Failures are `EnsureShopSessionError` only; an undecodable response is a defect.
- `toOrderLineItems({shop, orderId, nodes})` is effectful (logs drops). The no-session guard is new (legacy had none).

Step 4

- Legacy has no `ShopAgent.destroy`. The spec is `destroyShopAgent` (`Shopify.ts`): the abort rejection counts as success; log lines `…: shop=<shop> status=destroyed|failed` with `annotateLogs({shop, status})`. `ShopActors.destroy` ports that.

Step 5

- `SYNC_STALE_MS` (private, `ShopAgent.ts`) and `GAVE_UP_MESSAGE` ("Shopify did not finish the export in time. Try again.", private, `OrdersSyncWorkflow.ts`) move into `orders-sync-constants.ts` as §3 says. `ORDERS_SYNC_WORKFLOW_NAME` is not ported.
- `runShopAgentOrdersStream` is renamed `runOrdersStream`. It needs the repository and `HttpClient` (`filterStatusOk`, `retryTransient`) and reads `syncedAt` itself.
- Legacy has four GraphQL documents: the inner `BulkOrdersQuery` plus three operations.
- Legacy steps use default retries; the explicit `retries` here are new, as planned.
- Workflow API, verified:
  - The body is `Effect.fn((params) => …)` returned by the outer generator. Its requirements are limited to `WorkflowServices`, so resolve `ShopifyAdmin`, `ShopSessions`, `ShopActors` and the bulk repository in the outer generator. They flow to the Backend's init and come from `provideBackend`.
  - `handle.create({id, params})`; `get(id)` is itself an Effect (`yield* (yield* wf.get(id)).status()`).
  - `Effect.die` becomes `NonRetryableError`; a typed failure retries. Task results go through Cloudflare's serializer (no JSON check), so pass plain data.
  - An instance may run in another isolate of the script; the shared init runs there too.
- `ShopifyFake` patches only the Shopify library's fetch (`setAbstractFetchFunc`), answers JSON only, and 599s any other host. It cannot serve the bulk file to the actor's `HttpClient`.
  - Corrected design: the research §6 fallback. A `bulk` reply holds the JSONL body; the fake's `bulkOperation` answer names a URL on the test Backend's own origin, and the test Backend serves the body there.
  - `ShopifyFakeReply`/`ShopifyFakeCall` route literals, the queues and the script filter all grow.
  - Whether the Workflow's `ShopifyAdmin` sees the fake (same script, shared init) is checked first in Step 5.

Step 6

- `AddToFixture`'s `PlacedDaysAgo` is `< 365`, so it cannot insert a sweepable row. If the spike verdict is **unit**, the 365-day deletion is pinned over the repository with an explicit `now`, and integ pins that `storeOrder` sweeps when due (`lastSweepAt` set) plus the rate limit. If **integ**, a test-Backend-only path inserts the old row. Record which.
- Legacy has no "sweep batch and chunking" test; write new ones (200 per sweep, 90 ids per statement). The legacy title is "deletes any order older than 365 days, open or closed, with its runs".

Step 7

- `BackendApi` methods take `(request, payload)`. Resolve the `ShopKey` with `Shopify.decodeSessionToken` (`authenticateAdmin`'s first half, the one `ShopAccess.merchant` uses), not a full `authenticateAdmin`: that may token-exchange on every call. Server functions follow `src/web/server/shopify.ts`'s `shopifyAdmin` middleware.
- `app.tsx` renders the home body with no `<Outlet/>`. Move the home body to `app.index.tsx` and give `app.tsx` an `<Outlet/>`; the guards in `beforeLoad` still apply.
- The merchant socket has never been wired into `/app`: `ShopPage`/`seedShop` take a merchant token, but no route passes one. Step 7 wires it.
- Legacy's columns are Order, Placed, Payment (Paid/Unpaid badge), Status, Issues, Items, Shopify. The name links to the in-app order page, and `adminOrderUrl` (`shopify://admin/orders/${legacyId}`) is a last "Shopify" column, an icon button labelled `Open ${name} in Shopify`. Here: drop Issues; the name is plain text until the order page (slice F); keep the Shopify column.
- Per-row "Sync from Shopify" stays per row (legacy has it on the order page, which arrives with F).
- Copy:
  - InFlight: "A sync is already running".
  - A start error: its message, or "Couldn't start the sync.".
  - Gone: "Shopify no longer has this order".
  - Refused: legacy has no toast. It shows the ceiling in `QuotaBanners`; use that component's ceiling sentence as the toast and record it.
  - Sync banner: `<s-banner tone="critical">{lastError}</s-banner>` in `IndexSection`'s head.
  - Parts: `IndexSection` exists; add `EmptyLine` (and `FootLine` if needed) by legacy's names.
- `PingAdmin` callers beyond the e2e spec:
  - `test/unit/backend/dev.test.ts` (2 tests);
  - `test/integ/shopify-refresh.test.ts`'s `ping` helper (every refresh integ test);
  - five e2e tests plus `afterAll` in `refresh.spec.ts`: refresh, 5 parallel, reload reuse, rejected → `ReauthorizationRequired`, reload exchange.

  Each moves to a one-order sync: the `syncOrder` server function or press in e2e, a signed `orders/*` webhook or `syncOrder` in integ. Keep each case's assertion.

- `scripts/lib/stores.ts` has `DRAFT_ORDER_CREATE`/`DRAFT_ORDER_COMPLETE`/`ORDER_CANCEL` as private documents inside `applyStoreFixture`, and its store guard admits dev stores only. Export narrow order helpers guarded to the e2e store. They shell out per operation to `shopify store execute`. `testEmail` is in `test/e2e/fixtures.ts`.
- The runbook's `shopify store auth` line covers dev stores only; add the e2e store line.

### Deviations

- 2026-10-17 [Step 1] `Shopify.validateWebhook` fails with `WebhookRejected { status: 400 | 401 | 405 }` (a `Schema.TaggedError`), not legacy's `ResponseError` carrying a `Response`; `Webhooks.serve` answers `HttpServerResponse.empty({ status })`. The legacy titles still say "ResponseError" and are kept byte for byte.
- 2026-10-17 [Step 1] `validateWebhook` lives on `Shopify` (the step text), not on `Webhooks` as §3's table lists. `Webhooks` has `handle(request, handler)` (the web `Request` is a parameter; there is no `CurrentRequest` service) and `serve(HttpServerRequest)`, the Backend's `/webhooks/` branch: `HttpServerRequest.toWeb` hands back the Worker's own `Request` with its body unread, `validateWebhook` reads it once, a rejection answers its status, any other failure (already logged at Error by `handle`) answers 500.
- 2026-10-17 [Step 1] A signed delivery whose shop domain is not a `ShopKey` or whose body is not JSON is a 400 rejection (logged at Debug); legacy let both become a defect (500).
- 2026-10-17 [Step 1] An unknown topic is 404 after the `Webhook received` line, with a Warning `Webhooks.dispatch: shop=<shop> topic=<topic>: no handler`. Topics are a `WebhookTopic` literal schema; the dispatch is `Match` with `Match.exhaustive` over it.
- 2026-10-17 [Step 1] The compliance JSDoc (on `compliance` in `src/backend/webhooks.ts`) drops legacy's two sentences about the admin orphan sweep and `destroyShopAgent`'s `status=failed`, which do not exist here yet; `handle`'s Error line is the stated visibility.
- 2026-10-17 [Step 1] The Website forwarder answers non-POST with TanStack Start's `ANY` handler (405, `allow: POST`).
- 2026-10-17 [Step 1] `signWebhook(topic, shop, body)` answers the headers (the five plus `content-type`, API version `2026-10`); the caller builds the request.
- 2026-10-17 [Step 1] Tests beyond legacy's titles: each of the other four required headers missing is 400; a non-`ShopKey` domain is 400; through `serve`: the three compliance topics 200, `app/uninstalled` and `orders/*` 200 with nothing written, an unsubscribed topic 404, a scopes payload without `current` 500 with nothing written, 401/400/405. Legacy's "app/scopes_update updates the stored scope from the payload" and "app/scopes_update is a no-op when no session row exists" are ported as unit tests; the first also titles the integ case. The toml test adds "trims every orders topic but orders/edited to id, admin_graphql_api_id and updated_at" for both tomls.

### Issues

- 2026-10-17 setup: baseline `vp check` green. The first `vp test` failed with an unhandled "Port 63315 is already in use" (all 26 files that ran passed). A rerun was green: 30 files, 270 tests, 23.2 s. Transient; likely a concurrent run in `wt-01`.
- 2026-10-17 [Step 1] Route tree: `vp build` regenerates `src/web/routeTree.gen.ts` (2.7 s; +21 lines for `/webhooks/$`). It also writes `dist/`, which is gitignored.
- 2026-10-17 [Step 1] `shopify.app.toml?raw` imports type-check in the unit project with no extra declaration (`vite/client` is in `tsconfig.json`); legacy's `oxlint-disable` line for it is not needed here.
- 2026-10-17 [Step 1] The library checks the HMAC before the headers: a missing HMAC header or an empty body is 400 (`missing_hmac`, `missing_body`), a missing topic/domain/version/id after a good HMAC is 400 (`missing_headers`).

### Command results

- 2026-10-17 [Step 1] `vp check`: green, 214 files formatted, 171 files linted and type-checked (~2.5 s).
- 2026-10-17 [Step 1] `vp test`: green first run, 34 files, 316 tests, 30.1 s (unit alone: 276 tests, 10.8 s; `test/unit/backend/webhooks.test.ts` 32 tests; `test/integ/webhooks.test.ts` 2 tests, 10.3 s alone). The seven leaked `.alchemy/local/baton-test-…-ShopActor` directories were deleted.
- 2026-10-17 [Step 1] e2e by hand, not run (for the lead): with `vp run dev` up under `shopify app dev`, `shopify app webhook trigger --topic customers/redact --api-version 2026-10 --delivery-method http --address <tunnel>/webhooks/compliance --client-secret <Baton Dev client secret>`; expect 200 once, and a `Webhook received: shop=… topic=CUSTOMERS_REDACT` line in `.logs/dev/current`.

### Human steps requested

### Implementation review

## 8. Out of scope

- Runs, reconcile, the counts strip, filters and search on the orders index, the order page (slice F). `upsertOrder`'s `afterWrite` and `Run` in the sweep's SQL are the seams.
- Billing: the usage outbox, `flushUsageEvents` after a stream, a webhook write, a one-order sync and uninstall; `ordersLimitedAt` is set here and only read by billing's banner (slice G). Each handler names its seam in one JSDoc line.
- `bulk_operations/finish`, a Queue for webhooks, `orders/delete`, the `shop/redact` delete (research Q3, Q5, Q9, Q10).
- The admin console's orphan pages (slice H).
- Seeds: legacy `deleteSeedOrders`, `markSeedOrdersCounted`, `SEED_ORDER_ID_PREFIX`; the fixture covers dev data.
