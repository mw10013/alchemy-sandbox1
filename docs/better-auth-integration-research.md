# Research: Integrating Better Auth via `@alchemy.run/better-auth`

Date: 2026-10-10  
Status: round 1 decided 2026-10-10 ([§11](#11-decisions-and-open-questions)). Implementation plan: [better-auth-integration-plan.md](./better-auth-integration-plan.md). Supersedes [yielded-auth-integration-research.md](./yielded-auth-integration-research.md) after the library decision was reversed ([§0](#0-why-the-decision-changed)).  
Versions: Alchemy `2.0.0-beta.81`, `@alchemy.run/better-auth` `2.0.0-beta.81` (not yet installed), `better-auth` `1.7.7` (installed), Effect `4.0.1`, `@tanstack/react-start` `1.168.60`, Astryx `0.6.5`.  
Vocabulary: [glossary](./glossary.md). Prior decisions: [auth-library-research.md §10](./auth-library-research.md#10-decisions-round-1-2026-10-10), written "prior Qn" below.

Sources: `refs/alchemy` (`packages/better-auth`, `examples/cloudflare-better-auth`, `examples/cloudflare-git-service`, `examples/cloudflare-effect-sql-d1`, the `website/.../better-auth` guides), `refs/better-auth`, `refs/baton`, `refs/effect`, `refs/tan-router`, `refs/tan-start`, `refs/cloudflare-docs`, and the installed `node_modules`. Anchors are relative to the named ref. Claims not confirmed in source are marked **[spike]**.

## 0. Why the decision changed

The product flow is Baton's: an admin (later, a merchant) adds a member by email; the member goes to the sign-in page, enters that email, and gets a link. No open sign-up. In Baton this costs one app-table insert, because Better Auth's magic-link plugin creates the `user` row itself at first verify and issues the session in the same step (`refs/better-auth/packages/better-auth/src/plugins/magic-link/index.ts:447-495`). Baton only gates that creation on its own `Member` table (`refs/baton/src/lib/Auth.ts:90-133`).

Yielded Auth cannot do that: its sign-in requires an existing account, its registration flow creates the account but refuses to issue a session, and it has no API to create accounts programmatically. Matching Baton's flow would mean either two codes per new member or hand-writing three rows into the library's managed tables (see the superseded doc, §6). So the fallback the library research priced as cheap is taken: same architecture, Better Auth as the auth module. The spike's kill criteria from the Yielded doc no longer apply; §10 has new ones.

## Summary

- **The Alchemy wrapper does the heavy lifting.** `yield* BetterAuth(options)` in the Worker's construction phase gives `auth.fetch` (an `HttpEffect` for the routes), `auth.getSession(headers)`, and `auth.api.*` as Effects with typed `BetterAuthApiError`. The D1 layer `CloudflareD1(AuthDb)` binds D1 at runtime and runs Better Auth's own schema migration as an Alchemy Action at deploy and under `alchemy dev` (`refs/alchemy/packages/better-auth/src/BetterAuth.ts:140-258`, `CloudflareD1.ts:68-116`). The signing secret is a stable `Alchemy.Random` held in state.
- **Baton's shape transfers with one improvement.** The gate moves from `databaseHooks.user.create.before` to `user.validateUserInfo`, which Better Auth 1.7 added for exactly this and which fails closed and gives the browser a clean `?error=not_invited` redirect (`refs/better-auth/packages/core/src/types/init-options.ts:950-976`; `utils/validate-user-info.ts:41-71`). The `role` column and the admin operations come from the `admin()` plugin, as in Baton ([§4.2](#42-the-admin-plugin)).
- **The magic-link request is our RPC, not Better Auth's route.** A `RequestMagicLink` procedure checks the member allowlist and the rate limit in Effect, then calls `auth.api.signInMagicLink` server-side, as Baton's `loginFn` does. The Website's `/api/auth/$` proxy allows only `GET /magic-link/verify` and `POST /sign-out` (prior R7), and non-members get the same "check your email" reply ([§4.4](#44-the-sign-in-request-is-an-rpc)).
- **Promise callbacks are the one Effect seam.** `sendMagicLink` and `validateUserInfo` are awaited Promises. Both run Effects with a context snapshot taken in the construction phase, which is Baton's `makeRunPromise` idiom and also what the wrapper itself does for secondary storage (`BetterAuth.ts:187-196`). The Alchemy binding clients read `env` captured at init, so the Email binding and the raw D1 client work from inside a callback ([§4.5](#45-promise-callbacks)). **[spike]**
- **One Worker, two schema owners.** Better Auth's Action migrates its four tables; Alchemy's `D1.Database({ migrations })` applies our `member` table. The Worker depends on both ([§3](#3-schema-and-migrations)).
- **D1 non-atomicity is benign here** (library research §3.2): magic-link verify's writes are consume-token, then create-user, then create-session, and a user without a session self-heals on the next link.
- **Sessions already record `ipAddress` and `userAgent`**, and `listSessions` / `revokeSession` are core endpoints, so the deferred "your devices" page (prior Q9, Q10) needs no extra table.
- **Baton's migration has a stale `Account.issuer` column** from Better Auth 1.7.0–1.7.2; do not copy it ([§3.2](#32-better-auths-tables)).

**Recommendation:** proceed with the spike on this design. Twelve questions with recommendations are in [§11](#11-questions-round-1).

## 1. Architecture

```
Browser ─ RPC RequestMagicLink ──► Website: /api/rpc ──binding──► Backend: gate + auth.api.signInMagicLink ─► D1 + Email
Browser ─ GET /api/auth/magic-link/verify?token= ─► Website: /api/auth/$ (allowlist) ──binding──► Backend: auth.fetch ─► 302 + Set-Cookie
Browser ─ POST /api/auth/sign-out ─► Website: /api/auth/$ ──binding──► Backend: auth.fetch
Browser/SSR ─ RPC Me, admin RPCs ──► Website: /api/rpc ──binding──► Backend: CurrentUserMiddleware: auth.getSession(cookie)
```

- **Backend becomes a `Cloudflare.Worker` that branches on path.** `RpcWorker` is documented as functionally identical to a `Worker` returning `{ fetch: RpcServer.toHttpEffect(...) }` and adds only `RpcWorker.bind`, which the Website does not use (`refs/alchemy/packages/alchemy/src/Cloudflare/Workers/RpcWorker.ts:246-248`; `src/backend-client.ts:17-23`). The template is Alchemy's own: `if (request.url.startsWith("/api/auth")) return yield* auth.fetch; return yield* rpcFetch;` (`examples/cloudflare-git-service/src/api/host.ts:22-34`; the wrapper's doc comment at `BetterAuth.ts:96-108`).
- **One Better Auth instance per request event**, memoized on the execution scope (`BetterAuth.ts:174-213`). The RPC server is already rebuilt per request, so the cost model does not change.
- **Set-Cookie and redirects pass through the proxy.** `auth.fetch` converts Better Auth's `Response` with `HttpServerResponse.fromWeb`, and the Website returns the binding's `Response` as-is. One check for the spike: that `env.BACKEND.fetch` returns the verify route's 302 to the browser instead of following it. If it follows, construct the forwarded `Request` with `redirect: "manual"` **[spike]**.
- **Headers the Backend needs arrive already.** The browser proxy forwards the whole `Request` (`src/routes/api.rpc.ts:42`), so `Cookie`, `Origin`, `Sec-Fetch-*` and `CF-Connecting-IP` reach the Backend. SSR copies `cookie` only (`src/backend-client.ts:18-23`), which is enough for `getSession`.

## 2. Infrastructure with Alchemy

### 2.1 D1

- `Cloudflare.D1.Database("AuthDb", { migrations: "./migrations", readReplication: { mode: "disabled" } })` (`packages/alchemy/src/Cloudflare/D1/Database.ts:41-109`). The `migrations` directory is ours (the `member` table); the auth tables come from the wrapper's Action ([§3](#3-schema-and-migrations)). Both apply in dev (local simulator under `.alchemy/local/d1`) and on deploy.
- `CloudflareD1(AuthDb)` is the wrapper's `Database` layer. It yields `Cloudflare.D1.QueryDatabase(AuthDb)` and hands `client.raw` (the native `D1Database`) to Better Auth (`CloudflareD1.ts:68-80`). Baton gave Better Auth the raw binding too, not the replica session, because `D1DatabaseSession` lacks `exec` (`refs/baton/src/lib/Auth.ts:69-75`).
- **Our own queries** (`member` table, admin lists) use `alchemy/SQL/D1`: `const sql = yield* SQL.D1(d1)` in construction, tagged templates in handlers, `d1.batch` for atomic multi-row writes (`packages/alchemy/src/SQL/D1.ts:53-90`; `examples/cloudflare-effect-sql-d1/src/Api.ts`). Importing `@effect/sql-d1` directly would need a `package.json` entry; the Alchemy module avoids that.

### 2.2 Email

- `Cloudflare.Email.SendEmail("AuthEmail")` plus `const email = yield* Cloudflare.Email.Send(AuthEmail)` with `Effect.provide(Cloudflare.Email.SendBinding)`. `email.send({ from, to, subject, text, html })` fails with `SendEmailError` (`packages/alchemy/src/Cloudflare/Email/Send.ts:45-83`).
- The client captures `env` at init and reads the binding with `Effect.sync` (`Email/SendBinding.ts:13-34`), which is why it is callable from a Promise callback ([§4.5](#45-promise-callbacks)).
- **Local dev is simulated:** the runtime writes `.eml` files under `.alchemy/local/email` and logs the path. The magic-link URL is read from there. `.pipe(Alchemy.remote())` sends real mail from dev.
- **Staging needs a Cloudflare Email Service sending domain**, or sends only to verified destination addresses in the account (free, no DNS) (`refs/cloudflare-docs/.../email-service/platform/limits.mdx`). See Q4.

### 2.3 Secrets and config

- **Signing secret:** omit `secret`; the wrapper mints `Random("BetterAuthSecret")` once per stage and binds it as a secret (`BetterAuth.ts:151-164`; guide `configuration.mdx:94`).
- **`baseURL`:** `Config.String("AUTH_ORIGIN")` in construction, per stage: `http://localhost:<WEBSITE_PORT>` in dev, the staging `workers.dev` URL (`docs/alchemy-stages-and-deployments-research.md:111`). It is the _Website_ origin, because that is what the browser sees. Omitting it lets Better Auth derive the origin from the request (`configuration.mdx:83`), but the Backend only ever sees `https://backend/...` through the binding, so set it. See Q7.
- **No `ADMIN_EMAILS`.** Admins are `member` rows with `role = 'admin'`, seeded per stage ([§3.3](#33-seeding-members-per-stage)).
- Per-stage files: `Alchemy.Secrets.DotEnv(({ stage }) => ({ path: [".env", `.env.${stage}`] }))` in the stack options. `AUTH_ORIGIN` for staging is not secret and can be committed in `.env.staging`.

### 2.4 Rate limiting

`Cloudflare.RateLimit("SignInLimit", { namespaceId, simple: { limit: 5, period: 60 } })` with `Effect.provide(Cloudflare.Workers.RateLimitBinding)`; `limit({ key: ip })` returns `{ success }`; local dev has an in-memory implementation (`packages/alchemy/src/Cloudflare/Workers/RateLimit.ts:30-43`). Baton used the same binding keyed on `cf-connecting-ip`. Better Auth's own limiter is per isolate in memory and only on by default when `NODE_ENV === "production"` (`refs/better-auth/packages/better-auth/src/context/create-context.ts:357-365`); see Q5.

## 3. Schema and migrations

### 3.1 Our table

```sql
CREATE TABLE member (
  id         text PRIMARY KEY,
  email      text NOT NULL UNIQUE,
  role       text NOT NULL CHECK (role IN ('admin', 'user')),
  created_at integer NOT NULL DEFAULT (unixepoch())
);
```

This is Baton's `Member` without `shop` (prior Q3: no tenants yet) and with the role on it. **The `member` table is the authority on who may sign in and as what.** Better Auth's `user.role` is stamped from it at creation ([§4.3](#43-the-invite-gate-and-role-stamping)) because the admin plugin's own checks read `user.role`; a later role change updates both (`setRole` plus the member row). The `user` row appears at first verify; "members who have signed in" is a join on email.

Why not `ADMIN_EMAILS`: it is configuration pretending to be data, stamped only at creation (changing it later promotes nobody), and it is a second source of truth next to the member table. One table, seeded per stage, replaces it.

### 3.3 Seeding members per stage

Alchemy's `D1.Database` takes `importFiles`: `.sql` files run **after migrations**, hashed, and re-run only when their contents change, in both the live provider and the local simulator (`refs/alchemy/packages/alchemy/src/Cloudflare/D1/Database.ts:90-97, 499-508, 610-630`). That is the seeding mechanism:

```ts
// alchemy.run.ts
export const AuthDb = Cloudflare.D1.Database("AuthDb", {
  migrations: "./migrations",
  importFiles: [dev ? "./seed/dev.sql" : `./seed/${stage}.sql`],
});
```

```sql
-- seed/dev.sql (idempotent: re-runs on change, never duplicates)
INSERT OR IGNORE INTO member (id, email, role) VALUES
  ('seed-admin', 'a@a.com',  'admin'),
  ('seed-m1',    'm1@m.com', 'user'),
  ('seed-m2',    'm2@m.com', 'user');
```

- Only the `member` table can be seeded this way: Better Auth's tables are created later by the wrapper's Action, after the database reconciles. That is fine, because seeded members go through the real first-verify path and get their `user` row like anyone else. No fake sessions, no seed route.
- `seed/staging.sql` holds the operator's admin row; `seed/production.sql` the real one (Q13). The dev addresses never receive mail because dev delivery is inline ([§4.7](#47-magic-link-delivery-in-dev)).
- **Dev reset.** The import is tracked by file hash in Alchemy state (remote for this project), not in the database, so deleting the local D1 data alone leaves the seed skipped. The clean reset is to delete the database's state record: `alchemy state delete <stack>/dev/<AuthDb record>` ("Delete state records without deleting cloud resources", `node_modules/alchemy/src/Cli/commands/state.ts:130-152`). The next `dev:start` then treats `AuthDb` as new: a fresh local database id, migrations, the seed, and Better Auth's schema Action, which is keyed on the database identity (`packages/better-auth/src/Migrate.ts:96-100`). The orphaned local files are reclaimed by removing `.alchemy/local`. On its own that only makes Alchemy _forget_ the database; nothing is rebuilt until dev starts. So the script is `db:reset`: stop the dev server if running, delete the record and the local files, start dev again. When it returns the database really is reset, auth tables included (Q14). **[spike]** confirm the record path and that the Action re-runs.
- How `alchemy.run.ts` learns the stage name needs checking; `Alchemy.ALCHEMY_DEV` already gives the dev/not-dev split there.

### 3.2 Better Auth's tables

With `magicLink()` and `admin()`, the schema is the core four plus the plugin's columns (`user.role`, `banned`, `banReason`, `banExpires`; `session.impersonatedBy`) (`refs/better-auth/packages/core/src/db/get-tables.ts:86-350`; SQLite types at `get-migration.ts:845-895`):

| Table          | Columns                                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------ |
| `user`         | `id`, `name` NN, `email` NN UNIQUE, `emailVerified` NN, `image?`, `createdAt`, `updatedAt`, `role`                 |
| `session`      | `id`, `expiresAt` NN, `token` NN UNIQUE, `createdAt`, `updatedAt`, `ipAddress?`, `userAgent?`, `userId` FK cascade |
| `account`      | `id`, `accountId`, `providerId`, `userId` FK, token and password columns, `createdAt`, `updatedAt`                 |
| `verification` | `id`, `identifier` NN indexed, `value` NN, `expiresAt` NN, `createdAt`, `updatedAt`                                |

- **Automatic migration (recommended, Q3).** `BetterAuth({ migrate: true })` is the default with `CloudflareD1`. An Alchemy Action keyed on a fingerprint of the schema (plugins, additional fields, model names) applies missing tables, columns and indexes at deploy, before the Worker, and under `alchemy dev` against the simulator (`packages/better-auth/src/Migrate.ts:55-117`; guide `migrations.mdx`). It re-runs only when the fingerprint or the database changes. This replaces Baton's hand-written DDL and its drift test.
- **Hand-written alternative:** `migrate: false` and our own `migrations/0002_auth.sql`. If we go this way, **do not copy Baton's `Account.issuer` column or `Account_issuer_accountId_uidx`**: they belong to Better Auth 1.7.0–1.7.2 and were removed in 1.7.3 (`refs/better-auth/docs/content/docs/guides/1-7-upgrade-guide.mdx:82-132`). Baton's `banned`, `banReason`, `banExpires` and `Session.impersonatedBy` are the admin plugin's columns and stay.
- Two owners on one database: the wrapper's Action tracks its own state; Alchemy's `__alchemy_migrations` tracks ours. The Worker's env depends on the Action's output, so a first deploy cannot race the schema (`Migrate.ts:111-116`).

## 4. Better Auth in the Backend

### 4.1 Options

```ts
// src/backend/auth.ts, construction phase of the Worker
const auth = yield* BetterAuth({
  basePath: "/api/auth",
  baseURL: authOrigin,                                   // the Website origin, per stage
  user: { validateUserInfo: ... },                      // §4.3

  databaseHooks: { user: { create: { before: ... } } }, // §4.3: role from the member row
  plugins: [magicLink({ expiresIn: 300, storeToken: "hashed", disableSignUp: false, sendMagicLink: ... }), admin()],
  session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24 },  // defaults, stated
  advanced: { ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] } },
  rateLimit: { enabled: false },                         // ours is the Cloudflare binding (Q5)
});
```

- `expiresIn` is seconds, default 300 (`magic-link/index.ts:30-33`). `storeToken: "hashed"` stores a digest; the email still carries the raw token. A token is consumed atomically on first use (`:188-192`).
- **Cookies:** with an `https://` `baseURL`, cookies are `Secure` with the `__Secure-` prefix; with `http://localhost` they are not (`refs/better-auth/packages/better-auth/src/cookies/index.ts:53-76`). Name: `better-auth.session_token`, `SameSite=Lax`, `HttpOnly`, `Path=/`.
- **Trusted origins:** the `baseURL` origin is trusted automatically (`context/helpers.ts:135-143`), which covers the Website's same-origin calls. `callbackURL` values must be relative or trusted (`api/middlewares/origin-check.ts:83-150`).
- `nodejs_compat` is already on both Workers.

### 4.2 The admin plugin

`admin()` as Baton used it (`refs/baton/src/lib/Auth.ts`, plugins list). What it gives:

- `user.role` with the default `"user"` applied by its own `create.before` hook; a `role` already set by an earlier hook wins (`refs/better-auth/packages/better-auth/src/plugins/admin/admin.ts:77-87`). Our member-row hook therefore runs first, which is registration order: options hooks before plugin hooks (`context/create-context.ts:388-390`). **[spike]** confirm the order on 1.7.7.
- `banned`, `banReason`, `banExpires` on `user`, enforced by a `session.create.before` check (`admin.ts:90-127`), and `impersonatedBy` on `session`.
- Server-side operations we call from our admin RPCs through `auth.api.*` instead of touching Better Auth's tables: `listUsers`, `setRole`, `banUser`, `unbanUser`, `listUserSessions`, `revokeUserSessions`, `removeUser`, `impersonateUser`, `stopImpersonating`. Each checks that the calling session's role is in `adminRoles` (default `["admin"]`), which our `RequireAdmin` middleware already guarantees.
- The plugin's `/api/auth/admin/*` HTTP routes exist on `auth.fetch`, but the Website proxy allowlist never forwards them ([§4.4](#44-the-sign-in-request-is-an-rpc)), so the only way in is our RPCs.

Why the plugin rather than a bare `additionalFields.role`: the operations are the point. Ban, revoke-everywhere and user listing are then library calls with the library's invariants, and impersonation is available later without a schema change. The cost is four columns and one hook, both handled by the automatic migration.

**Impersonation, when wanted:** `auth.api.impersonateUser({ body: { userId }, headers })` creates a session marked `impersonatedBy` and sets its cookie. Because an RPC reply cannot set a cookie, it needs either a proxied `POST /api/auth/admin/impersonate-user` added to the allowlist or a dedicated Backend HTTP route that forwards the `Set-Cookie` headers from `returnHeaders: true`. Not in this slice. See Q2.

### 4.3 The invite gate and role stamping

Two callbacks, both in Promise-land, both small:

- **`user.validateUserInfo({ email }, { source })`** runs before any user creation, including magic-link verify. Return `{ error: "not_invited" }` for an email with no `member` row. It becomes a 403 `APIError`, which the verify route turns into a redirect to `errorCallbackURL?error=not_invited`; a throw inside it fails closed as `validation_failed` (`init-options.ts:950-976`; `validate-user-info.ts:41-71`; `magic-link/index.ts:455-462`). This is Baton's `user.create.before` returning `false`, with a better browser outcome (Baton's gave `?error=failed_to_create_user`).
- **`databaseHooks.user.create.before(user)`** returns `{ data: { ...user, role: member.role } }` from the same member lookup (`db/with-hooks.ts:42-66`). Stamped at creation; later changes go through `setRole` and the member row together.

The member lookup inside `validateUserInfo` is a D1 read from a Promise callback; see §4.5 for how.

### 4.4 The sign-in request is an RPC

Better Auth's `POST /sign-in/magic-link` does not check whether the user exists; it emails anyone (`magic-link/index.ts:227-306`). Baton therefore never exposed it: its `loginFn` rate-limits by IP, checks membership, answers "check your email" either way, and only then calls `auth.api.signInMagicLink` (`refs/baton/src/routes/login.tsx:45-85`). Same here, as a public procedure:

```ts
// src/api/backend.ts
Rpc.make("RequestMagicLink", {
  payload: { email: Email },
  success: Schema.Void,
  error: TooManyRequests,
});
```

Handler (Effect, no callbacks): decode and normalise the email; `limit({ key: ip })`; `member` lookup via `SQL.D1`; if not invited, log and return `void`; else `auth.api.signInMagicLink({ body: { email, callbackURL: "/app", errorCallbackURL: "/sign-in" }, headers })`. The `headers` argument is required (`requireHeaders: true`, `index.ts:231`); pass the RPC message headers. With no `Origin` on a server-side call the CSRF middleware passes (`origin-check.ts:365-374`). A `BetterAuthApiError` from the call is a defect to the client, not a typed failure: the user should not learn why.

Consequences:

- **The Website proxy allowlist** (`src/routes/api.auth.$.ts`) admits `GET /api/auth/magic-link/verify` and `POST /api/auth/sign-out`, and returns 404 for everything else, as Baton's `api.auth.$.tsx:13-32` does. Sign-out goes through the proxy because the response must clear the cookie, which an RPC reply cannot do. `get-session` is not needed; `Me` is an RPC.
- **`sendMagicLink` only sends.** The gate has already run.

### 4.5 Promise callbacks

`sendMagicLink`, `validateUserInfo` and the `create.before` hook are awaited Promises called from inside Better Auth. Options are built once in the construction phase, so the callbacks cannot receive a per-request Effect context. Baton solved this by snapshotting the context at layer-build time and running callbacks with `Effect.runPromiseWith(context)` (`refs/baton/src/lib/LayerEx.ts:110-123`). The wrapper does the same for `secondaryStorage` (`BetterAuth.ts:187-196`). For us:

```ts
// construction phase
const email = yield* Cloudflare.Email.Send(AuthEmail);
const d1 = yield* Cloudflare.D1.QueryDatabase(AuthDb);
const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());

sendMagicLink: ({ email: to, url }) =>
  runPromise(email.send({ from, to, subject, text, html }).pipe(Effect.provide(RuntimeContext.phantom))),
validateUserInfo: ({ email }) =>
  runPromise(isInvited(email).pipe(Effect.map((ok) => ok ? undefined : { error: "not_invited" }))),
```

- Why it works: `RuntimeContext` is a phantom marker (`RuntimeContext.phantom = Layer.empty`, `packages/alchemy/src/RuntimeContext.ts:178`); the Email and D1 binding clients read `env` captured at init (`SendBinding.ts:13-34`). So the construction-time snapshot has what they need. **[spike]**: confirm from inside a callback; the fallback is the raw binding through `WorkerEnvironment`.
- `isInvited` must use the raw `QueryDatabase` client (`d1.prepare(...).bind(...).first()`), not `SQL.D1`, because `SQL.D1` is memoized on the per-event execution scope, which a construction snapshot does not carry (`packages/alchemy/src/SQL/D1.ts:53-63`). **[spike]**
- `sendMagicLink` is awaited by the endpoint (`magic-link/index.ts:293-301`), so a failed send rejects `signInMagicLink` and our handler sees it. Baton relied on this to avoid claiming "check your email" after a failed send. Better Auth's background tasks are awaited by a finalizer on the execution scope through `waitUntil` (`BetterAuth.ts:178-186`), so nothing is lost at response time.
- Per-request logging context is not available inside callbacks. Pass the email as a log annotation by hand, or log from the RPC handler around the call.

### 4.6 Sessions and sign-out

- `auth.getSession(headers)` returns `{ session, user } | null` and fails only on real errors (`BetterAuth.ts:220-240`). `user` includes `role`; `session` includes `ipAddress`, `userAgent`, `expiresAt`.
- Defaults: `expiresIn` 7 days, `updateAge` 1 day (session row refreshed on reads after a day), `cookieCache` off (`create-context.ts:312-316`). Prior Q6 (no cookie cache) holds.
- Sign-out: `POST /api/auth/sign-out` through the proxy; the route deletes the session row and clears the cookie (`api/routes/sign-out.ts:36-165`).
- Admin "disconnect everywhere": `auth.api.revokeUserSessions({ body: { userId }, headers })`. Ban: `auth.api.banUser`. Prior Q11 and Q5 hold with these calls; no hand-written SQL on Better Auth's tables.
- Devices page later: `auth.api.listSessions({ headers })` and `revokeSession` are core endpoints; rows already carry IP and user agent. No `session_device` table (reverses prior Q10).

### 4.7 Magic-link delivery in dev

Baton's "demo mode" was a link-delivery switch: `sendMagicLink` wrote the URL to KV and the login server function read it back for the page (`refs/baton/src/lib/Auth.ts:135-190`). KV was needed there because the callback and the page's request were different requests. Here they are the same one: `RequestMagicLink` calls `signInMagicLink`, which awaits `sendMagicLink` inside the call, so the callback can hand the URL back to the handler in memory.

- **Setting:** `MAGIC_LINK_DELIVERY` = `email` | `inline`, decoded with Schema. `inline` is honoured only when `Alchemy.ALCHEMY_DEV` is set; otherwise delivery is `email` whatever the value says. Dev defaults to `inline`.
- **Inline:** `sendMagicLink` logs the URL at info level and stores it in a module-level map keyed by email; the handler takes and deletes the entry after `signInMagicLink` resolves and returns it. `RequestMagicLink`'s success becomes `{ link: Option<string> }`. The sign-in page renders the link as an anchor ("Open your sign-in link") when present, so humans and browser-driving agents click it; shell agents read it from `logs/dev/current`.
- **Fallback with no code:** the local email simulator's `.eml` files under `.alchemy/local/email`.
- **Accounts for agents and humans:** the dev seed ([§3.3](#33-seeding-members-per-stage)) gives `a@a.com` (admin), `m1@m.com` and `m2@m.com` (members). Sign in as any of them through the inline link. No seed route, no admin UI needed to get in.
- The rate limit stays on in inline mode. Extending inline delivery to staging is a separate decision; the principled form would be "addresses under a reserved test domain always get inline delivery", not a flag.

## 5. RPC guards

Unchanged from the Yielded doc §7; the only difference is what the middleware calls:

- `RpcServer.toHttpEffect` merges HTTP headers into every RPC message, lowercased, so `options.headers.cookie` is the browser's cookie header (`node_modules/effect/src/rpc/RpcServer.ts:1107, 1165, 266-272`). The server implementation is a plain function provided as a service; `error` is the typed-failure option; `RpcGroup.middleware(M)` guards the procedures added so far, last added is outermost (`rpc/RpcMiddleware.ts:278-336`; `RpcGroup.ts:66-68, 297-305`). Reference fixture: `refs/effect/packages/platform/node/test/fixtures/rpc-schemas.ts:27-32, 77-87`.

```ts
// src/api/backend.ts
export class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", {}) {}
export class Forbidden extends Schema.TaggedError<Forbidden>()("Forbidden", {}) {}
export class CurrentUser extends Context.Service<CurrentUser, { id: string; email: string; role: Role }>()("CurrentUser") {}
export class CurrentUserMiddleware extends RpcMiddleware.Service<CurrentUserMiddleware, { provides: CurrentUser }>()("CurrentUserMiddleware", { error: Unauthorized }) {}
export class RequireAdmin extends RpcMiddleware.Service<RequireAdmin, { requires: CurrentUser }>()("RequireAdmin", { error: Forbidden }) {}

const PublicRpcs = RpcGroup.make(Rpc.make("Hello", ...), Rpc.make("Shout", ...), Rpc.make("RequestMagicLink", ...));
const MemberRpcs = RpcGroup.make(Rpc.make("Me", { success: Me })).middleware(CurrentUserMiddleware);
const AdminRpcs  = RpcGroup.make(Rpc.make("ListMembers", ...))   // read-only in this slice
  .middleware(RequireAdmin).middleware(CurrentUserMiddleware);
export const BackendRpcs = PublicRpcs.merge(MemberRpcs, AdminRpcs);
```

```ts
// src/backend/middleware.ts
CurrentUserMiddleware.of((effect, { headers }) =>
  Effect.gen(function* () {
    const session = yield* auth.getSession(new Headers({ cookie: headers.cookie ?? "" })).pipe(
      Effect.mapError(() => new Unauthorized()),
      Effect.catchDefect(() => Effect.fail(new Unauthorized())),
    );
    if (session === null) return yield* new Unauthorized();
    return yield* Effect.provideService(effect, CurrentUser, {
      id: session.user.id,
      email: session.user.email,
      role: session.user.role,
    });
  }).pipe(Effect.provide(RuntimeContext.phantom)),
);
```

The `RuntimeContext.phantom` adapter is what Alchemy's own middleware example uses, because the RPC and HttpApi boundaries do not carry Alchemy's marker (`examples/cloudflare-better-auth/src/middleware.ts:21-45`; guide `http-api-middleware.mdx:140`). One D1 read per guarded RPC (the session row joined to the user). A removed member keeps a session until it expires or an admin revokes it; `RequireMember` can re-check the `member` row per call if that matters (Q9).

## 6. Website: routes, pages and guards

| File                                                           | Purpose                                                                                                                                                                                                                       |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/routes/api.auth.$.ts`                                     | Allowlist: `GET /magic-link/verify` and `POST /sign-out` → `env.BACKEND.fetch(request)`; else 404. Splat syntax `$`, param `params._splat` (`refs/tan-start/docs/.../server-routes.md:295-313`).                              |
| `src/routes/index.tsx`                                         | Public page (existing) plus a "Sign in" link.                                                                                                                                                                                 |
| `src/routes/sign-in.tsx`                                       | One email field; calls the `RequestMagicLink` mutation; swaps to "Check your email" on success. `validateSearch` for `error` (from `errorCallbackURL`) and `redirect`. `beforeLoad`: if `Me` succeeds, go to the user's side. |
| `src/routes/admin.tsx`, `admin.index.tsx`, `admin.members.tsx` | Layout with guard and admin sidebar; a members table with add and remove.                                                                                                                                                     |
| `src/routes/app.tsx`, `app.index.tsx`                          | Layout with guard and member sidebar.                                                                                                                                                                                         |

- **Guard:** `beforeLoad: async ({ context, location }) => { const me = await loadMe(context.registry); if (!me) throw redirect({ to: "/sign-in", search: { redirect: location.href } }); if (me.role !== "admin") throw redirect({ to: "/app" }); return { me }; }` (`refs/tan-router/docs/router/guide/authenticated-routes.md:34-51`). Two disjoint roles bouncing to each other's side cannot loop (Baton `MemberServerFnMiddleware.ts:26-43`). The guard is the outer layer; the RPC middleware is the boundary (prior R5).
- **`Me` is a keep-alive query** (`timeToLive: Infinity`, reactivity key `"me"`) per the session-data exception in `src/query.ts`; sign-out invalidates it. `beforeLoad` runs on every navigation but reads the registry after the first load. Per-layout, not root, so public pages make no auth call (Q10).
- **After the link:** verify redirects to `callbackURL: "/app"`. The `/app` guard bounces admins to `/admin`. No `login-callback` route is needed (Q11). Failures land on `/sign-in?error=INVALID_TOKEN` or `?error=not_invited`; show one neutral message for either.
- **Sign-out** is a browser `fetch("/api/auth/sign-out", { method: "POST", credentials: "include" })` followed by invalidating `"me"` and navigating home. Same-origin, so the Origin check passes.
- **Astryx:** `shell-side-nav` for both sides (`AppShell` + `SideNav` with `SideNavHeading`, `SideNavSection`, `SideNavItem`; set the router `Link` through `LinkProvider`), `login` card for the sign-in page (one `TextInput type="email"` and a primary `Button`), `table` for the members list. Templates import `@heroicons/react`, which is not installed; use Astryx's semantic icon names.

## 7. Effect idioms to hold to

- The Promise seam is confined to `src/backend/auth.ts`: three callbacks, each one `runPromise(effect)`. Everything they call is an `Effect.fn("Auth.sendMagicLink")`.
- Guards, handlers and the gate are `Effect.gen` or `Effect.fn`; dispatch on role with `Match`; errors are `Schema.TaggedError` in `src/api/`.
- Email addresses are a Schema (`Email`, lowercase and trimmed by decode) shared by the `RequestMagicLink` payload and the `member` reads. No hand-rolled checks.
- `Config.*` in the construction phase only.
- Better Auth's types stay inside `src/backend/auth.ts`; `CurrentUser` is our Schema, built from `session.user`.

## 8. Dev and staging specifics

| Concern       | Dev                                                     | Staging                                          |
| ------------- | ------------------------------------------------------- | ------------------------------------------------ |
| D1            | simulator; both migration owners apply locally          | real D1; Action + `./migrations` at deploy       |
| Email         | `.eml` under `.alchemy/local/email`; grep the link      | Email Service; domain or verified addresses (Q4) |
| `AUTH_ORIGIN` | `http://localhost:<WEBSITE_PORT>`                       | staging `workers.dev` URL                        |
| Cookies       | not `Secure` (http baseURL)                             | `__Secure-better-auth.session_token`             |
| Secret        | `Random` in `dev` state                                 | `Random` in `staging` state                      |
| Rate limit    | in-memory binding                                       | real namespace                                   |
| Members       | `seed/dev.sql`: `a@a.com` admin, `m1@m.com`, `m2@m.com` | `seed/staging.sql`: the operator's admin row     |

Dev sign-in uses inline link delivery ([§4.7](#47-magic-link-delivery-in-dev), Q8); staging always emails.

## 9. What changes against the earlier decisions

| Prior                        | Now                                                                                                                               |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Q1 email code                | Magic link, 5-minute expiry, hashed token. Cross-device works.                                                                    |
| Q2 open sign-up              | **Invite-only**: `member` table with `role`, seeded per stage; `validateUserInfo` gate; same reply for non-members (R2 restored). |
| Q4 Drizzle                   | Not applicable; Kysely is internal to Better Auth. `drizzle-orm` is not added.                                                    |
| Q5 ban                       | `auth.api.banUser` and `revokeUserSessions` from the admin plugin, when needed.                                                   |
| Q10 `session_device`         | Not needed; `session.ipAddress` and `userAgent` are built in.                                                                     |
| Q12 one migrations directory | Two owners: the wrapper's Action for auth tables, `./migrations` for ours (Q3 below).                                             |

## 10. Spike

Build order, each step typechecking alone:

1. `AuthDb`, `AuthEmail`, `SignInLimit`, `migrations/0001_member.sql`; Backend becomes `Cloudflare.Worker` with path branching; `SQL.D1` smoke query. No Better Auth yet.
2. Add `@alchemy.run/better-auth`; `BetterAuth({...})` with the three callbacks; `alchemy dev` applies the Action locally; `curl` the verify route after calling `RequestMagicLink` from a script; read the link from `.alchemy/local/email`.
3. `CurrentUserMiddleware`, `RequireAdmin`, `Me`, `ListMembers`.
4. Website: `api.auth.$`, sign-in page, `/admin` with a read-only members list, `/app`, sign-out.
5. Deploy to staging; sign in as the seeded admin with real mail from `mail.mw10013.com`, from a phone with a link requested on a laptop.

Checks that decide whether the design holds (there is no library fallback left; a failure here changes the design, not the library):

- **S1:** the Alchemy Action migrates the schema under `alchemy dev` and on deploy, and a schema change (adding a field) re-runs it.
- **S2:** `email.send` and the raw D1 client work from inside `sendMagicLink` and `validateUserInfo` with the construction-time context snapshot.
- **S3:** the verify route's 302 and `Set-Cookie` reach the browser through the Website proxy over the binding.
- **S4:** `auth.getSession` in `RpcMiddleware` works for browser and SSR calls; `ipAddress` is the real client IP.
- **S5:** a non-member gets "check your email" with no email sent, and a crafted verify for a non-member lands on `?error=not_invited`.

## 11. Decisions and open questions

Reviewed in Plannotator on 2026-10-10. Accepted as recommended: Q2 (`admin()`), Q3 (automatic migrations), Q5 (Cloudflare rate-limit binding), Q6 (`Cloudflare.Worker`), Q8 (inline link delivery under `ALCHEMY_DEV`), Q9 (delete sessions on removal), Q10 (per-layout guard), Q11 (`/app` plus bounce).

Changed by the review:

| #   | Decision                                                                                                                                                                                        |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Invite-only stands, but **no `ADMIN_EMAILS`**: admins are `member` rows with `role = 'admin'`, seeded per stage ([§3.3](#33-seeding-members-per-stage)).                                        |
| Q4  | **Sending domain exists: `mail.mw10013.com`.** Staging sends real mail; `AUTH_EMAIL_FROM` is an address on it, and the binding can carry `allowedSenderAddresses` for it.                       |
| Q12 | **No members admin UI in this slice.** Dev members come from `seed/dev.sql` (`a@a.com` admin, `m1@m.com`, `m2@m.com`); the admin side shows a read-only list. Add and remove come with tenants. |

Settled after the review:

| #   | Decision                                                                                                                                                                                                                                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Q7  | `AUTH_ORIGIN` per stage, as recommended.                                                                                                                                                                                                                                                                                             |
| Q13 | Per-stage seed files committed: `seed/dev.sql`, `seed/staging.sql`, `seed/production.sql`. Staging and production hold one admin row each.                                                                                                                                                                                           |
| Q14 | **`db:reset` script** composed from the existing `dev:stop` / `dev:start`: stop dev, `alchemy state delete` the dev `AuthDb` record, remove `.alchemy/local`, start dev. It returns with a fresh, migrated, seeded database ([§3.3](#33-seeding-members-per-stage)). Named for what it does when it returns, not for the state edit. |

## Appendix A: File plan

| Path                                                                                                  | Role                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `alchemy.run.ts`                                                                                      | `Secrets.DotEnv` per stage; stack outputs                                                                                                      |
| `src/backend/resources.ts`                                                                            | `AuthDb`, `AuthEmail`, `SignInLimit` descriptors                                                                                               |
| `migrations/0001_member.sql`, `seed/<stage>.sql`                                                      | `member` table                                                                                                                                 |
| `src/api/backend.ts`                                                                                  | `Email` schema, `CurrentUser`, `Unauthorized`, `Forbidden`, middleware declarations, `RequestMagicLink`, `Me`, member procedures, grouped RPCs |
| `src/backend/auth.ts`                                                                                 | `BetterAuth({...})`: options, the three callbacks, `runPromise` snapshot, `isInvited`                                                          |
| `src/backend/middleware.ts`                                                                           | `CurrentUserMiddleware` and `RequireAdmin` layers                                                                                              |
| `src/backend/members.ts`                                                                              | `member` table queries via `SQL.D1`                                                                                                            |
| `src/backend/handlers.ts`                                                                             | `RequestMagicLink`, `Me`, `ListMembers`                                                                                                        |
| `src/backend/worker.ts`                                                                               | `Cloudflare.Worker`; bindings, config, `BetterAuth` in construction; path branching in `fetch`                                                 |
| `src/routes/api.auth.$.ts`, `sign-in.tsx`, `admin.tsx`, `admin.index.tsx`, `app.tsx`, `app.index.tsx` | Website routes                                                                                                                                 |
| `src/components/AdminShell.tsx`, `MemberShell.tsx`, `SignInPage.tsx`                                  | Astryx pages from `shell-side-nav`, `login`, `table`                                                                                           |
