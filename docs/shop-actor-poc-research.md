# Research: ShopActor proof of concept (Durable Object, hibernating WebSocket, Effect RPC, Effect Atom)

Research date: 2026-10-11.
Status: research only. All recommendations in [§13](#13-questions-with-recommendations) accepted in Plannotator on 2026-10-11; not implemented.
Versions: Alchemy `2.0.0-beta.81` (`refs/alchemy` and the installed copy are byte-identical), Effect `4.0.1`, `@effect/atom-react` `4.0.1`, `@effect/sql-sqlite-do` `4.0.1` (in the pnpm store as Alchemy's dependency, not hoisted), `@cloudflare/workers-types` `5.20261006.1`, Baton pins `agents` `0.28.0`. Do not bump dependencies.
Background: [glossary](./glossary.md) (**Actor** = a Durable Object named `<Key>Actor`), [loaded-data-path research](./loaded-data-path-and-direct-backend-research.md) §7.2 and Q2 (a WebSocket upgrade is a GET; the proxy route 405s it today; "decide the exact hop when that phase starts"), [IPC research](./start-to-effect-worker-ipc-research.md) D2 (every crossing is Schema-validated), [Worker split research](./tanstack-start-alchemy-worker-split-research.md) §2 (the Bridge), [auth integration plan](./better-auth-integration-plan.md).

Sources: `refs/alchemy/packages/alchemy/src/Cloudflare/Workers/{DurableObject,DurableObjectBridge,DurableObjectState,DurableObjectStorage,WebSocket,RpcDurableObject,RpcWebSocket,RpcWebSocketClient,SqlMigrations,WorkerProvider,LocalWorkerProvider}.ts`, `refs/alchemy/packages/alchemy/src/Cloudflare/Fetcher.ts`, `refs/alchemy/packages/alchemy/src/Drizzle/Cloudflare.ts`, `refs/alchemy/packages/cloudflare-runtime/src/vite/{websockets,dev-plugin}.ts`, `refs/alchemy/website/src/content/docs/cloudflare/{apis/effect-rpc,compute/durable-objects,compute/hibernatable-websockets,compute/cross-worker-durable-object,local-development}.mdx`, `refs/alchemy/website/src/content/docs/sql/effect-sql/migrations.mdx`, `refs/alchemy/examples/cloudflare-worker/src/Room.ts`, `refs/alchemy/packages/alchemy/test/Cloudflare/Workers/{HibernatingWebSocket,RpcWebSocket,RpcWebSocketClient}.test.ts`; `node_modules/effect/src/rpc/{RpcServer,RpcClient,RpcMessage,RpcSerialization,Rpc}.ts`, `node_modules/effect/src/socket/Socket.ts`, `node_modules/effect/src/reactivity/{Atom,AtomRpc,Reactivity,AtomRegistry}.ts`, `node_modules/effect/src/http/{HttpServerResponse,HttpServerRequest}.ts`, `node_modules/effect/src/sql/Migrator.ts`, `refs/effect/packages/sql/sqlite-do/src/{SqliteClient,SqliteMigrator}.ts` and `test/{Client,Miniflare}.test.ts`, `refs/effect/packages/platform/node/test/RpcServer.test.ts`; `refs/baton/src/lib/{ShopAgent,ShopAgentClient,ShopAgentSocketHost,ShopAgentContext,useLiveQuery,ShopAgentSchema}.ts(x)`, `refs/baton/src/worker.ts`, `refs/baton/wrangler.jsonc`; `refs/agents/packages/agents/src/{index,agent-routing,client,lifecycle/*,websockets/*}.ts`, `refs/partykit/packages/partysocket/src/ws.ts`; `refs/cloudflare-docs/src/content/docs/durable-objects/{api/state,api/base,api/sqlite-storage-api,best-practices/websockets,best-practices/rules-of-durable-objects,concepts/durable-object-lifecycle,reference/durable-objects-migrations,platform/limits}.mdx`.

## 1. Summary

- **Alchemy already has the whole server half.** `Cloudflare.RpcDurableObject` takes an `RpcGroup` and a handler `Layer` and serves it two ways on the same object: Effect RPC over HTTP (ndjson) and Effect RPC over a **hibernating** WebSocket (JSON). The WebSocket transport (`RpcWebSocket.ts`) accepts sockets with `ctx.acceptWebSocket`, persists the connection's client id in the socket attachment, restores connections from `getWebSockets` after a wake, and installs the RPC Ping/Pong as a `setWebSocketAutoResponse` pair so the client's heartbeat never wakes the object. Nothing of this needs to be written; see [§4](#4-websockets-and-hibernation-what-alchemy-does).
- **Every Alchemy Durable Object is SQLite-backed, with no configuration.** Class migrations (`new_sqlite_classes`, renames, deletes) are computed from the Stack and sent with the Worker; there is no user-facing migration config, and no way to create a KV-backed class ([§3.3](#33-class-migrations-are-automatic)). The DO is hosted by the Backend Worker, which is already an Effect Worker, so `yield* ShopActor` in its init binds the namespace ([§3.2](#32-hosting-and-binding)).
- **The one thing Alchemy does not give us is server push that survives hibernation.** A `stream: true` RPC subscription works, but while any request or stream is in flight the transport calls `state.waitUntil(...)` and disables the auto-response heartbeat, so a subscribed actor never hibernates and every 5 s client ping wakes it. And Effect's `RpcClient` ignores any server frame it does not recognise (its dispatch has a `default: Effect.void`), so a server-initiated notification over the RPC protocol is silently dropped. The practical pattern is Baton's: the actor sends a small **notice frame** (`{ "_tag": "ShopActorNotice", ... }`) to every socket with `socket.send`, no request is pending, and the client **taps the socket reader** to pull notices out before the RPC parser sees them, then calls `Reactivity.invalidate`. Query atoms with that reactivity key refetch over the same socket ([§5](#5-the-push-problem-broadcasting-invalidations-under-hibernation)).
- **The client is one `AtomRpc.Service` with an isomorphic protocol.** In the browser the protocol is `RpcClient.layerProtocolSocket` over `Socket.layerWebSocket` with JSON serialization; during SSR it is `RpcClient.layerProtocolHttp` over the service binding with ndjson, to the same object. `AtomRpc.Service` accepts `protocol` as a function of the atom context, and `createIsomorphicFn` already picks sides in `backend-client.ts`. `Reactivity.invalidate` from a notice stream reaches `Atom.withReactivity` because both resolve `Reactivity` through the same runtime factory ([§6](#6-the-client-atomrpc-over-the-socket)).
- **The hop is browser → Website route → Backend → actor.** The Website route gains a `GET` handler that forwards the upgrade through `env.BACKEND.fetch`; Start returns a handler's `Response` unchanged, and the Backend's `fetch` calls `actors.fetch(name, request)`, which forwards the upgrade to the named object and passes the 101 back. Alchemy's Vite dev plugin proxies `upgrade` requests to workerd, so this works under `alchemy dev` ([§7](#7-routing-auth-and-dev)).
- **SQLite inside the actor: `@effect/sql-sqlite-do` with `SqliteMigrator.fromRecord`.** `SqliteClient.layer({ storage: state.raw.storage })` in the inner (per-activation) Effect, migrations as code, run on every activation inside the `blockConcurrencyWhile` Alchemy already wraps construction in. Alchemy's own `Cloudflare.SqlMigrations` (`.sql` files, like our D1 migrations) is the alternative ([§8](#8-sqlite-storage-in-the-actor)).
- **What the Agents SDK gave Baton and what we do instead** is tabulated in [§9](#9-baton-and-the-agents-sdk-what-we-replace). We keep the shape of Baton's invalidation pattern (broadcast "re-read", clients refetch) and drop `@callable`, PartySocket, the identity frame, and the SDK's scheduler.
- **Proposed POC:** a `ShopActor` with a `count` table and two procedures, `GetCount` and `Increment`; a member page with the count and a button; two tabs see each other's clicks; an `Activation` procedure proves hibernation by returning a per-activation id that changes after idle ([§10](#10-proposed-proof-of-concept)).

## 2. What exists today and what the POC adds

| Today                                                                                                                 | POC                                                                                                            |
| --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `Backend`: `Cloudflare.Worker`, Effect RPC over HTTP ndjson via `RpcServer.toHttpEffect` (`src/backend/worker.ts`)    | Also hosts `ShopActor` (`Cloudflare.RpcDurableObject`) and forwards `/api/actor/:key` to it                    |
| Website proxy route `/api/rpc`: `POST` forwards, `GET` 405 "until the Durable Object phase" (`src/routes/api.rpc.ts`) | A new route `/api/actor/$key` with `GET` (upgrade) and `POST` (SSR RPC) both forwarding to `env.BACKEND.fetch` |
| `BackendClient`: `AtomRpc.Service` with `layerProtocolHttp`, isomorphic transport (`src/backend-client.ts`)           | `ShopActorClient`: `AtomRpc.Service` with socket protocol in the browser, HTTP protocol on the server          |
| Reactivity keys invalidated by our own mutations (`Atom.withReactivity`, `reactivityKeys`)                            | Also invalidated by notices pushed from the actor                                                              |
| D1 for auth and members; no Durable Objects                                                                           | SQLite storage inside the actor via `@effect/sql-sqlite-do`                                                    |
| `vp test` tiers: unit, browser, integ; Playwright e2e on its own stage                                                | One test per tier for the actor ([§11](#11-testing))                                                           |

## 3. Alchemy Durable Objects

### 3.1 Declaration: two Effects, one class

`Cloudflare.DurableObject<Self>()(name, impl)` and `Cloudflare.RpcDurableObject<Self>()(name, { schema }, impl)` share one shape (`DurableObject.ts`, `RpcDurableObject.ts`): `impl` is an **outer** Effect that runs once per isolate (resolve dependencies, take the `Cloudflare.DurableObjectState` reference) and returns an **inner** Effect that runs **once per activation**, including after every hibernation wake, inside `state.blockConcurrencyWhile` (`DurableObjectBridge.ts`, the constructor). Anything the instance holds in memory is rebuilt there.

- Plain `DurableObject`: the inner Effect returns a `DurableObjectShape`: optional `fetch` (`HttpEffect`), `alarm`, `webSocketMessage`, `webSocketClose`, `webSocketError`, and any other function becomes an RPC method on the stub (its return values are `JSON.stringify`d, so `Schema.Class` identity is lost).
- `RpcDurableObject`: the inner Effect returns `Group.toLayer({...})`; Alchemy builds the HTTP and WebSocket transports around it (`makeHandlers`). This is the one to use: the JSDoc itself says to prefer it whenever values cross the boundary as Schema, and it is the only way to get the hibernating RPC transport.
- Both have a **modular form** (`(name, { schema })` plus `static make(impl)` and `static from(worker)`) for cross-script binding. Not needed here; the inline class form keeps class and runtime together, like `Backend` does.

`Cloudflare.DurableObjectState` (`DurableObjectState.ts`) wraps `ctx`: `id`, `storage` (Effect-wrapped `ctx.storage`, with `sql.exec` returning a cursor-stream, `transaction`, alarms, bookmarks), `raw` (the native `DurableObjectState`), `waitUntil`, `blockConcurrencyWhile`, `acceptWebSocket(ws, tags?)`, `getWebSockets(tag?)`, `setWebSocketAutoResponse`, `getTags`, `abort`. Every method is coloured with `RuntimeContext`, so it can only run in the inner Effect or a handler.

### 3.2 Hosting and binding

A Durable Object class lives in exactly one Worker script. `yield* ShopActor` inside the Backend's init Effect does three things: exports the class from the Backend bundle, declares the `durable_object_namespace` binding on the Backend (binding name = class name = the declared `name`), and yields the namespace handle. For `RpcDurableObject` the handle has `fetch(id, request)` (select the named instance and forward an HTTP request **or a WebSocket upgrade**) and `getByName(id)` (an Effect yielding a typed `RpcClient` over HTTP ndjson to that instance; yield it inside a per-request scope). Only `getByName` and `namespaceId` exist on the runtime object; `idFromName`, `newUniqueId`, `get`, `jurisdiction` are declared but commented out in `binding()`.

The Website is a plain TanStack Start Worker with no Alchemy runtime, so it cannot host the class or hold the Effect client. It can only forward. That is the same split the proxy route already makes (Website → `env.BACKEND.fetch`), so the Backend is the host ([Q2](#13-questions-with-recommendations)).

### 3.3 Class migrations are automatic

`WorkerProvider.ts` computes `{ newSqliteClasses, renamedClasses, deletedClasses, transferredClasses }` from the Stack and ships them with the script: the migration tag is a script tag `alchemy:migration-tag:<v>`, class ↔ logical-id mappings are packed into `alchemy:dos:` tags, a changed `className` on the same logical id is a rename, a vanished logical id is a delete (after checking the script still hosts the class). **Every new class goes to `newSqliteClasses`**; the legacy KV set is always empty. `DurableObjectProps` has `sqlite?` only as a commented-out field. There is nothing for us to write, and nothing that corresponds to Baton's `"migrations": [{ "tag": "v1", "new_sqlite_classes": ["ShopAgent"] }]`.

Consequences: a rename of the class string is safe (Alchemy emits `renamed_classes`); deleting the class deletes every instance's storage; a gradual rollout (`version.traffic`) that changes classes fails by design. Local dev always declares the namespace with `sql: true` (`LocalWorkerProvider.ts`) and stores under `.alchemy/local`.

### 3.4 Dev and types

`alchemy dev` runs workerd directly (not miniflare, not wrangler). Durable Objects run inside the local workerd with SQLite storage, and the Website's Vite dev server forwards `upgrade` requests to workerd (`cloudflare-runtime/src/vite/websockets.ts`, bound in `dev-plugin.ts`). `Cloudflare.InferEnv` types a DO binding as `DurableObjectNamespace<Shape>`; the Website does not bind the namespace, so `WebsiteEnv` is unchanged.

## 4. WebSockets and hibernation: what Alchemy does

The Cloudflare rules (`durable-object-lifecycle.mdx`, `best-practices/websockets.mdx`, `api/state.mdx`): an object hibernates after roughly 10 s with no in-flight request, no `setTimeout`/`setInterval`, no pending `waitUntil`, and only hibernation-API sockets (`ctx.acceptWebSocket`, not `ws.accept()`); in-memory state is discarded and the constructor re-runs on the next event; a socket attachment (`serializeAttachment`) survives, up to 16,384 bytes; at most 10 tags of 256 chars per socket; `setWebSocketAutoResponse` answers a fixed request string with a fixed response string without waking the object (each string at most 2,048 chars). Protocol-level ping frames are auto-ponged by the runtime. Modern workerd (any version we can run) simulates hibernation locally.

`RpcWebSocket.make` (`RpcWebSocket.ts`), wired by `RpcDurableObject.makeHandlers`, is a custom `RpcServer.Protocol` that lives in an instance-owned scope:

| Concern       | What it does                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Upgrade       | `fetch` on a `GET` with `upgrade: websocket`: `new WebSocketPair()`, `state.acceptWebSocket(server, ["alchemy:rpc"])`, a fresh client id persisted in the attachment under `__alchemyRpcWebSocket` (`{ version: 1, clientId, pending, serialization }`), then a 101 `Response` carried as a raw body (`HttpBody.raw`), which `HttpServerResponse.toWeb` passes through intact. Any other request on the WebSocket path gets 426. |
| Inbound       | `webSocketMessage` decodes the frame with the connection's parser and hands each `Request` to the `RpcServer`. Duplicate request ids close the socket.                                                                                                                                                                                                                                                                           |
| Staying awake | While a connection has pending requests it calls `state.waitUntil(idle.await)` and turns the heartbeat auto-response **off**. The object cannot hibernate mid-request (correct: there would be no one to answer), and the client's pings reach JS.                                                                                                                                                                               |
| Heartbeat     | Effect's `RpcClient` socket protocol sends `Ping` every 5 s and reconnects if no `Pong` arrives in time. The transport encodes `constPing`/`constPong` with the serializer and, for string serializers (JSON here), registers them as the auto-response pair, so an **idle** connection's pings are answered by the runtime without waking the object. It dies if someone else owns the auto-response.                           |
| Wake          | On activation it walks `state.getWebSockets("alchemy:rpc")`, restores each connection from its attachment, and **closes with 1012** any socket whose attachment says a request was pending, or whose serializer content type differs. Nothing is replayed.                                                                                                                                                                       |
| Disconnect    | `webSocketClose`/`webSocketError` unregister the connection and offer its id to `disconnects`, which makes the `RpcServer` interrupt that client's fibers.                                                                                                                                                                                                                                                                       |
| Serialization | JSON (`RpcSerialization.layerJson`) over WebSocket, one message per frame; ndjson over HTTP. Both are fixed by `RpcDurableObject`; a client must match (JSON).                                                                                                                                                                                                                                                                   |

The `effect-rpc.mdx` guide states the contract plainly: idle connections survive hibernation and accept new calls after the wake; in-flight calls and streams are not replayed; a reconstructed instance with unfinished work closes the socket with 1012 and the client must handle it. Effect's client does: any close becomes a `SocketError`, the read loop retries forever under `Schedule.min([Schedule.exponential(500, 1.5), Schedule.spaced(5000)])`, pending requests fail with `RpcClientError`, and the next call goes out on the new socket.

What this means for us: **a request/response RPC over the socket is hibernation-safe for free**. The constraints come from anything long-lived, which is the next section.

## 5. The push problem: broadcasting invalidations under hibernation

Baton's pattern: the agent writes, then sends `{ "type": "invalidated" }` to every identified connection (never the data), and the client refetches its live queries over the socket (`ShopAgent.publish`, `useLiveQuery.ts`). We want the same with Effect. Five ways to carry the notice, assessed against the pinned sources:

| Option                                                                                                                                                                                       | Hibernates with clients connected?                                                                                                                                                                                       | Effect RPC over the socket?              | Assessment                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Stream RPC subscription** (`Rpc.make("Notices", { stream: true })`, handler returns `Stream.fromPubSub`)                                                                                | **No.** The subscription is a pending request: `waitUntil` holds the object, the heartbeat auto-response is off, every 5 s ping wakes JS. After a platform reset the socket closes 1012 and the client must resubscribe. | Yes, pure Effect RPC                     | Simplest to write and the most idiomatic Effect, but it defeats the one hard requirement. Only acceptable if hibernation is deferred ([Q4](#13-questions-with-recommendations)).                                                                                                                                                                                                                   |
| **B. Server-initiated RPC notification** (the protocol has `supportsNotifications: true`; `FromServerEncoded` includes `RequestEncoded`)                                                     | Yes                                                                                                                                                                                                                      | Yes, in the wire format                  | **Dead end.** Effect's `RpcClient.make` dispatch handles `Chunk`, `Exit`, `Defect`, `ClientProtocolError` and falls to `default: Effect.void` (`RpcClient.ts` ~779). A notification is received and dropped. The flag exists for JSON-RPC servers, not for this client.                                                                                                                            |
| **C. Second plain WebSocket for notices** (a `Cloudflare.DurableObject` next to the RPC one, or a second path on the same object)                                                            | Yes                                                                                                                                                                                                                      | Yes, on the first socket                 | Two connections per tab, two upgrade routes, two auth checks; a `Cloudflare.DurableObject` and an `RpcDurableObject` cannot share one object, so the notice socket would live on a different object or the RPC object would have to be hand-built. Heavier than D or E for no gain.                                                                                                                |
| **D. Notices only over the socket; RPC stays HTTP** (a `Cloudflare.DurableObject` with `Cloudflare.upgrade()` and hand-rolled Schema frames; commands go through the Backend to `getByName`) | Yes                                                                                                                                                                                                                      | **No** (RPC is HTTP through the Backend) | Closest to Baton as built and the least code at the actor. Fails the brief's "Effect RPC over that WebSocket". Kept as the fallback if E's tap proves brittle ([Q4](#13-questions-with-recommendations)).                                                                                                                                                                                          |
| **E. RPC over the socket, plus a notice frame on the same socket** (recommended)                                                                                                             | Yes: a notice is a `socket.send` with nothing pending, so the heartbeat stays on auto-response                                                                                                                           | Yes                                      | Server: iterate `state.getWebSockets()` and `send(JSON.stringify(notice))`. Client: a `Socket` wrapper filters notice frames out of the reader into a `PubSub` before the RPC protocol parses them. Relies on two facts verified in the pinned sources: Alchemy's WebSocket serializer is JSON, one message per frame; and the frames we remove never reach Effect's parser, so the shape is ours. |

### 5.1 Option E in detail

Server side, inside the inner Effect of `ShopActor`:

```ts
const Notice = Schema.Struct({
  _tag: Schema.Literal("ShopActorNotice"),
  invalidated: Schema.Array(Schema.String),
});
const encodeNotice = Schema.encodeSync(Schema.toJsonString(Notice)); // exact API to confirm in the spike

const notify = Effect.fn("ShopActor.notify")(function* (keys: ReadonlyArray<string>) {
  const frame = encodeNotice({ _tag: "ShopActorNotice", invalidated: keys });
  for (const socket of yield* state.getWebSockets()) yield* socket.send(frame).pipe(Effect.ignore);
});
```

`state.getWebSockets()` returns Alchemy's RPC sockets (they carry the `alchemy:rpc` tag, but an untagged call returns every socket). A send to a socket mid-close fails; ignore it, as Baton does. The send happens inside the `Increment` handler after the write, so it runs inside that request's `waitUntil` window; no extra work is pending afterwards, and the object can hibernate.

Client side, the socket layer:

```ts
// Wraps the WebSocket Socket: frames that decode as Notice go to the PubSub and are removed;
// everything else is handed on to the RPC protocol untouched.
const layerNoticeTap = (notices: PubSub.PubSub<Notice>) =>
  Layer.effect(
    Socket.Socket,
    Effect.gen(function* () {
      const inner = yield* Socket.makeWebSocket(url); // Socket.makeWebSocket(url): Effect<Socket, never, WebSocketConstructor>
      return Socket.make({
        writer: inner.writer,
        reader: Effect.map(inner.reader, (reader) => ({
          ...reader,
          pull: pullFiltered(reader.pull, notices),
        })),
      });
    }),
  );
```

`pullFiltered` loops: pull a chunk, decode each string frame with `Schema.decodeUnknownOption(Notice)`, publish the matches, return the remainder, and pull again if nothing remains (the reader contract is a non-empty array). `Socket.make({ reader, writer })` is the public constructor (`Socket.ts`). The spike must confirm that `reader.pull` receives whole frames as strings for text messages (it does for `makeWebSocket`: the `message` handler forwards `event.data` as-is) and that filtering does not disturb the protocol's `Ack` handling (it does not: acks are frames the filter passes through).

Then one atom turns notices into invalidations:

```ts
export const noticesAtom = ShopActorClient.runtime.atom(
  Stream.fromPubSub(notices).pipe(Stream.tap((n) => Reactivity.invalidate(n.invalidated))),
);
// mounted by the page (useAtomMount), or Atom.keepAlive
```

`Reactivity.invalidate` is an Effect requiring `Reactivity`, which `ShopActorClient.runtime` provides; `Atom.withReactivity(["count"])` on the query atom registers against the same `Reactivity` instance because both come from the runtime factory's memo map (`AtomRpc.ts`, `Atom.ts` `AtomRuntime`). This is the same mechanism `reactivityKeys` on a mutation uses today.

Missed notices: a notice sent while a tab's socket was down is lost (Baton has the same gap and re-reads on every re-identify). Effect's socket protocol reads an optional `RpcClient.ConnectionHooks` service with `onConnect`/`onDisconnect`; providing `onConnect: Reactivity.invalidate(["count"])` refetches after every (re)connect, which closes the gap.

### 5.2 Why not fix B instead

`supportsNotifications` and the server→client `RequestEncoded` exist for JSON-RPC interop. Making Effect's client surface them would be a change to `effect`, out of scope here. E uses only public surface (`Socket.make`, `getWebSockets`, `send`) and reads as "a notice channel multiplexed on the RPC socket", which is honest about what it is.

## 6. The client: AtomRpc over the socket

`AtomRpc.Service<Self>()(id, { group, protocol })` accepts `protocol` as a `Layer` **or** `(get: AtomContext) => Layer` (`AtomRpc.ts` ~148). `backend-client.ts` already builds an isomorphic HTTP protocol with `createIsomorphicFn`. For the actor:

| Side    | Protocol layer                                                                                                                                                                            | Why                                                                                                                     |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Browser | `RpcClient.layerProtocolSocket()` ← `layerNoticeTap(notices)` (a `Socket` over `wss://<origin>/api/actor/<key>`) ← `Socket.layerWebSocketConstructorGlobal`; `RpcSerialization.layerJson` | Matches Alchemy's WebSocket serializer. One socket per registry, i.e. per tab, opened when the first actor atom mounts. |
| SSR     | `RpcClient.layerProtocolHttp({ url: "https://backend/api/actor/<key>" })` ← `FetchHttpClient` with `env.BACKEND.fetch` and the cookie forwarded; `RpcSerialization.layerNdjson`           | Same object, same `RpcGroup`, over the binding; `loadQuery` primes and dehydrates `countAtom` exactly like `helloAtom`. |

Alchemy's `alchemy/Cloudflare/RpcWebSocketClient.layer` is the same composition for a `Context.Service` client; `AtomRpc.Service` needs the protocol layer, not the client, so compose the Effect layers directly (the guide shows this under "Compose the built-in Effect layers directly").

Behaviour to expect, from `RpcClient.ts`:

- The socket opens when the protocol layer is built, which is when the first atom of `ShopActorClient.runtime` is read. Pages that never read an actor atom never connect.
- Reconnect is automatic and unbounded with a 5 s cap. A clean server close (1000, 1012) is also treated as an error and reconnected. In-flight calls fail with `RpcClientError`; the atom shows that failure like any other.
- With `retryTransientErrors: true`, failures to **open** the socket do not fail pending calls; they wait for the next attempt.
- The query atom: `ShopActorClient.query("GetCount", undefined, { serializationKey: "count", timeToLive: "5 minutes" }).pipe(Atom.withReactivity(["count"]), refreshOnFocus)`. The mutation: `ShopActorClient.mutation("Increment")`; it needs no `reactivityKeys`, because the actor's notice invalidates every tab including the one that clicked. (Keeping `reactivityKeys: ["count"]` on the mutation too gives the clicking tab an immediate refetch rather than waiting for the notice; it is harmless.)

Open point: the actor key. `AtomRpc.Service` has one protocol per registry; the URL (and so the actor) is fixed when the layer is built. For a POC with one key that is fine ([Q3](#13-questions-with-recommendations)). A per-key client later means `Atom.family` over `AtomRpc.Service` instances, or passing the key as payload and routing inside one object. Not needed now.

## 7. Routing, auth, and dev

Hop: `wss://<website>/api/actor/<key>` → Website route `GET` handler → `env.BACKEND.fetch(request)` → Backend `fetch` matches `/api/actor/:key` → `actors.fetch(key, request)` → object's `fetch` (Alchemy transport) → 101. The 101 comes back the same way: `stub.fetch` through `fromCloudflareFetcher` special-cases 101 into a raw body (`Fetcher.ts`), the Backend's `toWeb` passes the raw `Response` through, the service binding returns a native `Response` with `webSocket`, and Start returns a handler's `Response` unchanged (`handlerCallback.ts`, cited in the loaded-data-path research). Each link is in source; the full chain through a Start route is untested and is the first thing the spike verifies ([§12](#12-risks-and-what-the-spike-must-verify)).

The existing proxy route's `rejectRequest` (ndjson content type, body limit) applies to the `POST` side only; a `GET` upgrade has no body. The new route checks `upgrade: websocket` on `GET` and otherwise 405s, and reuses `rejectRequest` on `POST`.

Auth: the browser's upgrade carries the same-origin Better Auth cookie, so unlike Baton (which had to mint a Shopify token into `?token=` because an embedded iframe is cross-origin), the Backend can resolve the session with its existing `Auth` service before forwarding and return 401 otherwise. Recommended: require a signed-in member, i.e. the actor is reachable from `/app` and not anonymously, so the reference pattern is the one real features will use ([Q5](#13-questions-with-recommendations)). Authorization of _which_ key a member may open is a product question with no answer yet; the POC allows any key for a signed-in member and says so in the handler's JSDoc.

Dev: Alchemy's Vite dev plugin listens to the Node HTTP server's `upgrade` event and forwards the handshake to the local workerd address (`websockets.ts`), skipping only Vite's own HMR socket. The Backend runs in the same local workerd with the DO namespace declared `sql: true`. Hibernation is simulated by workerd, so the `Activation` check in [§10](#10-proposed-proof-of-concept) can be run locally.

## 8. SQLite storage in the actor

Two ways, both Effect-based, both already in `node_modules`:

| Aspect            | `@effect/sql-sqlite-do` (recommended)                                                                                                                                                                       | Alchemy `Cloudflare.SqlMigrations` + `@effect/sql-sqlite-do` for queries                                                                                                                                                            |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client            | `SqliteClient.layer({ storage: state.raw.storage })`, provides `SqlClient.SqlClient`; built in the inner Effect; `pnpm add @effect/sql-sqlite-do@4.0.1` because it is not hoisted                           | Same client                                                                                                                                                                                                                         |
| Migrations        | `SqliteMigrator.run({ loader: SqliteMigrator.fromRecord({ "0001_count": Effect.gen(...) }) })`, migrations as code, history in `effect_sql_migrations`, all pending ones in **one** `storage.transaction()` | `yield* Cloudflare.SqlMigrations("./actor-migrations")` in the outer Effect (files read at plan time, embedded in the bundle), `migrations.apply()` in the inner; one `transactionSync` per file; history in `__alchemy_migrations` |
| When they run     | Inner Effect, so on every activation, under the constructor's `blockConcurrencyWhile` (30 s cap). Cost per wake: `CREATE TABLE IF NOT EXISTS` plus one select.                                              | Same                                                                                                                                                                                                                                |
| Fit with the repo | Matches the brief ("Effect SQLite DO support and its way of handling migrations"); queries look exactly like `members.ts` (`sql\`...\``plus`Schema.decodeUnknownEffect`)                                    | Matches the D1 contract (`migrations: "./migrations"` directory of `.sql`) already used for `AuthDb`                                                                                                                                |

Facts that shape the code (`SqliteClient.ts`, `Migrator.ts`, `sqlite-storage-api.mdx`, `rules-of-durable-objects.mdx`):

- Pass `storage`, not `db`: with only `db: ctx.storage.sql`, `withTransaction` fails ("Transactions require Durable Object storage"). With `storage`, it uses the async `storage.transaction()`; `BEGIN`/`SAVEPOINT` through `exec` are not allowed by the platform. Nested transactions nest; concurrent sibling transactions are unsupported; all access is serialised by a semaphore of 1.
- Alchemy's `Drizzle.DurableObject` patches `withTransaction` to run on a `Scheduler.MixedScheduler("sync")` because "a parent input-gate timer can block later transaction timers" (`Drizzle/Cloudflare.ts`). The POC's `Increment` is a single `UPDATE ... RETURNING` and needs no transaction, so the patch can wait until a multi-statement write exists; note it in the client's JSDoc.
- `PRAGMA user_version` is unsupported, which is why both migrators keep a table.
- Limits: 10 GB per object, 100 bound parameters per statement, 2 MB per row or value, 100 KB per statement.
- `updateValues` is unsupported by the DO client; BLOBs come back as `Uint8Array`.

POC schema, as a `fromRecord` migration:

```sql
CREATE TABLE count (id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL);
INSERT INTO count (id, value) VALUES (1, 0);
```

Reads: `SELECT value FROM count WHERE id = 1`. Writes: `UPDATE count SET value = value + 1 WHERE id = 1 RETURNING value`. Decoded with a `Schema.Struct({ value: Schema.Int })` row schema, like `MemberRow`.

Where it lives: `src/backend/shop-actor.ts` (the class, handlers, SQL), `src/api/shop-actor.ts` (the `RpcGroup`, schemas, the `Notice` schema), following the `api/` vs `backend/` split in the glossary.

## 9. Baton and the Agents SDK: what we replace

Baton's `ShopAgent extends Agent` (`agents@0.28.0`), one object per shop (`getByName(shop)`), hibernating (the SDK made hibernation mandatory and vendored `partyserver`), Effect SQL inside via `SqliteClient.layer({ storage })` and `SqliteMigrator.fromRecord`, Better Auth checked at the Worker gate with the identity forwarded as `x-baton-*` headers and stored in the connection attachment, about 50 `@callable()` methods guarded by connection role, `publish()` sending `{ type: "invalidated" }` to identified connections, and a client on `AgentClient` (PartySocket) with TanStack Query `useLiveQuery` refetching on the message, throttled, deferred while the tab is hidden.

| Agents SDK feature Baton used                                    | POC replacement                                                                                                                                     |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `routeAgentRequest` + `onBeforeConnect` auth hook                | Backend `fetch`: session check, then `actors.fetch(key, request)`                                                                                   |
| `acceptWebSocket`, connection ids/tags, attachment state         | Alchemy `RpcWebSocket` (client id in attachment, `alchemy:rpc` tag); no per-connection app state needed in the POC                                  |
| `@callable()` RPC with `{type:"rpc", id, method, args}` frames   | Effect RPC messages (`Request`/`Exit`/`Chunk`), Schema-typed payloads and failures, middleware for auth                                             |
| `connection.send({type:"invalidated"})`                          | Notice frame to `state.getWebSockets()` ([§5.1](#51-option-e-in-detail))                                                                            |
| `cf_agent_identity` frame, `onIdentity`                          | Not needed: the RPC client is usable as soon as the socket opens; `ConnectionHooks.onConnect` for "refetch on (re)connect"                          |
| PartySocket reconnect, send buffering, `query()` token minting   | Effect `RpcClient` socket protocol: reconnect with capped backoff; pending calls fail typed instead of buffering; cookie auth, no token             |
| Keepalive `"ping"`/`"pong"` auto-response, 310 s stale watchdog  | Effect's 5 s `Ping`/`Pong` as the auto-response pair; a missed `Pong` triggers reconnect. The edge's ~300 s idle close is moot with a 5 s heartbeat |
| `this.sql`, `cf_agents_*` tables                                 | `@effect/sql-sqlite-do`; no SDK tables                                                                                                              |
| `schedule()` on the SDK's multiplexed alarm                      | Out of scope; Alchemy has `Workers.scheduleEvent` and `makeCallback` when needed                                                                    |
| TanStack Query `useLiveQuery` with throttle and hidden-tab defer | Atom query with `withReactivity`; `Reactivity.invalidate` refetches mounted queries; `refreshOnFocus` covers the hidden-tab case                    |

Baton details worth keeping in mind for the real port, not the POC: role tags per connection (`merchant` vs `member:<id>`) and `revokeMemberConnections` (close a member's sockets from a Better Auth hook) map onto `acceptWebSocket(ws, tags)` + `getWebSockets(tag)`, which `Cloudflare.upgrade()` does not expose (it accepts with no tags) but the hand-written sequence does; Alchemy's RPC transport uses its own tag and leaves attachment keys other than `__alchemyRpcWebSocket` alone, so app attachments can coexist.

## 10. Proposed proof of concept

**API definition** (`src/api/shop-actor.ts`): `ShopActorRpcs = RpcGroup.make(Rpc.make("GetCount", { success: Count }), Rpc.make("Increment", { success: Count }), Rpc.make("Activation", { success: Schema.Struct({ id: Schema.String }) }))`, `Count = Schema.Struct({ value: Schema.Int })`, `Notice` as in §5.1, `ActorKey` a branded string schema with a conservative pattern (`[a-z0-9-]{1,64}`) used by the route param and the Backend path match.

**Actor** (`src/backend/shop-actor.ts`): `class ShopActor extends Cloudflare.RpcDurableObject<ShopActor>()("ShopActor", { schema: ShopActorRpcs }, impl)`. Outer: `state = yield* Cloudflare.DurableObjectState`. Inner: build `SqliteClient.layer({ storage: state.raw.storage })`, run `SqliteMigrator.run(...)`, `activationId = crypto.randomUUID()`, return `ShopActorRpcs.toLayer({ GetCount, Increment: write then notify(["count"]), Activation })`.

**Backend** (`src/backend/worker.ts`): `const actors = yield* ShopActor` in init; in `fetch`, before the RPC fallthrough: match `/api/actor/:key`, decode the key with `ActorKey`, require a session (401 otherwise), `return yield* actors.fetch(key, request)`. The same path serves the SSR `POST` (ndjson RPC) and the browser `GET` (upgrade).

**Website**: route `src/routes/api.actor.$key.ts` with `GET` (forward if `upgrade: websocket`, else 405) and `POST` (`rejectRequest(request) ?? env.BACKEND.fetch(request)`); the existing `/api/rpc` `GET` comment is updated to point at it.

**Client** (`src/shop-actor-client.ts`): `ShopActorClient` as in §6, `countAtom`, `incrementAtom`, `noticesAtom`, with the notice `PubSub` created alongside the protocol layer.

**Page**: under `/app` (members), a route whose loader primes `countAtom` with `loadQuery`, and a component with the value, an Astryx `Button` "Increment", and the activation id in small text (dev aid: it changes after an idle period, which is the visible proof of hibernation). Two tabs open: a click in one updates both.

**Stack**: nothing to add to `alchemy.run.ts`; the actor is a dependency of `Backend`. The integ stack (`test/integ/stack.ts`) deploys the Backend and therefore the actor.

**Dependencies**: `pnpm add @effect/sql-sqlite-do@4.0.1`. Nothing else.

## 11. Testing

| Tier    | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| unit    | The handler layer over `SqliteClient` needs real `DurableObjectStorage`; Effect's own tests use a fake storage object (`sqlite-do/test/Client.test.ts`). Either copy that fake for `GetCount`/`Increment`, or skip the unit tier for the actor and rely on integ. Recommended: skip; the integ test covers it in workerd.                                                                                                                                                                                                                                                                                                                                                                                           |
| browser | The page component with `RpcTest.makeClient(ShopActorRpcs)` swapped in through `ShopActorClient.runtime.layer` as `SignInPage.test.tsx` does for `BackendClient`; a notice published to the `PubSub` by the test shows the refetch. The tap and the socket are not exercised here.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| integ   | `alchemy/Test` deploys the Backend (dev mode) like `auth.test.ts`; sign in (existing flow) to get the cookie; open a WebSocket to `<backendUrl>/api/actor/<key>` with `Socket.layerWebSocket` + `Socket.layerWebSocketConstructorGlobal` (Node 24 has a global `WebSocket`) and the same protocol layers as the browser; call `Increment` on one client and assert the other client's tap receives the notice and `GetCount` agrees; call `Activation`, idle past the hibernation threshold, call again and assert a different id (this is what proves hibernation under the Alchemy transport). `evictDurableObject` from the Cloudflare Vitest integration is not available under the Alchemy harness; idling is. |
| e2e     | Two Playwright pages signed in as the same member on the e2e stage; click in one, wait for the value in the other. The Vite upgrade proxy is only on the dev path; the e2e stage is a deployed Worker, so this also verifies the production hop.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

## 12. Risks and what the spike must verify

1. **The full upgrade hop through a Start route** (browser → Vite dev proxy → Website Worker → service binding → Backend → object). Every link is documented in source; the composition is not. First thing to run.
2. **The notice tap** on the client socket: that `reader.pull` yields whole text frames, that filtering preserves `Ack` frames, and that `Socket.make` composes with `RpcClient.layerProtocolSocket` without surprises. If it fights, fall back to D for the notice path (hand-rolled notice socket) while keeping RPC over the Alchemy socket, or to A with hibernation deferred.
3. **Hibernation actually happening under Alchemy's transport**: the `Activation` check. The transport's own test (`RpcWebSocket.test.ts`) runs in dev mode and asserts restore-after-wake, so the expectation is that it does.
4. **`waitUntil` inside the handler for `notify`**: sending to other sockets from inside one request's handler is ordinary I/O within that request; no extra `waitUntil` needed. Confirm no "I/O pinned to a different request" error from workerd (sockets accepted by the hibernation API are not request-pinned).
5. **SSR protocol over the binding**: `layerProtocolHttp` posts to `<url>/` with a trailing slash; the Backend match must accept `/api/actor/<key>/`. The existing test-control route has the same wrinkle.
6. **`@effect/sql-sqlite-do` import under the Backend's rolldown bundle** and the `Scheduler` patch question for future transactions ([§8](#8-sqlite-storage-in-the-actor)).
7. **Alchemy beta churn**: `RpcDurableObject`'s WebSocket transport shipped in beta.80 (`blog/2026-09-29-beta-80.md`); the attachment layout and tag are internal. We depend on public surface only (`getWebSockets`, `send`, JSON serializer), but a future Alchemy could change the WebSocket serializer; the notice tap would then need a matching change. Pinning covers this.

## 13. Questions with recommendations

Q1. **Which server shape?** (E) `Cloudflare.RpcDurableObject` for RPC over HTTP and the hibernating WebSocket, plus a notice frame for invalidation ([§5](#5-the-push-problem-broadcasting-invalidations-under-hibernation)).
Recommendation: E. It is the only option that satisfies all three of "Effect RPC over the socket", "hibernatable", and "broadcast invalidation", and it reuses Alchemy's transport instead of rewriting it. D is the fallback if the client-side tap misbehaves in the spike; A only if hibernation is deferred.

- [x] E: RpcDurableObject + notice frame (recommended)
- [ ] D: notices over a hand-rolled socket, RPC stays HTTP via the Backend
- [ ] A: stream subscription, accept no hibernation while clients are connected, revisit later
- [ ] Other

Q2. **Who hosts the actor?** The Backend Worker, with the Website forwarding `/api/actor/$key` the way it forwards `/api/rpc` today.
Recommendation: the Backend. It is the only Effect Worker, it already holds `Auth` for the session check, and a separate Actors Worker would add a cross-script binding (`ShopActor.from(ActorsWorker)`) for no benefit at this stage.

- [x] Backend hosts (recommended)
- [ ] A new Effect Worker hosts the actors
- [ ] Other

Q3. **Actor key for the POC.** The route has a `$key` param validated by `ActorKey`, and the member page links to one fixed key so two tabs land on the same object.
Recommendation: a fixed key constant (name to be chosen; not "demo", per the house rule that sandbox code is reference code), with the param in the URL so a second key can be tried by hand. The key is the shop domain in Baton; the POC has no shops, so the constant is a stand-in and its JSDoc says so.

- [x] Fixed key constant behind a `$key` route param (recommended)
- [ ] No param at all; one hard-wired object
- [ ] Other

Q4. **Hibernation is a hard requirement for the POC.** The brief says critical.
Recommendation: yes, and make the `Activation` procedure plus the integ idle test part of the definition of done, so hibernation is demonstrated rather than assumed.

- [x] Hard requirement with the Activation proof (recommended)
- [ ] Nice to have; A is acceptable for the first pass
- [ ] Other

Q5. **Require a signed-in member to open the socket?**
Recommendation: yes, checked in the Backend's `fetch` before `actors.fetch`, with the page under `/app`. Any member may open any key for now; authorization per key is a product decision deferred and noted in the handler's JSDoc. This mirrors Baton's gate-at-the-Worker shape without the token dance, because the cookie travels with a same-origin upgrade.

- [x] Yes, member-only, any key (recommended)
- [ ] No auth for the POC
- [ ] Other

Q6. **SQLite migrations: Effect's `SqliteMigrator.fromRecord` or Alchemy's `Cloudflare.SqlMigrations` directory?**
Recommendation: `SqliteMigrator.fromRecord`. It is what the brief asks for and what Baton uses, migrations are typed code next to the handlers, and it runs under the same `blockConcurrencyWhile`. Alchemy's directory form stays an option if we later want one `.sql` convention across D1 and actors.

- [x] `SqliteMigrator.fromRecord` (recommended)
- [ ] `Cloudflare.SqlMigrations("./actor-migrations")`
- [ ] Other

Q7. **Scope of the client state for the POC.** One query (`GetCount`), one mutation (`Increment`), one notice stream, plus `Activation` as a dev aid.
Recommendation: exactly that. No per-connection state, no presence, no streams, no alarms. Those are the real port's concerns and each has a known home (tags/attachments, `scheduleEvent`, `makeCallback`).

- [x] As proposed (recommended)
- [ ] Also show a stream RPC (knowing it blocks hibernation while subscribed)
- [ ] Other

Q8. **Tests in the first landing.** Integ (two clients, notice, idle activation check) and one Playwright spec with two pages; browser-mode component test for the page; no unit test for the handlers.
Recommendation: as listed. The integ test is where every risk in [§12](#12-risks-and-what-the-spike-must-verify) is caught except the Start hop, which the e2e spec covers.

- [x] As proposed (recommended)
- [ ] Integ only for the first landing
- [ ] Other
