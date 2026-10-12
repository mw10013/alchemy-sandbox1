# Research: what to spike next before porting Baton (without Shopify)

Research date: 2026-10-11.
Status: approved in Plannotator on 2026-10-11 with no per-question answers; the [§8](#8-questions-with-recommendations) recommendations are working assumptions. S1 is researched in depth in [connection-identity-research.md](./connection-identity-research.md).
Versions: Alchemy `2.0.0-beta.81`, Effect `4.0.1`, `@effect/sql-sqlite-do` `4.0.1`; Baton as pinned in `refs/baton` (`agents` `0.28.0`). Do not bump dependencies.
Background: [ShopActor POC research](./shop-actor-poc-research.md) and [plan](./shop-actor-poc-plan.md) (implemented; its §6 lists what was left out), [glossary](./glossary.md) (**Actor**, **Notice**, **Shop key**).

Sources: `refs/baton/src/lib/{ShopAgent,ShopAgentClient,ShopAgentSocketHost,ShopAgentContext,ShopAgentSchema,ShopAgentObjects,ShopAgentOrdersStream,OrdersSyncWorkflow,useLiveQuery,useMemberRunActions,SocketBanner,LayerEx,D1Session,D1Primary,D1Bookmark}.ts(x)`, `refs/baton/src/lib/agent/{Host,ShopWork,Orders,Billing}.ts`, `refs/baton/src/lib/domain/{Platform,ShopWork}.ts`, `refs/baton/src/worker.ts`, `refs/baton/wrangler.jsonc`, `refs/baton/test/integration/{agent-socket,shop-agent-*,worker-agent-gate,orders-sync-workflow,list-memo}.ts`; `node_modules/alchemy/src/Cloudflare/Workers/{RpcDurableObject,RpcWebSocket,DurableObject,DurableObjectBridge,DurableObjectState,AlarmCallback,ScheduledEvents,CronEventSource,Telemetry}.ts`, `node_modules/alchemy/src/Cloudflare/Workflows/Workflow.ts`, `node_modules/alchemy/src/Cloudflare/D1/QueryDatabase.ts`, `node_modules/alchemy/package.json` (exports); `refs/alchemy/packages/alchemy/test/Cloudflare/Workers/{RpcWebSocket,AlarmCallback,WorkflowLifecycle,CronEventSource.local}.test.ts`; `refs/alchemy/website/src/content/docs/cloudflare/{compute/durable-objects,compute/workflows,apis/effect-rpc,messaging/cron,local-development}.mdx`; `node_modules/effect/src/rpc/{RpcClient,RpcServer,RpcMiddleware}.ts`; `refs/cloudflare-docs/src/content/partials/durable-objects/durable-objects-pricing.mdx`.

## 1. Summary

- **Proven so far:** Alchemy creates and manages every resource in this repo (Workers, D1, Email, Rate Limit, a SQLite Durable Object); `Cloudflare.RpcDurableObject` serves Effect RPC over a hibernating WebSocket straight from the browser (the Website and Backend only forward the upgrade); notices invalidate every tab; SQLite plus migrations live in the actor through `@effect/sql-sqlite-do`. That replaces about half of what Baton takes from the Agents SDK.
- **The biggest open gap is connection identity.** Baton's `ShopAgent` knows who is on every socket (role, member id, teams), checks the role on every `@callable`, closes a member's sockets when their membership changes, and caps a member at two connections. Alchemy's RPC socket transport gives none of that to app code. It hard-codes one tag (`alchemy:rpc`), ignores the upgrade request's headers (`initialMessage: Effect.succeedNone`), offers no public way to attach data to a socket or close a particular client, and the transport module (`RpcWebSocket.ts`) is not in the package's exports. Our ShopActor works today only because every signed-in member may do everything. **This is spike 1** ([§4.1](#41-s1-connection-identity-roles-and-revocation)).
- **The second gap is long-running work.** Baton's only multi-minute job is a Cloudflare Workflow started by the agent with the SDK's `runWorkflow`. The SDK also tracks it in its own table and calls back into the agent when it completes or fails. Alchemy has a solid Effect-native `Cloudflare.Workflow`, and a Workflow calling a DO is tested. **A DO starting a Workflow is not tested**, and nothing replaces the tracking table or the callbacks. **This is spike 2**, and it naturally includes the streaming-NDJSON-into-SQLite fold and multi-statement transactions ([§4.2](#42-s2-actor-started-workflow-with-a-streamed-ingest)).
- **Third: timers and fan-out.** Baton avoids alarms on purpose: retention and usage flush ride on other writes. The only clock is a daily Worker cron that calls into agents. Alchemy now ships a durable, multiplexed `makeCallback` scheduler (SQLite-backed, at least once), but it is not tested inside an `RpcDurableObject`. Alchemy's cron handler also swallows failures silently. **This is spike 3** ([§4.3](#43-s3-durable-timers-and-cron-fan-out)), and is smaller.
- **Smaller items** (client ergonomics, actor lifecycle and admin, D1 sessions, tracing, the test harness) are in [§4.4](#44-s4-client-live-query-ergonomics) to [§4.7](#47-folded-into-the-spikes-observability-and-testing). Most of them fold into spikes 1 and 2 rather than standing alone.
- **Polaris web components: defer**, as the brief leans. It is a UI swap with no Alchemy or Effect risk; [Q8](#8-questions-with-recommendations) records the trade-off.
- **Recommended stand-in domain:** spike against a thin slice of Baton's own non-Shopify model, not counters. That slice is teams and members in D1, plus production runs with tasks in the actor, fed by synthetic orders. The result is then reference code for the port, per the house rule that sandbox code is never "just a demo" ([Q1](#8-questions-with-recommendations)).

## 2. What Baton takes from the Agents SDK and Cloudflare, by status here

| Baton mechanism (generic, no Shopify)                                                                                             | Where in Baton                                                                     | Status in this repo                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| One DO per shop, private SQLite, Effect migrations under `blockConcurrencyWhile`                                                  | `ShopAgent`, `ShopAgentSchema.runShopAgentMigrations`                              | **Done** (`ShopActor`)                                                                            |
| Hibernating WebSocket, keepalive auto-response                                                                                    | `ShopAgentContext` (240 s ping), `setWebSocketAutoResponse`                        | **Done** (Alchemy transport; Effect's 5 s ping as auto-response)                                  |
| Browser calls actor methods directly (`@callable`)                                                                                | `AgentClient`, `ShopAgentSocketHost`                                               | **Done** (Effect RPC over the socket)                                                             |
| Invalidate-only broadcast, clients refetch                                                                                        | `ShopAgent.publish`, `useLiveQuery`                                                | **Done** (notice frames + `Reactivity.invalidate`)                                                |
| SSR read of the same actor                                                                                                        | `ShopAgentClient` (stub RPC)                                                       | **Done** (HTTP RPC over the binding)                                                              |
| Gate at the Worker, identity forwarded as headers                                                                                 | `worker.ts: authorizeShopAgentRequest`, `rebuildRequest`                           | **Partial**: session checked, identity not forwarded                                              |
| Per-connection role and state, surviving hibernation                                                                              | `getConnectionTags`, `onConnect`, `connection.setState`                            | **Missing** (S1)                                                                                  |
| Role check per method, caller context from the connection                                                                         | `callableEffect`, `connectionRoleGuard`, `getCurrentAgent()`                       | **Missing** (S1)                                                                                  |
| Revoke a member's sockets (3401), displace past 2 per member (4409), revoke all on plan change                                    | `closeMemberConnections`, `displaceConnections`, `revokeAllConnections`            | **Missing** (S1)                                                                                  |
| Close codes steer the client: reconnect vs stay closed vs "displaced" banner                                                      | `AgentClient` terminal-close rule, `SocketBanner`                                  | **Missing** (S1, S4); Effect's client reconnects on every close                                   |
| DO starts a Workflow, single flight, completion and error callbacks                                                               | `syncOpenOrders`, `runWorkflow`, `onWorkflowComplete/Error`, `cf_agents_workflows` | **Missing** (S2)                                                                                  |
| Workflow calls back into the DO                                                                                                   | `OrdersSyncWorkflow` (`this.agent.onOrdersStream`)                                 | **Missing** (S2); Alchemy has it tested                                                           |
| Constant-memory NDJSON stream folded into SQLite, one transaction per item, interleaving with webhook writes under the input gate | `ShopAgentOrdersStream`, `OrderRepository.upsertOrder`                             | **Missing** (S2)                                                                                  |
| Multi-statement transactions, no nesting, no foreign I/O inside                                                                   | `RunRepository`, `OrderRepository` (`afterWrite`)                                  | **Missing**; ShopActor JSDoc flags the `MixedScheduler("sync")` workaround (S2)                   |
| Outbox table flushed after writes, at-least-once, never throws                                                                    | `UsageEvent`, `flushUsageEvents`                                                   | **Missing** (S3; the outbox is Shopify billing but the pattern is generic)                        |
| Worker cron fanning out to actors                                                                                                 | `worker.ts: scheduled`, `revalidateStalePlans`                                     | **Missing** (S3)                                                                                  |
| Actor writes D1 directly; D1-first deletes, dangling ids read as null                                                             | `makeRunEffect` builds `Repository` over `env.D1`; `ShopWork.deleteTeam`           | **Missing** (S1/S2 slice)                                                                         |
| In-memory list memo shared by concurrent refetches, cleared before publish                                                        | `ShopWork` `Cache.makeWith`                                                        | **Missing** (S2 slice)                                                                            |
| Client throttle (2 s leading+trailing), hidden-tab defer, act-er refetches at once, lost-connection banner                        | `useLiveQuery`, `useMemberRunActions`, `SocketBanner`                              | **Partial**: `refreshOnFocus`, `socket-session` guard (S4)                                        |
| Destroy an actor; list objects; find orphans                                                                                      | SDK `destroy()`, `ShopAgentObjects` (CF REST), `admin.orphan-shop-agent-objects`   | **Missing** (S5); Alchemy's `idFromString`/`get` are commented out                                |
| D1 Sessions with bookmarks (read replicas)                                                                                        | `D1Session`, `D1Primary`, `D1Bookmark`                                             | **Not used** (replication disabled here); Alchemy has no Effect wrapper, `raw` only (S6)          |
| Ceilings (`ShopLimits`), `databaseSize`                                                                                           | `domain/Platform.ts`                                                               | Domain code; ports as is                                                                          |
| Integration tests in workerd: hand-rolled socket frames, `runInDurableObject`, `introspectWorkflow` mocks, statement counting     | `test/integration/*` (`@cloudflare/vitest-pool-workers`)                           | **Partial**: Alchemy harness, real sockets; no Workflow step mocking or DO introspection (S2, S7) |

Everything under "Shopify-specific" in Baton stays out: OAuth and token exchange, session tokens in `?token=`, the Admin and Partner APIs, bulk operations, webhooks' HMAC and payloads, App Pricing and usage events, App Bridge.

## 3. Alchemy facts that shape the spikes

Verified in the pinned source unless marked otherwise.

1. **RPC socket transport is closed to app code.** `RpcWebSocket.ts`: `socketTag = "alchemy:rpc"` is the only tag passed to `acceptWebSocket`; `initialMessage: Effect.succeedNone`, so the upgrade request (and any `x-identity` header the Backend adds) never reaches a handler; the attachment is `{ ...previous, __alchemyRpcWebSocket: {...} }`, which keeps other keys, but app code never holds the socket at upgrade time to add them. `RpcDurableObject.makeHandlers` composes the transport privately, and `package.json` exports `./Cloudflare/RpcWebSocketClient` but not the server transport.
2. **What handlers do get.** Effect RPC passes every handler and middleware `{ client, requestId, headers, rpc }`; `client.id` is the transport's client id, which **is** restored from the attachment after hibernation. `RpcServer.Protocol` has `end(clientId)` and `clientIds`; the transport has them, app code does not.
3. **RPC middleware on the actor works in principle.** `makeHandlers` serves `props.schema.middleware(RpcRequestLifetime)`, so middleware declared on the group applies, and the returned handler layer can provide its implementation. Alchemy only type-tests this (`RpcWebSocket.types.ts`); there is no runtime test.
4. **Raw hibernatable sockets are fully open.** `DurableObjectState.acceptWebSocket(ws, tags)`, `getWebSockets(tag)`, `getTags(ws)`, typed `setAttachment(schema, value)` / `getAttachment(schema)` (beta.80). The tags part is untested in Alchemy.
5. **Workflows are solid.** `Cloudflare.Workflow<Self>()(name, props, impl)` with `Workflows.task/sleep/sleepUntil/waitForEvent`, per-task retries, timeout and rollback; a handle with `create({ id, params })`, `get(id).status()`, `terminate()`, `subscribe()` (a Stream), `sendEvent`. They run locally on workerd's engine. About 25 lifecycle scenarios are tested local and live. A Workflow calling a DO with `getByName` is in a fixture and an example. **A DO yielding a Workflow handle is not tested anywhere.**
6. **Durable callbacks are new and solid, with one gap.** `Alchemy.makeCallback(name, handler, { retry })` returns `{ schedule(id, { payload, at | after }), cancel(id) }`. Jobs live in SQLite table `alchemy_alarm_callbacks`, keyed so that rescheduling an id replaces it, and share one native alarm. Delivery is at least once and scheduling is transactional with storage writes. Callbacks must be registered during init, and there is no repeat (a handler reschedules itself). It is tested in plain `DurableObject` fixtures. `DurableObjectBridge` dispatches callbacks for every class, but **no test registers one inside an `RpcDurableObject`**, whose shape has no user `alarm`.
7. **Cron:** `Cloudflare.Workers.cron(expr, handler)`. Crons fire locally and can be triggered at `/cdn-cgi/handler/scheduled`. **Handler failures are swallowed** (`Effect.catchCause(() => Effect.void)`), so they are not logged and Cloudflare never retries them.
8. **DO namespace:** `getByName` and `fetch(name, request)` only. `newUniqueId`, `idFromName`, `idFromString`, `get`, `jurisdiction` are declared on the type but commented out in the implementation (`DurableObject.ts`), so calling them fails at runtime. There is no list or delete of objects.
9. **D1:** migrations, `importFiles` and `readReplication` are solid. There is no Effect wrapper for `withSession` or bookmarks; it is reachable through the client's `raw`.
10. **Heartbeat cost is fixed but small.** Effect's `RpcClient` pings every 5 s (`makePinger`, `Effect.delay("5 seconds")`, not configurable). Cloudflare bills incoming WebSocket messages at 20:1 as requests, and auto-responses add no wall-clock. That is 17,280 pings a day per open tab, or about 864 billed requests, against Baton's 18. At a thousand tabs open eight hours a day that is roughly 8.6 M requests a month, about $1.30. Whether auto-responded messages count as requests at all is not stated; measuring it once on staging settles it ([S4](#44-s4-client-live-query-ergonomics)).
11. **Tracing:** `Cloudflare.Telemetry()` bridges Effect spans into Cloudflare's native traces (compat date ≥ 2026-07-28; ours is 2026-07-01). Baton turned traces off because per-statement DO spans cost more than the logs; Effect spans were never bridged there.

## 4. Candidate spikes

Each spike lists why Baton needs it, the Alchemy unknowns, a non-Shopify shape, what "done" proves, and a rough size.

### 4.1 S1: connection identity, roles and revocation

**Why.** Every one of Baton's ~50 callables is role-guarded (`merchant<Verb>` / `member<Verb>`). Member methods take `memberId` and `teamIds` from the connection, never from the wire. Membership and team edits in D1 actively close sockets, because the keepalive defeats the edge's idle close. The port cannot start without this.

**Unknowns.** How identity crosses from the Backend gate into the actor for a socket (fact 1). How a handler learns who is calling, for both socket and HTTP RPC. How the actor finds and closes one member's sockets after a hibernation. Whether RPC middleware runs at runtime on the actor (fact 3). How the Effect client tells "revoked, reconnect through the gate" from "displaced, stay closed", given that it reconnects on every close.

**Three ways to carry identity:**

| Option                                                                                                                                                                                                                                                                                                                                           | Revoke / displace                                                                                                                          | Cost                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Extend Alchemy's transport.** An `RpcDurableObject` option such as `onUpgrade: (request) => Effect<{ tags, attachment }>`, a `CurrentConnection` service for handlers and middleware (tags + typed attachment, read by `client.id`), and `closeConnections(tag, code, reason)`. Prototype with `pnpm patch alchemy`, offer upstream.        | Native: `getWebSockets("member:<id>")`, close with chosen code. Identity in the attachment survives hibernation, exactly like partyserver. | A patch to carry across beta bumps until merged. Smallest diff to Baton's model.                                                                            |
| **B. Vendor the transport.** Copy `RpcWebSocket.ts` (~350 lines) and the `makeHandlers` composition into the repo, and build the actor on a plain `Cloudflare.DurableObject` with the same hooks as A.                                                                                                                                           | Same as A                                                                                                                                  | We own the hibernation and heartbeat code, and drift from upstream fixes. Nothing to wait on.                                                               |
| **C. Stock transport, signed identity per request.** The Backend mints a short-lived HMAC token (role, member id, expiry) when the page loads; a client `RpcMiddleware` sends it in each request's headers; an actor `RpcMiddleware` verifies it and provides `CurrentConnection`; the actor learns `client.id → member` from verified requests. | Weak: expiry is the revocation; closing a client needs Alchemy's internal attachment key or `end(clientId)`, neither public; no displace.  | No patch. Token refresh adds a round trip before expiry. Notices still reach revoked sockets (they carry no data, so the leak is only "something changed"). |

**Proposed shape (A, unless Q2 says otherwise).** The Backend gate resolves the session and the member's role in this shop from D1, then forwards the upgrade with `x-actor-identity` (a Schema-encoded `ConnectionIdentity`, with any client-sent copy stripped, as Baton's `rebuildRequest` does). `onUpgrade` decodes it, tags the socket `member` + `member:<id>` (or `owner`, the stand-in for Baton's merchant), and stores the identity in the attachment. The HTTP path passes the same header per request. On the actor, a `CurrentConnection` middleware declared on the group provides `{ role, memberId }` to handlers, and per-procedure `RequireRole` middleware replaces `connectionRoleGuard`. A Backend procedure that edits a membership calls an actor procedure `RevokeMember(memberId)`, which closes `member:<id>` sockets with a "reauth" code. A connection beyond two per member closes the oldest with a "displaced" code. On the client, an `onDisconnect` hook in `ConnectionHooks` (or a close-code tap in the socket wrapper, next to the notice tap) maps codes to a "displaced" state that stops retrying, and a "reauth" that lets the existing session guard run.

**Done proves:** two members with different roles see different results from one procedure, and a member gets a typed `Forbidden` on an owner procedure, over both socket and SSR HTTP. Identity survives a hibernation (the `Activation` trick from the ShopActor POC). Removing a member in D1 closes only their sockets, and their tab lands on sign-in. A third tab displaces the first, which shows a banner and does not reconnect. Middleware runs at runtime on the actor (closing fact 3).

**Size:** M, plus the patch. It is the largest unknown, so do it first.

### 4.2 S2: actor-started Workflow with a streamed ingest

**Why.** Baton's orders sync is the one job longer than a request. The merchant presses Sync; the agent starts a Workflow, single flight; the Workflow polls an external job with `sleep` between steps; it then tells the agent where the result file is; the agent streams the NDJSON into SQLite at constant memory, one transaction per order, interleaving with webhook writes. Completion and error callbacks re-enable the button and surface errors. Only the bulk-operation calls are Shopify; everything else is generic and is exactly where the SDK did invisible work (`runWorkflow`, `cf_agents_workflows`, `onWorkflowComplete/Error`, the `agent` stub inside the Workflow).

**Unknowns.**

- Yielding a `Cloudflare.Workflow` handle inside an `RpcDurableObject` (fact 5).
- Typing a Workflow's call back into an `RpcDurableObject` (does `getByName` give the typed HTTP RPC client inside a Workflow step?).
- Step results under `WorkflowBridge`'s serialization rules.
- `@effect/sql-sqlite-do` `withTransaction` in workerd: the `MixedScheduler("sync")` workaround Alchemy's Drizzle adapter applies "because a parent input-gate timer can block later transaction timers".
- `HttpClient` streaming plus `Ndjson` decode plus `Stream.runFoldEffect` inside an actor handler while other RPCs and notices interleave.
- Testing a Workflow under the Alchemy harness without `introspectWorkflow`'s step mocks and `disableSleeps`.

**Proposed shape.** Synthetic orders in place of Shopify:

1. An owner procedure `StartImport(count)` records a row in an `ImportJob` table and calls `workflow.create({ id: <job id>, params })`. The row is the single-flight lock. If the row is still running but `get(id).status()` says the instance is gone, the procedure clears it, which replaces Baton's 10-minute stale timeout with a real status check.
2. The `ImportWorkflow` generates N synthetic orders in steps, writes NDJSON to an R2 object (Alchemy's R2 is solid locally), `sleep`s between "poll" steps to mimic the external job, then calls the actor's `IngestImport({ key })`.
3. The actor streams the object from R2 through `Ndjson` into an `upsertOrder` transaction per order (orders plus line items: two tables and a guard, as in Baton), then publishes a notice.
4. Workflow errors run a final `on-error` step that calls `ImportFailed`, Baton's durable error sink. The actor marks the job done or failed and publishes.

Meanwhile a second procedure (stand-in for the webhook path) writes single orders during the ingest, to show the interleaving and the `updatedAt` guard.

**Done proves:** the DO→Workflow→DO round trip under `alchemy dev` and on staging; single flight across two tabs pressing Start; constant memory on a file of, say, 50k lines (watch `databaseSize` and the isolate's memory in logs); a transaction rolled back on a forced failure mid-order, with no partial line items; the interleaved write wins or loses by `updatedAt` and never corrupts; an integ test pattern for Workflows.

**Size:** L. It could be cut in two, S2a "Workflow round trip and single flight" and S2b "streamed ingest with transactions", if a smaller first landing is wanted ([Q3](#8-questions-with-recommendations)).

### 4.3 S3: durable timers and cron fan-out

**Why.** Baton has no alarms on purpose, but the reasons were SDK-shaped: one multiplexed alarm, and no durability for scheduled work. Retention sweeps and the outbox flush ride on unrelated writes, so a quiet shop never sweeps or flushes until someone writes. The daily cron calls into every stale shop's agent. With `makeCallback` the port can schedule work properly.

**Unknowns.** Registering `makeCallback` in an `RpcDurableObject` (fact 6): registration must be in init, and the inner Effect re-runs on every wake. How a callback and the RPC transport's `waitUntil` and auto-response interact, i.e. does a pending callback keep the object from hibernating? (It should not; an alarm wakes it.) Cron with swallowed failures (fact 7): wrap the handler so failures are logged and the fan-out is per-actor resilient. Bounded concurrency calling many actors from one cron run.

**Proposed shape.**

- An outbox table in the actor (stand-in: "notify an external system", posting to a Backend test endpoint that can be told to fail).
- A write inserts an outbox row and `schedule`s a flush in the same transaction.
- The flush callback posts and deletes on success; otherwise it reschedules with backoff, at least once and idempotent by key.
- A retention callback reschedules itself daily.
- A Worker cron (every minute in dev) lists actor keys from D1 and calls each with concurrency 4, logging failures.

**Done proves:** a flush retried across an actor restart (kill `alchemy dev` mid-backoff, restart, it still fires); the object hibernates between callbacks; cron failures visible in logs; at-least-once handled by the idempotency key.

**Size:** S–M.

### 4.4 S4: client live-query ergonomics

**Why.** Baton's `useLiveQuery` and `ShopAgentContext` carry a lot of hard-won behaviour:

- invalidations throttled to 2 s, leading and trailing;
- in a hidden tab, the query is marked stale and refetched on `visibilitychange`;
- the person who acted refetches at once, without waiting for the throttle;
- mutations are disabled until the socket is identified;
- a 4 s grace period before a "lost connection" banner;
- a "displaced" banner with a Reconnect button;
- a stale-socket watchdog.

Under Effect most of this becomes Atom and Stream code that nobody has written yet.

**Shape.**

- Put the throttle and visibility logic on `noticesAtom`'s stream, with `Stream.throttle` and a visibility `Stream` gating invalidation.
- Turn connection state (connecting, open, lost, displaced) into an atom fed by `ConnectionHooks` and the close-code tap from S1, and build an Astryx banner component on it.
- Use a per-key client family (`Atom.family` over `AtomRpc.Service`, or keep `shopKeyAtom`), so that a member who belongs to two shops can switch.
- Measure the heartbeat once on staging (fact 10). Only if it shows up in billing, consider dropping the client `Ping` in the socket wrapper and sending our own at 240 s. That costs liveness detection, so it is not recommended up front.

**Size:** S–M. It depends on S1's close codes; best done right after S1.

### 4.5 S5: actor lifecycle and the operator console

**Why.** Uninstall destroys a shop's agent, and Baton's console lists objects and finds orphans (objects with no D1 row) through the Cloudflare REST API, destroying by id. Alchemy has no destroy, list, or `idFromString` (fact 8).

**Shape.**

- A `Destroy` procedure: `storage.deleteAll()`, cancel callbacks, close sockets, then `state.abort()`. It is guarded by a tombstone row so the next wake does not re-run migrations into a "destroyed" object. Baton hit that trap.
- Listing: call `/accounts/{id}/workers/durable_objects/namespaces/{namespaceId}/objects` with an `HttpClient`, taking `namespaceId` from Alchemy's Output, with the account id and an API token from Alchemy Config. Locally, use `/cdn-cgi/explorer/api` as Baton does.
- Orphans: anti-join against D1.

**Open question:** destroy-by-id needs `idFromString`, which Alchemy comments out. Either reach the raw namespace or destroy only by name ([Q5](#8-questions-with-recommendations)).

**Size:** S. Lower priority; it can come after the first real port step.

### 4.6 S6: D1 read replicas with sessions

**Why.** Baton wraps every request in `withSession(bookmark)`, uses the primary for webhooks and DOs, and threads the bookmark through SSR and the client. Here `readReplication` is disabled.

**Shape:** an Effect `D1Session` service over `raw.withSession`, a bookmark header through the Website proxy, and the client holding a monotonic bookmark.

**Size:** S–M. Recommended: **skip for now**. It is orthogonal to Alchemy, the code ports nearly verbatim from Baton, and replication can be turned on later with one prop ([Q6](#8-questions-with-recommendations)).

### 4.7 Folded into the spikes: observability and testing

- **Structure at scale.** `ShopAgent` is 2,236 lines split into `agent/{Host,Orders,ShopWork,Billing}` services. S1 and S2 should settle the Effect equivalent:
  - one `RpcGroup` per bounded context, merged;
  - handler layers per context;
  - an `ActorHost` service exposing `publish`, `currentConnection` and `sql`;
  - the list memo (`Cache`) inside the handler layer, rebuilt per activation.
- **Logging and tracing.** Port `LayerEx` (JSON logger when deployed; cause flattened into one message). The flattening was needed because DO RPC kept only `.message`; with Effect RPC, typed failures cross intact, so check what is still needed. Try `Cloudflare.Telemetry()` once in S2 with sampling, to see whether Effect spans add anything over logs at an acceptable cost. That needs the compat date bumped to 2026-07-28 or later; see [Q7](#8-questions-with-recommendations).
- **Testing.** Baton's integ suite leaned on `@cloudflare/vitest-pool-workers`: `runInDurableObject`, `introspectWorkflow` step mocks, `disableSleeps`, statement counting through a storage proxy. Under Alchemy's harness we drive real sockets (already done) but cannot mock steps. S2 must find the pattern: likely a `Layer` seam so the Workflow's external calls are test layers, with short sleeps in test. S1 should replace Baton's `_isCallable` role-map test with a test that walks the `RpcGroup` and asserts every procedure declares a role middleware.

## 5. Recommended order

1. **S1 identity, roles, revocation** (with the D1 teams and members slice, and the structure-at-scale layout). Nothing else in the port is meaningful until callers are known.
2. **S4 client ergonomics** right after, since it consumes S1's close codes and is small.
3. **S2 Workflow and streamed ingest** (optionally as S2a then S2b).
4. **S3 timers and cron.**
5. **S5 lifecycle and console** when the port reaches uninstall and the admin side; **S6** only if read replicas are wanted before launch.

After S1 to S3 the remaining risk in the port is Shopify itself (OAuth, App Bridge, webhooks, billing) and Polaris, which is the brief's planned next phase.

## 6. Polaris web components now?

Baton's public side (outside the admin iframe: `/shop/$shop`, help, login) renders Polaris web components from Shopify's CDN script. Switching this repo from Astryx would show how a CDN-loaded custom-element library behaves under TanStack Start SSR and hydration inside the Alchemy Website, with no Alchemy or Effect risk in it. Those concerns are already handled in Baton, and the switch would rewrite every page and every browser test written so far. Recommended: defer to the Shopify phase as the brief leans; if any early signal is wanted, one throwaway page with a Polaris `s-button` and `s-text-field` answers the SSR question in an hour, without migrating the app.

## 7. Out of scope

Shopify OAuth, session tokens, App Bridge, Admin/Partner APIs, bulk operations, webhook HMAC, App Pricing and usage events; Polaris migration; Queues, KV, AI, Analytics Engine (Baton uses none of them except KV for demo links, which this repo already replaced with inline delivery); jurisdictions and location hints.

## 8. Questions with recommendations

Q1. **Stand-in domain for the spikes.** Spike against abstract stand-ins (counters, jobs), or a thin slice of Baton's own non-Shopify model: teams and members in D1; workflow templates, runs and run tasks in the actor; synthetic orders in place of Shopify's?
Recommendation: the Baton slice. Spikes then produce the schemas, repositories and handler layout the port reuses; the role rules (member sees only their teams' runs) are real enough to test S1 properly; and it follows the house rule that sandbox code is reference code. Keep it thin: one workflow template, one run state machine, no editor UI.

- [ ] Thin Baton slice with synthetic orders (recommended)
- [ ] Abstract stand-ins
- [ ] Other

Q2. **How identity reaches the actor (S1).** A: patch Alchemy's RPC transport (`onUpgrade` → tags + attachment, `CurrentConnection`, `closeConnections`) and offer it upstream; B: vendor the transport into the repo; C: stock transport with a signed per-request token.
Recommendation: A, via `pnpm patch` with an upstream PR. It is the smallest change that gives Baton's exact semantics (identity at connect, hibernation-safe, tag lookup for revoke and displace), and Alchemy beta.80 already added typed attachments and RPC sockets, so it is the direction they are moving. B if upstream says no and the patch gets painful; C only if neither is acceptable, because it cannot displace and revokes only by expiry.

- [ ] A: patch + upstream PR (recommended)
- [ ] B: vendor the transport
- [ ] C: signed per-request token, stock transport
- [ ] Other

Q3. **S2 as one spike or two.** S2a (DO→Workflow→DO, single flight, error sink, test pattern) then S2b (streamed NDJSON ingest, per-item transactions, interleaving), or both at once?
Recommendation: two. S2a answers the Alchemy questions; S2b is mostly Effect and SQLite and ports Baton's stream code closely. Separate landings keep each verifiable.

- [ ] Two landings, S2a then S2b (recommended)
- [ ] One spike
- [ ] Other

Q4. **Use `makeCallback` alarms in the port, or keep Baton's "ride on writes"?**
Recommendation: spike S3 and adopt `makeCallback` for the outbox flush and retention. Baton avoided alarms because the SDK's scheduler was not durable for this use; Alchemy's is SQLite-backed, transactional with writes, and at least once, which is exactly the outbox pattern. Keep the ride-on-write flush too as a fast path.

- [ ] Spike and adopt `makeCallback` (recommended)
- [ ] Keep ride-on-write only; skip S3 except cron
- [ ] Other

Q5. **Actor lifecycle and console (S5): now or at the port's uninstall step?** And for destroy-by-id with no `idFromString` in Alchemy: raw namespace access, or destroy by name only?
Recommendation: defer S5 until the port reaches uninstall and admin; when it does, destroy by name (the shop domain is the name) and list orphans by REST, which needs no `idFromString`. Report the commented-out methods upstream alongside the S1 PR.

- [ ] Defer; destroy by name; report upstream (recommended)
- [ ] Spike now
- [ ] Other

Q6. **D1 read replication with sessions (S6).**
Recommendation: skip for now; port Baton's session code when replication is turned on. It carries no Alchemy risk beyond using `raw`.

- [ ] Skip for now (recommended)
- [ ] Spike it
- [ ] Other

Q7. **Bump the compatibility date to try `Cloudflare.Telemetry()` during S2?**
Recommendation: yes, a one-time measured trial on staging with low head sampling, then decide. Effect spans bridged into Cloudflare's trace view is something Baton could not have; the cost question is Baton's and is answered by one day of numbers.

- [ ] Yes, trial on staging (recommended)
- [ ] No, logs only, as Baton
- [ ] Other

Q8. **Polaris web components.**
Recommendation: defer to the Shopify phase. Optionally one throwaway page to check SSR and hydration of Polaris custom elements under the Alchemy Website, without migrating anything.

- [ ] Defer (recommended)
- [ ] Defer, but do the one-page SSR check
- [ ] Migrate the member and admin pages now
- [ ] Other

Q9. **Order.** S1 → S4 → S2a → S2b → S3, with S5 and S6 deferred.
Recommendation: as listed; S1 first because every other spike's procedures need a caller identity to be realistic.

- [ ] As listed (recommended)
- [ ] Other order
