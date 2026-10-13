# Plan: split the actor's channels, identify the socket at the gate, move the Website to server functions

Plan date: 2026-10-13.
Research: [actor channel split research](./actor-channel-split-research.md) (decided; every question answered). It replaces the ticket design of [socket identity research](./socket-identity-research.md) and [socket identity plan](./socket-identity-plan.md), implemented in `bd9d7a2`. [Glossary](./glossary.md).
Versions: Alchemy `2.0.0-beta.81`, Effect `4.0.1`, TanStack Start `1.168.60`, Better Auth `1.7.7`. Do not bump dependencies. No new dependencies are expected.

## 1. Outcome

One change, landing on top of `bd9d7a2`:

- **The actor has two surfaces that never overlap.** `ShopActor` is a plain `Cloudflare.DurableObject`. The Backend calls it with schemaless methods on the stub (`revoke`, `snapshot`). Browsers call it with Effect RPC over their WebSocket, and that Group is served on the socket only. There is no HTTP RPC into the actor, no `system` role and no caller header on stub calls.
- **The gate names the socket once.** The Backend's gate (`ShopAccess`) resolves the browser on the upgrade and writes the answer into one header, `x-actor-connection`, on the request it forwards. The actor stores it in the socket's attachment and tags at accept, displaces a member's oldest socket past two, and reads the identity on every message. A refused upgrade is accepted by the gate and closed at once with a code the browser can read (4401, 4403, 4404, 1013). Tickets, `TICKET_SECRET`, `IssueActorTicket` and every first-call bind are gone.
- **The Website is plain TanStack Start.** Loaders, `beforeLoad` guards and Backend-owned writes call TanStack server functions. A server function validates its input with Effect Schema and calls a schemaless method on the Backend, passing the visitor's cookie; the Backend checks the session on every method. `BackendRpcs`, `BackendClient` and its atoms, and `/api/rpc` are gone.
- **Actor-owned reads and writes go over the socket.** The shop page's first paint comes from its loader (a server function that asks the Backend, which asks the actor); the socket's atoms start from that data and keep it current.

Behaviour visible to a person is unchanged from S1: live count across windows, member increments, merchant resets, sign-out and removal close sockets, a third window displaces the oldest with "Signed in elsewhere" and Reconnect, "not a member" and "Shopify session expired" pages. `vp check`, `vp test` and `vp run test:e2e` are green at the end.

## 2. Rules the implementer must follow

- Read `AGENTS.md` first. Effect Schema for all validation and encoding, `Match` for tag dispatch, `Schema.TaggedError` for failures, `Effect.fn("Service.method")` for reusable effects, JSDoc on declarations with each rule stated once, no `//` above a declaration, never a reference to this plan or the research in code.
- **The Website runs no Effect runtime and holds no atoms for Backend data.** Server functions and route code are plain async TypeScript. Effect Schema (`Schema.toStandardSchemaV1` in `.validator`, `Schema.decodeUnknownOption`, `Schema.is`) and `Match` are plain functions and are still required by `AGENTS.md`. Effect stays in the browser only for the actor socket (`ShopActorClient` and its atoms).
- Tooling through `vp` (`vp check --fix`, `vp test`, `vp run test:e2e`, `vp exec alchemy`, `vp exec astryx`). Never `npm` or `npx`. If a dependency seems needed, stop and record it in [§10](#10-deviations-and-issues).
- Do not commit. Do not create branches. Do not touch `.env`.
- Where the plan says **confirm**, the API or behaviour was read from source but not run. Check it, and record what you found under "API confirmations" in [§10](#10-deviations-and-issues).
- **Step 0 comes first and gates the rest.** If a check fails, record it. The fallback for S0.1 (a copy of the transport) is pre-authorised in decision 2; for every other check, the fallback is listed, but choosing it is the user's decision: record it and stop.
- Vocabulary: **browser**, **member**, **merchant**, **operator**, **caller**, **gate**, **stub**, **server function**, **schemaless method**. "Ticket" and "bind" leave the codebase.
- Copy rules on `RootDocument` apply to every user-facing string. Astryx components only; check with `vp exec astryx component <Name>` before using one you have not used here.
- This is one change, so the tree may be red between Step 1 and Step 8. Run `vp check --fix` after each step anyway, and fix what belongs to that step. The checkpoints in [§9](#9-order-of-work-and-stopping-points) must be green.

## 3. Design decisions already taken

From the research ([§10 and §12 of it](./actor-channel-split-research.md#10-questions-with-recommendations)). Not open; a forced departure is a deviation to record.

1. **Two channels.** Backend to actor: schemaless methods on the stub. Browser to actor: Effect RPC on the socket only. `MemberRpcs` and `MerchantRpcs` are the socket's Groups; `SystemRpcs` is deleted.
2. **Transport: reuse Alchemy's internal `RpcWebSocket.make`**, with a decorated `DurableObjectState` for accept and a wrapper around `webSocketMessage`. The research's subpath import `alchemy/Cloudflare/Workers/RpcWebSocket` does **not** resolve (checked 2026-10-13 with Node against `alchemy@2.0.0-beta.81`: the package's `./Cloudflare/*` export pattern is more specific than `./*`, so it maps to `lib/Cloudflare/Workers/RpcWebSocket/index.js`, which does not exist). Reach the module by a relative file import of `node_modules/alchemy/lib/Cloudflare/Workers/RpcWebSocket.js` from `src/backend/actor-socket.ts` (a file path bypasses the exports map; its `.d.ts` sits beside it). If Vite, the Alchemy bundler or workerd rejects that, the fallback is our own copy of that file under `src/backend/`; record which one was used as a deviation. Choosing the copy is pre-authorised for this run; the user reviews it afterwards.
3. **Identity on the upgrade is a plain header**, `x-actor-connection`, holding the JSON of the gate's `ConnectionCaller`. The Backend rebuilds the forwarded request from nothing, so a browser cannot set it. No signature.
4. **A refused upgrade is accepted and closed by the gate** with a close code: 401 → 4401, 403 → 4403, 404 → 4404, 503 → 1013.
5. **Server rendering of actor data** goes loader → server function → Backend → `actor.snapshot()`. The socket atoms are seeded from the loader's data.
6. **The Website moves to Baton's pattern** in this same change: server functions call the Backend schemaless with the cookie.
7. **Each Backend method takes the request's cookie and checks the session itself** (`sessionFromCookie`). A server function never passes a user id it worked out.
8. **Writes route by owner.** What the actor owns (increment, reset, and later orders and workflows) goes over the socket; what the Backend owns (sign-in link, members, Shout) goes through a server function.
9. **`TestControlRpcs` stays Effect RPC** behind `/api/test-control`, so `rpc-proxy.ts` stays for that route only.
10. **No upstream issue** is filed with Alchemy.
11. Unchanged from S1: `ShopAccess` and its statuses, the Website's Origin check on the upgrade route, close codes 3401, 4403, 4409, two sockets per member, merchants uncapped, revoke by member and by session from the Better Auth hooks and membership edits, the session-expiry backstop, Notices as frames beside the RPC protocol, Baton's data model.

## 4. The pieces, in dependency order

| Step | Piece                                                 | Files                                                                                                                                                                                |
| ---- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0    | Spike checks                                          | `test/integ/socket-facts.test.ts`, a scratch e2e spec, scratch code (removed after)                                                                                                  |
| 1    | Actor API: socket Groups, caller, close codes, header | `src/api/shop-actor.ts`, `src/api/shop-actor.test.ts`                                                                                                                                |
| 2    | Socket transport adapter                              | `src/backend/actor-socket.ts` (new)                                                                                                                                                  |
| 3    | The actor                                             | `src/backend/shop-actor.ts`                                                                                                                                                          |
| 4    | The gate and the Backend's actor client               | `src/backend/worker.ts`, `src/backend/actor-client.ts`, `src/backend/shop-access.ts`; delete `src/backend/ticket.ts`, `ticket.test.ts`                                               |
| 5    | The Backend's schemaless API                          | `src/backend/api.ts` (new), `src/backend/worker.ts`, `src/api/backend.ts`; delete `src/backend/handlers.ts` (keep `SignInLimiter`, moved)                                            |
| 6    | Test control                                          | `src/api/test-control.ts`, `src/backend/test-control.ts`, `src/backend/worker.ts`                                                                                                    |
| 7    | Website server functions, guards and loaders          | `src/server/*.ts` (new), `src/routes/*.tsx`, `src/session.ts`, `src/router.tsx`, `src/query.ts`; delete `src/backend-client.ts`, `src/backend-transport.ts`, `src/routes/api.rpc.ts` |
| 8    | Browser socket client and pages                       | `src/shop-actor-client.ts`, `src/actor-connection.ts` (renamed from `src/ticket-client.ts`), `src/components/*.tsx`                                                                  |
| 9    | Stack, tests, glossary, README                        | `alchemy.run.ts`, `test/integ/*`, `test/browser/*`, `src/**/*.test.ts(x)`, `e2e/*`, `docs/glossary.md`, `README.md`                                                                  |

## 5. Steps

### Step 0: spike checks

Each check is a small test. Write it, run it, record the result under "Step 0 results" in [§10](#10-deviations-and-issues). Scratch code is removed after the step; the integ checks that pin behaviour (S0.2 to S0.4) are kept and reworked in Step 9.

- **S0.1 The transport import builds and runs.** In a scratch plain `Cloudflare.DurableObject` hosted by the Backend, import `RpcWebSocket` by the relative lib path from decision 2 (the bare subpath is known not to resolve; do not spend time on it), build the transport with `RpcSerialization.layerJson` (`effect/rpc/RpcSerialization`), and serve a one-procedure Group over a socket. Confirm it type-checks, bundles under `vp run dev` and the integ stack, and answers a call. Also confirm the bundle holds one instance of the module (the same `__alchemyRpcWebSocket` attachment key and `DurableObjectState` tag as `alchemy/Cloudflare` itself). Fallback: copy `RpcWebSocket.ts` into `src/backend/` (decision 2, pre-authorised).
- **S0.2 Accept-time attachment and tags survive.** With the decorated state from Step 2, open a socket, make a call, force a new activation (the S1 `socket-facts` test already does this; reuse its method), and read back both our `shopActor` key next to `__alchemyRpcWebSocket`, and our tags through `state.getWebSockets("member:<id>")`.
- **S0.3 Context reaches the middleware.** Provide a service around `transport.webSocketMessage`; read it with `Effect.serviceOption` in an RPC middleware. Expected `Some`. (Effect's `RpcServer` merges `requestFiber.context` into the handler's context; S1's `HttpServerRequest` check relied on the same thing.)
- **S0.4 Close before dispatch is clean.** In the `webSocketMessage` wrapper, close a socket with 3401 and do not delegate. Confirm the browser side sees 3401, the actor does not abort, and a later socket on the same activation works.
- **S0.5 The gate's close code reaches the browser through the Website.** In a scratch Backend branch, answer an upgrade with a fresh `WebSocketPair`: accept the server end, close it with 4404, return 101 with the client end (the same `HttpServerResponse` with `HttpBody.raw(new Response(null, { status: 101, webSocket }))` that `RpcWebSocket.ts` uses). In a scratch Playwright spec through the real Website, confirm the page's `WebSocket` sees `close` with code 4404.
- **S0.6 Schemaless Backend methods from the Website.** Add a scratch method `ping: (n: number) => Effect.succeed(n + 1)` to the Backend Worker's returned object. In a scratch server function, call it with `toRpcAsync<Backend>(env.BACKEND)` from `alchemy/Cloudflare/Bridge`, importing `Backend` with `import type`. Confirm: the type of `ping` is inferred; the Website bundle does not pull in Backend runtime code; a method failing with a `Schema.TaggedError` rejects with an object whose `_tag` survives. Note that `toRpcAsync` rethrows a tagged error as the plain `{ _tag, ...fields }` object, not a class instance (`decodeRpcThrowable` in `node_modules/alchemy/src/Cloudflare/Workers/RpcAsync.ts`), so confirm that `Schema.decodeUnknownOption(Schema.Union([Unauthorized, Forbidden, ...]))` on the rejection yields the instance; `Schema.is` on the class does not match a plain object.
- **S0.7 Seeding a socket atom.** On the client, before the shop page mounts, call `registry.setSerializable(key, encoded)` for the inner serializable query atom (the value `ShopActorClient.query(...)` returns, before `.pipe(withReactivity, refreshOnFocus)`), where `key` is `atom[Atom.SerializableTypeId].key` (`AtomRpc.query` prefixes it: `AtomRpc:<tag>:<serializationKey>`, for example `AtomRpc:MemberGetCount:count`) and `encoded` is `atom[Atom.SerializableTypeId].encode(AsyncResult.success(value))`. The registry consumes a preloaded value when it first creates the atom's node (`ensureNode` in `effect/reactivity/AtomRegistry`), so the seed must land before any read. Confirm the first render shows the value with no "Loading…", and no socket message is needed to show it. Fallback: render the loader's value until the socket's first answer (the research's rejected Q10 option); that is a user decision.

### Step 1: actor API

`src/api/shop-actor.ts`:

- Keep `Count`, `Activation`, `Notice`, `NoticeFrame`, `COUNT_KEY`, `MemberCaller`, `MerchantCaller`, `ConnectionCaller`, the close codes, `MAX_CONNECTIONS_PER_MEMBER`, `RequireMember`, `RequireMerchant`.
- Delete `SystemCaller`, `Caller` (the three-way union), `TicketClaims`, `TICKET_HEADER`, `CALLER_HEADER`, `TICKET_TTL_MILLIS`, `SocketIdentity` (moves to the Backend; see Step 3), `RequireSystem`, `SystemRpcs`.
- `CurrentCaller` provides a `ConnectionCaller`.
- Rename `CallerMiddleware` to `ConnectionMiddleware`; JSDoc: provides the socket's caller, set at accept from the gate's header; nothing a message carries is read.
- Add `CONNECTION_HEADER = "x-actor-connection"` with JSDoc stating the rule: set only by the Backend's gate on the upgrade it forwards, which it rebuilds from nothing; the actor decodes it once, at accept.
- Add the gate's close codes, Baton-style names: `CONNECTION_CLOSE_UNAUTHENTICATED = 4401`, `CONNECTION_CLOSE_NOT_A_MEMBER = 4404`, `CONNECTION_CLOSE_TRY_AGAIN = 1013`. Keep `CONNECTION_CLOSE_FORBIDDEN = 4403` and update its JSDoc: sent by the gate for a 403 and by the actor for an undecodable header; terminal to the browser.
- `MemberWhoAmI` and `MerchantWhoAmI` succeed with `ConnectionCaller`.
- `ShopActorRpcs = MemberRpcs.merge(MerchantRpcs)`.
- Add `ShopSnapshot = Schema.Struct({ count: Count, activation: Activation })`: what `actor.snapshot()` returns.

Update `src/api/shop-actor.test.ts`: every procedure carries exactly one role middleware plus `ConnectionMiddleware`.

### Step 2: socket transport adapter

New `src/backend/actor-socket.ts`. One exported constructor, used by the actor's inner Effect:

```ts
make(options: {
  group: RpcGroup<Rpcs>;
  handlers: Layer<Rpc.ToHandler<Rpcs> | middleware services>;
  /** Tags to add and the attachment key to write for a socket being accepted. */
  onAccept: (identity: SocketIdentity) => { tags: ReadonlyArray<string> };
}): Effect<{
  fetch: (identity: SocketIdentity) => HttpEffect;   // accept with this identity
  webSocketMessage, webSocketClose, webSocketError;
  /** The raw socket the last `fetch` accepted, for displacement. */
}>
```

The shape above is a guide; record the final signature as an API confirmation. What it must do:

1. **Decorated state.** Read `Cloudflare.DurableObjectState`. Build `{ ...state, acceptWebSocket }` where `acceptWebSocket(ws, tags)` reads an internal `PendingAccept` service with `Effect.serviceOption`. When present: `ws.serializeAttachment({ shopActor: identity })`, then `state.acceptWebSocket(ws, [...tags, ...onAccept(identity).tags])`, and record `ws` in the `PendingAccept` cell. When absent, it is a defect (every accept comes through our `fetch`). Alchemy's `persist` spreads the previous attachment, so our key survives.
2. **Transport.** `RpcWebSocket.make` with the decorated state provided, plus `RpcSerialization.layerJson` and the current `RuntimeContext`.
3. **Server.** Copy the part of Alchemy's `makeHandlers` (`RpcDurableObject.ts`) that builds the handler Layer and `RpcServer.layer(group.middleware(RequestLifetime))` in an instance `Scope`, with `RpcServer.Protocol` from the transport and the `RequestLifetime` middleware that `waitUntil`s each call's fiber. Keep its comment on why the protocol outlives the constructor's scope.
4. **`fetch(identity)`** runs `transport.fetch` with `PendingAccept` provided, and returns the response and the accepted socket.
5. **`webSocketMessage(socket, message)`**: decode the attachment with Schema (`Attachment` from Step 3); if it has no `shopActor`, close 4403 and return; else hand to a caller-supplied `beforeDispatch(identity, socket)` that may close (expiry) and answer whether to dispatch; if yes, run `transport.webSocketMessage(socket, message)` with the internal `ConnectionIdentity` service provided. Cache decoded identities per activation in a `WeakMap` keyed by `socket.ws`.
6. **`webSocketClose` and `webSocketError`** delegate to the transport.

JSDoc on the module's main export says why it exists: Alchemy's `RpcDurableObject` accepts the socket before any of our code sees the upgrade and cannot host schemaless methods; this adapter reuses its internal transport and adds the identity at accept and on each message. `@see` the transport source path, `node_modules/alchemy/src/Cloudflare/Workers/RpcWebSocket.ts` `make`.

### Step 3: the actor

`src/backend/shop-actor.ts` becomes `Cloudflare.DurableObject<ShopActor>()("ShopActor", Effect.gen(...))`.

- **Outer Effect:** `Cloudflare.DurableObjectState`. `Tickets` is no longer needed.
- **Inner Effect:** SQLite client and migrations as now; `activationId`; `readCount`, `increment`, `resetCount`, `notify` as now.
- **Attachment schema** (module level): `Attachment = Schema.Struct({ shopActor: Schema.optional(SocketIdentity) })` where `SocketIdentity = Schema.Struct({ caller: ConnectionCaller, connectedAt: Schema.Number })` (Baton's `connectedAt`, replacing `boundAt`). Alchemy's own key is not read any more.
- **Tags** (`onAccept`): member: `member`, `member:<memberId>`, `session:<sessionId>`; merchant: `merchant`. Tags carry only what a fan-out selects by, as Baton's `getConnectionTags`. Record the limit (10 tags, 256 chars each) as an API confirmation.
- **`fetch`:** decode `CONNECTION_HEADER` with `Schema.fromJsonString(ConnectionCaller)`. A request that is not an upgrade: 426. A header that does not decode: accept and close 4403 with reason "unidentified connection", log a warning (Baton's behaviour). Otherwise `socket.fetch({ caller, connectedAt: now })`; then for a member, **displace**: `getWebSockets("member:<id>")`, drop the one just accepted, sort the rest by `connectedAt` descending, close all past `MAX_CONNECTIONS_PER_MEMBER - 1` with 4409 "signed in elsewhere". Best effort: a failure is logged and the new socket is served.
- **`beforeDispatch`:** a member whose `sessionExpiresAt <= now` is closed 3401 "session expired" and not dispatched. No `CLOSE_AFTER_RESPONSE`.
- **Middleware layers:** `ConnectionMiddleware` reads `ConnectionIdentity` with `Effect.serviceOption`; `None` is a defect (a socket message without identity is a broken invariant); `Some` provides `CurrentCaller`. `RequireMember`, `RequireMerchant` as now.
- **Handlers:** as now for the socket Groups.
- **Schemaless methods**, returned beside `fetch` and the socket handlers:
  - `revoke({ by: "member" | "session", id })`: `getWebSockets(by + ":" + id)`, close each 3401 "membership changed", return `{ closed }`, log as now.
  - `snapshot()`: `{ count: yield* readCount(), activation: { id: activationId } }`.
- Delete `findSocket`, `openSockets`, `socketIdentity`, the `bound` map, `closeAfterResponse`, `CLOSE_AFTER_RESPONSE`, the `HttpServerRequest` branch.
- Rewrite the class JSDoc: two surfaces, where identity comes from, the expiry backstop, the merchant's lack of one, and keep the existing paragraph on activation, migrations and `blockConcurrencyWhile`.

**Confirm:** the plain `DurableObject` stub types `revoke` and `snapshot` for the Backend (`actors.getByName(key).revoke(...)`), and what a defect inside a schemaless method looks like to the caller (`RpcCallError` per Alchemy's docs).

### Step 4: the gate and the Backend's actor client

`src/backend/worker.ts`, actor branch:

- A non-upgrade request under `/api/actor/<key>` is 426 with `upgrade: websocket` (there is no HTTP RPC into the actor any more).
- On an upgrade, `shopAccess.resolve` as now. On refusal, **accept and close**: a helper `refuseUpgrade(status)` builds a `WebSocketPair`, accepts the server end, closes it with the code from decision 4 and a short reason, and returns 101 with the client end. `Match` on the status.
- On success, rebuild the forwarded request as now (only `FORWARDED_HANDSHAKE_HEADERS`) and set `CONNECTION_HEADER` to the JSON of the resolved caller. Forward with `actors.getByName(key).fetch(forwarded)`.
- Update the Backend class JSDoc and `forwardToActor`'s JSDoc.

`src/backend/actor-client.ts`: `SystemActors` becomes `ShopActors` with `revoke(key, by, id)` (best effort, as now) and `snapshot(key)`, both plain stub calls with no header. Delete `encodeCallerHeader`, `call`, the `Proxy` in `layerTest` (the test layer records revokes and answers a fixed snapshot). Rename the call sites in `auth.ts`, `members.ts`, `test-control.ts`.

`src/backend/shop-access.ts`: unchanged, except its JSDoc no longer mentions `IssueActorTicket`; `ShopAccessDenied` is mapped by the upgrade branch and by the API in Step 5.

Delete `src/backend/ticket.ts` and `src/backend/ticket.test.ts`.

### Step 5: the Backend's schemaless API

New `src/backend/api.ts`: a `BackendApi` service (`Context.Service`, `layer`, and whatever test layer the tests need) whose methods the Worker returns. Every method takes a `RequestInfo` first:

```ts
/** What a server function forwards from the browser's request; nothing else crosses. */
RequestInfo = { cookie: string | undefined; ip: string | undefined };
```

| Method                                           | Replaces                       | Auth                                | Returns or fails                                                                                                             |
| ------------------------------------------------ | ------------------------------ | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `hello(request)`                                 | `Hello`                        | none                                | `Hello`                                                                                                                      |
| `shout(request, { input: ShoutText })`           | `Shout`                        | none                                | `Shouted`                                                                                                                    |
| `requestMagicLink(request, { email, returnTo })` | `RequestMagicLink`             | none; rate limit by `request.ip`    | `MagicLinkRequested`; fails `TooManyRequests`                                                                                |
| `me(request)`                                    | `Me`                           | `sessionFromCookie(request.cookie)` | `Me`; fails `Unauthorized`                                                                                                   |
| `listMembers(request)`                           | `ListMembers`                  | session, then `admin` role          | `Member[]`; fails `Unauthorized`, `Forbidden`                                                                                |
| `shopSnapshot(request, { key, sessionToken? })`  | `IssueActorTicket` + SSR reads | `ShopAccess.resolve`                | `{ caller: ConnectionCaller, snapshot: ShopSnapshot }`; fails `Unauthorized`, `NotAShopMember`, `Forbidden`; 503 is a defect |

- Keep each handler's body from `handlers.ts`; the session check moves from `CurrentUserMiddleware` into the method (`sessionFromCookie`, then `Match` on the role for `listMembers`). `RequestMagicLink` passed `new Headers(headers)` to Better Auth's `signInMagicLink`; **confirm** which headers Better Auth needs there and pass exactly those from `RequestInfo` (add a field if one is needed and record it).
- `ShopAccessDenied` maps as `IssueActorTicket` mapped it: 401 `Unauthorized`, 403 `Forbidden`, 404 `NotAShopMember`, 503 die.
- Methods return `Effect`s with typed failures. They cross the binding as `{ _tag, ...fields }` objects (S0.6).
- `src/backend/worker.ts` returns `{ fetch, ...api }` from the Worker's inner object. `fetch` keeps `/api/auth/*`, `/api/actor/*`, `/api/test-control`; the catch-all `RpcServer` for `BackendRpcs` and its per-request build are deleted, and an unknown path is 404.
- Move `SignInLimiter` from `handlers.ts` into `api.ts` (or its own file); delete `handlers.ts`.
- `src/api/backend.ts`: delete `Ticket`, `BackendRpcs` and the three Groups, `CurrentUser`, `CurrentUserMiddleware`, `RequireAdmin`. Keep the schemas and errors (`ShoutText`, `ShoutTextFromInput`, `Hello`, `Shouted`, `Email`, `EmailFromInput`, `ReturnPath`, `Role`, `Me`, `Member`, `MemberExists`, `MagicLinkRequested`, `NotAShopMember`, `Unauthorized`, `Forbidden`, `TooManyRequests`) and add `RequestInfo`. `src/backend/middleware.ts` keeps `sessionFromCookie` and `currentUserFromCookie`; delete `CurrentUserLive`, `RequireAdminLive`.

**Confirm:** a schemaless Worker method needs `RuntimeContext` provided as the old handlers did (`Effect.provide(RuntimeContext.phantom)`), or not.

### Step 6: test control

- `IssueActorTicketAs` is replaced by a test-only upgrade route on the Backend: `GET /api/test-control/actor/<key>` with `x-e2e-token` and an `x-test-caller` header (JSON `ConnectionCaller`). With the stage's `E2E_TOKEN` it forwards the upgrade to the actor with that caller as `CONNECTION_HEADER`, skipping the gate; without the binding or with a wrong token it is 404. It is how a test opens a socket as an identity no sign-in produces (an expired session). Browsers cannot reach it: the Website has no route for it; the integ tests call the Backend directly.
- Delete `IssueActorTicketAs` from `TestControlRpcs` and its handler. Keep `IssueMagicLink`; the integ `signIn` helper uses it instead of `RequestMagicLink`.
- `RemoveMember` calls `ShopActors.revoke`.
- Update `TestControlRpcs`' JSDoc list.

### Step 7: Website server functions, guards and loaders

New `src/server/backend.ts`:

```ts
/** The Backend through the service binding, read at call time; see `env`. */
export const backend = () => toRpcAsync<Backend>(env.BACKEND);
/** The fields of the visitor's request the Backend may see. */
export const requestInfo = (): RequestInfo => ({
  cookie: getRequestHeader("cookie"),
  ip: getRequestHeader("cf-connecting-ip"),
});
```

Import `Backend` with `import type`. `toRpcAsync` comes from `alchemy/Cloudflare/Bridge`.

Server functions, one module per concern under `src/server/`. Each uses `createServerFn({ method })`, `.validator(Schema.toStandardSchemaV1(Input))` where it takes input, and returns plain data. Expected failures come back as a tagged result the page can render; guard failures throw TanStack `redirect` or `notFound`; anything else rejects and the route error boundary shows it. A Backend failure reaches the server function as a plain tagged object (S0.6): decode the rejection with `Schema.decodeUnknownOption(BackendFailure)`, where `BackendFailure` is a `Schema.Union` of the error classes from `api/backend.ts` the function expects, then `Match` on the decoded instance's `_tag`; a rejection that does not decode is rethrown.

| Server function    | Method | Calls              | Answers                                                                                                                                                               |
| ------------------ | ------ | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getMe`            | GET    | `me`               | `Me` or `null` (`Unauthorized` → `null`)                                                                                                                              |
| `getHello`         | GET    | `hello`            | `Hello`                                                                                                                                                               |
| `shout`            | POST   | `shout`            | `Shouted`                                                                                                                                                             |
| `requestMagicLink` | POST   | `requestMagicLink` | `{ _tag: "Sent", link }` or `{ _tag: "TooManyRequests" }`                                                                                                             |
| `listMembers`      | GET    | `listMembers`      | `Member[]`; `Unauthorized` → redirect to sign-in, `Forbidden` → redirect to `homeFor(role)`                                                                           |
| `getShopSnapshot`  | GET    | `shopSnapshot`     | `{ _tag: "Snapshot", caller, snapshot }`, `{ _tag: "NotAMember" }` or `{ _tag: "Expired" }` (merchant `Unauthorized`); a member's `Unauthorized` redirects to sign-in |

Routes:

- `-guards.ts` `requireRole` calls `getMe()`. Its JSDoc keeps the rule that the Backend checks every method again.
- `sign-in.tsx` `beforeLoad` calls `getMe()`.
- `index.tsx` loader: `getHello()` and `getMe()`; `admin.members.tsx` loader: `listMembers()`; components take the loader data as props.
- `app.shop.$key.tsx` and `merchant.$key.tsx` loaders: `getShopSnapshot({ key, sessionToken? })`; return it as loader data. No atoms are set in the loader.
- `src/session.ts`: `currentMember` is replaced by `getMe`. `signOut` posts to `/api/auth/sign-out` as now, then `router.invalidate()` so guards and loaders run again.
- `src/router.tsx`: keep the atom registry in the router context (the socket atoms use it). Remove `defaultStaleReloadMode: "blocking"` and its comment, whose reason (atom TTLs) is gone, and remove `dehydrate`/`hydrate` unless S0.7 needed them. Record what you kept.
- `src/query.ts`: delete `loadQuery` and its JSDoc; keep `refreshOnFocus` (the socket's count atoms use it).
- Delete `src/backend-client.ts`, `src/backend-transport.ts`, `src/routes/api.rpc.ts`. Keep `src/rpc-proxy.ts` for `/api/test-control`; trim its JSDoc to that route.

Pages take data and actions as props, and the route wires them (`Route.useLoaderData()`, `useServerFn(...)`). That keeps the components testable without a server.

- `SignInPage`: props `returnTo`, `error`, `requestMagicLink(input) => Promise<result>`. TanStack Form's `onSubmit` awaits it; the result (or a rejection: "Something went wrong. Try again.") is kept in component state. Copy unchanged.
- `Playground`: props `hello` and `shout`. After a successful shout, `router.invalidate()` refreshes `hello`, replacing the `reactivityKeys: ["hello"]` behaviour. The "(refreshing…)" suffix goes.
- `MembersPage`: prop `members`.

### Step 8: browser socket client and pages

Rename `src/ticket-client.ts` to `src/actor-connection.ts`. Keep `shopKeyAtom`, `merchantTokenAtom`, `notAMemberAtom`, `merchantExpiredAtom`, `connectionStateAtom`, `reconnectAtom`, `lostAtom`, `retryPolicy`, `isTerminal`, `goToSignIn`; drop `Atom.serializable` from the state atoms (nothing is dehydrated into them now). Delete `TicketParts`, `isFresh`, `TicketRefused`, `connection`, `makeTicketStep`, `resetBinding`, `setClient`, `bindOnConnect`, `ticketMiddleware`.

- **Terminal close codes:** 4401, 4403, 4404, 4409. Before stopping, the policy's `onError` sets state: 4401 → `goToSignIn` for a member, `merchantExpiredAtom` for a merchant; 4404 → `notAMemberAtom`; 4409 → `displaced`; 4403 → `forbidden`. Everything else (3401, 1006, 1012, 1013) retries with the existing backoff; a 3401 reconnect goes back through the gate, which gives the current answer.

`src/shop-actor-client.ts`:

- `layerSocketWithNotices(url)` loses `beforeConnect`.
- `browserProtocol`: no ticket step; `ConnectionHooks.onConnect` sets `open` and publishes the refresh notice; `onDisconnect` as now.
- `serverProtocol` is deleted. The server side of `protocol` is a Layer that dies with a message naming the rule: the socket atoms are never read on the server.
- `makeClient`: `RpcClient.make(ShopActorRpcs, { flatten: true })`, no middleware.
- Delete `ticketAtom`, `ticketQuery`, `ticketPayload`, `loadTicket`.
- Export each serializable query atom separately from its wrapped form (`countQuery` and `countAtom = countQuery.pipe(withReactivity, refreshOnFocus)`, and so on) so the seeding helper can reach the serializable node.
- Add `seedShop(registry, { key, merchantToken, caller, snapshot })`: sets `shopKeyAtom` and `merchantTokenAtom`, and `registry.setSerializable` for the role's count, who-am-I and (member) activation queries, using each query atom's own `[Atom.SerializableTypeId]` key and encoder as S0.7 established. Its JSDoc says when it must run: once, on the client, before the page reads any socket atom.

Shop routes and `ShopPage`:

- The route component reads its loader data. For `NotAMember` and `Expired` it renders the refusal text and never mounts the socket. For `Snapshot` it renders `ShopPage` with the snapshot.
- `ShopPage` renders from the snapshot until the page is hydrated (`useHydrated()`), and from the socket atoms after; `seedShop` runs on the client before the atoms are read (for example in a `useState` initializer in the route component). The server render and the first client render therefore match, and no socket is built on the server.
- `describeCaller` drops the `system` branch.
- The displaced banner, the lost banner and the `refusal` texts stay; `refusal` also reads the loader result.

### Step 9: stack, tests, glossary, README

Stack:

- `alchemy.run.ts` and `test/integ/stack.ts`: drop the `Tickets` binding and `TICKET_SECRET`; update the comments that mention it.

Unit and component tests:

- Delete `src/backend/ticket.test.ts`, `src/ticket-client.test.ts`. Add `src/actor-connection.test.ts` for the retry policy: terminal on 4401, 4403, 4404, 4409; retries on 3401, 1006, 1013; the state each terminal code sets.
- `src/backend/auth.test.ts`, `test-control.test.ts`: rename to `ShopActors`; the test layer records revokes.
- New `src/backend/api.test.ts` with layers (no Worker): `me` without a cookie fails `Unauthorized`; `listMembers` as a user fails `Forbidden`; `requestMagicLink` rate-limited fails `TooManyRequests` and is silent for a non-member; `shopSnapshot` maps 401, 403, 404 and dies on 503.
- `src/components/SignInPage.test.tsx`, `ShopPage.test.tsx`, `test-setup.test.tsx`: pass props instead of stubbing `BackendClient`; delete `test/browser/backend.ts`; rework `test/browser/shop-actor.ts` to the new socket client (no ticket). `ShopPage` tests: renders the snapshot before hydration; shows the displaced banner on 4409; shows "not a member" on 4404.

Integration tests (`test/integ/`, straight at the Backend):

- `actor-clients.ts`: `signIn` uses test control's `IssueMagicLink`; the socket helper opens `/api/actor/<key>` with a cookie (or `?token=` for a merchant) and no ticket; an `openAs(caller)` helper uses the test-control upgrade route; the HTTP actor client is deleted.
- `socket-facts.test.ts`: keep S0.2 to S0.4 as permanent tests; drop facts that no longer apply (the `HttpServerRequest` marker).
- `shop-actor.test.ts`: role split (member calling a merchant procedure is `Forbidden`); identity survives hibernation; revoke by member and by session closes exactly the right sockets with 3401; expired session closes 3401 on the next message; third member socket displaces the oldest with 4409, merchants uncapped; gate refusals arrive as 4401, 4403, 4404; a forged `x-actor-connection` on the browser's upgrade is dropped by the gate (the actor sees the gate's caller, not the forged one); a non-upgrade request to `/api/actor/<key>` is 426.

E2E (`e2e/`, through the Website):

- `fixtures.ts`, `screens.ts`: drop ticket helpers.
- `shop.spec.ts`: the five existing tests keep their titles and behaviour.
- `actor-upgrade.spec.ts`: keep the Origin test; add "a visitor who is not a member sees the not-a-member page" through a refused upgrade (S0.5's spec, made permanent).
- `members.spec.ts`, `sign-in.spec.ts`, `shell.spec.ts`: unchanged in intent; adjust to loader data where they waited on atoms.

Docs:

- `docs/glossary.md`: remove **Ticket**, **Bind**, **System caller**; add **Server function**, **Schemaless method**, **Gate header**; update **Actor**, **Backend**, **Client**, **Procedure**, **Group**.
- `README.md`: the request paths (browser → Website → server function → Backend; browser → Website → gate → actor socket), and remove `TICKET_SECRET`.

## 6. Verification checklist

Tick each in [§10](#10-deviations-and-issues) with how it was checked.

1. `vp check` clean; `vp test` green (unit, browser, integ); `vp run test:e2e` green.
2. `rg -n "ticket|Ticket|TICKET|CALLER_HEADER|SystemRpcs|RequireSystem|BackendRpcs|BackendClient|IssueActorTicket|api/rpc\b" src test e2e alchemy.run.ts` finds nothing except intentional history in docs.
3. No `HttpServerRequest` import in `src/backend/shop-actor.ts` or `actor-socket.ts`.
4. The Website bundle contains no Backend runtime code (S0.6's check, repeated on the final build).
5. In dev: open the shop page in two windows, increment in one, the other updates; reload shows the count with no "Loading…" flash; the dev log shows one `shopSnapshot` per page load and no HTTP call into the actor.
6. In dev: sign out in another window; the shop window goes to sign-in.
7. A non-member's shop page shows "You're not a member of this shop." on first load (loader) and after removal while open (4404 on reconnect).
8. A socket idle past hibernation still answers with the right identity (integ).
9. The merchant page with a valid token works; with an expired token shows "Your Shopify session expired."

## 7. Out of scope

- Moving `TestControlRpcs` to server functions or schemaless.
- Effect RPC streaming in place of Notice frames.
- Any upstream change to Alchemy.
- S2 (Workflows) and S3 (cron); they will add schemaless actor methods, nothing more.
- Caching `getMe` across navigations; each `beforeLoad` calls it, as Baton does.

## 8. File plan

| File                                                                                                               | Change                                                                         |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `src/api/shop-actor.ts`                                                                                            | Groups, caller, header, close codes, `ShopSnapshot`                            |
| `src/api/shop-actor.test.ts`                                                                                       | middleware rule                                                                |
| `src/api/backend.ts`                                                                                               | drop RPC Groups and middleware; add `RequestInfo`                              |
| `src/api/test-control.ts`                                                                                          | drop `IssueActorTicketAs`                                                      |
| `src/backend/actor-socket.ts`                                                                                      | new: transport adapter                                                         |
| `src/backend/shop-actor.ts`                                                                                        | rewrite as plain Durable Object                                                |
| `src/backend/actor-client.ts`                                                                                      | `ShopActors`: `revoke`, `snapshot`                                             |
| `src/backend/api.ts`                                                                                               | new: `BackendApi`, `SignInLimiter`                                             |
| `src/backend/api.test.ts`                                                                                          | new                                                                            |
| `src/backend/handlers.ts`                                                                                          | delete                                                                         |
| `src/backend/ticket.ts`, `.test.ts`                                                                                | delete                                                                         |
| `src/backend/middleware.ts`                                                                                        | keep session helpers only                                                      |
| `src/backend/shop-access.ts`                                                                                       | JSDoc                                                                          |
| `src/backend/worker.ts`                                                                                            | gate header, refusals, schemaless methods, test-control upgrade, no RPC server |
| `src/backend/auth.ts`, `members.ts`                                                                                | `ShopActors` rename                                                            |
| `src/backend/test-control.ts`                                                                                      | upgrade route support, `ShopActors`                                            |
| `src/server/backend.ts`                                                                                            | new: binding accessor, `requestInfo`                                           |
| `src/server/*.ts`                                                                                                  | new: server functions                                                          |
| `src/routes/-guards.ts`, `sign-in.tsx`, `index.tsx`, `admin.members.tsx`, `app.shop.$key.tsx`, `merchant.$key.tsx` | server functions, loader data                                                  |
| `src/routes/api.rpc.ts`                                                                                            | delete                                                                         |
| `src/backend-client.ts`, `src/backend-transport.ts`                                                                | delete                                                                         |
| `src/rpc-proxy.ts`                                                                                                 | JSDoc: test control only                                                       |
| `src/session.ts`                                                                                                   | `signOut` with `router.invalidate()`                                           |
| `src/query.ts`                                                                                                     | keep `refreshOnFocus` only                                                     |
| `src/router.tsx`                                                                                                   | drop blocking reload and (likely) atom hydration                               |
| `src/ticket-client.ts` → `src/actor-connection.ts`                                                                 | connection state and retry policy only                                         |
| `src/shop-actor-client.ts`                                                                                         | no ticket, no server protocol, seeding                                         |
| `src/components/{SignInPage,Playground,MembersPage,ShopPage}.tsx`                                                  | props, snapshot                                                                |
| tests, e2e, `alchemy.run.ts`, `test/integ/stack.ts`, glossary, README                                              | as Step 9                                                                      |

## 9. Order of work and stopping points

1. Step 0. **Stop** if any check fails; record it and wait for the user.
2. Steps 1 to 4, then the actor parts of Step 9's integ tests. **Checkpoint A:** `vp test` integ green for the actor (socket identity, revoke, displace, expiry, gate codes).
3. Steps 5 and 6, with `api.test.ts`. **Checkpoint B:** Backend unit tests green.
4. Steps 7 and 8, then the rest of Step 9. **Checkpoint C:** everything in [§6](#6-verification-checklist).

Record each checkpoint's result in [§10](#10-deviations-and-issues). Do not commit; the user commits.

## 10. Deviations and issues

### Plan corrections before implementation (2026-10-13)

Checked against the installed packages before handoff; the plan text above already reflects them.

1. Decision 2 and S0.1: the subpath import `alchemy/Cloudflare/Workers/RpcWebSocket` does not resolve under Node's export rules; the plan now imports the lib file by relative path, with the copy as a pre-authorised fallback.
2. S0.6 and Step 7: `toRpcAsync` rethrows a typed failure as a plain `{ _tag }` object, so server functions decode it with `Schema.decodeUnknownOption` on a union of the error classes, not `Schema.is`.
3. S0.7 and Step 8: the seeding key is `atom[Atom.SerializableTypeId].key` (`AtomRpc:<tag>:<serializationKey>`), consumed by the registry when the node is first created.
4. Confirmed as written: `createServerFn().validator`, `getRequestHeader` from `@tanstack/react-start/server`, `Schema.toStandardSchemaV1`, `Schema.fromJsonString`, `registry.setSerializable`, `RpcSerialization.layerJson`, `useHydrated` from `@tanstack/react-router`, the plain `Cloudflare.DurableObject<Self>()(name, impl)` form, and every symbol the plan names in the current tree.

The implementer records here as they go. One entry per item: what the plan said, what was done instead or what went wrong, why, and the file. Leave a section empty rather than deleting it.

### Step 0 results

| Check                                            | Result | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S0.1 subpath import builds and runs              | Pass   | The relative lib-file import (`../../node_modules/alchemy/lib/Cloudflare/Workers/RpcWebSocket.js` from `src/backend/actor-socket.ts`) type-checks (`vp check`), bundles in the integ stack and under `vp run dev` (Backend reloaded, `SpikeActor` created), and a scratch plain `Cloudflare.DurableObject` served a one-procedure Group over a socket through it. The integ bundle holds one copy of the transport (one occurrence each of its `restartReason` and auto-response error strings, although the old `ShopActor` still reached it through `RpcDurableObject`). No copy was needed.                                                                                                                           |
| S0.2 attachment and tags survive                 | Pass   | Scratch integ test, hibernation forced by 12 s polls until the activation id changed. Before and after, `getWebSockets("member:spike-a")` returned the one socket with attachment `{ shopActor: { caller, connectedAt }, __alchemyRpcWebSocket: { version, clientId, pending, serialization } }` and tags `["alchemy:rpc", "member", "member:spike-a", "session:session-spike-a"]`. The decorated `acceptWebSocket` accepts first, then writes `shopActor` by spreading the previous attachment.                                                                                                                                                                                                                         |
| S0.3 context reaches the middleware              | Pass   | The scratch middleware died on `None` from `Effect.serviceOption(ConnectionIdentity)`; every call succeeded with the accepted caller, before and after hibernation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| S0.4 close before dispatch is clean              | Pass   | An expired member's socket was closed 3401 in `beforeDispatch` without delegating; the client saw 3401; another socket on the same object kept the same activation id (no abort), and a third socket opened afterwards on that activation was served.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| S0.5 gate close code reaches the browser         | Pass   | Scratch Backend branch (accept the server end of a `WebSocketPair`, close 4404, answer 101 with `HttpBody.raw(new Response(null, { status: 101, webSocket }))`) and a scratch Playwright spec run against the dev Website (`PLAYWRIGHT_TEST_BASE_URL=http://localhost:3900`): the page's `WebSocket` saw `close` with code 4404.                                                                                                                                                                                                                                                                                                                                                                                         |
| S0.6 schemaless Backend methods from the Website | Pass   | Scratch `ping` on the Backend, called from a scratch server function with `toRpcAsync<Backend>(env.BACKEND)` (`import type`): `ping(1)` is typed `Promise<number>` (assigning it to `string` is a type error) and answered 2. A `Schema.TaggedError` failure rejects with the plain object `{ _tag: "Unauthorized", message: "" }`; `Schema.decodeUnknownOption(Schema.Union([Unauthorized, Forbidden]))` yields an `Unauthorized` instance. A defect rejects with an `Error` carrying the message, which does not decode. `vp build` of the Website: the server-function chunk imports only Alchemy's `RpcAsync` helpers; no Backend module (`ShopAccess`, `sessionFromCookie`, `Tickets`, the actor) is in the bundle. |
| S0.7 seeding a socket atom                       | Pass   | Scratch browser component test over the in-memory `ShopActorClient`: `registry.setSerializable("AtomRpc:MemberGetCount:count", encode(AsyncResult.success({ value: 7 })))` before the first read; the component's first render was "7" (renders `["7"]`), and the `MemberGetCount` handler was called 0 times.                                                                                                                                                                                                                                                                                                                                                                                                           |

### Deviations

1. **Order of work.** Plan: Steps 1 to 4, then Checkpoint A, then Steps 5 and 6. Done: Steps 5 and 6 were written before Checkpoint A was run. Why: with `ticket.ts` deleted (Step 4) the Backend does not bundle until `IssueActorTicket` and `IssueActorTicketAs` are gone (Steps 5 and 6), and the expiry integ test needs Step 6's test-control upgrade route. Checkpoint A ran on the result. Files: `src/backend/worker.ts`, `src/backend/api.ts`, `src/backend/test-control.ts`.
2. **Where `SocketIdentity` and the attachment schema live.** Plan: module level in `src/backend/shop-actor.ts`. Done: `SocketIdentity`, the `Attachment` schema and the `ConnectionIdentity` service are in `src/backend/actor-socket.ts`. Why: the adapter decodes the attachment and provides `ConnectionIdentity`, and `shop-actor.ts` imports the adapter, so defining them in `shop-actor.ts` would be an import cycle. `shop-actor.ts` decodes the attachment only for displacement, with `ActorSocket.SocketIdentity`.
3. **§6 item 3 (no `HttpServerRequest` import in the actor).** Plan: none in `shop-actor.ts` or `actor-socket.ts`. Done: `actor-socket.ts` has none; `shop-actor.ts` imports it once, in the object's `fetch`, to check the upgrade and read `CONNECTION_HEADER` (Step 3 requires both). It is not used anywhere else; the old `serviceOption(HttpServerRequest)` path marker is gone. File: `src/backend/shop-actor.ts`.
4. **`MagicLinkRequested.link` crosses the binding encoded.** Plan: keep `MagicLinkRequested` (`link: Schema.Option(Schema.String)`). Done: `link: Schema.OptionFromNullOr(Schema.String)`; `BackendApi.requestMagicLink` returns the encoded value (`string | null`) and the server function decodes it. Why: an `Option` instance does not survive Cloudflare RPC's structured clone. Files: `src/api/backend.ts`, `src/backend/api.ts`, `src/server/sign-in.ts`.
5. **`RequestInfo` is a schema, and every Backend method decodes its arguments.** Plan: a `RequestInfo` type. Done: `RequestInfo = Schema.Struct({ cookie, ip })`, and each `BackendApi` method decodes its `RequestInfo` and payload with Schema on arrival (`orDie`: the only caller, a server function, already validated it). Why: the binding is a boundary and carries no schema. Files: `src/api/backend.ts`, `src/backend/api.ts`.
6. **The not-a-member and expired branches render in `ShopPage`.** Plan: the route component renders the refusal for `NotAMember`/`Expired`. Done: the route passes the loader data to `ShopPage`, which renders the refusal and never mounts `LiveShop` (the socket) for those tags. Why: one place to test it in a component test. Files: `src/components/ShopPage.tsx`, `src/routes/app.shop.$key.tsx`, `src/routes/merchant.$key.tsx`.
7. **The notices `PubSub` replays its last notice.** Not in the plan. `notices` is `PubSub.unbounded({ replay: 1 })`, so the refresh notice `onConnect` publishes reaches `noticesAtom` even when it subscribes after the first connect. Why: without the old bind call, nothing else is guaranteed to be sent on a new socket, so a dropped first notice left the seeded count unchecked and the e2e helper (below) had no answer to wait for. File: `src/shop-actor-client.ts`.
8. **e2e helper renamed.** `nextBoundSocket` became `nextOpenSocket` (same mechanism: the first successful answer on the page's next actor socket, now the on-connect count refetch). Files: `e2e/fixtures.ts`, `e2e/shop.spec.ts`.
9. **Integ test sockets stop on terminal codes.** The integ `connect` helper's retry policy now stops on 4401, 4403, 4404 and 4409, as the browser's does. Why: a test socket displaced with 4409 used to reconnect unbound and harmless; now a reconnect is identified at accept and displaced the next-oldest socket. File: `test/integ/actor-clients.ts`.
10. **Integ `auth.test.ts`.** Plan did not name it. It called `BackendRpcs` over `/rpc`, which is gone, and Node cannot reach the Backend's schemaless methods. It now signs in with test control's `IssueMagicLink` and reads the session from Better Auth's `/api/auth/get-session`. The session and role checks moved to `src/backend/api.test.ts`. File: `test/integ/auth.test.ts`.
11. **Backend unit tests split.** `src/backend/auth.test.ts` now drives `BackendApi` instead of `BackendRpcs`, keeping the sign-in, sign-out and mail-delivery cases; the guard and rate-limit cases moved to the new `src/backend/api.test.ts`. Their test layers provide `RuntimeContext.phantom` with `provideMerge` because the methods need it (see API confirmations).
12. **Socket queries lost their `timeToLive`.** The `count`, `merchant-count` queries had `timeToLive: "5 minutes"`. Removed, so a node dies at the registry's default idle TTL and a later visit creates a new node that takes the seed. `seedShop` also refreshes a node that already exists instead of seeding it, and resets `notAMemberAtom`, `merchantExpiredAtom` and `connectionStateAtom`, which are kept alive across pages. File: `src/shop-actor-client.ts`.
13. **Close outcome as two functions.** The terminal-code handling the plan puts in the policy's `onError` is `closeOutcome(error, merchant)` (pure) and `applyCloseOutcome(registry, outcome)` in `src/actor-connection.ts`, called from the browser protocol's `onError`, so `actor-connection.test.ts` can test the mapping without a socket.
14. **Redirects without a return path.** `listMembers` (`Unauthorized`) and `getShopSnapshot` (a member's `Unauthorized`) redirect to `/sign-in` with no `redirect` search param: a server function does not know the page's location. Both cases only happen when a session ends between the guard and the loader. `listMembers`' `Forbidden` redirects to `homeFor("user")`, the only role it can be. Files: `src/server/members.ts`, `src/server/shop.ts`.
15. **`getShopSnapshot` maps `Forbidden` to `NotAMember`.** The plan's table lists only the not-a-member and expired answers; the gate's 403 (operator, token for another shop) is shown as `NotAMember`, as `IssueActorTicket` used to map it. File: `src/server/shop.ts`.
16. **Test-control upgrade route answers 404 for an undecodable `x-test-caller`.** Plan: 404 for no binding or a wrong token. A caller header that does not decode is also 404 (`testControlCaller` answers `None`). File: `src/backend/test-control.ts`.
17. **Added a dev-log line and two tests.** `BackendApi.shopSnapshot` logs `Backend.shopSnapshot: shop=…`, as `hello` logs `Backend.Hello`, to count loads for §6 item 5. Added the e2e test "a merchant whose Shopify session expired is told so" for §6 item 9, and `SignInPage`'s "says when the request fails".

### Issues

1. **Dev server crashed on the first reload.** The dev server that was already running (since 2026-10-12) failed its first Backend reload with a sidecar `EPIPE` ("Failed to create a provider RPC session with the sidecar"). `vp run dev:stop` then `vp run dev` fixed it; no recurrence. Not caused by the code as far as I can tell.
2. **First use of a new dependency in Vite.** The first dev request after `alchemy/Cloudflare/Bridge` was imported by the Website re-optimized deps and rendered one "Invalid hook call" error; the next request was fine. The browser test project had the same one-off "Failed to fetch dynamically imported module" on its first run after the import changes. Both are Vite dep-optimizer behaviour; adding `alchemy/Cloudflare/Bridge` to `optimizeDeps.include` might avoid it on a fresh checkout. Not done.
3. **Notice replay couples `ShopPage` tests.** The module-level `notices` replays its last notice to the next subscriber, so a `ShopPage` test that mounts after another test published one sees one extra count refetch. No current test depends on it, but the order matters.
4. **Server functions trust the Backend's success values.** Only `MagicLinkRequested` is decoded on the Website; the other answers (`Me`, `Hello`, `Shouted`, `Member[]`, the snapshot and caller) are used as the binding types them. Question for the user: decode them with Schema in each server function too?
5. **The stub's types hide a defect.** `actors.getByName(key).revoke(...)` and `.snapshot()` are typed exactly as the actor's methods; a defect in the actor rejects the call, which Alchemy's stub turns into an `RpcCallError` in the error channel that the type does not show. `ShopActors.revoke` catches every cause; `snapshot` lets it through, and `shopSnapshot` then fails with an untyped error, which the server function rethrows (route error boundary).
6. **Sign-out from the side nav navigates twice.** `signOut` invalidates the router (the `/app` or `/admin` guard then redirects to `/sign-in`), and `SideNavShell` then navigates to `/`. The e2e test ends on `/` as before; the extra redirect is wasted work.
7. **`currentUserFromCookie` is unused.** Kept in `src/backend/middleware.ts` as the plan says; nothing calls it now.
8. **`TicketSecret` is deleted from stage state.** The dev stage deleted it on reload; staging and production will delete it on their next deploy. Expected, noted so it is not a surprise.
9. **The Website's not-a-member e2e test opens a raw `WebSocket` from the page.** It proves the gate's 4404 reaches a page through the Website (S0.5) but is not the page's own socket, because the loader already refuses that page and no socket is opened.

### API confirmations

1. **`actor-socket.ts` final signature.**
   ```ts
   make<Rpcs extends Rpc.Any, RH>(options: {
     group: RpcGroup.RpcGroup<Rpcs>;
     handlers: Layer.Layer<Rpc.ToHandler<Rpcs> | Rpc.Middleware<Rpcs>, never, RH>;
     onAccept: (identity: SocketIdentity) => { tags: ReadonlyArray<string> };
     beforeDispatch: (identity: SocketIdentity, socket: Cloudflare.Workers.WebSocket) => Effect<boolean>;
   }): Effect<{
     fetch: (identity: SocketIdentity) => Effect<{ response: HttpServerResponse; socket: Option<Cloudflare.Workers.WebSocket> }, …, HttpServerRequest | …>;
     webSocketMessage: (socket, message: string | ArrayBuffer) => Effect<void>;
     webSocketClose: (socket) => Effect<void>;
     webSocketError: (socket, error: unknown) => Effect<void>;
   }, never, DurableObjectState | RuntimeContext | RH>
   ```
   Also exported: `SocketIdentity` (schema), `ConnectionIdentity` (service). It imports Alchemy's transport by relative file path; no copy was needed.
2. **Better Auth's headers for `signInMagicLink`.** The endpoint has `requireHeaders: true`, so a `Headers` object must be passed, but nothing in it is read on this path: its `formCsrfMiddleware` returns at once when the call has no `request` (as with `auth.api.*` server calls), and Better Auth's rate limit, the only reader of `cf-connecting-ip`, is off. `BackendApi.requestMagicLink` passes `new Headers()`; no `RequestInfo` field was added. Read from `better-auth@1.7.7` `dist/plugins/magic-link/index.mjs` and `dist/api/middlewares/origin-check.mjs`; the e2e sign-in tests exercise it.
3. **`RuntimeContext` on schemaless methods.** Not needed. A Worker method runs with Alchemy's `RuntimeContext` provided by the bridge (S0.6: `Effect.serviceOption(RuntimeContext)` was `Some` inside a Backend method), and a Durable Object method runs with the instance's `RuntimeContext` (`DurableObjectBridge` adds it to every call's services). `BackendApi`'s methods therefore keep `RuntimeContext` in their requirements and the Worker satisfies it; tests provide `RuntimeContext.phantom`. `ShopActor.revoke` provides the activation's captured `RuntimeContext` itself so its stub type has no requirement for the Backend to meet.
4. **Plain `DurableObject` stub types.** `ShopActors` calls `actors.getByName(key).revoke({ by, id })` and `.snapshot()`; both are typed from the actor's returned object (`DurableObjectStub<Shape>` is `Shape` plus `fetch`), checked by `vp check`, and run in the integ tests (`RemoveMember` answers `closed: 1`). A defect inside such a method: `handleRpcExit` rethrows it, the stub's promise rejects, and `makeRpcStub` maps the rejection to `RpcCallError` in the error channel (read from `node_modules/alchemy/src/Cloudflare/Workers/Rpc.ts` and `WorkerBridge.ts`; not exercised by a test).
5. **WebSocket tag limits.** Cloudflare allows at most 10 tags per WebSocket, each at most 256 characters (Cloudflare Durable Objects WebSocket hibernation docs; not run against the limit). A member socket carries 4 (`alchemy:rpc`, `member`, `member:<id>`, `session:<id>`), a merchant 2. Recorded on `tagsOf` in `shop-actor.ts`.
6. **`router.tsx`.** Kept: the atom registry in the router context and the `RegistryContext` `Wrap` (the socket atoms use it). Removed: `defaultStaleReloadMode: "blocking"` and its comment, and `dehydrate`/`hydrate`; seeding (S0.7) needs neither.
7. **Server functions.** `createServerFn({ method }).validator(Schema.toStandardSchemaV1(…))` (the non-deprecated name; `inputValidator` is the deprecated alias in `@tanstack/start-client-core@1.170.34`), called from components through `useServerFn`. A redirect thrown inside a server function's handler reaches the router as a redirect.
8. **`toRpcAsync` failure shape.** As the plan corrected: a typed failure rejects with `{ _tag, …fields }` (`Unauthorized` arrived as `{ _tag: "Unauthorized", message: "" }`), which `Schema.decodeUnknownOption(Schema.Union([...]))` turns into the class instance (`rescue` in `src/server/backend.ts`); a defect rejects with an `Error`.

### Checkpoints

| Checkpoint           | Result                                                                                                                                                                                                                                                        | Date       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| A: actor integ       | Green. `vp test --project integ`: 3 files, 12 tests passed (`socket-facts.test.ts` 2, `shop-actor.test.ts` 9, `auth.test.ts` 1). The first run had 1 failure (displacement: the integ helper reconnected after 4409; see deviation 9), fixed and rerun green. | 2026-10-13 |
| B: Backend unit      | Green. `vp test --project unit src/backend src/api`: 6 files, 36 passed, 1 todo (the existing `ResetData` todo).                                                                                                                                              | 2026-10-13 |
| C: full verification | Green. `vp check`: no warnings, lint errors or type errors in 95 files, all files formatted. `vp test`: 13 files, 80 passed, 1 todo (unit 7 files 55 + 1 todo, browser 3 files 13, integ 3 files 12). `vp run test:e2e`: 17 passed (3 setup, 14 chromium).    | 2026-10-13 |

### Verification checklist (§6)

| Item | Result  | How checked                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Pass    | Checkpoint C commands and counts above.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 2    | Pass    | `rg -n "ticket\|Ticket\|TICKET\|CALLER_HEADER\|SystemRpcs\|RequireSystem\|BackendRpcs\|BackendClient\|IssueActorTicket\|api/rpc\b" src test e2e alchemy.run.ts` found nothing (exit 1).                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 3    | Partial | `actor-socket.ts` has no `HttpServerRequest` import; `shop-actor.ts` imports it for its `fetch` only. See deviation 3.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 4    | Pass    | `vp build --outDir /tmp/website-build` on the final tree: no `ShopAccess`, `sessionFromCookie`, `BackendApi`, `ShopActor.readCount`, `SignInLimiter`, `ActorSocket`, `betterAuth(` or `RpcWebSocket` anywhere in the output; `toRpcAsync` only in the server chunk for `src/server/backend.ts`; the client bundle has no `cf-connecting-ip` or `BACKEND`.                                                                                                                                                                                                                                                       |
| 5    | Pass    | Scratch Playwright spec against `vp run dev` (port 3900, removed after): signed in as m1 through the sign-in page, opened the shop in two windows, incremented in one, the other showed the new count; a reload showed the count with no "Loading…" at `DOMContentLoaded` or after hydration, and the server HTML had no "Loading…". `logs/dev/current` gained exactly 4 `Backend.shopSnapshot` lines for 4 page loads. No HTTP call into the actor: the actor has no HTTP RPC (non-upgrade is 426, integ test), and the only Backend → actor traffic is the stub's `snapshot`/`revoke` and forwarded upgrades. |
| 6    | Pass    | e2e "sign-out in one window sends the other to sign-in; an admin is untouched" (e2e stage, not the dev stage).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 7    | Pass    | e2e "a visitor who is not a member sees the not-a-member page, and the gate closes its socket with 4404" (loader path) and "a member removed while the page is open is told so" (3401, then 4404 on reconnect); integ "RemoveMember closes … and the gate then refuses it with 4404".                                                                                                                                                                                                                                                                                                                           |
| 8    | Pass    | Integ `socket-facts.test.ts` "a socket's identity and tags survive Alchemy's writes and a hibernation": the activation id changed, who-am-I still answered the same caller, and a revoke by member (tag) closed it.                                                                                                                                                                                                                                                                                                                                                                                             |
| 9    | Pass    | e2e "the merchant resets the count and a member sees it" (valid token) and the new "a merchant whose Shopify session expired is told so" (token minted with `expiresInSeconds: -60`).                                                                                                                                                                                                                                                                                                                                                                                                                           |

### Review changes (after implementation)

Reviewed 2026-10-13. Deviations 1 to 6, 8 to 11, 13 and 15 to 17 accepted as recorded. Changes made:

1. **Deviation 14 reversed.** `getShopSnapshot` redirects to sign-in with `redirect=/app/shop/<key>` (it has the key); `listMembers` with `redirect=/admin/members` (the only page that calls it). Files: `src/server/shop.ts`, `src/server/members.ts`.
2. **Deviation 7 kept, issue 3 fixed.** The notices `PubSub` is now an atom (`noticeBus`, kept alive), so it lives per registry: the protocol reads it with `get`, `noticesAtom` subscribes through `get`, and each test registry has its own replay buffer. `ShopPage.test.tsx` publishes to its registry's bus. File: `src/shop-actor-client.ts`.
3. **Issue 4 answered: no.** Server functions use the Backend's answers as typed. The rule is on `BackendApi`'s JSDoc: a method answers with JSON-plain values; a schema whose type is not JSON-plain is encoded on the Backend and decoded in its server function. File: `src/backend/api.ts`.
4. **Issue 6 fixed.** The side nav navigates to `/` before signing out, so the guard never redirects. File: `src/components/SideNavShell.tsx`.
5. **Issue 7 fixed.** `currentUserFromCookie` deleted. File: `src/backend/middleware.ts`.
6. **Deviation 12 noted on `seedShop`'s JSDoc:** a second run on the same registry refetches, which is what React's StrictMode would cause in development.
7. **Issue 2 not done.** `alchemy/Cloudflare/Bridge` is imported by server code only, so the one-off error belongs to the SSR environment's optimizer; a client `optimizeDeps.include` would not reach it, and the error did not reproduce in this session. Revisit if a fresh checkout shows it.
8. Issues 5, 8 and 9 and the unverified items stand as recorded; no change.
9. **`StrictMode` added** around the router's `Wrap` (`src/router.tsx`); the e2e suite, which runs the dev build, passes under it (17 of 17).
