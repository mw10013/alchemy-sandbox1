# Research: Better Auth vs Yielded Auth for the Backend

Date: 2026-10-10  
Status: round 1 decided ([§10](#10-decisions-round-1-2026-10-10)). Next: spike (§9).  
Versions: Alchemy `2.0.0-beta.81`, Effect `4.0.1`, `better-auth` `1.7.7`, `@yielded/auth` `0.1.0-beta.32`, `@tanstack/react-start` `1.168.60`.  
Vocabulary: [glossary](./glossary.md). Background: [IPC research](./start-to-effect-worker-ipc-research.md) (D8, D14, §8), [loaded-data research](./loaded-data-path-and-direct-backend-research.md).

Sources: `refs/better-auth`, `refs/yielded-auth`, `refs/alchemy` (including `packages/better-auth` and `examples/`), `refs/baton`, and the installed `node_modules`. Anchors are relative to the named ref unless they say otherwise. `refs/yielded-auth` and `refs/better-auth` have no `.git`. Release dates come from `npm view`.

## Summary

- **Auth goes in the Backend, whichever library we pick.** This confirms D8. The Website stays plain TypeScript. It proxies `/api/auth/*` to the Backend unchanged, and route guards ask the Backend through the existing client, which already forwards the visitor's cookie during SSR (`src/backend-client.ts:17-22`).
- **Your D1 suspicion about Better Auth is correct.** On D1 its Kysely dialect sets `transaction = false` (`packages/kysely-adapter/src/dialect.ts:184-195`). Multi-row writes then run one after another with no rollback. Nothing in Better Auth uses `batch()` for writes; it uses it only for schema introspection.
- **Yielded Auth does D1 properly.** Every write family commits as **one D1 `batch()`**. Read-then-write checks are re-asserted _inside_ the batch with a statement that errors on purpose when the check fails, so D1 rolls the whole batch back (`packages/auth-persistence/src/internal/d1-planning.ts:4-7`).
- **Better Auth is less painful in Effect than it was in Baton.** Alchemy ships a first-party package, `@alchemy.run/better-auth`. It gives `auth.api.*` as Effects with typed errors, a `CloudflareD1` layer, migrations at deploy time, and a managed secret. Callbacks (`sendMagicLink`, `databaseHooks`) are still Promise-land.
- **Baton's protection model fits Yielded Auth's ownership model.** Baton uses none of Better Auth's admin or organization endpoints. It uses only the `role` column, an app-owned `Member` table, an `ADMIN_EMAILS` bootstrap and an invite gate. Yielded Auth says "the app owns subjects and authorization", which is what Baton already does by hand.
- **Yielded Auth's real costs:**
  - It is one month old, with 32 betas in 30 days and no stored-data compatibility between betas.
  - It effectively has one maintainer.
  - D1 is tested only against emulated SQLite.
  - Its D1 support goes through Drizzle 1.0 (a release candidate). Drizzle can be kept down to one table definition that only compiles SQL; avoiding it entirely means writing our own D1 adapter ([§4.6](#46-running-without-drizzle)).
  - Magic links complete only **in the browser that requested them**.
  - Sessions are listed and revoked per device. The rows record no device, browser or IP, so a "your devices" screen needs our own table ([§4.5](#45-sessions-across-devices)).
  - It has no RPC middleware, so we write a small one ourselves.
- **Recommendation:** adopt **Yielded Auth**, behind a time-boxed spike with explicit kill criteria ([§9](#9-recommendation-and-spike)). The fallback is `@alchemy.run/better-auth` on the same architecture, so a failed spike costs only the spike.

## 1. What we need to protect (from Baton)

Baton's admin and member sides are the model ([Baton inventory](#appendix-a-baton-auth-inventory)). Reduced to requirements:

| #   | Requirement                                                                                                                                                                                           | Baton mechanism                                                                             |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| R1  | **Passwordless email sign-in.**                                                                                                                                                                       | Better Auth `magicLink`, 5-minute expiry, hashed token (`src/lib/Auth.ts:135-190`).         |
| R2  | ~~**Invite-only.**~~ Dropped: open sign-up (Q2). You can sign in only if you are a member or in `ADMIN_EMAILS`. The same "check your email" reply is shown either way, so emails can't be enumerated. | Checked in `loginFn` and again in `databaseHooks.user.create.before` (`Auth.ts:90-133`).    |
| R3  | **Two disjoint roles**: `admin` (operator, `/admin/*`) and `user` (member, `/shop/*`). Each is bounced to its own side.                                                                               | Admin-plugin `role` column; `requireAdmin` / `memberServerFnMiddleware`.                    |
| R4  | _Deferred: no tenants yet (Q3)._ **Per-tenant access** through an app-owned `Member` row. A non-member gets `notFound`, never "forbidden".                                                            | `requireMember` in every loader and server function (`src/lib/MemberAccess.ts:42-61`).      |
| R5  | **A guard at both layers**: the layout `beforeLoad` _and_ every server call.                                                                                                                          | Layout guard plus middleware on each server function.                                       |
| R6  | **Rate-limited sign-in** by client IP.                                                                                                                                                                | `LOGIN_LIMITER` binding on `cf-connecting-ip`.                                              |
| R7  | **A closed auth surface.** Only the endpoints we use are reachable.                                                                                                                                   | `/api/auth/$` allowlist: only `GET /magic-link/verify` (`src/routes/api.auth.$.tsx:13-31`). |
| R8  | **Sign-out**, and session revocation that takes effect on the next request.                                                                                                                           | `auth.signOut`. A deleted member is cut off by the next `findMemberAccess`.                 |

Baton does **not** use: passwords, OAuth, organizations, invitations tables, the admin plugin's endpoints (list, ban, impersonate), or Stripe via Better Auth.

## 2. Where auth lives in our architecture

You read the split correctly: the Website is TanStack Start SSR in plain TypeScript, with no managed runtime. The Backend is the Effect Worker. D8 already placed auth in the Backend, and both libraries fit there. Yielded Auth _only_ fits there, because it is all Effect Layers.

```
Browser ──/api/auth/*──► Website (proxy route, GET+POST) ──binding──► Backend: auth HTTP routes ──► D1
Browser ──/api/rpc────► Website (proxy route, POST)     ──binding──► Backend: RpcServer
                                                                        └─ CurrentUserMiddleware (reads Cookie)
SSR ── beforeLoad ── BackendClient (cookie forwarded) ──binding──► Backend: `Me` procedure
```

**What changes:**

- **The Backend `fetch` routes by path.** `/api/auth/*` goes to the auth library's HTTP handler. Everything else goes to `RpcServer.toHttpEffect`, as today.
  - Today the Backend serves only the RPC handler (`src/backend/worker.ts:20-24`).
  - Alchemy's git-service example does this split: `examples/cloudflare-git-service/src/api/host.ts:15-35`, with the front door at `src/worker.ts:32-44`.
- **A second proxy route in the Website**, `src/routes/api.auth.$.ts`, for GET and POST. It is the same one-liner as `api.rpc.ts`.
  - It keeps cookies first-party. `Set-Cookie` and `Origin` pass through untouched.
  - An allowlist (R7) belongs here or in the Backend; the Backend is better, because it is the trust boundary.
- **`CurrentUserMiddleware` gets its server implementation.** It is already declared in `src/api/backend.ts:15-22`.
  - HTTP request headers, including `Cookie`, are merged into each RPC message's headers (`node_modules/effect/src/rpc/RpcServer.ts:1107,1165`), and `RpcMiddleware` receives `headers` (`RpcMiddleware.ts:59`).
  - So the middleware can verify the session cookie and provide `CurrentUser`. It works the same for browser calls (cookie sent by the browser) and SSR calls (cookie forwarded by `serverFetch`).
- **Guards in the Website:**
  - The admin and member layout routes call a `Me` procedure in `beforeLoad` and `redirect` to `/login` or the other side.
  - This is the R5 outer layer. The inner layer is the middleware on every procedure, which is where security actually lives.
  - Each guard is one in-process binding hop. The [loaded-data research](./loaded-data-path-and-direct-backend-research.md) measured that hop as cheap.
- **D1 is bound only to the Backend.**

**Why not run Better Auth in the Website?** Its TanStack docs describe exactly that: a catch-all route, `tanstackStartCookies`, and `auth.api.getSession` in server functions (`docs/content/docs/integrations/tanstack.mdx`).

- It would put D1 and auth logic in the Worker that has no Effect runtime.
- It would split authorization between two Workers: sessions checked in the Website, `CurrentUser` needed in the Backend.

Rejected, consistent with D8 and your preference.

## 3. Better Auth (via `@alchemy.run/better-auth`)

### 3.1 Alchemy's wrapper removes most of the Baton pain

`refs/alchemy/packages/better-auth` is a first-party Alchemy package, at the same version as Alchemy: `2.0.0-beta.81`. It is **not installed** yet.

- **`yield* BetterAuth(options)`** builds one Better Auth instance per _execution_ (per Worker event), not per isolate. Background tasks are awaited by a finalizer that runs through `waitUntil` (`src/BetterAuth.ts:174-213`).
- **`auth.api.*` is a Proxy** that turns every endpoint into an Effect failing with `BetterAuthApiError`. It also surfaces the `set-cookie` headers that better-call hides (`src/ApiProxy.ts:26-69`).
- **`auth.fetch`** is an `HttpEffect` that serves the Better Auth routes. **`auth.getSession()`** reads the ambient request (`BetterAuth.ts:217-240`).
- **`CloudflareD1(AuthDb)`** binds D1 natively. Migrations run at **deploy** time over the D1 HTTP API, or against the local simulator under `alchemy dev`. They run as an Alchemy Action keyed on a schema fingerprint and ship nothing in the bundle (`src/CloudflareD1.ts`, `src/Migrate.ts:55-228`).
  - This replaces Baton's hand-written migration plus its drift test. Better Auth's own CLI cannot reach D1 (`packages/cli/src/utils/cloudflare-virtual-modules.ts`).
- **The secret is managed.** It defaults to a stable `Alchemy.Random` held in state, so there is no `BETTER_AUTH_SECRET` to handle (`BetterAuth.ts:52-63,151-164`).
- **Examples:**
  - `examples/cloudflare-better-auth` shows an `HttpApiMiddleware` that provides `CurrentUser` (`src/middleware.ts:21-45`).
  - `examples/cloudflare-git-service` is a Vite front door plus a backend Worker on a service binding: our shape.

**What stays painful:** Better Auth calls _us_ through Promise callbacks: `sendMagicLink`, `databaseHooks`, `sendVerificationOTP`. Baton needed a context-snapshot bridge (`makeRunPromise`, `refs/baton/src/lib/LayerEx.ts:110-123`) to run Effect code in them. The wrapper does not address that; it wraps the calls _into_ Better Auth, not the callbacks _out_ of it. Email sending (R1) and role assignment at user creation are both callbacks.

### 3.2 D1: no transactions, no batches

- **Dialect.** D1 is auto-detected and handed to a built-in `D1SqliteDialect` with `transaction = false` (`packages/kysely-adapter/src/dialect.ts:184-195`).
  - The driver throws "D1 does not support interactive transactions. Use the D1 batch() API instead." if a transaction is forced (`d1-sqlite-dialect.ts:123-139`).
  - `batch()` appears only in PRAGMA introspection (`d1-sqlite-dialect.ts:46-68`).
- **"Transactions" fall back to running the callback directly.** `runWithTransaction` calls `fn(adapter)` (`packages/core/src/db/adapter/factory.ts:46-49,862-873`).
  - On a throw, writes already made stay in the database.
  - Queued `after` hooks are dropped (`packages/core/src/context/transaction.ts:141-143`).

| Flow                                                   | Writes                                     | Partial-failure result on D1                                                                                                  |
| ------------------------------------------------------ | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Email/password sign-up (`api/routes/sign-up.ts:187`)   | user → account → session                   | Orphan user. Re-sign-up says "email exists" (acknowledged in `packages/better-auth/CHANGELOG.md:550-552`).                    |
| OAuth user creation (`db/internal-adapter.ts:234-266`) | user → account                             | Orphan user.                                                                                                                  |
| Magic-link verify                                      | consume token → find/create user → session | Consume is a single atomic statement (`consumeOne`). A user without a session self-heals on the next link. **Benign for R1.** |
| Organization plugin (create, accept invite, teams)     | several                                    | Not transactional on _any_ database. Worse on D1.                                                                             |
| Delete user (`internal-adapter.ts:427-460`)            | sessions → accounts → user                 | Partly mitigated: generated foreign keys are `ON DELETE CASCADE`.                                                             |
| SCIM, SSO user resolution                              | —                                          | **Refuses to run** without native transactions (`packages/scim/src/transaction.ts:5-12`).                                     |

**For the Baton model (magic link only, no organization plugin), the non-atomicity is mostly theoretical.** It becomes real once we add passwords, OAuth or organizations.

### 3.3 Workers caveats

- It needs `nodejs_compat` for AsyncLocalStorage. We already have it.
- Set `advanced.ipAddress.ipAddressHeaders: ["cf-connecting-ip"]`.
- In-memory rate limiting is per isolate; Baton disabled it and used a binding.
- Set `useSecureCookies` or an https `baseURL`, because the Secure flag otherwise falls back to `NODE_ENV`.
- The changelog shows a run of Workers async-context fixes: `packages/core/CHANGELOG.md:63,427` and `packages/better-auth/CHANGELOG.md:508`.

## 4. Yielded Auth (`@yielded/auth`)

### 4.1 Shape

- **Contract and service.**
  - `AuthContract.make(id, { claims, actions })` is a schema-only contract that is browser-safe.
  - `Auth.make(contract, { sessions, strategies })` is a yieldable Effect service, built by Layers.
  - Every concern is a replaceable service: crypto, storage, account authority, session claims, password hashing, proof keys and delivery (`AGENTS.md:106-115`, `docs/.../reference/adapters.md:216-256`).
- **Mounting.** It mounts as plain HTTP JSON routes via `HttpRouter` / `HttpApi`:
  - `Http.make(...)` returns `.routes()`, `.middleware` and `.handlers(Api)` (`packages/auth/src/http/auth-http.ts:168-180,839-850`).
  - It is **not** Effect RPC, and there is no `RpcMiddleware`.
- **Ownership.** The app owns subjects, provisioning, transactions and authorization. The library owns workflows, proofs, session issuance and cookies (`docs/.../guide/effect.mdx:134-151`).
  - This is the right split for R2–R4: our `user` table, our `role` column, our `member` table.
- **Strategies:**
  - password (Argon2id, with Wasm on Workers);
  - email code;
  - email link;
  - phone OTP;
  - passkeys;
  - TOTP with recovery codes;
  - OAuth and OIDC: GitHub, Google, GitLab, Slack, Vercel, Zoom, Hugging Face, Strava, generic OIDC;
  - OAuth proxy;
  - OAuth server for MCP.
- **Sessions:** stateful (D1, immediate revocation, optional signed cache of 5 minutes or less), stateless, or state-assisted.
  - Revocation is a per-subject `securityRevision` bump, which serves R8 and replaces "ban".
  - Reads never renew; renewal is explicit (`docs/.../reference/sessions.md:13-31`).
- **Security posture:**
  - Origin plus `x-effect-auth-csrf: 1` plus JSON content type on POST (`packages/auth/src/http-operation/security.ts:13-64`).
  - `__Host-` cookies.
  - Tokens and codes stored as digests; provider tokens and TOTP secrets encrypted (`SECURITY.md:53-120`).

### 4.2 D1: atomic batches, done carefully

The D1 entrypoint `@yielded/auth-persistence-drizzle/D1` wires every write family in `batch` mode (`packages/auth-persistence-drizzle/src/D1.ts:80-87`):

1. Workflow code appends statements to a commit scope. At the end, postcondition statements are added and **one** `batch.execute` runs (`packages/auth-persistence/src/internal/sql-commit.ts:322-332`).
2. Read-then-write checks are re-asserted inside the batch by `sqlBatchAssertion`. It is `select case when <cond> then 1 else json_extract('[]', '$[auth-batch-precondition]') end`, which errors when the condition is false and aborts the whole batch (`internal/d1-planning.ts:4-7`).
   - Row-count checks use `changes() = n` the same way (`session-native-stateful.ts:102-111`).
   - There are 57 uses across 25 files: sessions, password, email, passkeys, TOTP, phone, proofs, OAuth and cleanup.
3. **Our own writes can join the auth batch** via `D1BatchStatements.append` inside the `coordinate*` helpers (`drizzle/D1BatchStatements.ts:4-10`).
   - Example: insert the `user` row with `role` in the same atomic batch as the credential.
4. Provisioning inserts the subject, receipt and identifier in one batch, linked by `last_insert_rowid()`. It recovers idempotently on conflict (`drizzle/d1-identity.ts:184-260`).
5. Migrations: Drizzle Kit generates SQL from `storage.schema`. A bundled-SQL migrations layer applies pending files plus journal rows in one batch (`internal/drizzle-d1-migrations.ts:26-150`).

**Caveat:** D1 is tested against **real SQLite with `batch` emulated as a transaction**, not Miniflare or real D1 (`packages/auth-persistence-drizzle/test/fixtures/proof-sqlite.ts:128-163`). The error-to-abort trick depends on D1's batch rollback semantics. The spike must prove it on real D1.

### 4.3 Gaps and friction for our stack

| Item                                                          | Impact                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Magic link completes only in the requesting browser.**      | `beginSignIn` sets a request-binding cookie, and the link page must "complete from the originating client" (`docs/.../guide/codes.md:53-57,87-91`). Requesting on a laptop and tapping the link on a phone fails. **Email code** (`Email.makeCode`) avoids the mismatch: you type 6 digits on the device that asked. See Q1.                                                                                                                          |
| **No RPC middleware.**                                        | The docs say to use `auth.verifySession(Redacted credential)` for RPC (`docs/.../guide/http-and-client.mdx:167-195`). It doesn't renew, and it skips the cookie cache. Writing our `CurrentUserMiddleware` around it is roughly 30 lines. Renewal happens on the auth HTTP routes (`renewSession`), which the Website could call on navigation.                                                                                                       |
| **No admin or organization features.**                        | No user list, ban, impersonation, roles or invitations. Baton used none of the endpoints; the `role` column and `Member` table are ours anyway. Ban becomes `status` on our subject table plus a `securityRevision` bump. **Impersonation** would be ours to build (Q5).                                                                                                                                                                              |
| **Drizzle 1.0 RC** (see [§4.6](#46-running-without-drizzle)). | The D1 adapter peers `drizzle-orm >=1.0.0-rc.4` and uses `drizzle-orm/effect-d1`. rc.4 needed `@yielded/drizzle-effect-v4-patch`, a Bun-only CLI, because it calls `Schema.TaggedErrorClass`, absent from `effect@4.0.1` (0 hits in `node_modules/effect/dist/Schema.d.ts`). Alchemy itself pins `drizzle-orm 1.0.0-rc.5-ab785fc` with **no patch** (`node_modules/alchemy/package.json:442`), which suggests rc.5 fixed it. **Verify in the spike.** |
| **Per-request lifecycle on Workers.**                         | The docs say to build Auth per request (`docs/.../guide/rate-limits.md:183-185`). Email delivery runs on an in-process queue that is cancelled when the Auth scope closes, so we must hold the scope with `waitUntil` (`email-delivery.md:114-131`). There is no durable outbox.                                                                                                                                                                      |
| **Client IP behind the proxy.**                               | Proof requests key their rate limits on the socket peer and _ignore_ forwarding headers. On Workers the peer is `none`, so they **fail closed** until we provide `Proofs.ProofRequestContext` from `CF-Connecting-IP`. Behind our binding, the Website must forward that header (`docs/.../reference/http.md:138-156`).                                                                                                                               |
| **Origin is checked, Host is not.**                           | The Backend's `origin` config must be the public Website origin. The Website forwards `Origin` unchanged, which the proxy already does. Server-to-server mutations without `Origin` are rejected; SSR only reads, via `verifySession`.                                                                                                                                                                                                                |
| **Clock skew.**                                               | Issue #183 found that a DB clock ahead of the app clock invalidated fresh sessions, made worse because Workers' `Date.now()` advances only on I/O. Now addressed by `AuthenticationClock.layer({ futureToleranceMillis })` (`docs/.../reference/sessions.md:33-51`). Not verified on D1.                                                                                                                                                              |

### 4.4 Maturity

- **Releases:** beta.1 on 2026-09-11, beta.32 on 2026-10-10. Often several a day. The npm `latest` tag still points at beta.1.
- **Breaking changes:** 40 `BEHAVIOR CHANGE` entries in the core changelog. The policy is "update internal contracts in place… prefer resetting affected development data" (`AGENTS.md:170-172`). "Prerelease versions do not promise compatibility of stored data or keyrings between betas" (`SECURITY.md:122-127`).
  - Pre-launch, this means resetting the dev and staging D1 on upgrades. After launch, we must pin and read changelogs.
- **People:** effectively one maintainer, `danieljvdm`, with 138 of about 174 commits. 221 stars. The project describes itself as built by "a large, parallel AI-assisted project".
- **Tests:** 70 test files. The stated policy is to _not_ write tests by default, even for an auth library (`AGENTS.md:178-196`).
- **Security process:** private advisory reporting with SLAs. No third-party audit.

You said beta is acceptable; this is the risk you're accepting. Two things limit it:

- The library is Effect services all the way down, so any one service can be replaced if it breaks.
- The fallback (§9) is ready.

### 4.5 Sessions across devices

**Short answer.** Yes, each sign-in is its own session. Signing in on a desktop browser and then on a phone gives two sessions with different `sessionId`s, under one user (subject). Each can be listed and revoked on its own, or all at once. What a session row does **not** record is _which_ device or browser it is.

**What a session is.** With stateful sessions (the mode Q6 recommends):

- Every completed sign-in issues a new session row in the managed `*_sessions` table, holding a digest of the cookie token, never the token itself.
- The cookie lives only in the browser that signed in, so desktop and phone each hold their own.
- What the library returns for a session is `SessionMetadata`: `sessionId`, `subjectId`, `securityRevision`, `assurance` (which factors were used), `issuedAt`, `expiresAt` and `absoluteExpiresAt` (`packages/auth/src/sessions/models.ts:101-109`).
- There is **no user agent, IP or device name**. This matches the earlier round-1 finding (IPC research §8). Session claims hold app data taken from the user, such as `displayName` (`docs/.../guide/sessions.mdx:18`), not request data.

**Operations.** The session module defines three operations, besides sign-out of the current session (`packages/auth/src/sessions/contract.ts:154-183`; handlers at `sessions/module.ts:2151-2193`):

| Operation   | What it does                                                                                                                                                                                 | Who may call it                                                                                       |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `List`      | Pages through the subject's live sessions (at most 100 per page) as `SessionMetadata`. Stateful only; signed sessions return `unsupported("session-listing")` (`module.ts:1069`).            | The signed-in user, for **their own** sessions (the handler rejects a different subject).             |
| `Revoke`    | Deletes one session by `sessionId`. That device's next request is unauthenticated.                                                                                                           | The signed-in user, own sessions only. Requires the `management` assurance (a recent enough sign-in). |
| `RevokeAll` | Bumps the subject's `securityRevision`. Every session issued under the old revision fails its next check, including the caller's. Returns the invalidation window (immediate when stateful). | Same as `Revoke`.                                                                                     |

- The persistence port underneath is `StatefulSessionPersistence.revoke({ subjectId, sessionId })` and `revokeAll({ subjectId, expectedSecurityRevision })` (`sessions/persistence.ts:85-102`).
- Unlike passkeys (`listPasskeys`), these are not surfaced as convenience methods on the auth service. We reach them through the session module's `operations` / `SessionStrategy`.

**"Disallow or disconnect" in practice:**

- **A user signs out their other devices.** `List` plus `Revoke`, or `RevokeAll` then sign in again. Built in.
- **An admin disconnects a user.** The built-in operations only let users manage _their own_ sessions. Because we own the `user` table, an admin action just increments that user's `securityRevision` column. All their sessions die on the next request (`SECURITY.md:76-80`). This is also "ban", combined with `status = disabled` so they can't sign back in.
- **An admin disconnects one specific device of a user.** Not built in. It means calling the persistence port, or deleting the row by `sessionId`, from our own admin procedure. It works, but it is outside the documented surface. Verify in the spike.
- **Disallow a second device (one session at a time).** Not a built-in policy. We can enforce it after sign-in completes: revoke every other `sessionId` for that subject (newest wins). Or refuse the new sign-in when a live session exists (oldest wins), but then a lost phone locks the user out until it expires. Newest-wins is the usual choice. See Q9.
- **Detect a second sign-in** (the D11 proof of concept). `List` returning more than one live session for the subject _is_ the signal. Without device data we can say "two sessions, issued at these times", not "a phone and a desktop".

**Getting device information.**

- Keep our own `session_device` table keyed by `sessionId`: user agent, `CF-Connecting-IP`, country from `request.cf`, created and last-seen times.
- Write it in the Backend right after a sign-in completes, when the issued session is known.
- `List` joined with this table gives a "your devices" screen.
- This is ours to build, and the exact point where the new `sessionId` is available must be confirmed in the spike.

**Better Auth for comparison:**

- Its session rows store `ipAddress` and `userAgent` out of the box.
- It ships `listSessions`, `revokeSession`, `revokeOtherSessions` and `revokeSessions`.
- Its admin plugin adds `listUserSessions` and `revokeUserSession(s)`, so admins can act on other users' sessions.

On sessions, Better Auth gives more for free; Yielded Auth needs the device table and an admin procedure.

### 4.6 Running without Drizzle

You'd prefer not to bring in Drizzle. Here is exactly where Drizzle sits in Yielded Auth, and what avoiding it costs.

**What Drizzle actually does in the D1 adapter.** Less than it looks:

- **Executing queries:** not Drizzle. The batch executor calls `@effect/sql-d1`'s `D1Client.batch` on Effect SQL statements (`packages/auth-persistence-drizzle/src/drizzle/native-target.ts:43-46`). All the batching and assertion logic (§4.2) lives in the Drizzle-free `@yielded/auth-persistence` package.
- **Compiling SQL:** Drizzle. Table objects are used to _produce_ SQL text. "Builders are used to materialize SQL, never executed" (`drizzle/native-sql-table.ts:28-30`).
- **Describing tables:** Drizzle. Our subject table (`user`) must be passed as a Drizzle table object (`docs/.../guide/storage.mdx:30-52`), and the managed `auth_*` tables are generated as Drizzle tables.
- **Migrations:** Drizzle Kit, from `storage.schema` (§4.2 item 5).

**Options:**

| Option                                                    | What it means                                                                                                                                                                                                                                                                                                                                                                                              | Cost                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Drizzle as a hidden detail of the auth adapter**     | We write **one** Drizzle `sqliteTable` for `user` and nothing else in Drizzle. Our own queries use `SQL.D1` (Effect SQL), as planned. Migrations can be hand-written SQL in `./migrations`; the adapter checks columns and unique keys against the live database on first use (`docs/.../reference/adapters.md:99-102`). Drizzle Kit is optional: run it once to get the auth tables' DDL, or skip it.     | `drizzle-orm` RC in the bundle and lockfile, plus possibly the Effect v4 patch (K1). This is the same relationship Better Auth has with Kysely: an ORM inside the library that we don't write against.                                                                                                                                       |
| **B. Our own D1 driver on the public adapter API**        | `@yielded/auth-persistence/Adapter` exports `makeNativeSqlTables`, `SqlBatchCommit`, `SqlNativeCommit` and `makeSqlCommitExecutor`. It says "drivers supply physical codecs, SQL expressions and transaction/batch capabilities to one commit owner" (`Adapter.ts:1-3,195-200`). We would supply `SqlBatchCommit` with `D1Client.batch` and replace the Drizzle SQL compiler with hand-written Effect SQL. | The Drizzle D1 path is about 1,000 lines (`native-sql-table.ts` 276, `D1.ts` 164, `native-target.ts` 120, `d1-identity.ts` 385, `drizzle-sqlite.ts` 92), and the adapter API changes with most betas. We would own a security-critical persistence layer on a moving target.                                                                 |
| **C. The direct Effect SQL path** (no Drizzle, supported) | `persistence-sql` example; works with plain `SqlClient`.                                                                                                                                                                                                                                                                                                                                                   | **Does not work on D1.** It needs interactive transactions: "Direct Effect SQL supports PostgreSQL and SQLite with interactive transactions, not MySQL or D1 batches" (`adapters.md:408-409`). `D1Client` batches "intentionally cannot participate in SqlClient transactions" (`node_modules/.pnpm/@effect+sql-d1@4.0.1…/D1Client.ts:174`). |
| **D. Direct Effect SQL on Durable Object SQLite**         | Put the auth store in one Durable Object. Its SQLite has real transactions, and `@effect/sql-sqlite-do` (already installed via Alchemy) maps `withTransaction` to `storage.transaction()` (`SqliteClient.ts:5-15`). The Drizzle-free path (C) should then apply.                                                                                                                                           | Changes the architecture: auth data no longer in D1, and every session check is a call to one Durable Object in one location. Not verified that the direct path accepts `sql-sqlite-do`; Yielded Auth's own DO support is via Drizzle (`./SqliteDo`).                                                                                        |

**Recommendation: A.**

- It is the only option that keeps D1, atomic batches and a supported code path.
- Drizzle's footprint is one table definition. We never write Drizzle queries or carry Drizzle in our domain code.
- B is the "no Drizzle at all" answer, but it means owning about 1,000 lines of auth persistence that break on upgrades. That is worse than an unused-by-us dependency.
- If Drizzle is a hard no, fall back to Better Auth. It uses Kysely internally, which we also never touch, but then we lose D1 atomicity.

## 5. Head to head

| Concern                         | Better Auth via `@alchemy.run/better-auth`                                              | Yielded Auth                                                                                     |
| ------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Effect fit                      | Calls in are Effects. Callbacks out are Promises (bridge needed for R1, R2).            | Native. Hooks, delivery and storage are all Effect services.                                     |
| D1 atomicity                    | None. Sequential writes.                                                                | One `batch()` per commit, with in-batch abort assertions. Our writes can join.                   |
| D1 migrations                   | Automatic at deploy (Alchemy Action).                                                   | Drizzle Kit generates SQL; we commit it and apply it.                                            |
| Magic link (R1)                 | Cross-device.                                                                           | Same-browser only. Email code works.                                                             |
| Role at sign-up                 | `databaseHooks.user.create.before` (Promise callback).                                  | Our account authority / provisioning; we own subject creation.                                   |
| Roles (R3)                      | Admin plugin `role` column.                                                             | Our column on our subject table.                                                                 |
| RPC middleware                  | Write it with `auth.getSession(headers)`.                                               | Write it with `auth.verifySession(cookie)`.                                                      |
| Rate limiting (R6)              | Disable it; use a Cloudflare binding.                                                   | Built-in buckets; plug in KV or a Cloudflare rate-limit binding (documented Alchemy recipe).     |
| Admin extras                    | List users, ban, impersonate, set role.                                                 | None; build what we need.                                                                        |
| Sessions per device             | Separate sessions with IP and user agent. List and revoke own; admin can revoke others. | Separate sessions, no device data. List and revoke own; admin revoke-all via `securityRevision`. |
| ORM inside                      | Kysely (internal, never touched).                                                       | Drizzle for D1 (one table definition written by us; queries stay Effect SQL).                    |
| Future: orgs, Stripe, SSO, SCIM | Plugins exist, but they are non-atomic on D1, and SCIM/SSO are blocked.                 | Not provided; app-owned.                                                                         |
| Passkeys, TOTP                  | Plugins.                                                                                | Built in.                                                                                        |
| Maturity                        | Mature, widely deployed. The Alchemy wrapper is beta with Alchemy.                      | One month, one maintainer, fast-moving, data resets between betas.                               |
| Examples on our exact stack     | Yes (Alchemy examples).                                                                 | No Workers or D1 example; Bun servers only. Workers is covered by doc recipes.                   |

## 6. How Yielded Auth would map to Baton's model

1. **Tables.**
   - Our `user` table: `id`, `email`, `role` (`user` | `admin`), `status`, `securityRevision`.
   - No `member` or tenant table in the first iteration (Q3).
   - Yielded Auth's managed `auth_*` tables via `AuthPersistence.make(AppAuth).managed({ subjects: { table: user, … } })` (`docs/.../guide/storage.mdx:27-80`).
2. **Sign-in:** `Email.makeCode()`, or `makeLink` (Q1).
   - Sign-up is open (Q2). The first sign-in provisions the `user` row in the same D1 batch, with `role = admin` when the email is in `ADMIN_EMAILS`, otherwise `user`.
3. **The Backend serves** `http.routes()` under `/api/auth` (R7: only the actions in our contract exist, so the surface is closed by construction). It also serves `RpcServer` for everything else.
4. **`CurrentUserMiddleware`:**
   - read the cookie from the RPC headers;
   - call `verifySession`;
   - load the `user` row;
   - provide `CurrentUser { id, role }`.
5. **Role checks:** `RequireAdmin` is a second middleware, or a check inside each handler. Per-tenant checks (R4, Baton's `requireMember`) wait for a tenant model (Q3).
6. **Website guards:** `/admin` and `/app` layout `beforeLoad` call `Me` and redirect (R5 outer layer). Sign-in and sign-out pages call `/api/auth/*` through the proxy.

## 7. Database and migrations ownership

Whichever library we pick, there are two schema owners on one D1 database:

- the auth library's tables;
- our tables (`user` with Yielded Auth, and `session_device`).

Alchemy's `D1.Database({ migrations: "./migrations" })` applies plain SQL files in both cloud and local dev (`refs/alchemy/packages/alchemy/src/Cloudflare/D1/Database.ts:73-88`). **Recommended:** a single `./migrations` directory owned by Alchemy.

- **With Yielded Auth:** hand-write or generate (Drizzle Kit, once) the auth tables' SQL into the same directory, and skip its runtime `migrationsLayer`. The adapter validates the schema on first use.
- **With Better Auth:** Baton hand-wrote the auth tables into its migration and drift-tested them. The Alchemy wrapper's automatic migration is simpler, but it keeps separate bookkeeping from `./migrations`.

## 8. Things that are true for either library

- The Website forwards `Cookie` (it already does for SSR), `Origin` and `CF-Connecting-IP` to the Backend. The browser proxy forwards the original request, so it already carries these.
- Session reads should hit the D1 **primary**, not a read-replica session. Both libraries say so.
- The magic-link or code email needs `Cloudflare.Email.SendEmail`, an Alchemy resource. Baton used the `send_email` binding.
- Sign-in rate limiting uses a Cloudflare rate-limit binding (Baton: 5 per 60 seconds).
- Local dev: D1 runs in the workerd simulator under `.alchemy/local/d1`, and migrations apply locally. Cookies over plain HTTP need `secure: false`: in Yielded Auth the prefix becomes `effect-auth-`; in Better Auth it is `useSecureCookies: false`.

## 9. Recommendation and spike

**Adopt Yielded Auth**, starting with a spike of about two days. The spike is a vertical slice on the real stack, and it goes to staging (real D1), not just `alchemy dev`:

1. D1 with `./migrations`.
2. Our `user` table plus Yielded Auth managed tables.
3. Email-code sign-in (Q1), open sign-up (Q2), with `ADMIN_EMAILS` assigning the `admin` role.
4. Backend path routing: `/api/auth/*` versus RPC.
5. The `api.auth.$` proxy route.
6. `CurrentUserMiddleware`.
7. A `Me` procedure.
8. Guards on `/admin` and `/app`.
9. Sign-out.
10. Sessions: sign in on two devices, `List` both, `Revoke` one, an admin `securityRevision` bump, and a `session_device` row written at sign-in (§4.5).

**Kill criteria.** Fall back to `@alchemy.run/better-auth` if any of these fails:

- **K1:** Drizzle `rc.5` (Alchemy's pin) works with `effect@4.0.1` without the Bun patch, or the patch applies cleanly with `pnpm patch`.
- **K2:** On **real D1**, a forced precondition failure rolls back the whole batch. Test it by provisioning a user whose identifier already exists, and check that no partial rows remain.
- **K3:** Email delivery completes under the per-request scope, with `waitUntil`.
- **K4:** Proof rate limits work behind the binding with `ProofRequestContext` taken from `CF-Connecting-IP`.
- **K5:** `verifySession` in `RpcMiddleware` works for both browser and SSR calls.

**Why not just take Better Auth?**

- The Alchemy wrapper does fix most of the integration pain.
- But the remaining pain sits on our requirements: email delivery and user provisioning (role assignment) are Promise callbacks.
- The D1 non-atomicity becomes real as soon as we add passwords, OAuth or organizations.
- Yielded Auth's ownership model is what Baton built by hand on top of Better Auth anyway.

**Why the fallback is cheap.** The architecture in §2 is the same for both libraries: path routing, proxy route, `CurrentUserMiddleware`, `Me`, guards. Only the Backend's auth module changes.

## 10. Decisions (round 1, 2026-10-10)

All recommendations were accepted except Q2 and Q3, which changed scope.

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | **Email code**, 6 digits, 5-minute expiry. No magic link for now.                                                                                                                                                                                                                                                                                                                     |
| Q2  | **Open sign-up.** Anyone can sign up; there is no invite gate (R2 dropped). `ADMIN_EMAILS` still bootstraps the `admin` role at provisioning.                                                                                                                                                                                                                                         |
| Q3  | **No tenants in the first iteration.** There is no shop-like concept yet; only `admin` versus signed-in `user` (R4 deferred). Tenancy is to be designed later.                                                                                                                                                                                                                        |
| Q4  | **Drizzle option A.** One `sqliteTable` for `user`, pinned to Alchemy's `1.0.0-rc.5-ab785fc`. Our queries stay on `SQL.D1`.                                                                                                                                                                                                                                                           |
| Q5  | **Admin extras deferred.** Ban becomes `status` plus a `securityRevision` bump when needed. Impersonation only on demand.                                                                                                                                                                                                                                                             |
| Q6  | **Stateful sessions without a cookie cache.** Add `cacheFor` only if `cf o11y` shows D1 latency matters.                                                                                                                                                                                                                                                                              |
| Q7  | **Spike goes to staging** (real D1).                                                                                                                                                                                                                                                                                                                                                  |
| Q8  | **No other sign-in methods now.**                                                                                                                                                                                                                                                                                                                                                     |
| Q9  | **Many concurrent sessions,** shown on a "your devices" page with a revoke button.                                                                                                                                                                                                                                                                                                    |
| Q10 | **Build the `session_device` table** (user agent, IP, country, created and last-seen).                                                                                                                                                                                                                                                                                                |
| Q11 | **Admin disconnect is "everywhere"** via a `securityRevision` bump. No per-device admin revoke.                                                                                                                                                                                                                                                                                       |
| Q12 | **One `./migrations` directory, owned by Alchemy** (`D1.Database({ migrations })`), for our tables and Yielded Auth's. Auth DDL is hand-written, or generated once with Drizzle Kit and committed. Yielded Auth's runtime `migrationsLayer` is not used. Consistent with Q4. A mismatch with what the adapter expects fails at first use, not at deploy, so the spike checks it (§7). |

## Appendix A: Baton auth inventory

Paths are relative to `refs/baton`.

- **Stack:** one TanStack Start Worker. Effect `4.0.0-rc`, `@effect/sql-d1`, Better Auth `1.7.2`. A new `ManagedRuntime` is built per request, and `betterAuth()` is constructed per request (`src/worker.ts:39-92,181-188`).
- **Auth service:** `src/lib/Auth.ts`, an Effect `Context.Service`.
  - Every call goes through `tryAuth` (`Effect.tryPromise` mapped to `AuthError`).
  - `getSession` output is checked against Schema.
- **Database:** Better Auth gets the raw `env.D1`. It does _not_ get the replica session, because `D1DatabaseSession` lacks `exec` (`Auth.ts:69-75`).
- **Schema:** auth tables are hand-written in `migrations/0001_init.sql:62-139`, PascalCase via `modelName`. A drift test compares them against `getSchema(auth.options)`, because `getMigrations` is rejected by D1's authorizer.
- **Plugins:** `magicLink` (300 s, hashed), `admin()` (defaults), `tanstackStartCookies()` (last). No organization or Stripe plugin.
- **Hooks:** `user.create.before` makes `ADMIN_EMAILS` admins and returns `false` for non-members (`Auth.ts:90-133`). It runs Effect via `makeRunPromise`.
- **Routes:**
  - `/admin` layout: `beforeLoad` → `requireAdmin` (`src/lib/AdminServerFnMiddleware.ts:20-30`).
  - `/shop` layout: `beforeLoad` → `requireUserFn`.
  - Per-shop pages call `requireMember` in each loader and server function.
  - `/login`, `/login-callback` (routes by role), `/api/auth/$` (allowlist).
- **Login:** IP rate limit → invite gate (same response either way) → `signInMagicLink` → verify → callback routes admin to `/admin` and members to their shop.
- **Pain points visible in the code:**
  - the Promise-callback bridge;
  - the replica-session incompatibility;
  - no D1 `getMigrations`;
  - in-memory rate limit disabled;
  - error fields flattened by server-function serialization;
  - a type cycle between the two guards.
- **D1 batching** in the app's own code: `sqlPrimary.batch([...])` (`src/lib/Repository.ts:840-862,1176-1206`). Better Auth's own writes are not batched.
