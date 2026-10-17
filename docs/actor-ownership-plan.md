# Plan: the actor ownership correction

Implements `docs/actor-ownership-research.md` (settled 2026-10-17, Q1–Q12; Q10 revised) under `docs/legacy-port-research.md` §0.1 (A1–A3 and the refinement below them). Read the research's §0, §1, §3 and §5 first; this plan does not restate the reasons.

Legacy paths are relative to `refs/baton-legacy/`.

## 0. Rules for the implementer

- Follow `AGENTS.md`: Vite+ only (`vp`, never npm or npx); `vp check --fix` after every step; Effect Schema for parsing; `Match` for tag dispatch; `Schema.TaggedError`; `Effect.fn("name")`; the JSDoc rules (no `//` above a declaration, no reference to this plan, the research or any `docs/` file in code); the logging and SQL rules.
- Work on `main` in the main checkout. Commit at the end of each green step.
- Each step ends green: `vp check`, `vp test` (unit, browser, integ) and `vp run test:e2e`. A step that cannot end green is recorded in §7 before moving on.
- A step that adds or deletes a route under `src/web/routes/` regenerates `src/web/routeTree.gen.ts` (`vp build`) before `vp check`.
- No table changes. Never `db:reset`, `cloud:reset` or `alchemy deploy`; never touch the `dev` or `staging` stages beyond running the dev server.
- **Behaviour does not change.** Every screen, rule, log line form, notice and test title from slice A stays, unless a step names the change. A test that moves to a new path keeps its title byte for byte.
- Each callable lands as the research's §3 table says, and nothing else: a server function for a first-render read, a role-prefixed procedure for a browser write or live read, a stub method for what the Backend or the Workflow does to the actor. No stub method may exist that only a test calls.
- Legacy is the spec, not the source; keep legacy's names where §3 below gives them.
- Do not rewrite the steps. Record what you built differently, and what surprised you, in §7 as you go.
- The integ suite leaks `.alchemy/local/baton-test-…-ShopActor` directories; delete the ones your runs create.

## 1. Outcome

- The `ShopActor` holds `ShopSessions` (over `AuthDb`), `Shopify` and `ShopifyAdmin`. It fetches one order from the Admin API itself (webhooks, "Sync from Shopify"), refreshes the offline token when that call needs it, and creates the orders sync Workflow instance itself.
- An `orders/*` webhook makes one actor round trip, `syncOrderWebhook`, after the Backend's HMAC check and installed-shop check.
- "Sync open orders" and "Sync from Shopify" are the merchant procedures `MerchantSyncOpenOrders` and `MerchantSyncOrder`. The two server functions, their `BackendApi` methods and request schemas, `src/backend/orders.ts`, and the stubs `orderVersion`, `storeOrder` and `beginSync` are gone.
- The Workflow keeps its bulk calls; its callbacks are `onOrdersStream`, `onOrdersSyncEmpty`, `onOrdersSyncError`.
- One socket per tab: the `/app` layout and the member shop layout hold it; Orders → App Home → Orders opens exactly one socket. `SocketBanner` shows in both layouts.

## 2. What this plan rests on

- **Alchemy, proven** (research §5.1): D1 yielded in a Durable Object's outer phase (`TaggedDO.test.ts`, deployed); `Config.String` there (`SqlMigrations.upgrade.test.ts`, local and deployed); a Workflow calling a Durable Object (`WorkflowLifecycle.test.ts`). The outer phase runs at plan time inside the Backend's init (bindings attach to the Backend's script) and once per activation at runtime; take handles there, do I/O in methods.
- **Alchemy, unproven**, checked first in the step that needs it: `Config.Redacted` read in the actor's outer phase (Step 1, S2); a Workflow instance created from the actor, and whether yielding `OrdersSyncWorkflow` in the actor recurses through `ShopActors` (Step 2, S1).
- **The test machinery reaches the actor.** The actor activates in an isolate that ran the test Backend's init, so `ShopifyFake`'s `setAbstractFetchFunc` covers the Shopify library inside the actor. The forged-caller route (`/api/integ/actor/<key>`, `x-test-caller`) opens a merchant socket for integ; `test/integ/actor-clients.ts` has `connectAs` and `socketUrl`.
- **The socket already keeps itself alive.** Effect's `RpcClient` pings every 5 s and reconnects on a missed pong (`makePinger`, `refs/effect/packages/effect/src/rpc/RpcClient.ts`); Alchemy's `RpcWebSocket` answers at the edge and owns the auto-response. Nothing in this plan sets `setWebSocketAutoResponse`.
- **What exists** (research §2): the per-page socket (`nameOrdersSocket` in `OrdersPage`'s `LiveOrders`, `seedShop` in `ShopPage`'s `LiveShop`), `lostAtom` and the close outcomes in `src/web/client/actor-connection.ts`, the registry's `defaultIdleTTL: 400`.

## 3. Names and constants

| Name                                                       | What                                                                                                                                                                                                                                          |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/backend/shop-actor/orders-agent.ts`                   | `OrdersAgent`, legacy `agent/Orders.ts`: `fetchAndUpsertOrder`, `syncOrderWebhook`, `syncOrder`, `syncOpenOrders`, built once per activation over the repository, `ShopifyAdmin`, the Workflow handle, `notify` and the shop. Logs as legacy. |
| `syncOrderWebhook({orderId, topic, updatedAt})`            | Stub method; legacy `ShopAgent.syncOrderWebhook`. Answers the outcome `Webhooks` logs (`"stale" \| "refused" \| "gone" \| "stored"`, the existing `OrderWebhookOutcome` minus `"uninstalled"`).                                               |
| `MerchantSyncOrder`                                        | Procedure in `MerchantRpcs`: payload `{orderId}`, success `SyncOrderResult`, error `OrdersCallFailure` minus `ShopNotInstalled`.                                                                                                              |
| `MerchantSyncOpenOrders`                                   | Procedure in `MerchantRpcs`: no payload, success `OrdersSyncResult`, the same error.                                                                                                                                                          |
| `onOrdersStream`, `onOrdersSyncEmpty`, `onOrdersSyncError` | The three Workflow callbacks, renamed from `streamOrders`, `syncEmpty`, `syncFailed`; signatures unchanged; the Workflow's step names unchanged.                                                                                              |
| `OrdersSyncWorkflows`                                      | Moves from the Backend's provision to the actor: the handle the actor creates instances with (S1 decides whether it wraps the yielded class or the binding).                                                                                  |
| `ShopSocket`                                               | The layout socket holder, `src/web/components/ShopSocket.tsx`: names the socket once per shop and credential, keeps the client runtime and `noticesAtom` mounted, renders `SocketBanner` and its children.                                    |
| `SocketBanner`                                             | Legacy `src/lib/SocketBanner.tsx`, as a part under `src/web/components/screen/` if it needs layout: nothing while connected; displaced, with Reconnect; lost after the 4 s grace (`lostAtom`); legacy's copy.                                 |
| `src/web/routes/shop.$key.index.tsx`                       | Today's member shop page; `shop.$key.tsx` becomes its layout.                                                                                                                                                                                 |

## 4. Steps

### Step 1: The actor's services and the one-order fetch

- **Check first (S2).** In `ShopActor`'s outer phase yield `ShopSessions`, `Shopify` and `ShopifyAdmin`, provided where `backendBody` yields `ShopActor` (`provideBackend` already provides all three; confirm the actor's captured services include them). Add a temporary call in an existing stub method: `ensureShopSession` and one GraphQL call; run integ (against `ShopifyFake`) and once on the dev store. Record the result in §7, then remove the probe. **If it fails** (the secret or D1 does not resolve in the actor): stop, record the error and the stack output under §7 "Issues", and end the run; the orchestrator decides.
- `src/backend/shop-actor/orders-agent.ts`: `fetchAndUpsertOrder(orderId)` (from `Orders.fetchOrder` plus the actor's `storeOrder` body: `graphqlDecode(shop, OrderSyncResponse, orderSyncQuery, ...)`, `null` is gone, `hasNextPage` logged, then `toShopOrder`/`toOrderLineItems` and `upsertOrder`, the rate-limited sweep, `notify([ORDERS_KEY])` when changed or swept); `syncOrderWebhook` (the repository's `orderVersion` probe and ceiling, then `fetchAndUpsertOrder`); `syncOrder` (no probe; `Stored | Gone`). No Admin call inside `transaction()`; say so on `OrdersAgent`'s JSDoc.
- Actor: stub method `syncOrderWebhook`; procedure `MerchantSyncOrder`. Delete stubs `orderVersion` and `storeOrder`.
- Backend: `Webhooks.ordersWebhook` decodes, checks `ShopSessions.find` (no row: 200, no actor call, the `"uninstalled"` outcome logged as today), then `actors.syncOrderWebhook`. `ShopActors` wraps `syncOrderWebhook`; drops `orderVersion`, `storeOrder`. Delete `Orders.fetchOrder`, `syncOrderFromWebhook`, `syncOrder`. `BackendApi.syncOrder`, its server function and `SyncOrderRequest` go in Step 3, not here; until then `BackendApi.syncOrder` calls nothing it needs from `Orders` (point it at a temporary stub call or leave the server function answering `ShopifyUnavailable`; record which, and keep e2e green).
- `IntegRpcs`: drop `OrderVersion`, `StoreOrder`, `SyncOrder`. Each integ case that arranged an order with `StoreOrder` arranges it with a signed `orders/*` webhook and the order scripted into `ShopifyFake` (a helper beside `signWebhook`). `shopify-refresh.test.ts`' five cases call `MerchantSyncOrder` over a forged merchant socket.
- Tests. Unit: `OrdersAgent` over layers (stale skips the fetch; a new order at the ceiling marks `ordersLimitedAt` and skips; `null` is gone; the moved `Orders` cases keep their titles). Integ: `webhooks.test.ts` unchanged by title; `orders.test.ts`' version-guard, ceiling, notice and `Gone` cases through webhooks and `MerchantSyncOrder`; a member socket is refused `MerchantSyncOrder`. e2e: `refresh.spec.ts` green (still through the server function this step).
- Verify: green.

### Step 2: The sync start in the actor

- **Check first (S1).** Yield `OrdersSyncWorkflow` in the actor's outer phase and call `create` from a method; run it under the test stage and on the dev stage. If the yield recurses (the Workflow's outer phase yields `ShopActors`, which yields `ShopActor`) or the registration misbehaves, build `OrdersSyncWorkflows` in the actor from the Workflow's binding on `WorkerEnvironment` (the name the Backend registers), wrapping `create({id, params})` and `get(id).status()`, and keep the Backend yielding the class so the binding and export stay on its script. Record which held, with the stack output. **If neither works**: stop, record it under §7 "Issues", end the run.
- `OrdersAgent.syncOpenOrders`: `workflowId = crypto.randomUUID()`; `orders.beginSync({workflowId, now})` in its transaction (unchanged rules; the record is written before the create, which is what legacy's `syncStarting` did); on `Started`, `notify([SYNC_KEY])`, then `create({id: workflowId, params: {shop}})` outside the transaction; a failed create clears the record and sets `lastError` through the same repository calls `onOrdersSyncError` uses, notifies `SYNC_KEY`, and fails `ShopifyUnavailable`. Logs as `ShopActor.beginSync` does today, under `OrdersAgent.syncOpenOrders`.
- Actor: procedure `MerchantSyncOpenOrders`. Rename the callbacks to `onOrdersStream`, `onOrdersSyncEmpty`, `onOrdersSyncError` (actor, `ShopActors`, the Workflow's three call sites). Delete the `beginSync` stub.
- Backend: delete `Orders.beginOpenOrdersSync` and the Backend's `OrdersSyncWorkflows` provision if S1's first try held; `src/backend/orders.ts` is empty after this step: delete it and its `Orders` provision. `BackendApi.syncOpenOrders` is handled as Step 1 handled `syncOrder`.
- `IntegRpcs`: drop `SyncOpenOrders`, `TrackSync`, `ApiSyncOpenOrders`; `SyncFailed` calls `onOrdersSyncError`.
- Tests. Unit: `ordersSyncBody` unchanged; `OrdersAgent.syncOpenOrders` over layers (`Started` creates once; `InFlight` and `Refused` create nothing; a failed create clears the record and sets the banner); the stale-record rule ("a tracking row older than ten minutes is deleted on the next press") pinned over the repository with an explicit `now`. Integ: `orders-sync.test.ts` over `MerchantSyncOpenOrders` on a forged merchant socket, legacy titles kept, the stale case removed from integ (it is unit now); a member socket is refused `MerchantSyncOpenOrders`; "the stream's callbacks are not callable from a socket" over the renamed stubs.
- Verify: green.

### Step 3: The browser's writes

- `OrdersPage`: "Sync open orders" and each row's "Sync from Shopify" call `MerchantSyncOpenOrders` and `MerchantSyncOrder` as `ShopActorClient` mutation atoms. Toasts, banner and copy unchanged (`Started` → "Syncing open orders", `InFlight`, `Refused`, `Gone`, a failure's message or "Couldn't start the sync."). The row button's loading state follows the mutation.
- Delete `syncOpenOrders` and `syncOrder` from `src/web/server/orders.ts`, `BackendApi`, and `SyncOpenOrdersRequest`/`SyncOrderRequest` from `src/contract/orders.ts`; `OrdersActions` loses what only they used. `IntegRpcs` drops `ApiSyncOrder`. `src/web/server/orders.ts` keeps `listOrders`.
- Tests. Browser: `OrdersPage.test.tsx`'s toast and banner cases answer from the in-memory server in `test/browser/shop-actor.ts`, which gains both procedures. e2e: `orders.spec.ts`, `orders-pages.spec.ts`, `refresh.spec.ts` unchanged by title; the refresh spec's presses now refresh inside the actor (confirm in `.logs/e2e/current` that the refresh line comes from the actor's activation, and record the line).
- Verify: green.

### Step 4: One socket per tab

- **Check first.** Write the e2e case before the change and watch it fail: in `test/e2e/embedded/`, open Orders, go to App Home by its link, return to Orders by its link, and count the WebSockets to `/api/actor/` the page opens (`page.on("websocket")` sees the app frame's sockets; if it does not, count the actor's "socket accepted" lines for the shop in `.logs/e2e/current`, and record which). Today it should see two. Record the count in §7.
- `ShopSocket` (§3) and `SocketBanner`. `app.tsx`'s `component` renders `ShopSocket` for the merchant (shop from the route context, the credential `mintSessionToken`) around `<Outlet/>`. `shop.$key.tsx` becomes the member layout (loader and params stay; `ShopSocket` for the member around `<Outlet/>`); today's page body moves to `shop.$key.index.tsx`. Regenerate the route tree.
- Pages seed and read only: `OrdersPage` keeps `seedOrders` per cursor and drops `nameOrdersSocket` (delete it); `ShopPage` keeps seeding and drops naming. Neither renders a banner of its own; the existing uninstalled and expired lines move into `SocketBanner` if they are socket outcomes.
- `ShopSocket`'s JSDoc states the rule (one socket per tab, held by the layout; pages never name it) and why legacy's keepalive and watchdog are absent (Effect's ping and Alchemy's edge auto-response; `@see` both refs paths).
- Tests. Unit or browser: `SocketBanner`'s three states; a page that seeds without a holder shows its seeded data and opens no socket. Browser: `ShopPage.test.tsx` and `OrdersPage.test.tsx` render under a `ShopSocket` the way the routes do. Unit: a socket that misses a pong is reconnected (drive Effect's client protocol over an in-memory socket that stops answering), if it can be written in under an hour; otherwise record why and skip. e2e: the new case sees exactly one socket; the member specs (`shop.spec.ts`, `members.spec.ts`) unchanged by title.
- Then the dev-store check (research §10): `vp run dev`, open `/app/orders` in the dev store's admin, leave it five minutes, create an order in the Shopify admin, and see its row without a reload. Record the time and the actor's accept and close log lines.
- Verify: green.

### Step 5: Docs

- `docs/legacy-port-research.md`: §1.3's "Admin API calls run in the Backend" bullet rewritten to the corrected rule (A1 and its refinement); §2's Workflow row ("the actor creates instances; the Workflow makes the bulk calls and calls the actor back") and socket rows; nothing else.
- `docs/glossary.md`: the `Actor` and `Stub` rows name what the actor now holds and the Workflow's callbacks; add `Socket holder` if `ShopSocket` needs a word.
- `CHECKPOINT: ready for staging (<commit>)` under §7 "Command results". The orchestrator runs staging.
- Verify: `vp check` green.

## 5. Verification checklist

- `vp check`, `vp test`, `vp run test:e2e` green at the end; counts and times in §7.
- `grep -rn "beginOpenOrdersSync\|orderVersion\|storeOrder\|syncOpenOrders\b\|streamOrders\|syncEmpty\|syncFailed\|nameOrdersSocket" src test` finds nothing but legacy-named tests' titles and `MerchantSyncOpenOrders`.
- `src/backend/orders.ts` does not exist; `src/web/server/orders.ts` exports only `listOrders`.
- Every stub method on `ShopActor` has a production caller (Backend, Workflow or `DevRpcs`): list them in §7 with their callers.
- The production bundle (`.alchemy/bundles/Backend/`) contains no `IntegRpcs` or `ShopifyFake` string.
- The e2e socket count is one; the dev-store check of Step 4 passed.

## 6. Done when

- §1 holds on the dev stage; every step is green and committed; §7 is filled in; the `CHECKPOINT` line is written.

## 7. Deviations and issues

For the implementer. Append as you go. Keep each entry short, dated and tagged with its step. A deviation is anything built differently from the step that specified it. An issue is anything the plan did not predict. Command results go under their own heading with counts and times.

### Plan review

### Deviations

### Issues

### Command results

### Human steps requested

### Implementation review

## 8. Out of scope

- Slice C (members, teams, `Members` in the actor) and its revised questions.
- Billing's usage flush after a webhook write, a one-order sync and a stream (slice G); each keeps its named seam, now in `OrdersAgent`.
- `MerchantSyncStatus` seeding (research Q7).
- Legacy's keepalive and watchdog (research Q10, revised).
- The `embedded/app.spec.ts` hydration timeout, unless it recurs.
