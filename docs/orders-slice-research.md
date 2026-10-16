# Orders slice: research

The next port slice from `refs/baton-legacy`: getting a shop's orders into its `ShopActor`, keeping them current with `orders/*` webhooks, and removing everything when the app is uninstalled. This doc covers findings and open questions only; no code has changed.

Workflows, runs and billing are out of scope. Where orders touch them, the doc lists the touch point and leaves it unported (§5).

Legacy paths are relative to `refs/baton-legacy/`.

---

## 0. What this repo has today, and what the slice needs first

| Need                               | Here today                                                                                                                                  | Gap                                                                                                                                                                                                                                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Actor storage                      | `ShopActor` `0001_init` already has `ShopOrder`, `OrderLineItem`, `SyncState`, `ShopUsage`, `UsageEvent` (plus the workflow and run tables) | Nothing reads or writes them. The schema matches legacy's columns, so no migration change is needed for this slice except `SyncState` tracking columns if Q4 lands that way.                                                                                                                             |
| Offline Admin API access           | `Shopify.authenticateAdmin` does token exchange (`expiring: true`) and stores the session in D1                                             | **No refresh.** `ShopSessions.updateTokens` exists but nothing calls it. There is no `ensureShopSession`. Expiring offline access tokens live **1 hour**, so any background Admin call (a webhook fetch, a bulk sync) fails within an hour of the merchant's last visit. This is the first prerequisite. |
| Public HTTP entry for Shopify      | The Website is public. The Backend has `workersDev: false` and no URL.                                                                      | Webhooks must land on the Website and be forwarded raw to `env.BACKEND.fetch`, the way `src/web/routes/api.actor.$key.ts` forwards upgrades. The Backend holds `SHOPIFY_API_SECRET`, so HMAC is checked there.                                                                                           |
| Backend → actor calls              | Schemaless `revoke` and `snapshot` through `ShopActors`                                                                                     | Add new schemaless methods (store an order, version probe, stream a bulk file, destroy). This fits the settled two-transport design: no new transport.                                                                                                                                                   |
| Webhook config                     | `shopify.app.toml` and `shopify.app.staging.toml` already copy legacy's subscriptions verbatim                                              | No route serves `/webhooks/*` yet. Shopify is delivering to 404s on staging today, and app-config subscriptions are never auto-deleted for failures.                                                                                                                                                     |
| Multi-statement actor transactions | None yet. The `shop-actor.ts` JSDoc already points at Alchemy's `MixedScheduler("sync")` workaround.                                        | `upsertOrder` is the first multi-statement write, so the workaround has to land with it (§1.3).                                                                                                                                                                                                          |

---

## 1. Order sync

### 1.1 What legacy does

There are three sources, and all of them funnel into one write, `OrderRepository.upsertOrder` (`src/lib/OrderRepository.ts`). The decision is the pure `Domain.syncOrder` (`src/lib/domain/Orders.ts`); its JSDoc holds the actions table and invariant rules 1–18.

**The write: `upsertOrder`**

- One transaction per order. It probes the stored `updatedAt`, then asks `syncOrder` for `write{fresh}` / `skip` / `refuse{ceiling|retention}`.
- It upserts with `where excluded.updatedAt >= ShopOrder.updatedAt returning id`.
- Line items are replaced wholesale.
- An optional `afterWrite` runs inside the same transaction; it is the reconcile seam.
- It returns `{ written, fresh, changed, refused, afterWrite }`.
- `countedAt` is never in the `SET` list, so it survives every write.

**Gates (only a new order is gated)**

- Retention: `processedAt < retentionCutoff(syncedAt)`, where `ShopLimits.orderRetentionDays` is 365.
- Order ceiling: `openOrdersAtCeiling(countOpenOrders())`, where `ShopLimits.maxOpenOrders` is 2,500. A refusal sets `ShopUsage.ordersLimitedAt`.

**Mapping (`src/lib/OrderSync.ts`)**

- `OrderNode` and `LineItemNode` are the Effect Schemas both paths decode with.
- `toShopOrder` and `toOrderLineItems` cap properties at 8 KB per item (`Domain.capProperties`) and log what they drop.
- `orderSyncQuery` is the single-order GraphQL query. It asks for one page of 250 line items and selects `hasNextPage` so a truncated order is logged.

**Source A: a webhook (§2).** This is a single-order fetch through `OrdersAgent.fetchAndUpsertOrder` (`src/lib/agent/Orders.ts`). Shopify answering `null` means the order is gone: it is logged and skipped, the response is still 2xx, and the stored row stays.

**Source B: Sync from Shopify on the order page.** `ShopAgent.syncOrder` is the same fetch without the version probe. It answers `Stored | Gone`.

**Source C: Sync open orders (the bulk sync)**

- `ShopAgent.syncOpenOrders` is a `@callable` over the merchant socket. In order, it:
  1. checks the merchant role;
  2. refuses while a fresh Agents-SDK tracking row exists (`SYNC_STALE_MS` is 10 minutes; a stale row is deleted), with a `syncStarting` field closing the window during the create;
  3. reads the ceiling, refusing with `Refused` and setting `ordersLimitedAt`;
  4. clears `SyncState.lastError` and `ordersLimitedAt`;
  5. starts `ORDERS_SYNC_WORKFLOW` through `runWorkflow`;
  6. publishes.
- `OrdersSyncWorkflow` (`src/lib/OrdersSyncWorkflow.ts`) is an Agents-SDK `AgentWorkflow`. Its steps:
  1. `ensure-session` (D1 read plus refresh; returns the session as a property array because step results must be JSON);
  2. `run-bulk-orders-query` (`bulkOrdersQueryText(now)`: fixed filter `created_at:>=now-30d status:open -fulfillment_status:fulfilled`, `groupObjects: false`);
  3. a poll loop of `step.sleep` plus `poll-bulk-orders-N` every 5 s, for up to 5 minutes (`orderSyncConstants.ts`);
  4. on timeout, `cancel-bulk-orders` (failure swallowed), then fail with a merchant sentence;
  5. otherwise `completedBulkUrl` (`url ?? partialDataUrl`), then `agent.onOrdersStream({url})` or `agent.onOrdersSyncEmpty()`.
- Any failure goes through an `Effect.onError` sink step, `agent.onOrdersSyncError({message})`. Permanent errors are `Effect.die(new NonRetryableError(...))`.
- `OrdersBulkRepository` (`src/lib/OrdersBulkRepository.ts`) has `submit`, `findById` and `cancel` over GraphQL, decoded with `Domain.BulkOperation`.
- `runShopAgentOrdersStream` (`src/lib/ShopAgentOrdersStream.ts`) runs inside the DO:
  1. one `syncedAt` for the whole stream;
  2. an `HttpClient` GET of the signed URL with transient retry;
  3. `Ndjson.decodeSchema(BulkLine)` (tagged on `__typename`);
  4. `Stream.mapAccumEffect` buffering one order and its items (a mismatched `__parentId` fails the stream; past 250 items it truncates);
  5. `Stream.runFoldEffect` calling `upsertOrder` per order and counting.

  Memory stays constant, and webhooks interleave between orders at every `await`. That is safe because of per-order transactions plus the version guard.

- `onOrdersStream` streams, flushes usage (`ensuring`), runs the retention sweep and publishes.
- `onWorkflowComplete` and `onWorkflowError` delete the tracking row. `onWorkflowError` writes `lastError` only if the sink did not (`setSyncErrorIfEmpty`).

**Retention: `sweepExpiredOrders`**

- Up to `sweepBatch` (200) orders older than 365 days are deleted, with their runs, in id chunks of 90.
- The sweep rides the bulk stream, and the webhook path every `sweepIntervalMs` (6 h, tracked by `ShopUsage.lastSweepAt`).
- There is no alarm.

**Reads: `ordersIndexQuery.ts`**

- `ORDERS_PAGE_SIZE`, `ordersQueryKey` and `decodeOrdersIndexData` are UI-side.
- `OrderRepository.listOrders` is entangled with runs (the counts strip, Issues). Only a run-free subset belongs in this slice.

### 1.2 What carries over unchanged

- `Domain.syncOrder` and its tables, `SyncAction`, `capProperties`, `ShopLimits` (the order-related keys), `retentionCutoff`, and the `ShopOrder` / `OrderLineItem` / `LineItemProperty` / `BulkOperation` / `SyncState` / `OrdersSyncResult` / `SyncOrderResult` schemas. These are pure, Effect Schema based, and already in the shape AGENTS.md asks for.
- `OrderNode`, `LineItemNode`, `toShopOrder`, `toOrderLineItems`, `orderSyncQuery`, `bulkOrdersQueryText` and the bulk GraphQL documents. All on API `2026-10`, which both tomls already pin.
- `runShopAgentOrdersStream` nearly verbatim. Alchemy provides `HttpClient` inside a DO (`FetchHttpClient.layer` in the isolate build; `examples/cloudflare-microvm-shell/src/shell-session.ts` streams a response the same way), and `Ndjson` / `Stream` are plain Effect.
- `upsertOrder`'s SQL and the `sweepExpiredOrders` SQL. The table shapes are identical. `ShopOrder_open_idx` here keeps legacy's predicate character for character, so the `OPEN` fragment still proves the partial index.
- The design stances: a webhook is a signal, never the data; nothing is cleared on sync; a version guard instead of dedupe; a fixed 30-day query with no delta marker; partial files are accepted.

### 1.3 What must change for Alchemy and Effect

1. **No Agents SDK.** `runWorkflow`, `getWorkflows`, `deleteWorkflow`, `onWorkflowComplete`/`onWorkflowError`, the `cf_agents_workflows` tracking row, `@callable` and `AgentWorkflow`'s `this.agent` stub all go away. Their replacements:
   - **Workflows:** `Cloudflare.Workflow` exists in Alchemy (`refs/alchemy/packages/alchemy/src/Cloudflare/Workflows/Workflow.ts`).
     - Steps are `Cloudflare.Workflows.task` (wrapping `step.do`, typed fail means retry and die means stop), `sleep` and `waitForEvent`.
     - The handle offers `create({id, params})`, `get(id).status()`, `terminate` and `sendEvent`.
     - It runs locally under `alchemy dev` on a vendored copy of miniflare's workflows engine, and is tested in `test/Cloudflare/Workflows/Workflow.local.test.ts`.
     - Creating an instance **from a Durable Object** type-checks but has no example or test in Alchemy, so treat it as unverified.
     - There are no completion callbacks into an actor: the workflow's last step calls the actor itself.
   - **Tracking:** with no SDK row, the actor records the running sync itself. Proposal: add `SyncState.workflowId` and `SyncState.startedAt`. The in-flight rule then reads that row with legacy's 10-minute staleness. This edits `0001_init` in place, followed by a reset.
   - **`@effect/rpc` instead of `@callable`:** browser-facing reads and verbs become `ShopActorRpcs` entries (`Merchant*`) with the existing role middleware. Workflow-only callbacks (`onOrdersStream`, `onOrdersSyncError`) become **schemaless stub methods**, which no browser can reach. That preserves legacy's rule 16 by construction.
2. **Where Admin API calls live** (Q1). Legacy's DO built its own `Shopify` + D1 `Repository` runtime and called Shopify from inside the actor. This repo's actor has no D1 binding and no Shopify secret. The recommendation keeps it that way:
   - The **Backend** (and a Workflow in the Backend Worker) does every Admin API call: single-order fetch, bulk submit, poll and cancel.
   - The **actor** stores and reads. It fetches only the bulk result URL, which is a signed, credential-free URL valid for a week.

   The token-refresh race (`recoverRefreshRace`) then lives in one module.

3. **Port `ensureShopSession`** from legacy `Shopify.ts`: `loadShopSession`, `refreshShopSessionIfExpired`, `refreshShopSession` with transient retry, and `recoverRefreshRace`, plus the errors `RefreshTokenExpiredError`, `OfflineSessionNotFoundError` and `OfflineSessionInvalidError`. It goes into `src/backend/shopify.ts` over the existing `ShopSessions.updateTokens`, following the docs' rotation rules:
   - the old refresh token stays valid until the new one is used, a new token is acquired, 30 days pass, or its 90-day expiry;
   - never acquire and refresh concurrently.

   An `/app` load (`authenticateAdmin` re-exchanging) can race a background refresh, and that is exactly what `recoverRefreshRace` adjudicates.

4. **A `ShopifyAdmin` service** with `graphqlDecode(schema, query, {variables})`, built per call from the session `ensureShopSession` returns. Legacy's `ShopifyAdmin.ts` is 69 lines. Its JSDoc explains why it must not be built once per runtime: it would pin a rotated token.
5. **SQLite in the actor:** `upsertOrder` and `sweepExpiredOrders` use `sql.withTransaction`. Alchemy's `Drizzle.DurableObject` (`src/Drizzle/Cloudflare.ts`) and `DurableObjectStorage.ts` run transactions under `new Scheduler.MixedScheduler("sync")`. Without that, the DO input gate can block the timer-based fiber yield and stall the transaction; Alchemy's regression test is `DrizzleDurableObjectMigrations.test.ts`. The actor's `SqliteClient.layer` needs the same wrapper before the first multi-statement write.
6. **Publish becomes `notify`.** Legacy's `publish` pushed fresh data to every connection and kept a list memo. Here the actor pushes a `ShopActorNotice` with invalidated keys and the browser refetches. A write with `changed` notifies, for example with an `ORDERS_KEY`. Legacy's "publish only when changed" rule carries over as "notify only when changed", and the memo is dropped.
7. **Workflow shape.** Legacy's two pitfalls carry over: a runtime layer that cannot fail, and JSON-only step results (so the session travels as data, not as a `Session`). Under Alchemy, though, the Workflow's outer `Effect.gen` resolves dependencies once, and `task` handles retry and die semantics. Legacy's `ManagedRuntime` per run, `timedStep` and `NonRetryableError` die trick mostly disappear, with `Effect.die` taking the place of `NonRetryableError`. Each poll step still needs its own name (`poll-bulk-orders-${n}`) because a step name is its cache key.
8. **Bulk completion** (Q3). Shopify now recommends the `bulk_operations/finish` webhook over polling, but warns that "Webhook delivery isn't always guaranteed, so you might still need to poll". With Alchemy's `waitForEvent`, the Workflow can wait for the event (the Backend's webhook handler calls `instance.sendEvent`) with a short timeout, and fall back to a poll. Legacy's plain poll loop is simpler and already proven. The recommendation is to port the poll first and add the finish webhook later only if poll latency matters.
9. **Concurrency.** API 2026-01+ allows **5** concurrent bulk queries per shop per app. Legacy's comment on `OrdersBulkRepository.cancel` already says five. With one in-flight sync per shop, this never binds.

### 1.4 Risks

- **Token refresh is new code on the critical path.** Every background call depends on it. Misclassifying a transient failure as dead strands a shop until the merchant reopens the app. Port the unit tests too: legacy's `shopify-offline-refresh.test.ts`.
- **A Workflow created from the actor is unverified in Alchemy.** Q4 avoids depending on it by having the Backend create the instance.
- **Losing the tracking row.** The SDK row, staleness, `syncStarting` and stale-row deletion are delicate (rule 3). Rebuilding them on `SyncState` must keep the same behaviour: a dead instance must never wedge the button.
- **DO CPU per stream.** A 2,500-order file is one request into the actor that does thousands of transactions. The default per-request CPU limit is 30 s and can be raised. Measure on a seeded store before relying on it.
- **`listOrders` is run-entangled.** Porting it whole drags in shop work. This slice should ship a run-free read (order rows and items, paged by `ShopOrder_processedAt`) and leave the counts strip to the runs slice.

---

## 2. `orders/*` webhooks

### 2.1 What legacy does

**Subscriptions** (`shopify.app.toml`, already copied here)

- `orders/create`, `orders/paid`, `orders/cancelled` and `orders/fulfilled` go to `/webhooks/orders` with `include_fields = ["id","admin_graphql_api_id","updated_at"]`. `updated_at` keeps Shopify's identical-payload debounce from dropping updates.
- `orders/edited` goes to the same URI with no `include_fields`.
- `orders/updated` is deliberately not subscribed.
- `orders/delete` exists (payload `{id}`) and is **not** subscribed. A deleted order stays until retention, and a fetch answers `null`, which counts as gone.
- `app/uninstalled`, `app/scopes_update` and the three compliance topics each have their own URI.

**Validation: `Shopify.validateWebhook` and `handleWebhook` (`src/lib/Shopify.ts`)**

- Responses: non-POST gets 405, bad HMAC 401, other invalid requests 400. These rejections are logged at Debug because the URL is public and draws scanner noise.
- On success it returns `{ shop, topic, payload, webhookId }` through `@shopify/shopify-api`'s `webhooks.validate`.
- `handleWebhook` logs "Webhook received" at Info, runs the handler under `annotateLogs({shop, topic})`, and on failure logs at Error and re-raises, which makes the response non-2xx so Shopify retries.

**Routing: `src/routes/webhooks.orders.ts`**

- Payloads decode through a union of `OrderEditWebhookPayload` (`order_edit.order_id`) and `OrderWebhookPayload` (`id`, `admin_graphql_api_id?`, `updated_at?`).
- `orderRef` derives `{orderId: GID, updatedAt: ms | null}`. An edit has `null`, so it always fetches.
- The route then calls `SHOP_AGENT.getByName(shop).syncOrderWebhook({orderId, topic, updatedAt})` and awaits it inside Shopify's 5-second budget.

**`ShopAgent.syncOrderWebhook`**

1. Version probe: if the payload's `updatedAt` ≤ the stored one, return without a fetch (rule 2).
2. A **new** order at the ceiling: mark `ordersLimitedAt`, return 2xx, no publish.
3. Fetch and upsert (`fetchAndUpsertOrder`, the topic decides nothing: rule 1).
4. A rate-limited retention sweep.
5. Publish if anything changed or was swept.
6. Flush the usage outbox (billing).

**Idempotency and ordering**

- There is no `X-Shopify-Webhook-Id` dedupe store. A redelivery is skipped by the probe or rewrites the same version harmlessly (rule 17).
- Shopify guarantees no ordering within or across topics and recommends ordering by `updated_at`. Comparing Shopify's own `Order.updatedAt` is exactly that.

### 2.2 What carries over unchanged

- Both toml subscription blocks, already in place. Note that the staging toml change needs `shopify app deploy --config staging` only when the file changes.
- `OrderWebhookPayload`, `OrderEditWebhookPayload`, `orderRef`, the version-probe, ceiling and fetch order, and the "always 2xx on a business refusal, non-2xx on a fault" stance.
- The `handleWebhook` combinator's logging contract and status codes.

### 2.3 What must change

1. **Ingress path.** Add a Website route `src/web/routes/webhooks.$.ts` (or one per URI) that forwards the untouched request to `env.BACKEND.fetch(request)`. The body must stay byte-identical for HMAC, and `fetch` over a service binding preserves it. The Backend's `fetch` gains a `/webhooks/` branch beside `/api/auth`. No Origin check applies: HMAC is the credential.
2. **HMAC in the Backend.** Add `validateWebhook` to `src/backend/shopify.ts` over the same lazily built `shopifyApi` (`api.webhooks.validate({ rawBody, rawRequest })`). Decode `X-Shopify-Shop-Domain` through `ShopKey`: here a `ShopKey` is held to the myshopify pattern, unlike legacy's `Shop`. Return `ResponseError`-style statuses as an `HttpServerResponse`.
3. **The handler runs in the Backend, in three hops:**
   1. Decode → `ShopSessions.find(shop)`. If there is **no session, answer 200 and touch nothing** (§3.3: this prevents resurrecting an uninstalled shop's actor).
   2. `actors.getByName(shop).orderVersion({orderId, updatedAt})` returns `"stale" | "fetch" | "refused"`. The actor runs the probe plus the ceiling check and marks `ordersLimitedAt`.
   3. If `"fetch"`: `ensureShopSession` → `ShopifyAdmin.graphqlDecode(OrderSyncResponse, orderSyncQuery, ...)`. On `order === null`, log gone and answer 200. Otherwise call `actor.storeOrder({ order, lineItems })`. The actor maps, upserts, sweeps when due, and notifies if anything changed.

   That is two actor round trips instead of legacy's one, because the fetch moved out of the actor (Q1). The version guard in `upsertOrder` keeps the race between the probe and the store harmless.

4. **`app/scopes_update`.** Port it in the same slice. It is about ten lines over the existing `ShopSessions.updateScope`.
5. **5-second budget.** The inline path does D1 read + possible refresh + one GraphQL + two DO calls. A token refresh with its transient retries (`Schedule.exponential("500 millis")`) can overrun it. Shopify then retries and the next delivery finds the fresh token, which is acceptable. A Queue (`Cloudflare.Queues.consumeQueueMessages`, Worker-level, runs locally) would decouple the work but adds a resource and loses the non-2xx retry signal (Q5).

### 2.4 Risks

- **Webhooks during `shopify app dev` with two checkouts.** The tomls use relative URIs, and Shopify's docs recommend them for the tunnel case without stating the resolution rule. The runbook says one `app dev` per store, because the CLI points the app's URL at its own tunnel per store. Whether a toml subscription on the shared `Baton Dev` app delivers store A's events to session A's tunnel when main and `wt-01` both run is **unverified**. Verify it before e2e depends on it.
- **Debounce.** Removing `updated_at` from `include_fields` would silently drop updates. Keep the toml comment and add a unit test that reads the toml, as legacy's `shopify-webhook.test.ts` does with `appToml?raw`.
- **Staging is already subscribed** and currently 404s. Deliveries fail and retry for 4 hours. App-config subscriptions are never auto-deleted, so this is harmless but noisy until slice 2 deploys.
- **Uninstall vs in-flight webhooks.** Order webhooks that arrive after `app/uninstalled` must not recreate the actor. Covered in §3.3.

---

## 3. Uninstall teardown and compliance webhooks

### 3.1 What legacy does

**`src/routes/webhooks.app.uninstalled.ts`**

1. `flushUsageEvents(shop)`, best effort (billing; out of scope).
2. `shopify.deleteShopSession(shop)`: an **unconditional** `delete from ShopSession where shop = ?`. No read first, so it is correct even against a lagging replica, and it is one call on retries.
3. `destroyShopAgent(shop)` (`src/lib/Shopify.ts`) runs `SHOP_AGENT.getByName(shop).destroy()`. The Agents SDK's `destroy` awaits `storage.deleteAll()` and then aborts the object. The expected `Error("destroyed")` is treated as success, and any other error propagates as non-2xx so Shopify retries the idempotent teardown.

**What gets deleted**

- In D1, `ShopSession` cascades to `Member`, `Team` and `TeamMember` (legacy and this repo's `migrations/0001_init.sql` both declare `on delete cascade`, and D1 enforces foreign keys by default). Better Auth `User`/`Session` rows stay: a member's user may belong to other shops.
- In the actor, everything: orders, items, sync state, usage and outbox, workflows, runs and tasks. Live sockets die with the abort.

**`src/routes/webhooks.compliance.ts`**

- All three compliance topics are verified no-ops (401 on bad HMAC, 200 otherwise).
- `customers/*`: Baton stores no customer identity. The caveat is that `note` and line-item `properties` are free text, deleted with the shop on uninstall.
- `shop/redact` (48 h after uninstall): a deliberate no-op. Acting on it risks resurrecting a destroyed object, and Shopify does not document whether it is suppressed on reinstall within 48 h. The JSDoc records the accepted risk: if all 8 `app/uninstalled` retries fail, the object is stranded but visible in logs.
- The admin orphan pages (`admin.orphan-shop-agent-objects.tsx`, `destroyShopAgentObjectById`) are the manual cleanup.

### 3.2 What carries over unchanged

- The order of operations (flush, then delete the session, then destroy the actor), the unconditional delete (`ShopSessions.remove` already exists), the "propagate a destroy failure, so Shopify retries" stance, and the cascade.
- The compliance no-ops and their reasoning, including the `shop/redact` stance and the privacy note.

### 3.3 What must change

1. **A schemaless `destroy` on the actor**, since there is no SDK `destroy()`. It must:
   - close every socket with a new close code (say `CONNECTION_CLOSE_UNINSTALLED`, so the browser does not just reconnect);
   - `state.storage.deleteAlarm()` (once alarms exist);
   - `state.storage.deleteAll()`;
   - `state.abort("uninstalled")`.

   Alchemy's `DurableObjectState` exposes `storage.deleteAll`, `deleteAlarm` and `abort(reason)`. The abort matters: the actor migrates once per activation, so without it the same activation would keep serving with its tables gone. Expect the stub call to reject when the abort lands, and treat that rejection as success, as legacy does with `"destroyed"`. Verify which error shape Alchemy's stub surfaces.

2. **No resurrection.** `getByName(shop)` creates an actor whose constructor runs `0001_init` and writes storage.
   - **Legacy had this hole on the order path:** `syncOrderWebhook` ran its version probe in the object _before_ `ensureShopSession` discovered the missing session, so a late `orders/*` delivery after uninstall re-created an empty, billed object.
   - Here the Backend checks `ShopSessions.find(shop)` **before** any actor call on every background path (webhooks, Workflow steps).
   - The actor's own `fetch` path is already gated by `ShopAccess.shopExists`.
3. **The billing flush is skipped** in this slice. Note the touch point in the handler's JSDoc and leave a hook for later.
4. **`shopActorId`** is the shop domain here and is set once. After a reinstall, `getByName(shop)` reaches a fresh, empty object, because `deleteAll` emptied the old one. The behaviour is the same as legacy's.

### 3.4 Risks

- **Reinstall wipes members, teams and all work.** Legacy accepted this. Merchants who uninstall and reinstall to fix something lose their floor setup (Q8).
- **Partial teardown.** If the session delete succeeds and the destroy fails, the retry still finds no session. The destroy must therefore not depend on the session, and the "no session, touch nothing" guard from §3.3 must **not** apply to the uninstall handler itself.
- **A destroy that times out:** `deleteAll` on a large store "makes progress and is safe to retry". It should be fine at 2,500 orders.
- **Orphans:** with no admin orphan page here, a stranded actor is only visible in logs. Acceptable for now.

---

## 4. Proposed order of work

Each slice ends green on `vp check` and `vp test`, and is usable on its own.

| #   | Slice                                                     | Delivers                                                                                                                                                                                                                                                                                                                          | Depends on       |
| --- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 1   | **Offline session refresh**                               | `Shopify.ensureShopSession` + refresh + race recovery; `ShopifyAdmin.graphqlDecode`                                                                                                                                                                                                                                               | —                |
| 2   | **Actor order storage**                                   | `Domain` order schemas and `syncOrder`; an `OrderRepository` subset (`upsertOrder`, `getOrder`, `getOrderUpdatedAt`, `countOpenOrders`, `markOrdersLimited`, a run-free `listOrders`); the `MixedScheduler` transaction fix; schemaless `orderVersion` / `storeOrder`; `notify` on change; test-control `GetOrder` / `ListOrders` | —                |
| 3   | **Webhook ingress**                                       | Website `/webhooks/*` forward; Backend `validateWebhook` / `handleWebhook`; compliance no-ops; `app/scopes_update`; test-control `SignWebhook`                                                                                                                                                                                    | 1 (shared `api`) |
| 4   | **`orders/*` webhooks end to end**                        | the `/webhooks/orders` handler (session guard, probe, fetch, store)                                                                                                                                                                                                                                                               | 1, 2, 3          |
| 5   | **Uninstall teardown**                                    | actor `destroy`; the `app/uninstalled` handler; the session guard on every background path                                                                                                                                                                                                                                        | 2, 3             |
| 6   | **Open-orders bulk sync**                                 | `Cloudflare.Workflow` in the Backend; `OrdersBulkRepository`; `SyncState` tracking; schemaless `beginSync` / `streamOrders` / `syncFailed`; the merchant trigger (Q4); `runShopAgentOrdersStream`                                                                                                                                 | 1, 2             |
| 7   | **Sync from Shopify (one order)** and **retention sweep** | merchant RPC or server function; `sweepExpiredOrders` riding 4 and 6                                                                                                                                                                                                                                                              | 4, 6             |
| 8   | **Minimal orders screen**                                 | a merchant RPC read plus a page listing orders, refetching on the notice                                                                                                                                                                                                                                                          | 2 (Q7)           |

Slices 1 and 2 are independent and can run in parallel worktrees. Slice 5 goes early on purpose: from slice 4 onward the actor holds real data, and teardown should exist before anything installs on more stores.

---

## 5. Out-of-scope touch points (noted, not ported)

- `ShopOrder.countedAt` is written only by `OrderRepository.countOrder`, which `RunRepository.insertRun` calls. `upsertOrder` must never name it in `SET` (rule 7). Pin that with a test now.
- `ShopUsage.ordersLimitedAt` is set by the ceiling refusal here. It is cleared only by a bulk sync start (`clearOrdersLimited`); the quota banner that reads it is billing UI.
- `ShopUsage.lastSweepAt` belongs to retention (slice 7).
- `ShopUsage.cycleStartAt`/`cycleEndAt`/`ordersThisCycle`/`seatsThisCycle`/`shopGid` and the `UsageEvent` outbox, along with `flushUsageEvents` after a stream, a webhook write, a one-order sync and uninstall, are billing. Leave a named seam in each handler.
- The `afterWrite` parameter of `upsertOrder` is the reconcile seam for runs. Keep the parameter, generic in `A`/`E`, with no caller yet. `fetchAndUpsertOrder`'s `reconciler` argument goes with it.
- `sweepExpiredOrders` deletes `Run` rows. Those tables exist and are empty, so the SQL ports as is.
- Seeds: legacy `deleteSeedOrders` / `markSeedOrdersCounted` and `SEED_ORDER_ID_PREFIX`. They are only needed once runs exist; `SEED_SHOP` here is a placeholder with no Shopify store.

---

## 6. Testing per slice

What is available: **unit** (Vitest with Effect layers, `test/unit/backend/layers.ts`: `testShopify` with `TEST_SHOPIFY_APP`); **integ** (`test/integ`, Alchemy `Test.make` deploying the Backend into local workerd with the `test` environment's fake Shopify app and test control on); **e2e** (Playwright on the e2e server under `shopify app dev` against `mw10013-e2e-shop-NN`, with the embedded specs using the saved admin login).

Two harness additions recur below:

- **test-control `SignWebhook`** (`{ topic, shop, body }` → headers). The integ and e2e stages bind a random fake secret held in Alchemy state, so a test cannot compute the HMAC itself. `IssueMerchantSessionToken` is the precedent.
- **A fake Admin API in integ.** Shopify's library builds `https://<shop>/admin/api/...` from the shop domain, so a deployed integ Backend cannot be pointed at a fake. Either the Admin call sits behind a `ShopifyAdmin` service with a `test`-environment implementation chosen at stack time (canned responses keyed by order GID, fed through test control), or integ covers only the actor's methods and the Backend handler is unit-tested with layers (Q6).

| Slice                   | Unit                                                                                                                                                                                                                                                                                                                             | Integ                                                                                                                                                                                                                                                                                                                                                               | E2E (real Shopify)                                                                                                                                                                                                                                                                                                                                  |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 Refresh               | the legacy `shopify-offline-refresh.test.ts` cases over a fake `fetch`: active, expired with valid refresh, refresh token past 90 days, transient then success, rejected with a winner in `ShopSessions`, rejected with no winner                                                                                                | —                                                                                                                                                                                                                                                                                                                                                                   | dev/e2e store: load `/app`, wait > 1 h or force-expire `accessTokenExpiresAt` with a test-control `ExpireAccessToken`, trigger a webhook path, then see `GetShopSession` show a new expiry                                                                                                                                                          |
| 2 Storage               | `syncOrder` table (legacy reads the JSDoc table from source; port that test), `capProperties`, `toShopOrder` / `toOrderLineItems`, `OrderNode` decode of a recorded Shopify response                                                                                                                                             | `storeOrder` then `GetOrder`; version guard (older skipped, equal rewritten, newer wins and replaces items); ceiling refusal sets `ordersLimitedAt`; retention refusal; a merchant socket receives the notice on change and none on a same-version rewrite; a multi-statement transaction completes (the `MixedScheduler` regression)                               | —                                                                                                                                                                                                                                                                                                                                                   |
| 3 Ingress               | `validateWebhook`: 405, 401 bad HMAC, 400 missing headers, ok with `ShopKey`-decoded shop; payload decodes; toml subscriptions pinned (`?raw` import, as legacy does)                                                                                                                                                            | signed POST to `/webhooks/compliance` returns 200, unsigned 401; `app/scopes_update` rewrites `scope` (`GetShopSession`)                                                                                                                                                                                                                                            | `shopify app webhook trigger --topic customers/redact --address <tunnel>/webhooks/compliance --client-secret …` returns 200 (sample payload only)                                                                                                                                                                                                   |
| 4 Orders webhooks       | `orderRef` (edit vs order, missing GID, bad `updated_at`); the handler over layers: no session means no actor call; stale means no fetch; `null` order is gone, answered 200                                                                                                                                                     | signed `orders/create` for the seeded shop with the fake Admin answer (if Q6 says yes), then `GetOrder`                                                                                                                                                                                                                                                             | create an order on the e2e store via `draftOrderCreate` + `draftOrderComplete` through `shopify store execute` (the helpers already in `scripts/lib/stores.ts`), poll `GetOrder` until present; `orderCancel`, then `cancelledAt` set. Needs a one-time `shopify store auth` on each e2e store (the runbook marks the e2e store as unseeded today). |
| 5 Uninstall             | handler order and error mapping over layers (the destroy's abort rejection counts as success, other errors propagate)                                                                                                                                                                                                            | seed a shop with an order and a member socket; signed `app/uninstalled`: the socket closes with the uninstalled code, `GetShopSession` is null, the `Member` rows are gone, a fresh `GetOrder` is none; a signed `orders/create` afterwards makes no actor call (no storage written; probe with a test-control actor "exists" read that does not create, or by log) | manual, once per milestone: uninstall Baton Staging from `mw10013-staging-shop-00`, check the logs (`cf o11y` on `baton-backend-staging`), reinstall from the Dev Dashboard. Not automated: uninstalling the dev/e2e app disrupts `shopify app dev`.                                                                                                |
| 6 Bulk sync             | `bulkOrdersQueryText`; stream fold over an in-memory `HttpClient` layer (the legacy `shop-agent-orders-stream.test.ts` cases: fold, 250 cap, 8 KB cap, parent mismatch, undecodable line, partial failure keeps rows, one `syncedAt`, a fresher webhook row survives); the in-flight, stale-row and ceiling rules on `SyncState` | `streamOrders` with a JSONL the actor can fetch (a test-control route serving a posted body, or a local server; verify workerd can reach it); the Workflow under `alchemy dev` with a fake bulk repository if Q6 allows, else e2e only                                                                                                                              | staging store (3 orders): press Sync open orders, see 3 orders listed, a second press while running answers `InFlight`; e2e store after creating orders in the test                                                                                                                                                                                 |
| 7 One-order sync, sweep | sweep batch and chunking; `Gone` mapping                                                                                                                                                                                                                                                                                         | sweep deletes rows older than 365 days (insert with an old `processedAt`); sweep rate limit                                                                                                                                                                                                                                                                         | order page Sync from Shopify on a dev store                                                                                                                                                                                                                                                                                                         |
| 8 Orders screen         | —                                                                                                                                                                                                                                                                                                                                | merchant RPC read returns stored rows; a member is refused                                                                                                                                                                                                                                                                                                          | embedded admin: orders page lists the store's orders and updates after a webhook                                                                                                                                                                                                                                                                    |

---

## 7. Open questions

1. **Where do Admin API calls run?** Legacy called Shopify from inside the actor (D1 plus secret in the DO runtime). **Recommendation:** in the Backend (and a Backend-hosted Workflow) only; the actor stores, reads, and fetches the signed bulk URL. That keeps secrets and D1 out of the actor, puts the refresh race in one module, and matches "the Backend calls schemaless methods on the stub". The cost is two actor hops per webhook instead of one.
2. **Port token refresh as slice 1?** **Recommendation:** yes, before any webhook or sync work. Without it every background call fails an hour after the merchant last opened the app.
3. **Bulk completion: poll or `bulk_operations/finish`?** **Recommendation:** port legacy's 5 s / 5 min poll first. It is proven, needs no extra subscription, and Shopify itself says the webhook is not guaranteed. Add `waitForEvent` on `bulk_operations/finish` later if latency matters.
4. **What starts the bulk sync, and where is it tracked?** Legacy used a socket `@callable` that started an SDK workflow from the DO. **Recommendation:** a merchant server function → Backend → `actor.beginSync()`. That method applies the in-flight, staleness and ceiling rules and returns `Started | InFlight | Refused`. The Backend then creates the `Cloudflare.Workflow` instance and the actor records its id in `SyncState` (new `workflowId`, `startedAt` columns, edited into `0001_init`, then a reset). This avoids the unverified "create a Workflow from a DO" path. The alternative is a `MerchantSyncOpenOrders` socket RPC that creates the instance from the actor; it saves a hop but depends on that unverified path.
5. **Webhook work inline or on a Queue?** **Recommendation:** inline, as legacy does. One GraphQL call fits Shopify's 5 s budget, and a non-2xx keeps Shopify's retry as the recovery path. Revisit with a Queue if the logs show timeouts.
6. **How do integ tests reach a fake Admin API?** **Recommendation:** put Admin calls behind a `ShopifyAdmin` service and bind a fake one on the `test` environment, chosen at stack time like `ShopifyApp`, fed canned answers through test control. That makes slices 4 and 6 integ-testable without Shopify. The alternative is to unit-test the Backend handlers with layers, integ-test only the actor methods, and leave the full path to e2e.
7. **Is a minimal orders screen part of this slice?** **Recommendation:** yes, a thin one (slice 8: name, date, fulfillment and paid status, items), with no counts strip or filters. Without it the only way to see sync working is test control. Legacy's full orders index waits for the runs slice.
8. **Keep legacy's uninstall scope: delete members and teams with the shop?** **Recommendation:** yes, it is the same as legacy. The cascade is already in `0001_init.sql`, a merchant's data is the shop's, and keeping it would need a "pending delete" state and a retention job. Flag it in the help copy later.
9. **`shop/redact`: keep it a no-op?** **Recommendation:** yes, for legacy's reason (resurrection risk, undocumented reinstall suppression). With the §3.3 guard in place, a guarded "delete if no `ShopSession` and the actor has storage" would become safe, but that needs a way to ask whether an actor exists without creating it. Not worth it now.
10. **Subscribe `orders/delete`?** **Recommendation:** no, as legacy. A deleted order answers `null` on the next fetch and ages out by retention; deleting rows on a webhook would make a webhook destructive, against rule 9.
11. **Verify multi-checkout webhook delivery before e2e depends on it?** Two `shopify app dev` sessions (main on `e2e-shop-00`, `wt-01` on `e2e-shop-01`) share the Baton Dev app's toml subscriptions. **Recommendation:** a 15-minute spike at the start of slice 4: create an order on each store and check which tunnel receives it. If deliveries cross, the e2e webhook specs must run on one checkout at a time.
12. **Run the `orders/*` e2e on the e2e store or the dev store?** **Recommendation:** the e2e store, after a one-time `shopify store auth` with order write scopes, recorded in `docs/shopify-stores-runbook.md`. The tests create and cancel their own orders, tagged so `stores:seed`-style cleanup can find them, and never depend on seeded data.
