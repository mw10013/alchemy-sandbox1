# Actor ownership correction: research

Status: research, written 2026-10-17. **Settled** the same day: Q1–Q9, Q11, Q12 as recommended; Q10 revised (§0). No code has changed. Plan: `docs/actor-ownership-plan.md`. Implements `docs/legacy-port-research.md` §0.1 (A1–A3, decided 2026-10-17) over what slice A built (`docs/orders-slice-plan.md`). Slice C (`docs/members-teams-research.md`) is parked until this lands.

The correction makes the `ShopActor` the owner of its shop, as legacy's `ShopAgent` is: it holds `AuthDb`, calls the Admin API, refreshes the offline token, and starts and tracks the orders sync Workflow. Browser writes become merchant procedures, and one socket per tab lives in the layouts. The orders slice's behaviour does not change: the same screens, the same rules, the same tests by title. What moves is where each piece runs.

Legacy paths are relative to `refs/baton-legacy/`.

---

## 0. Decisions

Agreed in review, 2026-10-17. They are the plan's input.

| Q   | Decision                                                                                                                                                                                  |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | The actor yields the Backend's own `ShopSessions`, `Shopify`, `ShopifyAdmin` in its outer phase; one refresh module for actor and Workflow; `Members` with C.                             |
| Q2  | `MerchantSyncOpenOrders` creates the Workflow instance from the actor: the class if spike S1 holds, else a narrow handle over the Backend's binding.                                      |
| Q3  | Bulk Admin calls stay in the Workflow; its callbacks stay stub methods named `onOrdersStream`, `onOrdersSyncEmpty`, `onOrdersSyncError`.                                                  |
| Q4  | The one-order fetch runs in the actor (`OrdersAgent` in `src/backend/shop-actor/orders-agent.ts`), shared by the webhook and `MerchantSyncOrder`.                                         |
| Q5  | `orders/*` is one round trip: Backend HMAC, decode, installed check, then `syncOrderWebhook`.                                                                                             |
| Q6  | `MerchantSyncOpenOrders` and `MerchantSyncOrder` procedures; the server functions, `BackendApi` methods and request schemas are deleted.                                                  |
| Q7  | First-render reads unchanged (server function → Backend → stub); `MerchantSyncStatus` stays unseeded.                                                                                     |
| Q8  | Stub methods and `IntegRpcs` with no production caller are deleted; integ arranges orders by signed webhook; the stale record is pinned in unit.                                          |
| Q9  | The `/app` layout and a new `shop.$key.tsx` layout hold the socket; pages seed and read only; verified by an e2e socket count.                                                            |
| Q10 | Not ported (revised in review, 2026-10-17): Effect's RPC client pings every 5 s and reconnects on a missed pong; Alchemy's `RpcWebSocket` answers at the edge and owns the auto-response. |
| Q11 | `SocketBanner` ports into the layout holder with legacy's states and copy.                                                                                                                |
| Q12 | One implementation thread on `main`; staging by `deploy:staging`, no reset.                                                                                                               |

---

## 1. How legacy does each mechanism

What legacy runs where, before anything we propose. Sources: `src/lib/ShopAgent.ts`, `agent/Orders.ts`, `Shopify.ts`, `OrdersSyncWorkflow.ts`, `ShopAgentSocketHost.tsx`, `routes/app.tsx`, `routes/shop.$shop.tsx`, `routes/webhooks.*`, `src/worker.ts`, `wrangler.jsonc`.

### 1.1 Runtimes and what they hold

Legacy is one Worker script. The Worker, the `ShopAgent` object and `OrdersSyncWorkflow` all see the same `env`: `D1`, `SHOP_AGENT`, `ORDERS_SYNC_WORKFLOW`, `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET` and the vars. Nothing is scoped per class.

| Runtime                       | Built                                                                                                                                                       | Holds                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Worker (`src/worker.ts`)      | A `ManagedRuntime` per request over `env.D1.withSession`.                                                                                                   | D1 `Repository`, `Shopify` (the secret, `authenticateAdmin`, `validateWebhook`), Partner API.                                                                                                                                                                                                                                                                                                                                  |
| `ShopAgent` (`makeRunEffect`) | One `ManagedRuntime` per activation, in the constructor; migrations run under `blockConcurrencyWhile`. `ConfigProvider.fromUnknown(env)` reads the secrets. | D1 `Repository` on the raw binding (primary, because refresh is correctness-sensitive); `Shopify` (`ensureShopSession`, refresh, the GraphQL client); the actor's SQLite repositories; `FetchHttpClient`; `ShopifyAppEvents`; the host (`publish`, `closeMemberConnections`). `ShopifyAdmin` is **not** in the runtime: it is built per call from the session `ensureShopSession` returns, so a rotated token is never pinned. |
| `OrdersSyncWorkflow`          | A `ManagedRuntime` per run, disposed in `finally`.                                                                                                          | D1 `Repository` (primary), `Shopify`, and `this.agent`, the SDK's stub to the object named in the params.                                                                                                                                                                                                                                                                                                                      |

### 1.2 Admin API and token refresh

- **The object** makes the one-order calls. `fetchAndUpsertOrder` (`agent/Orders.ts`): `ensureShopSession(host.shop())` → `ShopifyAdmin.graphqlDecode(OrderSyncResponse, orderSyncQuery)` with a per-call `ShopifyAdmin` layer → `upsertOrder` with the reconcile `afterWrite`. Both the webhook path and "Sync from Shopify" use it.
- **The Workflow** makes the bulk calls itself: `ensure-session` (a refresh if due), `run-bulk-orders-query`, the polls and the cancel, each through a per-step `ShopifyAdmin` over the session.
- **The Worker** calls Shopify only for auth: `authenticateAdmin`'s token exchange and the first install's `fetchShopGid`. No route makes an order call.
- **Refresh** (`Shopify.ensureShopSession`, `recoverRefreshRace`) runs wherever the caller is, the object or the Workflow, against the same D1 rows. D1 is the only coordination.

### 1.3 The orders sync

- **Start.** `ShopAgent.syncOpenOrders` is a merchant `@callable` on the socket. It refuses while a fresh SDK tracking row exists (`SYNC_STALE_MS`, 10 minutes; a stale row is deleted), with `syncStarting` closing the window during the create; refuses at the ceiling (`markOrdersLimited`, publish); otherwise clears `lastError` and `ordersLimitedAt`, calls `this.runWorkflow("ORDERS_SYNC_WORKFLOW", {shop})` **from inside the object**, publishes and answers `Started`.
- **Callbacks.** The Workflow calls the object through `this.agent`: `onOrdersStream({url})` (the object fetches the signed bulk file and folds it), `onOrdersSyncEmpty()`, `onOrdersSyncError({message})` from the `Effect.onError` sink step. The SDK's `onWorkflowComplete` / `onWorkflowError` delete the tracking row.
- **Status.** The loader reads `syncInFlight` once; the socket query keeps it live.

### 1.4 Webhooks

- HMAC is checked in the Worker (`handleWebhook` → `validateWebhook`).
- **`orders/*`: one round trip.** The route decodes the payload and awaits `SHOP_AGENT.getByName(shop).syncOrderWebhook({orderId, topic, updatedAt})`. Everything else is in the object, in that one call: version probe, ceiling for a new order, `fetchAndUpsertOrder`, the rate-limited sweep, publish, usage flush. There is no installed-shop check first (the hole the orders research closed, §3.3).
- **`app/uninstalled`:** usage flush (object), `deleteShopSession` (Worker, D1), `destroyShopAgent` (object). **`app/scopes_update`:** D1 from the Worker. **Compliance:** validated no-ops.

### 1.5 Reads and writes from the browser

- **First render.** Each route's `getLoaderData` server function reads the object over its RPC stub (`ShopAgentClient`, `env.SHOP_AGENT.getByName(shop).listOrders(...)`) and D1 through `Repository`. Loaders never use the socket. Example: `app.orders.index.tsx` reads `listOrders` and `getUsage` from the object.
- **Live.** `useLiveQuery({read: stub => stub.listOrders(input), initialData})` re-reads the same method over the socket, refetches on `{type: "invalidated"}` (throttled 2 s, deferred while the tab is hidden) and on every identify.
- **Writes.** Every write a page makes to the object is a socket call (`agent.stub.syncOpenOrders()`, `stub.syncOrder({orderId})`, the workflow editor, run actions). D1-only writes (members, team rename and membership) are POST server functions that write D1 and then call `revokeMemberConnections` on the stub.

### 1.6 The socket

- `ShopAgentSocketProvider` (`src/lib/ShopAgentSocketHost.tsx`) is mounted **in the layouts**: `routes/app.tsx`'s `AppRouteContent` (merchant; `query` mints `shopify.idToken()` on every connect) and `routes/shop.$shop.tsx` (member; the cookie rides the same-origin upgrade). It opens once per tab after hydration and stays open across child navigation.
- It holds `identified` (true on the identity frame) and `displaced`, and runs three effects: frame evidence; a **watchdog** (every 30 s and on `visibilitychange`, reconnect a socket that is OPEN but has seen no frame for 310 s); a **keepalive** (`SocketKeepalivePing` every 240 s, answered at the edge by `ctx.setWebSocketAutoResponse` without waking the object).
- `SocketBanner`, in the layout: nothing while identified; "Signed in elsewhere" with Reconnect when displaced; after a 4 s grace, "lost its connection".
- The gate (`routeAgentRequest` with `authorizeShopAgentRequest`) checks the token or cookie once, at connect.

---

## 2. Where this repo diverged, and where it already matches

| Mechanism                          | Legacy                                                     | Here today (slice A)                                                                                                 | After the correction                                                                 |
| ---------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| D1 in the object                   | yes, read and write                                        | none: the actor yields only `DurableObjectState`                                                                     | `AuthDb` through `ShopSessions` (Q1); `Members` joins with C                         |
| Shopify secret, `Shopify`, refresh | in the object and the Workflow                             | Backend and Workflow only                                                                                            | the actor too, the same modules (Q1)                                                 |
| One-order Admin call               | object (`fetchAndUpsertOrder`)                             | Backend `Orders.fetchOrder`                                                                                          | actor (Q4)                                                                           |
| Bulk Admin calls                   | Workflow                                                   | Workflow                                                                                                             | Workflow, unchanged (Q3)                                                             |
| Who creates the sync Workflow      | object (`runWorkflow`)                                     | Backend `Orders.beginOpenOrdersSync`, after `actor.beginSync`                                                        | actor, inside `MerchantSyncOpenOrders` (Q2)                                          |
| Workflow → object callbacks        | `onOrdersStream`, `onOrdersSyncEmpty`, `onOrdersSyncError` | `streamOrders`, `syncEmpty`, `syncFailed`                                                                            | same three stub methods, legacy's names (Q3)                                         |
| Tracking a running sync            | SDK row + `syncStarting`                                   | `SyncState.workflowId`, `startedAt`                                                                                  | unchanged; the record is written in the same transaction that decides `Started` (Q2) |
| `orders/*` webhook                 | one round trip, `syncOrderWebhook`                         | two: `orderVersion`, then Backend fetch, then `storeOrder`                                                           | one: installed check in the Backend, then `syncOrderWebhook` (Q5)                    |
| Uninstall, scopes update, HMAC     | Worker                                                     | Backend                                                                                                              | unchanged                                                                            |
| First-render read                  | server function → object stub                              | server function → Backend → `listOrders` stub                                                                        | unchanged (Q7)                                                                       |
| Sync buttons                       | socket callables                                           | server functions → `BackendApi.syncOpenOrders` / `syncOrder`                                                         | `MerchantSyncOpenOrders`, `MerchantSyncOrder` (Q6)                                   |
| Socket lifetime                    | one per tab, in the layouts                                | one per page: `OrdersPage`'s `LiveOrders` and `ShopPage`'s `LiveShop` name it; released 400 ms after the last reader | one per tab, in `/app` and the member shop layout (Q9)                               |
| Keepalive, watchdog                | 240 s ping, 310 s stale watchdog                           | Effect's 5 s RPC ping, answered at the edge by Alchemy's auto-response                                               | unchanged (Q10)                                                                      |
| `SocketBanner`                     | in the layouts                                             | `lostAtom` exists; no banner                                                                                         | in the layouts (Q11)                                                                 |

**The per-page socket, confirmed by reading.** The `ShopActorClient` runtime atom comes from `Atom.context()` with `keepAlive` false, so the registry (`defaultIdleTTL: 400` in `src/web/router.tsx`) disposes it, and its socket, 400 ms after the last subscriber unmounts. App Home reads no socket atom. Orders → App Home → Orders therefore opens a second socket. Even inside 400 ms it would: `nameOrdersSocket` stores fresh `Option.some(...)` values, atom equality is `Object.is`, and the protocol layer is rebuilt. "Next page" keeps the socket, because the route component stays mounted. The fix is verified by counting sockets (§8, sub-slice 4).

---

## 3. Each callable sorted

The rule (`docs/legacy-port-research.md` Q5 as tightened by A2): first-render read → server function → stub method; browser write or live read → role-prefixed procedure; anything the Backend or a Workflow does to the actor → stub method. Only the orders surface exists today; the counter procedures stay as they are.

| Legacy                                                     | Kind here                               | Name here                                                                | Change                                                                                                         |
| ---------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `listOrders` (loader)                                      | server function → Backend → stub method | `listOrders` server function, `BackendApi.listOrders`, stub `listOrders` | unchanged                                                                                                      |
| `listOrders` (`useLiveQuery`)                              | procedure                               | `MerchantListOrders`                                                     | unchanged                                                                                                      |
| `syncInFlight` (loader) + live status                      | procedure                               | `MerchantSyncStatus`                                                     | unchanged; not seeded (Q7)                                                                                     |
| `syncOpenOrders`                                           | procedure                               | `MerchantSyncOpenOrders` → `OrdersSyncResult`                            | new; replaces the server function, `BackendApi.syncOpenOrders`, `Orders.beginOpenOrdersSync`, stub `beginSync` |
| `syncOrder`                                                | procedure                               | `MerchantSyncOrder({orderId})` → `SyncOrderResult`                       | new; replaces the server function, `BackendApi.syncOrder`, `Orders.syncOrder`                                  |
| `syncOrderWebhook`                                         | stub method                             | `syncOrderWebhook({orderId, topic, updatedAt})`                          | new; replaces stubs `orderVersion` and `storeOrder` and `Orders.fetchOrder`/`syncOrderFromWebhook`             |
| `onOrdersStream`, `onOrdersSyncEmpty`, `onOrdersSyncError` | stub methods (the Workflow)             | `onOrdersStream`, `onOrdersSyncEmpty`, `onOrdersSyncError`               | renamed from `streamOrders`, `syncEmpty`, `syncFailed` (Q3)                                                    |
| `onWorkflowComplete` / `onWorkflowError`                   | none                                    | —                                                                        | no SDK; the callbacks clear the record, `SYNC_STALE_MS` covers a run that dies outside every task              |
| `destroy` (SDK)                                            | stub method                             | `destroy`                                                                | unchanged                                                                                                      |
| `getOrderDetail` (loader)                                  | stub method                             | `getOrder`                                                               | kept for F's order page loader                                                                                 |
| (none)                                                     | stub method (`DevRpcs`)                 | `removeOrder`, `loadFixture`, `addFixture`, `snapshot`, `revoke`         | unchanged                                                                                                      |

**Failures on the new procedures.** `MerchantSyncOrder` and `MerchantSyncOpenOrders` declare the session failures the server functions answered as `OrdersCallFailure` today: `OfflineSessionMissing`, `ReauthorizationRequired`, `ShopifyUnavailable`. `ShopNotInstalled` cannot happen on a socket (the gate refused it at connect, and uninstall closes it with 4410); if the row vanished mid-session, `OfflineSessionMissing` is the honest answer.

**Notices.** Unchanged in content, moved with their writes:

| Write                                    | Notifies                                                                            |
| ---------------------------------------- | ----------------------------------------------------------------------------------- |
| `syncOrderWebhook`                       | `ORDERS_KEY` when the order changed or the sweep deleted something (legacy rule 17) |
| `MerchantSyncOrder`                      | `ORDERS_KEY` when changed                                                           |
| `MerchantSyncOpenOrders`                 | `SYNC_KEY` on `Started`; nothing on `InFlight`; on `Refused` as built today         |
| `onOrdersStream`                         | `ORDERS_KEY` and `SYNC_KEY`; `ORDERS_KEY` also when the stream fails partway        |
| `onOrdersSyncEmpty`, `onOrdersSyncError` | `SYNC_KEY` when the record was cleared                                              |
| a Workflow create that fails             | `SYNC_KEY` (the record is cleared and `lastError` set, in the procedure)            |

---

## 4. What carries over unchanged

- Every pure piece: `src/domain/orders.ts`, `order-sync.ts`'s mapping, `orders-bulk.ts`, `orders-stream.ts`, the repository (`src/backend/shop-actor/orders.ts`) including `beginSync`'s rules on `SyncState`, the constants.
- `Shopify.ensureShopSession`, the lease and race recovery, `ShopifyAdmin` built per call: the same modules, now also yielded by the actor (Q1). The D1 lease already coordinates two callers, which is exactly legacy's situation with the object and the Workflow.
- The Workflow's steps, names, retries and sink (`src/backend/orders-sync-workflow.ts`). It stays a Backend-script class, as legacy's was in its one script.
- Webhook ingress on the Website, HMAC in the Backend, `scopes_update`, compliance, uninstall teardown with `storage.sync()` before `abort`, the installed-shop check before any `getByName` on a background path.
- The gate, roles, close codes, notices, displacement, expiry; the first-render read path.
- The actor's tables: nothing in `0001_init` changes, so staging needs `deploy:staging`, not a reset.

---

## 5. What must change

### 5.1 The actor's construction phase (Q1)

The actor yields, in its outer phase, the services it now uses: `ShopSessions` (over `Cloudflare.D1.QueryDatabase(AuthDb)`), `Shopify` (the secret through `Config.Redacted`, bound on the Backend in `stack.ts`), `ShopifyAdmin`, and the Workflow handle (Q2). Alchemy runs the outer phase at plan time against a mock state inside the hosting Worker's init, so any binding it takes attaches to the Backend's script, which the actor shares. At runtime the phase runs once per activation inside `blockConcurrencyWhile`. The rule from Alchemy's JSDoc applies: take handles in the outer phase, do I/O only in methods.

What Alchemy proves (`refs/alchemy/packages/alchemy/`):

| Claim                                    | Evidence                                                                                                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| D1 yielded in a DO's outer phase         | `test/Cloudflare/Workers/TaggedDO.test.ts` with `fixtures/tagged-do/object.ts` (deployed only, no local variant)                            |
| `Config.String` in a DO's outer phase    | `SqlMigrations.upgrade.test.ts`, local and deployed                                                                                         |
| `Config.Redacted` in a DO                | not tested; the same interceptor (`src/Platform.ts`) serves it, and a Workflow reads one in `examples/cloudflare-dev/src/NotifyWorkflow.ts` |
| A Workflow handle yielded in a DO        | **no test or example**; type-checks; yielding the class re-runs its registration and the Workflow's own outer phase on every activation     |
| A Workflow calling a DO                  | `WorkflowLifecycle.test.ts`, local and deployed (the fixture retries a cold object's "RPC receiver does not implement the method")          |
| `HttpClient` in a DO                     | present through the shared isolate build; the actor already provides `FetchHttpClient.layer` itself                                         |
| `ShopifyFake` reaching code in the actor | yes by construction: the actor activates in an isolate that ran the test Backend's init, including `setAbstractFetchFunc(fake)`             |

**The layer cycle.** `ShopActors` yields `ShopActor`; the Workflow's outer phase yields `ShopActors`. If the actor's outer phase yields `OrdersSyncWorkflow`, the actor needs the Workflow, which needs the actor. Whether Alchemy's lazy class yields break the cycle or recurse is the first thing spike S1 settles (§7, Q2).

### 5.2 Admin API in the actor (Q4)

`fetchAndUpsertOrder` moves into the actor as legacy has it: `ShopifyAdmin.graphqlDecode(shop, OrderSyncResponse, orderSyncQuery, ...)` then `upsertOrder`. `syncOrderWebhook` and `MerchantSyncOrder` both use it. The Backend's `Orders` service loses `fetchOrder`, `syncOrder` and `beginOpenOrdersSync`; what is left (installed check, then `syncOrderWebhook`) folds into `Webhooks.ordersWebhook`, and `src/backend/orders.ts` goes.

Two rules the move must keep:

- **No Admin call inside `transaction()`.** The sync scheduler exists because timers do not fire behind the storage transaction's input gate; the refresh's retries and lease poll are timers. Legacy fetched first and wrote after; so does this.
- **Interleaving is safe**, as legacy states: the actor's input gate opens during the outbound fetch, so a webhook can interleave with a bulk stream or another webhook. Per-order transactions plus the version guard keep it harmless.

### 5.3 The sync start (Q2)

`MerchantSyncOpenOrders` in the actor: `workflowId = crypto.randomUUID()`; `orders.beginSync({workflowId, now})` in its transaction (the in-flight, stale and ceiling rules, recording `workflowId` and `startedAt` on `Started`); then, outside the transaction, `workflow.create({id: workflowId, params: {shop}})`; if the create fails, clear the record and set `lastError` (today's `syncFailed` path), notify `SYNC_KEY`, and fail. Writing the record before the create, in the same transaction that decides `Started`, does what legacy's `syncStarting` did: a second press during the create answers `InFlight`.

### 5.4 Writes as procedures (Q6)

`src/web/server/orders.ts` keeps `listOrders` only; `syncOpenOrders` and `syncOrder` go, with `BackendApi.syncOpenOrders` / `syncOrder` and `SyncOpenOrdersRequest` / `SyncOrderRequest` in `src/contract/orders.ts`. `OrdersPage` calls the two procedures as mutation atoms. The toasts and banner copy are unchanged.

### 5.5 One socket per tab (Q9–Q11)

- A `ShopSocket` component (name to settle in the plan) in the `/app` layout and the member shop layout: it names the socket once per shop and token (`nameSocket`), mounts the client's runtime atom and `noticesAtom` for as long as the layout is mounted, and renders `SocketBanner`.
- `app.tsx`'s `component: Outlet` becomes that component around `<Outlet/>`. The member area gets a layout: `shop.$key.tsx` holds the socket and renders `<Outlet/>`, and today's page moves to `shop.$key.index.tsx`.
- Pages seed their queries (`seedOrders`, `seedShop`) and read them; they never call `nameSocket`. `nameOrdersSocket` goes.
- The merchant token is minted on every connect from App Bridge, as today.

---

## 6. Risks

- **The layer cycle** (§5.1). If the actor cannot yield the Workflow class, it takes a narrow handle over the Workflow binding the Backend already registers (Q2). Either way the Backend no longer creates instances.
- **A Workflow created from a Durable Object** has no proof in Alchemy, locally or deployed. Spike S1 runs it in both.
- **Refresh from two runtimes at once.** The actor (webhooks, one-order sync) and the Workflow (bulk) can refresh the same shop concurrently. The D1 lease and `rotateTokens`' compare-and-swap already handle concurrent callers in one Worker; across the actor and the Workflow it is the same D1 row. Keep the integ case "five concurrent syncs refresh once", now over five merchant procedure calls.
- **The actor's activation grows.** Building `Shopify` (`shopifyApi`, cached lazily) and its layers per activation adds work to every wake. Legacy did the same per constructor. Measure nothing yet; watch the staging logs.
- **The member shop route split** touches the member e2e specs' URLs only if a path changes; it does not (`/shop/$key` stays, served by the index child).
- **The missed-row report** (orders plan §7, Step 8) may or may not be the per-page socket. One socket per tab and the Info logs on accept and close make the next occurrence diagnosable (§9).

---

## 7. Spikes before the plan's steps

Each is the first thing its sub-slice does; the plan says what happens if it fails.

- **S1. The actor creates a Workflow instance**, locally (`alchemy dev`, the test stage) and on staging. First try: yield `OrdersSyncWorkflow` in the actor's outer phase and call `create`. If the cycle (§5.1) recurses or the registration misbehaves, second try: a narrow `OrdersSyncWorkflows` handle in the actor built from the binding the Backend registers (`WorkerEnvironment`, the Workflow's binding name), wrapping `create` and `get(id).status()`. Record which held.
- **S2. Shopify in the actor.** `Config.Redacted("SHOPIFY_API_SECRET")` and `Cloudflare.D1.QueryDatabase(AuthDb)` resolved in the actor's outer phase, one `ensureShopSession` and one GraphQL call from a stub method: locally against `ShopifyFake` (integ), and on the dev store for real.

---

## 8. Proposed order of work

One implementation thread on `main` (`wt-01` stays idle: every step touches `src/backend/shop-actor.ts`). Each sub-slice ends green.

| #   | Sub-slice                       | Delivers                                                                                                                                                                                                                                |
| --- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **The actor's services**        | S2; the actor yields `ShopSessions`, `Shopify`, `ShopifyAdmin`; `fetchAndUpsertOrder` in the actor; `syncOrderWebhook` (one round trip); `MerchantSyncOrder`; stubs `orderVersion`, `storeOrder` and `Orders.fetchOrder`/`syncOrder` go |
| 2   | **The sync start in the actor** | S1; `MerchantSyncOpenOrders` creates the Workflow; callbacks renamed `onOrdersStream`, `onOrdersSyncEmpty`, `onOrdersSyncError`; `Orders.beginOpenOrdersSync`, stub `beginSync`, `OrdersSyncWorkflows` in the Backend go                |
| 3   | **The browser's writes**        | `OrdersPage` calls both procedures; the two server functions, `BackendApi` methods and request schemas go; `src/backend/orders.ts` goes                                                                                                 |
| 4   | **One socket per tab**          | the layout socket holder in `/app` and `/shop/$key`; `shop.$key.index.tsx`; `SocketBanner`; pages only seed and read                                                                                                                    |
| 5   | **Docs, staging**               | `docs/legacy-port-research.md` §1.3 and §2 rewritten to the corrected architecture; glossary (`Stub`, `Gate`, `Actor` rows); `deploy:staging` and the staging check                                                                     |

---

## 9. Testing per sub-slice

The test machinery stays: `ShopifyFake` reaches the actor's isolate (§5.1); the forged-caller route on the test Backend opens a merchant socket, which is how integ calls the new procedures. `DevRpcs` does not grow.

**`IntegRpcs` shrinks** (Q8): `OrderVersion`, `StoreOrder`, `TrackSync`, `SyncOpenOrders`, `SyncOrder`, `ApiSyncOpenOrders`, `ApiSyncOrder` go with the stubs and methods they call. integ arranges an order the way production gets one: a signed `orders/*` webhook with the order scripted into `ShopifyFake`. `SyncFailed` becomes the `onOrdersSyncError` stub call it is.

| #   | Unit                                                                                                                                                                                                                      | Integ                                                                                                                                                                                                                                                                                                                                                              | Browser                                                                                                                               | E2E (real Shopify)                                                                                                                                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `fetchAndUpsertOrder` and `syncOrderWebhook` over layers (stale skips the fetch, a new order at the ceiling marks and skips, `null` is gone); the existing `orders.test.ts` cases that tested `Orders` move with the code | `webhooks.test.ts` unchanged by title (one GraphQL call, stale skip, edited always fetches, gone, redelivery, no session creates no storage); `orders.test.ts`'s version-guard, ceiling and notice cases arranged by webhook; `MerchantSyncOrder` over a forged merchant socket (`Stored`, `Gone`); `shopify-refresh.test.ts`' five cases over `MerchantSyncOrder` | —                                                                                                                                     | `refresh.spec.ts` unchanged: "Sync from Shopify" now refreshes in the actor                                                                                                                                                                                           |
| 2   | `ordersSyncBody` unchanged; the start's rules stay in the repository's `beginSync` cases, the stale record included (explicit `now`)                                                                                      | `orders-sync.test.ts` over `MerchantSyncOpenOrders` on a forged merchant socket: completes through `on-orders-stream`, `on-orders-sync-empty`, a second press is `InFlight`, the banner sentence, the sink after a die; legacy titles kept; the stale-record case is unit only                                                                                     | —                                                                                                                                     | `orders.spec.ts`' "Sync open orders brings back an open order the screen no longer lists" unchanged                                                                                                                                                                   |
| 3   | —                                                                                                                                                                                                                         | a member socket is refused `MerchantSyncOpenOrders` and `MerchantSyncOrder`; "the stream's callbacks are not callable from a socket" keeps its title over the renamed stubs                                                                                                                                                                                        | `OrdersPage.test.tsx`: the toasts and banner from procedure answers (the in-memory server in `test/browser/shop-actor.ts` gains both) | unchanged                                                                                                                                                                                                                                                             |
| 4   | the banner's states                                                                                                                                                                                                       | a socket that stops answering pings is dropped and reconnects (the client's missed-pong path), through the forged-caller route                                                                                                                                                                                                                                     | `SocketBanner` states; a page that seeds without naming the socket                                                                    | **one socket across Orders → App Home → Orders** (`page.on("websocket")` counts sockets opened by the app frame: exactly one); the member shop page keeps its socket across its own navigation once F adds children                                                   |
| 5   | —                                                                                                                                                                                                                         | —                                                                                                                                                                                                                                                                                                                                                                  | —                                                                                                                                     | staging by hand on `mw10013-staging-shop-00`: Sync open orders lists the store's orders (the Backend log shows the actor creating the instance); Sync from Shopify on one order answers; a new order arrives by webhook; one socket across Orders → App Home → Orders |

Legacy tests that land here: `shop-agent-callables.test.ts`'s role table for the orders callables (`syncOpenOrders` and `syncOrder` merchant-only) becomes the integ member-refusal case; `orders-sync-workflow.test.ts`' titles stay where slice A put them.

---

## 10. Carried-over open items

From the orders plan's §7 "Implementation review", triaged:

- **Closed** by its §7 "Follow-up round 1": fixture rows' button and admin link are hidden; `orders.spec.ts`' third case waits for the spec's own order; `app/scopes_update` without `current` answers 400; `/app/orders` has "Next page"; the compliance JSDoc sentence is back. `ORDER_SYNC_WINDOW_DAYS` stays in `src/contract/orders.ts` (decided there). The `vp run fixture` note is in the runbook.
- **Touched by this correction:** one order did not reach an already-open orders page until reload. The correction removes the per-page socket; the socket's accept and close are logged at Info since round 2. Sub-slice 4 ends with the dev-store check repeated: an Orders tab open for several minutes, then an order created in the Shopify admin, row seen without reload; if it recurs, the logs now say whether the socket was open.
- **Left listed:** the one-time `embedded/app.spec.ts` hydration timeout.

---

## 11. Questions and recommendations

1. **How does the actor get D1 and Shopify?** Legacy's object built its own runtime over `env.D1` and the secrets. **Recommendation:** the actor yields the Backend's own services in its outer phase (`ShopSessions` over `AuthDb`, `Shopify`, `ShopifyAdmin`), the same modules and the same layers the Backend provides, no copy. One refresh module, used by the actor and the Workflow, as legacy's `Shopify.ts` was used by both. `Members` joins the actor with slice C, which is the first to need it (A1's "read and write" is met by `ShopSessions` now).
2. **How does the actor create the Workflow instance?** Legacy: `this.runWorkflow(...)` from the object. **Recommendation:** inside `MerchantSyncOpenOrders`, through Alchemy's `OrdersSyncWorkflow` class yielded in the actor's outer phase if spike S1 shows the cycle resolves; otherwise through a narrow handle over the binding the Backend registers. The record is written before the create in `beginSync`'s transaction (§5.3).
3. **Do the bulk Admin calls stay in the Workflow, and what do its callbacks become?** Legacy's Workflow made them itself, holding D1 and the secrets, and called the object back. **Recommendation:** yes, unchanged; the three callbacks stay stub methods (the Workflow is a Backend-side caller, rule 16 holds by construction) and take legacy's names: `onOrdersStream`, `onOrdersSyncEmpty`, `onOrdersSyncError`.
4. **Where does the one-order fetch run?** **Recommendation:** in the actor, as legacy's `fetchAndUpsertOrder`, shared by the webhook and `MerchantSyncOrder`. The actor's order code goes in `src/backend/shop-actor/orders-agent.ts` as `OrdersAgent` (legacy's `agent/Orders.ts` and its name), beside the repository.
5. **The `orders/*` webhook: one round trip?** **Recommendation:** yes. The Backend validates, decodes, checks `ShopSessions.find` (the guard legacy lacked, which must run before `getByName`), and awaits `syncOrderWebhook({orderId, topic, updatedAt})`. The actor does the probe, ceiling, fetch, store, sweep and notice in that call. A stub failure is non-2xx, so Shopify retries.
6. **The two sync buttons.** **Recommendation:** `MerchantSyncOpenOrders` (→ `OrdersSyncResult`) and `MerchantSyncOrder({orderId})` (→ `SyncOrderResult`), declaring `OfflineSessionMissing`, `ReauthorizationRequired`, `ShopifyUnavailable` (§3). The server functions, `BackendApi` methods and request schemas are deleted, not kept beside them.
7. **First-render reads.** **Recommendation:** unchanged: `/app/orders`' loader calls the `listOrders` server function → `BackendApi.listOrders` → stub `listOrders`, and seeds `MerchantListOrders`, as legacy's loader read the object's stub. `MerchantSyncStatus` stays unseeded (the banner appears a frame after hydration; legacy's loader seeded it); seed it if that frame shows.
8. **Stub methods that lose their production caller** (`orderVersion`, `storeOrder`, `beginSync`, and the `IntegRpcs` that call them). **Recommendation:** delete them. Production code keeps no method only a test calls (testing research Q15's line). integ arranges orders by signed webhook through `ShopifyFake`, the path production uses; the stale-record rule is pinned in unit over the repository with an explicit `now`.
9. **Who holds the socket?** **Recommendation:** the layouts, as legacy: a socket holder component in `app.tsx` and a new `shop.$key.tsx` layout (the page moves to `shop.$key.index.tsx`). It names the socket once per shop, keeps the client's runtime and `noticesAtom` mounted while the layout is, and renders the banner. App Home holds the socket too, as legacy's `/app` did. Verified by the e2e socket count.
10. **Keepalive and watchdog.** The socket now lives as long as the tab. **Recommendation:** port both now: a ping every 240 s answered by `state.setWebSocketAutoResponse` (no wake, no hibernation cost), and a watchdog every 30 s and on `visibilitychange` that reconnects a socket OPEN with no frame for 310 s. Legacy's constants and reasons, verbatim in JSDoc.
    **Decision (review, 2026-10-17):** not ported. The recommendation rested on a wrong fact: the stack already has both. Effect's `RpcClient` socket protocol pings every 5 s and fails and reconnects a socket that misses a pong (`makePinger` in `refs/effect/packages/effect/src/rpc/RpcClient.ts`), and Alchemy's `RpcWebSocket` answers that ping at the edge with `setWebSocketAutoResponse` and dies if anything else sets the auto-response (`refs/alchemy/packages/alchemy/src/Cloudflare/Workers/RpcWebSocket.ts` `make`). The plan pins that a silent socket reconnects, and the holder's JSDoc says why legacy's keepalive and watchdog are absent.
11. **`SocketBanner`.** **Recommendation:** port it into the layout holder now, with legacy's three states and copy (lost after 4 s, displaced with Reconnect; uninstalled from 4410 as today's terminal outcome). `lostAtom` and the close outcomes already exist. Slice C's Q10 then has nothing to add.
12. **Where it runs.** **Recommendation:** one implementation thread on `main`, in the order of §8; `wt-01` stays idle. No schema change, so staging is `vp run deploy:staging` and a push, not a reset.
