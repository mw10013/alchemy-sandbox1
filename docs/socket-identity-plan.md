# Plan: who is on the socket (spike S1)

Plan date: 2026-10-12.
Research: [socket identity research](./socket-identity-research.md) (decided; every question answered), with [connection identity research](./connection-identity-research.md) for background. [Glossary](./glossary.md).
Versions: Alchemy `2.0.0-beta.81`, Effect `4.0.1`, Better Auth `1.7.7`. Do not bump dependencies. No new dependencies are expected.

## 1. Outcome

The sandbox takes on Baton's data model: a shop is a `ShopSession` row keyed by its myshopify domain, with its (fake) Shopify tokens; a member is a `Member` row of one shop; teams are `Team` and `TeamMember` rows. Seed data fills all of it. A merchant is whoever presents a Shopify session token for the shop, as in Baton; in this sandbox the token is minted by test control with a fake Shopify API secret. The operator `a@a.com` is a seeded Better Auth `user` row with `role = 'admin'`.

A signed-in member opens `/app/shop/alchemy-sandbox1.myshopify.com`. Before each socket connect the browser holds a short-lived signed **ticket** from the Backend (the first one comes with the page) and sends it on the socket's first call. The actor binds the identity to that socket's attachment; every later call reads it from the socket and never from a header. Procedures are split by role as Baton's are: `Member…`, `Merchant…`, and `System…` for the Backend's own calls through the stub. A member calling a merchant procedure gets a typed `Forbidden`, over the socket and over SSR alike. Sign-out, ban, or removal from the shop makes the Backend call `SystemRevoke` on the actor, which closes the right sockets with 3401; the browser's next connect asks for a ticket over HTTP first, and that answer decides between reconnecting, going to sign-in, and showing "not a member". A member's third socket displaces the oldest with 4409 and that window shows "Signed in elsewhere" with Reconnect. Identity survives hibernation, and an idle browser costs nothing: no timers, no renewals. Alchemy is not patched. `vp check`, `vp test` and `vp run test:e2e` stay green at every step.

## 2. Rules the implementer must follow

- Read `AGENTS.md` first: Effect Schema for all validation and encoding (never a hand-rolled check on input), `Match` for tag dispatch, `Schema.TaggedError` for failures, `Effect.fn("Service.method")` for reusable effects, JSDoc on declarations with each rule stated once, no `//` above a declaration, and never a reference to this plan or the research in code. State the reason in the comment itself.
- Tooling through `vp` (`vp check --fix`, `vp test`, `vp run test:e2e`, `vp exec alchemy`, `vp exec astryx`). Never `npm` or `npx`. If a dependency seems needed, stop and record it in [§10](#10-deviations-and-issues) before adding it.
- Do not commit. Do not create branches. Do not touch `.env`.
- Follow the existing seams: the `api/` vs `backend/` split; `Effect.fn` plus `Effect.orDie` for storage code as in `members.ts`; `createIsomorphicFn` in `shop-actor-client.ts`; `loadQuery` for every SSR-rendered query; Astryx components only, checked with `astryx component <Name>` before use; copy rules on `RootDocument`.
- Alchemy's Durable Object contract: the outer Effect resolves dependencies and `Cloudflare.DurableObjectState`; everything touching `state.*`, storage or sockets runs in the inner Effect or a handler.
- Vocabulary in code and comments: **browser** (never "tab"), **member**, **merchant**, **operator**, **caller**, **ticket**, **bind**, **stub**, **gate**, as defined in the research's §2 and the glossary. Role names are Baton's `CallerRole`: `merchant`, `member`, and `system` for the Backend's own calls (Baton calls that one `rpc`; `system` says what it is).
- Baton's data model and connection rules are the target. Table and column names, domain schema names, the gate's status codes, the close codes and the role-per-procedure rule come from `refs/baton` unchanged (`src/lib/domain/Platform.ts`, `migrations/0001_init.sql`, `src/worker.ts`, `src/lib/ShopAgent.ts`). [§3](#3-design-decisions-already-taken) lists every deliberate difference; any other difference is a deviation to record.
- Keep every step green: `vp check` and `vp test` after each step; `vp run test:e2e` after Step 1 and Step 8. Where the plan says **confirm**, the API or behaviour was read from source but not run; check it before relying on it and record any difference in [§10](#10-deviations-and-issues).
- Step 0 comes first and gates the rest. If any of its three checks fails, stop and record it; the fallbacks are listed there, but choosing one is the user's decision.

## 3. Design decisions already taken

From the research and the user's review. Not open; a deviation is recorded if forced off any of them.

1. **Identity binds on the first call, on stock Alchemy.** The actor reaches sockets through `DurableObjectState.getWebSockets()`, matches the middleware's `client.id` to Alchemy's `__alchemyRpcWebSocket.clientId` in the attachment, and writes its own `shopActor` key next to it.
2. **The stub path is told from the socket path by `HttpServerRequest`** being present in the middleware's context (stub) or absent (socket). Verified in Step 0; the fallback is a signed header on the Backend's stub calls.
3. **A ticket per connect.** The browser fetches a ticket over HTTP immediately before every socket connect, inside the socket's URL effect, and sends it on that connection's first call. The first ticket is primed by the loader and dehydrated, so the first connect makes no extra call. Because every reconnect asks the Backend first, the Backend's HTTP answer (401, "not a member", or a ticket) is how the browser learns why a socket was closed; the POC's three-failures-then-check guard in `socket-session.ts` is retired.
4. **No rebind deadline.** The backstop for a missed revoke on a member socket is the session's own expiry, checked on every socket call. A merchant socket has no backstop, as in Baton (its token is checked at connect only).
5. **Close codes are Baton's:** 3401 revoked, 4403 forbidden, 4409 displaced. In S1 nothing sends 4403 (a bad ticket is answered as a failure on the call that carried it, which Baton could not do at accept time); the constant exists and the browser treats it as terminal. **Displacement is in:** at most two sockets per member, the newest wins, merchants are not capped.
6. **Baton's data model, no extra tables.** `ShopSession`, `Member`, `Team`, `TeamMember` exactly as Baton's migration has them, seeded with fake data including fake Shopify tokens. This repo's `member` invite table is dropped. Who may sign in is Baton's rule: a `Member` row exists for the email in some shop. Who is an operator is seed data, not config: the seed inserts the operator's Better Auth `user` row with `role = 'admin'`. Baton's `ADMIN_EMAILS` config is not brought over. The admin members page lists `Member` rows.
7. **The shop key is Baton's `Shop`:** the myshopify domain. `ShopKey` becomes `alchemy-sandbox1.myshopify.com` and names the `ShopSession` row and the actor.
8. **The merchant is proved by a Shopify session token, as in Baton.** Baton decodes it with `@shopify/shopify-api`; this sandbox verifies the same JWT with Web Crypto. The API key and secret are fake Backend config. Test control mints tokens as Shopify would, which is how a merchant window exists in dev and e2e. Everything else Shopify (the app, OAuth, real tokens, App Bridge, plans and 402) is the Shopify slice.
9. **Better Auth's tables stay managed by `@alchemy.run/better-auth`** (`CloudflareD1` migrates them at deploy). Baton hand-writes them with a `UserRole` enum table; that is the one place the sandbox does not copy Baton, because the integration owns that schema.
10. **Teams are seeded and unused** in S1. `teamIds` travels in the caller as Baton carries it; nothing reads it.
11. **The Website's `POST /api/actor/$key` route is removed**, and the upgrade route checks `Origin`.
12. **Revocation triggers in S1:** session deleted (sign-out, revoke, ban, password change, account deletion), user updated (role or ban), member removed. Baton's session cap and its revoke-all on plan change are not in S1.

## 4. The pieces, in dependency order

| Step | Piece                                                                        | Files                                                                                                                                                                                                                    |
| ---- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0    | Spike checks: the three facts the design rests on                            | `test/integ/socket-facts.test.ts`, scratch procedures (removed after)                                                                                                                                                    |
| 1    | Baton's data model: migration, seeds, `Members`, sign-in rules, admin page   | `migrations/0002_baton_schema.sql`, `seed/*.sql`, `src/api/{backend,shop-actor,test-control}.ts`, `src/backend/{members,auth,auth.test,handlers,test-control}.ts`, `src/routes/admin.members.tsx`, `e2e/members.spec.ts` |
| 2    | API definition: caller, ticket, middleware, role groups, codes               | `src/api/shop-actor.ts`, `src/api/backend.ts`, `src/api/shop-actor.test.ts`                                                                                                                                              |
| 3    | Tickets and the fake Shopify: secrets, mint, verify                          | `src/backend/ticket.ts`, `src/backend/shopify.ts`, their tests, `alchemy.run.ts`, `test/integ/stack.ts`                                                                                                                  |
| 4    | The gate and the Backend routes                                              | `src/backend/shop-access.ts`, `src/backend/middleware.ts`, `src/backend/worker.ts`, `src/backend/handlers.ts`, `src/backend/actor-client.ts`                                                                             |
| 5    | The actor: caller middleware, bind, roles, revoke, displace, expiry          | `src/backend/shop-actor.ts`, plus the test renames                                                                                                                                                                       |
| 6    | Revocation triggers: Better Auth hooks, member removal, test control         | `src/backend/auth.ts`, `src/api/test-control.ts`, `src/backend/test-control.ts`                                                                                                                                          |
| 7    | Browser: ticket per connect, client middleware, retry policy, page, merchant | `src/shop-actor-client.ts`, `src/ticket-client.ts`, `src/components/ShopPage.tsx`, `src/routes/{app.shop.$key,merchant.$key,api.actor.$key}.tsx`, `src/socket-session.ts` (removed)                                      |
| 8    | Tests: unit, browser, integ, e2e                                             | `test/integ/shop-actor.test.ts`, `test/browser/shop-actor.ts`, `src/components/ShopPage.test.tsx`, `e2e/{shop.spec,screens,fixtures,auth.setup}.ts`                                                                      |
| 9    | Glossary and README                                                          | `docs/glossary.md`, `README.md`                                                                                                                                                                                          |

## 5. Steps

### Step 0: spike checks

Three facts, each read from source in the research (§3, §4.8, §7 there). Prove them in workerd before building on them. One integ file, `test/integ/socket-facts.test.ts`, against `test/integ/stack.ts`, using copies of the `connect` and `signIn` helpers from `test/integ/shop-actor.test.ts`. The file stays as a regression test; the scratch procedures are folded into the real ones in Step 5.

**0.1 Our key in the attachment survives.** Add a temporary procedure `Probe` to `ShopActorRpcs` whose handler lists `state.getWebSockets()`, finds the socket whose attachment's `__alchemyRpcWebSocket.clientId` equals `client.id` (the handler's second argument carries `client`; **confirm** the shape `{ client: Rpc.ServerClient }`), writes `{ ...previous, shopActor: { stamp } }` with `socket.serializeAttachment`, and returns the `shopActor` value it read before writing (or `null`). Test: call `Probe` twice on one socket; the second call returns the first stamp. Then wait for hibernation as `shop-actor.test.ts` does (12-second spaced `Activation` polls until the id changes) and call `Probe` again: the stamp is still there. Decode the attachment with a Schema (`Schema.Struct({ __alchemyRpcWebSocket: Schema.Unknown, shopActor: Schema.optional(...) })`), never by hand.

**0.2 Closing a socket from our code leaves the transport clean.** Add a temporary procedure `CloseMe` whose handler finds the caller's socket the same way, returns, and closes it with `socket.close(3401, "probe")` after the response is written (run the close through `state.waitUntil` or as a forked effect after the handler returns; the point is to see the response and then the close). Test: open sockets `a` and `b`; `a` calls `CloseMe`; `a`'s socket closes and the Effect client surfaces an `RpcClientError` whose reason is a `SocketCloseError` with code 3401 (**confirm** the code arrives unchanged with no Vite in front); `b` calls `Increment` and `GetCount` and both work; `a` reconnects and works; a third socket's `Activation` returns the id `b` saw, so the object was not restarted. The absence of `Unable to close RPC WebSocket` in the harness output is part of the check.

**0.3 `HttpServerRequest` marks the stub path.** Add a temporary procedure `Path` whose handler returns `Option.isSome(yield* Effect.serviceOption(HttpServerRequest.HttpServerRequest))`. Over the socket: `false`. Over HTTP through the Backend's `/api/actor/:key` forwarding with a cookie, using `RpcClient.layerProtocolHttp` as `serverProtocol` does: `true`. Through the stub from the Backend: a temporary Backend procedure `ProbeActor` on `BackendRpcs` that does `yield* (yield* actors.getByName(key)).Path()`: `true`. Remove `ProbeActor` with the rest.

**Fallbacks, for the user to choose:** 0.1 false: identity in a SQLite table keyed by `clientId` plus an activation generation. 0.2 false: a `SystemClose` through the transport's own `end(clientId)`, which needs a one-line Alchemy export (the one upstream ask). 0.3 false: the Backend's stub client stamps `x-actor-caller` with a signature the actor verifies on every HTTP call.

Record the three results in [§10](#10-deviations-and-issues) under "Step 0 results" before going on.

### Step 1: Baton's data model

**1.1 Migration `migrations/0002_baton_schema.sql`.**

1. `DROP TABLE member;` The sandbox has no data worth keeping; dev and staging users keep their Better Auth rows.
2. `ShopSession`, `Member`, `Team`, `TeamMember` and their two indexes, pasted verbatim from `refs/baton/migrations/0001_init.sql` with Baton's comments, under one leading comment naming the source and saying the `ShopSession` token and plan columns hold seed values until the Shopify slice. Baton's Better Auth tables and `UserRole` are not pasted ([§3](#3-design-decisions-already-taken) item 9).

**confirm** that `alchemy dev` applies a `DROP TABLE` migration on the existing dev database, and that `importFiles` re-runs a changed seed file after it.

**1.2 Seeds.** `dev.sql` and `test.sql` are identical; `staging.sql` has the first shop and the operator only. Every insert is `INSERT OR IGNORE`. Values are fake but shaped like Baton's:

| Table         | Rows                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ShopSession` | `alchemy-sandbox1.myshopify.com`: `shopGid` `gid://shopify/Shop/1`, `shopAgentId` `alchemy-sandbox1.myshopify.com`, `scope` `read_orders,write_orders`, `accessToken` `shpat_fake_alchemy_sandbox1`, `accessTokenExpiresAt` and `refreshTokenExpiresAt` far-future epoch-ms, `refreshToken` `shprt_fake_alchemy_sandbox1`, `planHandle` `basic`, `planHandleExpiresAt` far future, `planBoundaryAt` null. `other-shop.myshopify.com`: the same shape with `/2` and `_other_shop`. |
| `Member`      | `mem-1` `m1@m.com` and `mem-2` `m2@m.com` in `alchemy-sandbox1.myshopify.com`; `mem-3` `m1@m.com` in `other-shop.myshopify.com`. `createdAt` epoch-ms literals.                                                                                                                                                                                                                                                                                                                   |
| `Team`        | `team-1` `ops` in `alchemy-sandbox1.myshopify.com`.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `TeamMember`  | (`team-1`, `mem-1`).                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `"user"`      | `a@a.com`, the operator: `INSERT OR IGNORE INTO "user" (id, name, email, emailVerified, role, banned, createdAt, updatedAt) VALUES ('user-admin', 'Admin', 'a@a.com', 1, 'admin', 0, '<iso>', '<iso>')`.                                                                                                                                                                                                                                                                          |

The operator has no `Member` row. A magic link for an existing user signs it in without sign-up (the plugin only creates a user it cannot find), so the seeded role stands and no account row is needed. Two things to **confirm** on a fresh stage: the column names and value shapes the integration migrates (read the live table with `vp exec alchemy`; dates are ISO text, booleans 0/1), and that `importFiles` runs after the integration has created the Better Auth tables. If the second does not hold, the seed's user row moves to a one-off `TestData` call for the test stages and a manual insert for dev, recorded as a deviation.

**1.3 `Members` over Baton's `Member`** (`src/backend/members.ts`, keeping the service name): `listShopsOf(email)` (Baton's `listMemberShops`: `select shop from Member where email = ? order by shop`), `find(shop, email)` → `Option<Member>`, `teamIdsOf(memberId)` (`select teamId from TeamMember where memberId = ?`), `list()` → every row ordered by `shop, email`, `add(shop, email)` (id `crypto.randomUUID()`, `createdAt` `Date.now()`; a duplicate is a typed `MemberExists` failure from the unique index), `remove(shop, email)` → the removed row's id as `Option`. The JSDoc on `Members` states Baton's rule once: a membership edit must be followed by a revoke on that shop's actor, and the caller does it (`Members` has no stub). `Members.layerTest` holds `Member` rows in memory for `auth.test.ts`. `Member` in `api/backend.ts` becomes `{ id, shop: ShopKey, email, createdAt }` (Baton's row); `Role` stays only as Better Auth's `user.role` type for `Me`.

**1.4 Sign-in rules** in `auth.ts`: `validateUserInfo` and `user.create.before` admit a new user only if `members.listShopsOf(email)` is non-empty, and refuse otherwise (Baton's invite-only backstop without its admin-email branch, which [§3](#3-design-decisions-already-taken) item 6 replaces with the seed row). The hook that copied `member.role` goes away; every new user is `'user'`. `auth.test.ts` seeds `Member` rows instead of invites; its `not_invited` case stays.

**1.5 Admin page and test control.** `ListMembers` returns `Member` rows; `admin.members.tsx` shows Shop, Email, Added; `e2e/members.spec.ts` asserts the three seed rows. Test control: `CreateMember` becomes `AddMember({ shop: ShopKey, email: E2eEmail })`; `RemoveMember({ shop, email })` is added; both call `Members` and then revoke on the shop's actor once Step 6 exists (until then they only edit). `ResetData` deletes every session, account and verification row, `Member` rows whose email ends in `@e2e.test` (team edges cascade), and users whose email ends in `@e2e.test`, so the seeded operator survives a reset. `IssueMagicLink` checks "a Better Auth user exists for the email, or a `Member` row does" instead of `findByEmail`.

**1.6 ShopKey.** In `api/shop-actor.ts`, `ShopKey` is Baton's `Shop` with this sandbox's route-safety pattern: `Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,62}\.myshopify\.com$/u))` branded `ShopKey`; the JSDoc says Baton's `Shop` is any non-empty string and why the pattern is narrower. `SANDBOX_SHOP = "alchemy-sandbox1.myshopify.com"`. `MemberShell`'s link and `e2e/shop.spec.ts` follow.

Green: `vp check`, `vp test`, `vp run test:e2e`.

### Step 2: API definition

In `src/api/shop-actor.ts`:

**2.1 Caller.** One flat union on `role`, Baton's `CallerRole` with `system` for `rpc`:

```ts
export const MemberCaller = Schema.Struct({
  role: Schema.Literal("member"),
  memberId: Schema.String,
  memberEmail: Email,
  teamIds: Schema.Array(Schema.String),
  userId: Schema.String,
  sessionId: Schema.String,
  sessionExpiresAt: Schema.Number, // epoch ms, the Better Auth session's expiresAt
});
export const MerchantCaller = Schema.Struct({ role: Schema.Literal("merchant") });
export const SystemCaller = Schema.Struct({ role: Schema.Literal("system") });
export const ConnectionCaller = Schema.Union([MemberCaller, MerchantCaller]); // what a socket can carry
export const Caller = Schema.Union([MemberCaller, MerchantCaller, SystemCaller]);
export class CurrentCaller extends Context.Service<CurrentCaller, Caller>()("CurrentCaller") {}
```

Baton's `ConnectionState` is `role`, `memberId`, `memberEmail`, `teamIds`, `connectedAt`; `userId`, `sessionId` and `sessionExpiresAt` are added for session-scoped revoke and the expiry backstop, and `connectedAt` becomes `boundAt` on the socket identity (2.3). A merchant carries nothing beyond its role, as in Baton.

**2.2 Ticket.** `TicketClaims = Schema.Struct({ shop: ShopKey, caller: ConnectionCaller, expiresAt: Schema.Number })`. The wire form is one string, `<base64url(JSON claims)>.<base64url(HMAC)>`; `Ticket = Schema.String.pipe(Schema.brand("Ticket"))`. `TICKET_HEADER = "x-actor-ticket"`, `CALLER_HEADER = "x-actor-caller"`, `TICKET_TTL_MILLIS = 60_000`. A ticket is minted immediately before a connect and used on that connect's first call, so one minute is generous; it is not a session.

**2.3 Socket identity.** `SocketIdentity = Schema.Struct({ caller: ConnectionCaller, boundAt: Schema.Number })`, what the actor writes into the attachment.

**2.4 Failures and middleware.** Reuse `Unauthorized` and `Forbidden` from `api/backend.ts`.

```ts
export class CallerMiddleware extends RpcMiddleware.Service<
  CallerMiddleware,
  { provides: CurrentCaller }
>()("CallerMiddleware", { error: Unauthorized }) {}
export class RequireMerchant extends RpcMiddleware.Service<
  RequireMerchant,
  { requires: CurrentCaller }
>()("RequireMerchant", { error: Forbidden }) {}
export class RequireMember extends RpcMiddleware.Service<
  RequireMember,
  { requires: CurrentCaller }
>()("RequireMember", { error: Forbidden }) {}
export class RequireSystem extends RpcMiddleware.Service<
  RequireSystem,
  { requires: CurrentCaller }
>()("RequireSystem", { error: Forbidden }) {}
```

Each `Require…` admits exactly its role. A read both roles may make is declared once per role, as Baton does (`MemberGetCount` and `MerchantGetCount`), never with a role switch inside a handler.

**2.5 Groups and procedures.** The POC's three procedures are renamed; nothing keeps the old names.

| Group          | Procedures                                                                                                            | Middleware (innermost first)          |
| -------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `MemberRpcs`   | `MemberGetCount` → `Count`; `MemberIncrement` → `Count`; `MemberActivation` → `Activation`; `MemberWhoAmI` → `Caller` | `RequireMember`, `CallerMiddleware`   |
| `MerchantRpcs` | `MerchantGetCount` → `Count`; `MerchantResetCount` → `Count`; `MerchantWhoAmI` → `Caller`                             | `RequireMerchant`, `CallerMiddleware` |
| `SystemRpcs`   | `SystemRevoke` payload `{ by: Schema.Literals(["member", "session"]), id: Schema.String }` → `{ closed: Schema.Int }` | `RequireSystem`, `CallerMiddleware`   |

`by: "member"` closes a member's sockets (Baton's `revokeMemberConnections`); `"session"` closes one Better Auth session's sockets (finer than Baton, research Q5). `ShopActorRpcs = MemberRpcs.merge(MerchantRpcs, SystemRpcs)` (**confirm** `RpcGroup.merge` keeps per-group middleware; `api/backend.ts` already merges groups carrying different middleware). The first middleware added runs innermost.

**2.6 Close codes.** `CONNECTION_CLOSE_REVOKED = 3401`, `CONNECTION_CLOSE_FORBIDDEN = 4403`, `CONNECTION_CLOSE_DISPLACED = 4409` (Baton's names), `MAX_CONNECTIONS_PER_MEMBER = 2`, each with Baton's one-line meaning; 4403's JSDoc says nothing sends it yet ([§3](#3-design-decisions-already-taken) item 5). `Notice` and `NoticeFrame` unchanged.

**2.7 Backend procedures** in `api/backend.ts`, in `PublicRpcs` (a merchant has no Better Auth session, so neither can require `CurrentUser`; the gate inside decides):

- `IssueActorTicket({ key: ShopKey, sessionToken: Schema.optional(Schema.String) })` → `{ ticket: Ticket }`, failing `Unauthorized` (no session, or a bad token) or `NotAShopMember` (operator, not a member, or a token for another shop).
- `NotAShopMember`: a `Schema.TaggedError` with no fields. A 503 from the gate is a defect, as every D1 outage is today.

**2.8 Surface test** `src/api/shop-actor.test.ts` (unit): walk `ShopActorRpcs.requests` and assert each procedure carries exactly one of `RequireMerchant`, `RequireMember`, `RequireSystem`, plus `CallerMiddleware`, and that its name starts with its role (**confirm** the field `middlewares` on `Rpc.AnyWithProps`). A procedure without a role, or with the wrong prefix, fails this test.

### Step 3: tickets and the fake Shopify

**3.1 `src/backend/ticket.ts`.** `Tickets` service: `mint(claims)` and `verify(ticket, { shop, now })`, HMAC-SHA256 through `crypto.subtle` (`importKey` once, `sign`, `verify`). Claims encode with `Schema.encodeSync(Schema.fromJsonString(TicketClaims))`, then base64url. `verify` fails `Unauthorized` on a bad signature, a malformed string, a `shop` mismatch or `expiresAt < now`, and returns the claims. The secret is `Config.Redacted("TICKET_SECRET")`; `Tickets.layer` reads it, `Tickets.layerWith(secret)` is for tests. Unit test: round trip; a changed role, a changed signature, a past `expiresAt`, another shop, and a string with no dot all fail.

**3.2 `src/backend/shopify.ts`.** A `Shopify` service with the one method Baton's gate uses, `decodeSessionToken(token)`, verifying a Shopify session token as `@shopify/shopify-api` does: HS256 JWT signed with `SHOPIFY_API_SECRET`; `aud` equal to `SHOPIFY_API_KEY`; `exp` and `nbf` honoured; returns `{ dest, exp }`. The JSDoc names what Shopify's library checks and says this is the sandbox's stand-in until the Shopify slice brings the real one. For test control it also has `signSessionToken({ shop, expiresIn })`, which Shopify's library does not have and which the JSDoc marks as test-only; `expiresIn` defaults to one day so a merchant window lives through an e2e run. Config: `Config.String("SHOPIFY_API_KEY")`, `Config.Redacted("SHOPIFY_API_SECRET")`. Unit test: sign then decode; a wrong `aud`, a wrong secret and an expired token fail.

**3.3 Stack wiring.** In `alchemy.run.ts` and `test/integ/stack.ts`: `TICKET_SECRET` and `SHOPIFY_API_SECRET` from `Alchemy.makeRandom`, `SHOPIFY_API_KEY` the literal `fake-api-key`, each bound to the Backend in the `AuthOrigin` shape (**confirm** a `Redacted<string>` is accepted by `bind`'s `env` and lands as a secret). `test/integ/stack.ts` also binds `E2E_TOKEN` (`"integ"`) so the integ tests can use test control.

### Step 4: the gate

**4.1 `src/backend/shop-access.ts`.** A service `ShopAccess` with `resolve({ key, cookie, sessionToken })`, Baton's `authorizeShopAgentRequest` and `authorizeShopAgentMember` in one Effect:

- A `sessionToken` present: `shopify.decodeSessionToken`; a bad token is `ShopAccessDenied({ status: 401 })`; `new URL(dest).hostname !== key` is 403; the `ShopSession` row must exist, else 404; result `MerchantCaller`. (Baton also resolves the subscription plan here and answers 402; the JSDoc says where it would go.)
- No token: the member branch. The session from the cookie, via a new `sessionFromCookie` in `middleware.ts` that returns `{ me, sessionId, sessionExpiresAt }` (**confirm** the field names on Better Auth's `getSession` result; `currentUserFromCookie` maps over it). No session is 401. `me.role === "admin"` is 403. Then `members.find(key, me.email)`: none is 404; found, `members.teamIdsOf(member.id)`, result `MemberCaller`.
- A D1 failure anywhere is 503, so an outage never reads as "not yours".

`ShopAccessDenied` is a `Schema.TaggedError` with `status: Schema.Literals([401, 403, 404, 503])`; it never crosses a boundary.

**4.2 Backend routes in `worker.ts`.** `ActorPath` is unchanged apart from the new `ShopKey`. The actor branch:

- GET with `upgrade: websocket`: `shopAccess.resolve({ key, cookie: request.headers.cookie, sessionToken: url.searchParams.get("token") })`; a `ShopAccessDenied` answers its status; success forwards a **rebuilt request** with Baton's `FORWARDED_HANDSHAKE_HEADERS` only (copy Baton's list from `worker.ts`), no cookie, no query, nothing starting with `x-actor-`. **confirm** how to build an `HttpServerRequest` from a web `Request` (`HttpServerRequest.fromWeb`).
- Any other method: the SSR read. `resolve` as above (the loader forwards the cookie; a merchant page forwards its token as `authorization: Bearer`, Baton's second form), then a rebuilt request keeping method, body and `content-type`, dropping the cookie, `authorization` and incoming `x-actor-*`, and setting the raw header `x-actor-caller` to the JSON-encoded `Caller`. **confirm** that the body stream survives the rebuild through `actors.fetch`.

Why the SSR path may trust a header at all: on the HTTP path the RPC server merges the raw request's headers with the message's headers, so the actor's middleware sees `x-actor-caller` either way. The only things that reach the HTTP path are the Backend's own stub calls and requests the Backend forwarded, and those messages were authored by the Website's server code during server rendering, never by a browser (the browser's HTTP route into the actor is removed in Step 7). That is the whole trust argument, stated once in `CallerMiddleware`'s JSDoc.

**4.3 `IssueActorTicket` handler** in `handlers.ts`: `shopAccess.resolve` with the RPC headers' cookie and the payload's `sessionToken`; 401 → `Unauthorized`; 403 and 404 → `NotAShopMember`; 503 → die; success → `tickets.mint({ shop: key, caller, expiresAt: now + TICKET_TTL_MILLIS })`.

**4.4 The Backend's stub client**, `src/backend/actor-client.ts`: `systemActor(key)` returns `actors.getByName(key)` with every call wrapped in `RpcClient.withHeaders({ [CALLER_HEADER]: encodedSystemCaller })`. That header lands in the RPC message, which on the HTTP path is merged with the raw request's headers, so the actor reads both forms the same way (5.1). **confirm** `withHeaders` applies to Alchemy's `getByName` client as it does to `e2e/fixtures.ts`'s client.

Green: `vp check`, `vp test`.

### Step 5: the actor

All in `src/backend/shop-actor.ts`. The outer Effect gains `const tickets = yield* Tickets`; the inner Effect reads the actor's own name from `state.id.name` (**confirm** it is set for an object reached through `getByName`; it is a named id) and dies if it is absent, since every actor is reached by name.

**5.1 `CallerMiddleware` implementation.**

```text
on each call, with { client, headers }:
  request = yield* Effect.serviceOption(HttpServerRequest)
  if Some(request):                                   // HTTP path: the stub, or a request the Backend forwarded
    caller = decode headers[CALLER_HEADER]            // RPC headers = raw request headers + message headers
    missing or undecodable -> fail Unauthorized
    provide CurrentCaller = caller
  else:                                               // socket path
    identity = bound.get(client.id)                   // per-activation Map<number, SocketIdentity>
    if none: socket = yield* findSocket(client.id)    // getWebSockets, match attachment clientId
             identity = read shopActor from its attachment
             if none: ticket = headers[TICKET_HEADER]; none -> fail Unauthorized
                      claims = yield* tickets.verify(ticket, { shop: name, now })   // failure -> Unauthorized, socket left open
                      identity = { caller: claims.caller, boundAt: now }
                      write { ...previous, shopActor: identity } into the attachment
                      if member: yield* displace(identity.caller.memberId, except this socket)
             bound.set(client.id, identity)
    if member and identity.caller.sessionExpiresAt <= now:
             bound.delete(client.id); schedule closeSocket(socket, CONNECTION_CLOSE_REVOKED) after the response; fail Unauthorized
    provide CurrentCaller = identity.caller
```

- `findSocket(clientId)`: list `state.getWebSockets()`, decode each attachment with `Attachment = Schema.Struct({ __alchemyRpcWebSocket: Schema.Struct({ clientId: Schema.Int }), shopActor: Schema.optional(SocketIdentity) })`, return the match; write by spreading the raw previous value, not the decoded one, so Alchemy's other fields survive. No match is a defect.
- `bound` is a per-activation cache keyed by `client.id`, rebuilt from attachments after a wake; entries are dropped when we close a socket. Alchemy restores the same ids from attachments after a wake and reuses ids only after a full restart, which is harmless because the map is per activation and the attachment is per socket.
- A bad or missing ticket fails the call and leaves the socket open: the browser's middleware fetches a fresh ticket and retries once, then stops. There is a response channel here, which Baton's `onConnect` did not have; that is why 4403 goes unused.
- "After the response": a close issued inside the middleware races the failure being written. Issue it through `state.waitUntil` on a short `Effect.sleep` (or a forked fiber that awaits the request fiber; **confirm** which is reliable in 0.2), so the client sees `Unauthorized` and then the close. Tests assert the close code, not the order.
- Headers are read only for the ticket, only when the socket has no identity yet. Nothing else on the socket path reads a header.

**5.2 Role middlewares.** `Match` on `caller.role`, each a `Layer.succeed` like `RequireAdminLive`.

**5.3 Handlers.**

- `MemberGetCount`, `MerchantGetCount`, `MemberIncrement`, `MemberActivation`: today's handlers under the new names.
- `MemberWhoAmI`, `MerchantWhoAmI`: return `CurrentCaller`.
- `MerchantResetCount`: `UPDATE count SET value = 0 WHERE id = 1 RETURNING value`, then `notify([COUNT_KEY])`.
- `SystemRevoke({ by, id })`: list sockets, decode attachments, close every match with `CONNECTION_CLOSE_REVOKED` and reason `"membership changed"` (Baton's), drop their `bound` entries, return `{ closed }`. `by: "member"` matches `caller.memberId`; `"session"` matches `caller.sessionId`. Merchant sockets match neither. A close never fails the procedure.

**5.4 Displacement**, Baton's `displaceConnections`: among sockets whose `caller.memberId` matches, excluding the new one, sort by `boundAt` descending and close all past `MAX_CONNECTIONS_PER_MEMBER - 1` with `CONNECTION_CLOSE_DISPLACED`, reason `"signed in elsewhere"`. Merchants are not capped. Best effort, logged, never fails the bind.

**5.5 `closeSocket(socket, code, reason)`**: `socket.close` under `Effect.catchDefect` with a log, used everywhere above. Reasons stay under 123 bytes.

Rename the procedures in `test/browser/shop-actor.ts`, `ShopPage.test.tsx` and `test/integ/shop-actor.test.ts` in the same sitting so `vp test` stays green; the integ `connect` helper fetches a ticket through `IssueActorTicket` over `Test.rpcClientLayer` and sends it on the first call with `RpcClient.withHeaders`.

### Step 6: revocation triggers

**6.1 Better Auth hooks** in `auth.ts`, each through `runPromise`, each catching and logging so Better Auth never sees a throw:

- `session.delete.after (session)`: the user's email from Better Auth's `"user"` table by `session.userId` (**confirm** the hook's row has `userId` and `id`), then `members.listShopsOf(email)`, then `systemActor(shop).SystemRevoke({ by: "session", id: session.id })` for each shop.
- `user.update.after (user)`: for each shop in `listShopsOf(user.email)`, `members.find(shop, user.email)` and `SystemRevoke({ by: "member", id })`. (**confirm** what the hook receives; it fires for every user update, including the sliding session refresh if that touches the user row, so measure how often it runs on the dev stack and record it. If it is noisy, compare `role` and `banned` against a read of the row before the update, via `user.update.before`.)

**6.2 Member removal.** Test control's `RemoveMember` calls `members.remove` and, if a row was removed, `SystemRevoke({ by: "member", id })` on that shop's actor. `AddMember` revokes nothing (a new member has no socket). That is Baton's rule from `Members`'s JSDoc, applied by the only caller S1 has.

**6.3 Test control.** `IssueMerchantSessionToken({ shop: ShopKey, expiresInSeconds: Schema.optional(Schema.Int) })` → `{ token }` through `Shopify.signSessionToken`. `IssueActorTicketAs({ shop: ShopKey, caller: ConnectionCaller })` → `{ ticket }` through `Tickets.mint` with no gate, so a test can bind a socket with any identity it likes, including one whose `sessionExpiresAt` is already past (8.3's expiry row).

Green: `vp check`, `vp test`.

### Step 7: the browser

**7.1 Ticket per connect** in `src/ticket-client.ts`:

- `merchantTokenAtom: Atom<Option<string>>`, set by the merchant route from its `token` search param; `None` on the member page.
- `ticketAtom = BackendClient.query("IssueActorTicket", …)` keyed by `shopKeyAtom` and `merchantTokenAtom` (**confirm** how an `AtomRpc` query's payload can depend on other atoms; `Atom.family` keyed by the payload, read through a derived atom, is the expected shape). The route loader primes it with `loadQuery`, so the first ticket is dehydrated.
- `ticketRef: Ref<Option<Ticket>>`, the ticket the next first call will send. The socket layer's URL is an Effect (`Socket.makeWebSocket(url: Effect<string>)`, which runs on every connect): it takes the primed ticket if its claims (readable without the secret from the first segment, decoded with `TicketClaims`) are not yet expired, otherwise refreshes `ticketAtom` and awaits the result; it writes the ticket into `ticketRef` and returns the URL (`?token=` appended when `merchantTokenAtom` is `Some`). A failure here is how the browser learns why it was cut off: `Unauthorized` runs `goToSignIn` (the full-page load to `/sign-in?redirect=…` that `socket-session.ts` has today) for a member, or sets `merchantExpiredAtom` for a merchant; `NotAShopMember` sets `notAMemberAtom` and re-runs the route loader (`router.invalidate()`, as Baton's member page does on 3401). Both then fail the URL effect with a terminal error the retry policy stops on. A transport failure (the Backend unreachable) fails with a transient error the policy keeps retrying.
- `socket-session.ts` and its test are removed: every reconnect now asks the Backend over HTTP first, which is a stronger version of what the guard approximated.

**7.2 Client middleware** (`RpcMiddleware.layerClient` on a client-side middleware, or `RpcClient`'s per-request headers hook; **confirm** which adds a header per call without a server-side `requiredForClient`): a `Ref<boolean>` `bound`, reset to `false` by `ConnectionHooks.onConnect`. When `bound` is false, set `TICKET_HEADER` from `ticketRef`; after a successful call set `bound` true. On `Unauthorized`: set `bound` false, refresh the ticket (as 7.1 does), retry once. Several first calls in flight all carry the ticket; binding is idempotent.

**7.3 Retry policy and connection state.** Replace `RpcClient.layerProtocolSocket` with `Layer.effect(RpcClient.Protocol, RpcClient.makeProtocolSocket({ retryPolicy }))`. The policy: `Schedule.exponential("250 millis")` capped at a few seconds, with `Schedule.while` on the input: continue unless the error is a `SocketCloseError` with `CONNECTION_CLOSE_FORBIDDEN` or `CONNECTION_CLOSE_DISPLACED`, or the terminal error 7.1 raises. A `Schedule.tapInput` writes the close code into `connectionStateAtom: Atom<"connecting" | "open" | "lost" | "displaced" | "forbidden">`; `onConnect` sets `open`; `onDisconnect` sets `lost` unless a terminal code was just seen. `reconnectAtom` (a counter) is read inside `protocol: (get) => …` so bumping it rebuilds the protocol; the displaced banner's Reconnect bumps it.

**7.4 Routes.** `api.actor.$key.ts`: drop `POST`; on `GET`, refuse an upgrade whose `Origin` is present and differs from the request's own origin with 403 (browsers always send `Origin` on an upgrade; the JSDoc states the rule); the query string is already forwarded. `app.shop.$key.tsx` (members) primes `ticketAtom` and `whoAmIAtom` (`ShopActorClient.query("MemberWhoAmI")`) with the count. New `merchant.$key.tsx`: a merchant page without App Bridge, taking `token` from `validateSearch`, setting `merchantTokenAtom`, priming `ticketAtom`, `MerchantGetCount` and `MerchantWhoAmI`, rendering `ShopPage` in merchant mode; its SSR reads send the token as `authorization: Bearer` through `backendTransport` (a second isomorphic protocol, or the same one taking the token from the registry).

**7.5 Page.** `ShopPage.tsx` takes a `role` prop. Both modes show the count and "Signed in as … (member)" or "Merchant of <shop>"; member mode has Increment; merchant mode has Reset (a member calling it anyway gets `Forbidden`, which integ checks); a status line from `connectionStateAtom` with an Astryx notice component (run `astryx search "banner"` then `astryx component <Name>`): `lost` after a 4-second grace ("Reconnecting…"), `displaced` ("Signed in elsewhere" with a Reconnect `Button`); `notAMemberAtom` replaces the card with "You're not a member of this shop."; `merchantExpiredAtom` with "Your Shopify session expired." Copy follows `RootDocument`'s rules.

Green: `vp check`; browser tests in Step 8.

### Step 8: tests

**8.1 Unit.** `src/api/shop-actor.test.ts` (2.8); `src/backend/ticket.test.ts` and `shopify.test.ts` (Step 3); `src/ticket-client.test.ts`: the retry policy stops on 4403, 4409 and the terminal error, and continues on 3401 and 1006 (`TestClock`); the middleware sends the ticket on the first call after a connect and not on the second (an `RpcTest` client with a handler recording headers); the URL effect uses a fresh primed ticket without a fetch and fetches when the primed one is expired.

**8.2 Browser.** `test/browser/shop-actor.ts` and `ShopPage.test.tsx` use the new names; new cases: merchant mode shows Reset and member mode shows Increment; `connectionStateAtom` `displaced` shows the banner and Reconnect bumps `reconnectAtom`; `notAMemberAtom` shows its copy.

**8.3 Integ** (`test/integ/shop-actor.test.ts`; `signIn` takes the email; `control` calls test control over `Test.rpcClientLayer` with the stack's `E2E_TOKEN`; `connect` takes `{ cookie } | { token }`, fetches a ticket through `IssueActorTicket` (or takes one from `IssueActorTicketAs`), and sends it on the first call):

| Check                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A merchant socket can `MerchantResetCount`; `m1@m.com` gets `Forbidden` on it and on `MerchantGetCount`; a merchant gets `Forbidden` on `MemberIncrement`; all over the socket and over HTTP through the Backend                                            |
| A socket call before any ticket fails `Unauthorized` and the socket stays open; a tampered ticket fails `Unauthorized`; the same socket then binds with a good ticket                                                                                       |
| `x-actor-caller: {"role":"system"}` sent by a socket client in RPC headers is ignored (`MemberWhoAmI` still says member, `SystemRevoke` over the socket fails `Forbidden`)                                                                                  |
| `MemberWhoAmI` is unchanged after a hibernation (`MemberActivation` id changed) with no ticket sent again                                                                                                                                                   |
| Sign-out (Better Auth's `/api/auth/sign-out` with the cookie) closes only that session's sockets with 3401; a second session's socket keeps working                                                                                                         |
| `RemoveMember` closes `m1`'s sockets with 3401; `m2`'s socket keeps working; `IssueActorTicket` for `m1` now fails `NotAShopMember`; `AddMember` back restores it                                                                                           |
| `m1`'s third socket closes the oldest with 4409; the two newest keep working; a merchant opens three and none closes                                                                                                                                        |
| A socket bound with an `IssueActorTicketAs` ticket whose `sessionExpiresAt` is in the past: the next call fails `Unauthorized` and the socket closes 3401                                                                                                   |
| No session 401; operator (`a@a.com`) 403; non-member (`m2` on `other-shop.myshopify.com`) 404; a merchant token for `other-shop` on the sandbox shop 403; a bad token 401: on the upgrade, and as `Unauthorized` / `NotAShopMember` from `IssueActorTicket` |
| The Backend's stub call (`SystemRevoke { by: "member", id: "nobody" }`, driven through `RemoveMember` of a member with no sockets, or a scratch Backend procedure) returns `{ closed: 0 }`                                                                  |

**8.4 e2e** (`auth.setup.ts` unchanged apart from paths; `screens.ts` gains the who-am-I text, Reset, the banner and the not-a-member copy; a `merchant(page, shop)` helper in `fixtures.ts` mints a token through test control and opens `/merchant/<shop>?token=…`):

- The merchant page shows Reset and resets the count; the member page sees the new count through a notice.
- Sign-out in window A makes window B, same session, land on sign-in; the admin's window in another context is untouched.
- `RemoveMember` for a member created by `AddMember` while their page is open: the page shows "You're not a member of this shop."
- A third window for the member shows "Signed in elsewhere" in the oldest; Reconnect there brings it back and displaces the then-oldest.
- The existing two-window increment test still passes; `members.spec.ts` passes with the new columns.

Green: `vp check`, `vp test`, `vp run test:e2e`.

### Step 9: glossary and README

`docs/glossary.md`: **Shop** (a `ShopSession` row, keyed by its myshopify domain; `ShopKey`), **Member** (Baton's sense: a `Member` row of one shop; replaces the invite-list meaning), **Merchant**, **Operator**, **Caller**, **Ticket**, **Bind**, **Gate**, **Stub**, in the research's wording, and under **Actor** that identity lives in the socket's attachment. README: one sentence on how a browser proves who it is to an actor, and that the Shopify pieces are fakes until the Shopify slice.

## 6. Verification checklist

Before declaring the spike done, each of these is observed and its test named in [§10](#10-deviations-and-issues):

1. Step 0's three facts, with their integ file kept.
2. Every integ row in 8.3 and every e2e case in 8.4 passing on a fresh stack.
3. `vp check` clean; `vp test` and `vp run test:e2e` green.
4. A manual run under `vp run dev` with `E2E_TOKEN` in the user's `.env` (so test control can mint a merchant token): sign in as `m1@m.com`, open the shop in two windows, open a third, see the banner in the first; open the merchant page with a minted token, reset the count, see it in the member windows; sign out in one member window, see the other go to sign-in; let a window sit idle past the local hibernation window, click, and see it work with no reconnect; `logs/dev/current` shows the 3401 and 4409 closes and no `Unable to close RPC WebSocket`.
5. The seed data is visible: the admin members page lists the three seed `Member` rows with their shops.
6. No file imports from `alchemy/Cloudflare/Workers/RpcWebSocket` or patches `node_modules`; no table exists that Baton's migration does not have, other than Better Auth's; `socket-session.ts` is gone.

## 7. Out of scope

Team-scoped reads and run-level authorization; the real Shopify app (OAuth, token exchange, App Bridge, `@shopify/shopify-api`); subscription plans and 402; Baton's session cap and revoke-all; an admin UI for shop membership beyond the list (test control adds and removes); a rebind deadline; upstream issues to Alchemy (drafted separately if Step 0.2 needs the `end(clientId)` export).

## 8. File plan

| File                                                          | Change                                                                                                              |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `migrations/0002_baton_schema.sql`                            | new: drop `member`; Baton's `ShopSession`, `Member`, `Team`, `TeamMember` verbatim                                  |
| `seed/{dev,test,staging}.sql`                                 | shops with fake tokens, members, a team, the operator's user row                                                    |
| `alchemy.run.ts`, `test/integ/stack.ts`                       | `TICKET_SECRET`, `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`; `E2E_TOKEN` on the integ stack                            |
| `src/api/backend.ts`                                          | `Member` as Baton's row, `IssueActorTicket`, `NotAShopMember`                                                       |
| `src/api/shop-actor.ts`                                       | `ShopKey` as a myshopify domain, caller, ticket, identity, middleware, role groups, close codes, renamed procedures |
| `src/api/shop-actor.test.ts`                                  | new: surface test                                                                                                   |
| `src/api/test-control.ts`                                     | `AddMember`, `RemoveMember`, `IssueMerchantSessionToken`, `IssueActorTicketAs`                                      |
| `src/backend/members.ts`                                      | over Baton's `Member`; `layerTest` with rows                                                                        |
| `src/backend/auth.ts`, `auth.test.ts`                         | Baton's invite-only rule, two database hooks; tests over `Member` rows                                              |
| `src/backend/ticket.ts`, `.test.ts`                           | new: mint and verify                                                                                                |
| `src/backend/shopify.ts`, `.test.ts`                          | new: session token verify and test-only sign                                                                        |
| `src/backend/shop-access.ts`                                  | new: the gate, both branches                                                                                        |
| `src/backend/actor-client.ts`                                 | new: `systemActor(key)`                                                                                             |
| `src/backend/middleware.ts`                                   | `sessionFromCookie`                                                                                                 |
| `src/backend/worker.ts`                                       | rebuilt forwards for upgrade and SSR, new layers                                                                    |
| `src/backend/handlers.ts`                                     | `IssueActorTicket`, `ListMembers` over `Member`                                                                     |
| `src/backend/shop-actor.ts`                                   | caller middleware, bind, roles, revoke, displace, expiry, new handlers                                              |
| `src/backend/test-control.ts`                                 | reset of `Member` and `@e2e.test` user rows, new handlers                                                           |
| `src/ticket-client.ts`, `.test.ts`                            | new: ticket per connect, client middleware, retry policy, connection state                                          |
| `src/socket-session.ts`, `.test.ts`                           | removed                                                                                                             |
| `src/shop-actor-client.ts`                                    | URL effect, `makeProtocolSocket`, `?token=`, new atoms, renamed procedures                                          |
| `src/components/ShopPage.tsx`, `.test.tsx`                    | role modes, who-am-I, Reset, banner, not-a-member, merchant-expired                                                 |
| `src/components/MemberShell.tsx`                              | the new `SANDBOX_SHOP` link                                                                                         |
| `src/routes/app.shop.$key.tsx`                                | prime ticket and who-am-I                                                                                           |
| `src/routes/merchant.$key.tsx`                                | new: the merchant page                                                                                              |
| `src/routes/admin.members.tsx`                                | Shop, Email, Added                                                                                                  |
| `src/routes/api.actor.$key.ts`                                | drop `POST`, `Origin` check                                                                                         |
| `test/integ/socket-facts.test.ts`                             | new: Step 0, kept                                                                                                   |
| `test/integ/shop-actor.test.ts`                               | 8.3                                                                                                                 |
| `test/browser/shop-actor.ts`                                  | renamed procedures                                                                                                  |
| `e2e/{shop.spec,members.spec,screens,fixtures,auth.setup}.ts` | 8.4                                                                                                                 |
| `docs/glossary.md`, `README.md`                               | Step 9                                                                                                              |

## 9. Order of work and stopping points

Step 0 first, alone; stop if any check fails. Then 1 (large: the data model, with e2e green at its end), 2, 3, 4. Step 5 with the test renames. Then 6, 7, the rest of 8, and 9. Natural pauses for review: after Step 1 (the data model is visible on the admin page and through `vp exec alchemy`), after Step 4 (the gate is observable with the existing integ tests), and after Step 5 (roles are observable over the socket).

## 10. Deviations and issues

For the implementer. Append as you go; keep each entry short and dated. A deviation is anything built differently from the step that specified it, including any place Baton's name or rule was not followed; an issue is anything observed that the plan did not predict (a failing assumption, an API that differs from the sketch, a flaky test, a limit hit). Do not rewrite the steps above; this section is the record. Every **confirm** in the steps gets an entry under "API confirmations", even when the plan was right.

### Step 0 results

| Check                                                | Result | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.1 our key in the attachment survives hibernation   | pass   | 2026-10-12. `Probe` wrote `shopActor` beside `__alchemyRpcWebSocket` (spreading the raw attachment); the second call read it back, and after the activation id changed (hibernation) the same stamp came back. Alchemy's `persist` spreads the previous attachment, so its own writes keep our key. Test: `socket-facts.test.ts` "0.1".                                                                                                                                         |
| 0.2 closing from our code leaves the transport clean | pass   | 2026-10-12. `CloseMe` returned, then closed through `state.waitUntil(Effect.sleep("50 millis") ...)` with 3401. The client saw `SocketError` whose reason is `SocketCloseError` code 3401 (read as the retry policy's input, no Vite in front); `b` kept working; `a` reconnected and worked; a third socket's `Activation` equalled `b`'s, so no `state.abort`. No `Unable to close RPC WebSocket` in the harness output or `.alchemy/log/test_mw/Backend/*.log`. Test: "0.2". |
| 0.3 `HttpServerRequest` marks the stub path          | pass   | 2026-10-12. `Path` was `false` over the socket, `true` over HTTP forwarded by the Backend's `/api/actor/:key` with a cookie, and `true` through the Backend's stub (`ProbeActor`). Test: "0.3". The scratch procedures were then folded into the real ones; see Deviations.                                                                                                                                                                                                     |

### Deviations

- 2026-10-12, Step 0: after the gate passed, the scratch procedures (`Probe`, `CloseMe`, `Path`, `ProbeActor`) were removed and `test/integ/socket-facts.test.ts` was rewritten over the real procedures: 0.1 binds with a ticket and reads `MemberWhoAmI` after a hibernation with no ticket resent; 0.2 has the actor close a socket bound with an expired session (3401 after the `Unauthorized` is written) and checks the other socket, the reconnect and an unchanged `MemberActivation`; 0.3 checks that a `x-actor-caller` header on the socket names no one, that the Backend-forwarded HTTP read gets the gate's caller, and that the stub's `SystemRevoke` (via `RemoveMember`) is accepted. It runs on `other-shop.myshopify.com`, so no other file shares its actor.
- 2026-10-12, Step 1.2: the seeds do not insert the operator's `"user"` row. On a fresh stage `importFiles` runs inside the `AuthDb` resource, before `BetterAuthMigrate` creates Better Auth's tables, and the deploy fails with `no such table: user` (seen on a scratch integ stage `fresh_s1a`). As the plan's fallback says, the row moved to test data: `TestData.reset` (test control's `ResetData`) inserts `a@a.com` with `role = 'admin'` if missing, so every test stage gets it from its first reset. Dev and staging need a one-off manual insert on a fresh database (README says how); the existing dev database already has `a@a.com` as admin (from the old invite-role copy), and so does staging's operator if it has signed in before. The seeds' comments and `AuthDb`'s JSDoc say why.
- 2026-10-12, Step 1.2: `staging.sql`'s operator would be `support@mw10013.com`, the staging admin the old seed had, not `a@a.com` (a fake address cannot receive a mailed link). With the row out of the seed (above), staging's seed is the first shop only.
- 2026-10-12, Step 1.6: `ShopKey` and `SANDBOX_SHOP` live in a new leaf module `src/api/shop.ts`, not `src/api/shop-actor.ts`. `api/backend.ts` needs `ShopKey` (`Member.shop`, `IssueActorTicket`) and `api/shop-actor.ts` imports `Email`, `Unauthorized` and `Forbidden` from `api/backend.ts`; keeping the key in `shop-actor.ts` would make the two modules an import cycle that fails at evaluation. For the same reason the `Ticket` brand is in `api/backend.ts` (beside `IssueActorTicket`), not `api/shop-actor.ts`; `TicketClaims` and the rest of 2.2 are in `api/shop-actor.ts`.
- 2026-10-12, Step 1.4/1.5: who may _request_ a link is "a Better Auth user exists for the email, or a `Member` row does" (`Auth.maySignIn`), used by both `RequestMagicLink` and test control's `IssueMagicLink`. The plan named this only for `IssueMagicLink`; `RequestMagicLink` needs it too, or the operator (no `Member` row) never gets a link. `Auth.userExists` goes through Better Auth's `internalAdapter.findUserByEmail`, so the same check works over D1 and the in-memory test database.
- 2026-10-12, Step 1.3/1.5: `Members.add` detects a duplicate with `INSERT ... ON CONFLICT (shop, email) DO NOTHING RETURNING id` (no row back is `MemberExists`) rather than by reading the D1 error text. `MemberExists` is in `api/backend.ts` beside `Member`. `RemoveMember` answers `{ removed: boolean, closed: number }` (the plan gave no success shape; `closed` is the actor's `SystemRevoke` answer, which makes the stub path observable in integ).
- 2026-10-12, Step 1.5: `e2e/members.spec.ts` asserts the three seed rows by filtering rows on shop and email rather than an exact ARIA snapshot, because the specs run in parallel and another spec's `AddMember` rows can be in the table.
- 2026-10-12, Steps 2-5: the tree was not type-check green between Step 2 and the end of Step 5 (renaming the procedures in Step 2 breaks the actor and its clients until Step 5 renames them). `vp check` and `vp test` were green at the end of Step 5 and after every later step.
- 2026-10-12, Step 2.4/2.6: each constant and middleware got a JSDoc with Baton's one-line meaning. `TICKET_TTL_MILLIS` is documented on `TicketClaims` rather than on itself.
- 2026-10-12, Step 3.1/3.2: the wire forms are parsed with `Schema.TemplateLiteralParser` (`<base64url segment>.<signature>` for a ticket, `header.payload.signature` for a JWT) with `Schema.StringFromBase64Url` / `Schema.Uint8ArrayFromBase64Url` parts, so nothing is split by hand. `Shopify.decodeSessionToken` fails with its own `InvalidSessionToken` (a `Schema.TaggedError`), which the gate maps to 401. `SHOPIFY_API_KEY` (`"fake-api-key"`) is exported from `src/backend/shopify.ts` for both stacks.
- 2026-10-12, Step 3.3: `Tickets.layer` and `Shopify.layer` read their config with `Config.option` and die at runtime if it is missing, the same pattern as `AUTH_ORIGIN`: a required `Config` read in the Worker's init would fail while the stack is planned. `test/integ/stack.ts` returns `e2eToken` with `backendUrl`.
- 2026-10-12, Step 4.1: the merchant branch checks the `ShopSession` row with its own query in `ShopAccess` (no new service). The D1-to-503 mapping is a `catchDefect` around `resolve`, since every storage call is `Effect.orDie`.
- 2026-10-12, Step 4.2: `FORWARDED_HANDSHAKE_HEADERS` is Baton's list without `x-partykit-namespace` (PartyKit-specific, nothing here uses it). The SSR forward buffers the body (`request.arrayBuffer`) instead of streaming it, so the "body survives the rebuild" question did not arise. The merchant's `authorization: Bearer` is decoded with `Schema.TemplateLiteralParser(["Bearer ", NonEmptyString])`.
- 2026-10-12, Step 4.4: `src/backend/actor-client.ts` exposes a `SystemActors` service (`call(key, f)` and `revoke(key, by, id)`) rather than a bare `systemActor(key)`; `revoke` logs and swallows failures (for the Better Auth hooks), while test control's `RemoveMember` uses `call` and dies on a failed revoke so a test sees it. `SystemActors.layerTest` records revokes for unit tests.
- 2026-10-12, Step 5.1: socket identities are read with a `readyState === OPEN` filter, so a socket the actor has just closed no longer counts toward displacement or revocation. A close after the response is `state.waitUntil(Effect.sleep("50 millis") ...)`, the form proved in 0.2. The expiry close uses Baton's 3401 with the reason `"session expired"` (Baton has no such close).
- 2026-10-12, Step 5 / 8.3: the integ `connect` helper takes a credential and returns a `bind(ticket, call)` that sends the ticket on one call, rather than binding inside `connect`; the helpers are shared from a new `test/integ/actor-clients.ts` instead of being copied into each file. Every socket error the helper's retry policy sees goes to a `closes` queue, which is how the tests read close codes.
- 2026-10-12, Step 6.1: `user.update.after` revokes only when the updated user is banned or an operator (`banned === true || role === "admin"`), instead of comparing against a read before the update. Better Auth fires the hook on every user update, including a member's first magic-link verify (it sets `emailVerified`), and only those two states take a shop away from a member. The usage was not measured on the dev stack (see Issues). `session.delete.after` reads the user through the hook's endpoint context (`endpoint.context.internalAdapter.findUserById`), not the `auth` instance, which is not in scope while Better Auth is being built.
- 2026-10-12, Step 7.1: the per-connect ticket step runs in the socket's `reader` (wrapped in `layerSocketWithNotices`), not in the URL effect: `Socket.makeWebSocket`'s URL is `Effect<string>` with no error channel, so it cannot fail with the terminal error the retry policy must see. The reader is acquired once per connect, before the socket opens, so it is the same moment. A refusal fails the reader with a `SocketOpenError` whose cause is a `TicketRefused` (a `Schema.TaggedError`); `isTerminal` stops the retries on it. The merchant's token is put on the socket URL when the protocol is built (it rebuilds when `merchantTokenAtom` changes).
- 2026-10-12, Step 7.1: the primed ticket is spent on the first connect only; every later connect asks the Backend, even if the primed ticket is still fresh, because a reconnect after a revoke must learn the new answer. `NotAShopMember` sets `notAMemberAtom` and the page replaces the card at once; `router.invalidate()` is not called (the ticket module has no router, and nothing else on the page needs the loader again). The page's loaders call `loadTicket` first and skip the actor reads when it fails.
- 2026-10-12, Step 7.1: `ticketAtom`, `ticketQuery` and `loadTicket` live in `src/shop-actor-client.ts`, not `src/ticket-client.ts`, because they need `BackendClient`, whose module chain imports `cloudflare:workers` and cannot load in the Node unit project. `src/ticket-client.ts` holds the state atoms, the ticket step (`makeTicketStep`, given the primed ticket and the fetch), the client middleware, the retry policy and `isTerminal`, and is unit-tested.
- 2026-10-12, Step 7.1: `shopKeyAtom` moved to `src/ticket-client.ts`. It, `merchantTokenAtom`, `notAMemberAtom` and `merchantExpiredAtom` are `Atom.serializable` and `keepAlive`: the loader runs on the server for the first page only, so without serialization the browser's protocol was built with no merchant token (found by the e2e merchant case). `connectionStateAtom` and `reconnectAtom` are `keepAlive`.
- 2026-10-12, Step 7.2: the client middleware is `RpcMiddleware.layerClient(CallerMiddleware, ...)`, provided through `AtomRpc.Service`'s `makeEffect` (browser only, via `createIsomorphicFn`). `bound` and the current ticket are a module-level object, one per browser like the socket and `notices`. `bound` is reset in `onConnect`.
- 2026-10-12, Step 7.3: `Schedule.tapInput` does not exist in Effect 4.0.1; the policy uses `Schedule.tap(({ input }) => ...)` and `Schedule.while(({ input }) => ...)` (exported as `while`). The cap is `Schedule.min([exponential("250 millis"), spaced("4 seconds")])`, the shape of Effect's default policy. "connecting" is set when the protocol layer is built (`Layer.tap`), not when the protocol function runs. The 4-second grace is `lostAtom`, an atom with a timer, not component state.
- 2026-10-12, Step 7.5: the who-am-I line, Reset/Increment and the activation line come from a per-role table of atoms in `ShopPage`, so a merchant page never calls a `Member…` procedure (the activation line is member-only). The refusal copy replaces the card as a `Text` with `role="alert"`; the banners are Astryx `Banner` (`warning` for displaced with a Reconnect `Button`, `info` for "Reconnecting…").
- 2026-10-12, Step 8.3: the sign-out row sends `Origin` (read off a magic link) with the POST, because Better Auth refuses a cookie POST without it in workerd. The `RemoveMember` row uses an `@e2e.test` member added by `AddMember` instead of `m1@m.com`, since `AddMember` only takes `@e2e.test` addresses and could not restore `m1`. The hibernation row is covered by `socket-facts.test.ts` "0.1" rather than repeated in `shop-actor.test.ts`. The integ gate row calls `ResetData` first so the operator row exists.
- 2026-10-12, Step 8.4: `shop.spec.ts` runs serially (every case reads or writes the one count), and the sign-out, removal and displacement cases each sign in their own `@e2e.test` member in a fresh context (`ownMember` in `fixtures.ts`), so they never sign out, remove or displace the shared `m1` session the parallel specs use. A window is bound before it is revoked or displaced by making a write in it (a page's first data comes with the page, so an idle window's socket is open but unbound and is neither counted nor revoked).

### Issues

- 2026-10-12: the user's dev server (`vp run dev`, main checkout) was running and live-reloaded the edits throughout, so the dev database took migration `0002` during Step 1 and the dev stage has the new bindings (`TicketSecret`, `ShopifyApiSecret`). It also regenerated `src/routeTree.gen.ts` for the new `/merchant/$key` route.
- 2026-10-12: two scratch integ stages, `fresh_s1a` (failed seed, used to prove the ordering above) and `fresh_s1b` (the passing re-run), remain in `.alchemy/` local state; they are local only.
- 2026-10-12: an unbound socket is invisible to revocation and displacement. A window that has only server-rendered data and has made no call since its socket opened is not bound, so `SystemRevoke` and displacement do not close it; its first call then binds with the ticket fetched at connect (which, after a removal, the Backend refuses). The onConnect synthetic notice usually makes that first call (a count refetch), but the notice can be dropped before `noticesAtom` subscribes on the first connect. **Resolved** by review recommendation 1 (see Review changes).
- 2026-10-12: `user.update.after` frequency was not measured on the dev stack (that needs the manual run). Better Auth's magic-link verify updates the user only when `emailVerified` is false (read from `better-auth/dist/plugins/magic-link`); the sliding session refresh updates the session, not the user.
- 2026-10-12: the 403 for an `Origin` that is not the site's own is not covered by a test (Playwright's browser always sends the right origin, and the integ tests go straight at the Backend). The e2e run shows same-origin upgrades pass the check under `alchemy dev`, where the Website sits behind Alchemy's proxy. **Resolved** by review recommendation 6 (see Review changes).

### API confirmations

- 2026-10-12, 0.1: the handler's second argument carries `client: Rpc.ServerClient` (`{ client, requestId, headers, rpc }`); `client.id` is the number Alchemy stores as `__alchemyRpcWebSocket.clientId`. The middleware receives the same `{ client, headers, rpc, payload, requestId }`.
- 2026-10-12, 0.2: the close code arrives unchanged (3401) with no Vite in front, observed as the `SocketError` input to the client's retry policy (`reason._tag === "SocketCloseError"`, `code === 3401`); no request was in flight, so no `RpcClientError` was produced for a call. A close via `state.waitUntil(Effect.sleep("50 millis") ...)` after the handler returned was reliable (the failure or response arrived first).
- 2026-10-12, 1.1: `alchemy dev` applied `0002_baton_schema.sql` (`DROP TABLE member`) on the existing dev and e2e databases (`__alchemy_migrations` lists it), and `importFiles` re-ran the changed seed after it (the `Member`, `ShopSession`, `TeamMember` rows are there).
- 2026-10-12, 1.2: Better Auth's `user` table columns, read from the local D1 file with `sqlite3` (`vp exec alchemy` has no SQL command): `id, name, email, emailVerified, image, createdAt, updatedAt, role, banned, banReason, banExpires`; dates are ISO text, booleans 0/1. `importFiles` does **not** run after the integration's tables exist on a fresh stage (see Deviations).
- 2026-10-12, 2.5: `RpcGroup.merge` keeps each group's middleware per procedure; `src/api/shop-actor.test.ts` walks `ShopActorRpcs.requests` and finds exactly `CallerMiddleware` plus the role middleware on each.
- 2026-10-12, 2.8: the field is `middlewares: ReadonlySet<…>` on `Rpc.AnyWithProps` (it needed widening to `ReadonlySet<unknown>` for `has` on a middleware class).
- 2026-10-12, 3.3: a `Redacted<string>` from `Alchemy.makeRandom` is accepted by `bind`'s `env` (Worker `env` takes `Redacted<string>` and Outputs resolving to one; Alchemy's docs say `Redacted` deploys as `secret_text`). Locally the Worker read both secrets (tickets verified, tokens decoded in integ and e2e); the secret-vs-plain classification on Cloudflare was not observed (no deploy).
- 2026-10-12, 4.1: Better Auth's `getSession` result is `{ user, session }` with `session.id` and `session.expiresAt` (a `Date`); `sessionFromCookie` returns `expiresAt.getTime()`.
- 2026-10-12, 4.2: `HttpServerRequest.fromWeb(new Request(...))` builds the forwarded request; `actors.fetch(key, request)` forwards it for both the upgrade and the SSR read (integ: sockets bind; `httpActor` reads over HTTP with the gate's caller).
- 2026-10-12, 4.4: `RpcClient.withHeaders` applies to Alchemy's `getByName` client (it sets the request headers the client reads at send time); the actor saw `{"role":"system"}` on `SystemRevoke` (integ: `RemoveMember` answers `closed: 1` and the socket closes 3401).
- 2026-10-12, 5: `state.id.name` is set for an actor reached through `getByName` and through `actors.fetch(key, …)`; the actor decodes it as `ShopKey` and dies if it does not.
- 2026-10-12, 6.1: `databaseHooks.session.delete.after(session, endpoint)` receives the deleted row (Better Auth's `deleteWithHooks` reads it before deleting) with `id` and `userId`, once per session also for bulk deletes (`deleteManyWithHooks`); unit test "sign-out ends the session and revokes its sockets" and integ "sign-out closes only that session's sockets". `user.update.after(user)` receives the whole updated user row.
- 2026-10-12, 7.1: an `AtomRpc` query keyed by a payload that depends on other atoms works as a plain derived atom over `BackendClient.query(tag, payload)`: `query` is itself an `Atom.family` keyed structurally by `{ tag, payload, … }`, so `Atom.make((get) => get(ticketQuery(get(shopKeyAtom), get(merchantTokenAtom))))` returns the same query atom for the same payload.
- 2026-10-12, 7.2: client middleware applies without `requiredForClient`: `RpcClient` looks up `${tag.key}/Client` in its context for every middleware on a procedure, so a `RpcMiddleware.layerClient(CallerMiddleware, …)` in the client's context is used (unit test "sends the ticket on the first call after a connect and not on the second").

### Verification checklist (§6)

- 1, Step 0: `test/integ/socket-facts.test.ts` "0.1", "0.2", "0.3" (kept, over the real procedures).
- 2, 8.3 rows, all in `test/integ/shop-actor.test.ts` unless named: roles over socket and HTTP — "roles: a merchant resets and a member may not; …"; no ticket / tampered ticket, socket stays open, then binds — "binding: …"; `x-actor-caller` on the socket ignored — `socket-facts.test.ts` "0.3"; identity after hibernation with no ticket — `socket-facts.test.ts` "0.1"; sign-out closes only that session — "sign-out closes only that session's sockets with 3401"; `RemoveMember` 3401, other member unaffected, `NotAShopMember`, `AddMember` restores — "RemoveMember closes the member's sockets …"; displacement 4409 and merchants uncapped — "a member's third socket displaces the oldest …"; expired session — "a socket whose session has expired …"; the gate's 401/403/404 on the upgrade and from `IssueActorTicket` — "the gate: …"; the stub call — `RemoveMember` answers `closed: 1` (row above) and `closed: 0` (`socket-facts.test.ts` "0.3"). 8.4 cases, all in `e2e/shop.spec.ts`: "the merchant resets the count and a member sees it"; "sign-out in one window sends the other to sign-in; an admin is untouched"; "a member removed while the page is open is told so"; "a third window displaces the oldest, and Reconnect there takes it back"; "an increment in one window updates the count in another"; `e2e/members.spec.ts` "the admin sees the seed members with their shops". Run on the existing (reused) integ and e2e stacks, not freshly created ones; a fresh test stage was only deployed for the seed-ordering check.
- 3: `vp check` clean; `vp test` 13 files, 69 passed, 1 todo; `vp run test:e2e` 14 passed (2026-10-12, final tree).
- 4: not done by the implementer (the reviewer runs it).
- 5: the admin members page lists the three seed `Member` rows with their shops — `e2e/members.spec.ts` "the admin sees the seed members with their shops".
- 6: no file imports `alchemy/Cloudflare/Workers/RpcWebSocket` or patches `node_modules`; the only tables beyond Better Auth's are Baton's four (`ShopSession`, `Member`, `Team`, `TeamMember`); `src/socket-session.ts` and its test are deleted.

### Review changes (after implementation)

- 2026-10-12, review (no code changed). Re-ran `vp check` (clean), `vp test` (69 passed, 1 todo) and `vp run test:e2e` (14 passed) on the full tree. §6 item 4 run against `vp run dev` with a Playwright script as `m1@m.com`: two windows increment and see each other; a third window shows "Signed in elsewhere" in the first; a window idle 30 s increments with no reconnect (WebSocket constructions unchanged, no "Reconnecting…" banner); Reconnect in the displaced window works and displaces the then-oldest; sign-out in one window sends the other open window to `/sign-in?redirect=…`. `logs/dev/current` shows two `ShopActor.displace` lines and `SystemRevoke by=session closed=2` (plus `closed=0` on `other-shop`), and no `Unable to close RPC WebSocket`. Not run: the merchant page on dev, because the user's `.env` has no `E2E_TOKEN` (covered by e2e "the merchant resets the count and a member sees it"). The activation line did not change across the idle window; `activationAtom` is not refetched on a notice, so it says nothing about hibernation (proved by `socket-facts.test.ts` "0.1").

- 2026-10-12, review recommendation 1 (bind at connect). The browser's `onConnect` is now `bindOnConnect` (`src/ticket-client.ts`): it resets `bound` and forks the role's who-am-I (`MemberWhoAmI` or `MerchantWhoAmI`) through the browser's client, so the call carries the connect's ticket and the socket is bound within one round trip of opening. It is forked because `makeProtocolSocket` awaits `onConnect` before it starts reading the socket, so awaiting the reply inside the hook would never end. The client reaches the hook through a `Deferred` that `makeTicketStep` renews on every protocol build and `makeClient` completes (`setClient`), because the protocol layer is built before the client and the first connect can race the client's construction. Tests: unit "binds on connect with the role's who-am-I, carrying the ticket" in `src/ticket-client.test.ts`; in `e2e/shop.spec.ts` the "write first to bind" helper is gone, and the sign-out, removal and displacement cases now revoke or displace windows that have made no call of their own, waiting only for the socket's first successful answer (`nextBoundSocket` in `e2e/fixtures.ts`, which watches the page's actor WebSocket frames). **Deviation:** the integ row the recommendation proposed ("a socket that has made no call is still closed by `SystemRevoke`") was not added. The integ `connect` helper is a bare protocol client, not the browser's, so in integ a socket that made no call is unbound by construction; the behaviour lives in the browser client, and the unit test plus the e2e cases cover it.
- 2026-10-12, review recommendation 6 (foreign `Origin`). New `e2e/actor-upgrade.spec.ts`: with the member's cookie, an upgrade to `/api/actor/<shop>` with `Origin: https://evil.example` does not open and the same upgrade with the site's own origin opens (101). Through the Website under `alchemy dev`, via `node:http` as integ's `upgradeStatus` does. **Deviation:** the test asserts opens / does not open, not the 403. The dev server answers a refused upgrade by dropping the connection (curl: "empty reply from server"), so the status never reaches the client; the same holds for the gate's 401 on a cookie-less upgrade. The two handshakes differ only in `Origin`, so the pair still pins the check: with the check disabled the test fails (tried, then restored).
- 2026-10-12, verification after 1 and 6: `vp check` clean; `vp test` 13 files, 70 passed, 1 todo (the first run after the edits had 3 failing files; its output was not kept, and three later runs were green, so it is recorded as an unexplained one-off, most likely the integ stack redeploying on the changed sources); `vp run test:e2e` 15 passed.

### Review recommendations (2026-10-12, for the user's decision)

Ordered by weight. Each names the §10 entry it answers. None is applied; the code is as Opus left it.

1. **Done 2026-10-12** (see Review changes). **Bind at connect, not on the first data call** (Issues, "Unbound sockets"). A window whose data came with the page and that has made no call since its socket opened has no identity: `SystemRevoke` and displacement skip it, and it does not count toward `MAX_CONNECTIONS_PER_MEMBER`. Today the first call is the synthetic notice's refetch, which can be dropped on the first connect. Recommend: the browser's `ConnectionHooks.onConnect` makes the binding call itself (`MemberWhoAmI` or `MerchantWhoAmI` by role) before publishing the notice, so every open socket is bound within one round trip. Then drop the `bind` helper in `e2e/shop.spec.ts` ("write first to bind") and add an integ row: a socket that has made no call is still closed by `SystemRevoke`. Recommend doing this before the spike is called done.

2. **Operator row** (Deviations, "Step 1.2, operator row"). Accept the fallback as built: `ResetData` inserts it on test stages, dev and staging need a one-off insert. Staging's insert must happen before the next fresh deploy, or `a@a.com` cannot sign in there (no `Member` row, no user row). If it should be automatic, add an Alchemy resource that runs after `BetterAuthMigrate` and inserts the row; a follow-up, not part of S1.

3. **`user.update.after` heuristic** (Deviations, "Step 6.1"; Issues, "frequency"). Accept: revoke only when `banned` or `role === "admin"`. Those are the only two states that take a shop away from a member, and a first sign-in's `emailVerified` update is correctly ignored. Drop the measurement the plan asked for.

4. **Ticket step in the socket reader** (Deviations, "Step 7.1, where the ticket is fetched"). Accept. `Socket.makeWebSocket`'s URL effect has no error channel, so it could not raise the terminal error the retry policy stops on. The reader is acquired once per connect, so the moment is the same. Also accept: the primed ticket spent on the first connect only, and `notAMemberAtom` set directly instead of `router.invalidate()`.

5. **Module layout** (Deviations, "Step 1.6" and "Step 7.1, module split"). Accept. `src/api/shop.ts` for `ShopKey` and the `Ticket` brand in `api/backend.ts` avoid an import cycle; `ticketAtom` in `shop-actor-client.ts` because `BackendClient`'s module chain imports `cloudflare:workers` and cannot load in the Node unit project.

6. **Done 2026-10-12** (see Review changes). **Untested: foreign `Origin` 403** (Issues, "Origin check"). Add one row: an upgrade with `Origin: https://evil.example` against the Website route answers 403, and one with the site's own origin passes. Through the Website, so e2e (`request.fetch` with an `upgrade` header) or a Node `http.get` as `upgradeStatus` in `test/integ/actor-clients.ts` does. Cheap; do it with item 1.

7. **Secrets as secrets** (API confirmations, "3.3"). Whether Cloudflare stores `TICKET_SECRET` and `SHOPIFY_API_SECRET` as secret rather than plain-text bindings is confirmed on the first staging deploy; check the Worker's settings in the dashboard then.

8. **Scratch stages** (Issues, "Leftover scratch stages"). `fresh_s1a` and `fresh_s1b` under `.alchemy/state/Alchemy-sandbox1-test/` and `.alchemy/log/`. Local only; delete them.

9. **Minor, accept as built:** `RemoveMember` answers `{ removed, closed }` (the plan gave no shape; `closed` makes the stub path observable); `staging.sql` seeds the sandbox shop only; the tree was not type-check green between Steps 2 and 5, unavoidable with the plan's step order; the log lines name the event (`ShopActor.displace`, `SystemRevoke`) rather than the close code, which is enough.

Two observations the implementer did not record:

- **Session expiry on a socket is a snapshot.** `sessionExpiresAt` is the session's expiry at mint. Better Auth's sliding refresh extends the session but not the bound identity, so a socket that outlives the original expiry gets a 3401, fetches a fresh ticket and reconnects. This is the plan's design (§3 item 4); noted so the 3401 in a long-lived window is not read as a bug.
- **Inline magic-link delivery logs the full link, token included,** to `logs/dev/current`. Predates this work; dev only.

Suggested order tomorrow: 1, 6, then decide on commit; 2 before any staging deploy; 8 whenever.

### Closing out the remaining recommendations (2026-10-12)

Decided by the user in Plannotator on 2026-10-12. Every recommendation is closed.

- **1, bind at connect:** done (Review changes).
- **2, operator row:** closed for S1. How the row reaches staging is carried into the [staging research](./staging-research.md) (§4.1), a later follow-up.
- **3, `user.update.after` heuristic:** closed, built as is. The plan's Step 6.1 asked to measure how often the hook fires on dev, to decide whether a cheaper rule was needed. The rule built (revoke only when the updated user is `banned` or `role === "admin"`) makes the frequency irrelevant: an ordinary update, including a first sign-in's `emailVerified`, revokes nothing, and a repeat update of a banned or admin user costs one `SystemRevoke` per shop and closes nothing new. So the measurement is dropped, not deferred.
- **4, ticket step in the socket reader:** accepted.
- **5, module layout:** accepted.
- **6, foreign `Origin` test:** done (Review changes).
- **7, secrets as secrets:** closed for S1. The check belongs to the first staging deploy and is in the staging research (§4.4).
- **8, scratch stages:** moved to the Trash on 2026-10-12: `.alchemy/state/Alchemy-sandbox1-test/fresh_s1a` and `fresh_s1b`, `.alchemy/log/fresh_s1b`, the `fresh_s1b` ShopActor directory under `.alchemy/local/`, and the two local D1 files those stages created (matched by creation time and contents: one with Baton's tables but no Better Auth tables, the failed `fresh_s1a`; one created with `fresh_s1b`). Another local D1 file from before S1 (it still has the old `member` table) belongs to no current stage and was left alone.
- **9, minor items:** accepted.
- **Observations:** session expiry as a snapshot is by design; the magic link in dev logs stays (dev only).
- **Staging:** everything S1 left for a deployed stage (deploying, seeding, the operator row, members and merchants on staging, secrets, edge behaviour, mail) is in the [staging research](./staging-research.md), with its own questions.
- **Commit:** the S1 work is committed on `main`.
