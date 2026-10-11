# Research: Integrating Yielded Auth

Date: 2026-10-10  
Status: **superseded 2026-10-10.** The library decision was reversed to Better Auth; see [better-auth-integration-research.md](./better-auth-integration-research.md) §0 for why. Kept for the Yielded Auth findings (two-code sign-up, managed storage gaps, Drizzle status).  
Versions: Alchemy `2.0.0-beta.81`, Effect `4.0.1`, `@yielded/auth` `0.1.0-beta.32`, `@tanstack/react-start` `1.168.60`, Astryx `0.6.5`.  
Vocabulary: [glossary](./glossary.md). Decisions D-numbers: [IPC research](./start-to-effect-worker-ipc-research.md). Decisions Q1–Q12: [auth-library-research.md §10](./auth-library-research.md#10-decisions-round-1-2026-10-10) (written "prior Q4" etc. below to avoid clashing with this document's questions).

Sources: `refs/yielded-auth` (source, docs, examples), `refs/alchemy` (packages and examples), `refs/effect`, `refs/tan-router`, `refs/tan-start`, `refs/baton`, `refs/cloudflare-docs`, the installed `node_modules`, and two probes: a download of the Drizzle build Alchemy pins, and `pnpm view` of npm metadata. Anchors are relative to the named ref. Claims I could not confirm in source or docs are marked **[unverified]** and go to the spike.

## Summary

Three findings change the plan that §6 and §9 of the library research sketched:

- **Email-code sign-in only signs in an account that already exists.** `EmailSignInTargets.lookup` must return an active subject with a verified identifier and an active email credential (`packages/auth/src/email/EmailSignInTargets.ts:7-21`). For an unknown email, the request still returns a receipt (so nothing is leaked) but no code is sent, and completion fails with `EmailRejected` (`packages/auth/src/email/module.ts:264-301`). Open sign-up (prior Q2) therefore needs a second strategy, `Email.makeRegistration`, in the same namespace. Registration does not issue a session: "Start a fresh email sign-in afterward" (`docs/.../guide/codes.md:170-191`). **A new user gets two codes**, one to register and one to sign in. Options are in [§6](#6-the-sign-in-flow-and-the-two-code-problem) and [Q1](#11-questions-round-1).
- **The managed D1 composition does not cover email codes.** `Persistence.managed(...)` creates and serves `identifiers`, `credentials`, `sessions` and `pending` for our strategy set. The `proofs` and `emailCredentials` roles are added only when a strategy declares `addresses` (`packages/auth-persistence/src/internal/persistence.ts:137-147`), which `makeCode` and `makeRegistration` do not. We must declare those two tables ourselves and wire three explicit D1 services: `makeEmailSignInServices`, `makeProofPersistenceServices`, `makeEmailRegistrationServices` (`packages/auth-persistence-drizzle/src/D1.ts:17-40`; `codes.md:179-183`). The Drizzle footprint is three `sqliteTable`s (ours: `user`, `auth_proofs`, `auth_email_credentials`), not one. Still no Drizzle queries.
- **The Drizzle question (prior K1) is mostly answered.** The build Alchemy pins, `drizzle-orm@1.0.0-rc.5-ab785fc`, already uses `Schema.TaggedError` in the Effect core and cache modules (probe: 0 hits for `TaggedErrorClass`), and the `effect-d1` entry imports nothing else that is missing from Effect 4.0.1. Two residues remain: its `.d.ts` files import `effect/unstable/sql/SqlError`, which our `skipLibCheck: true` masks, and `effect-schema/column.js` still calls `Schema.isLengthBetween`, which the D1 path does not import. So no patch is needed. Confirm with a real install (K1 in [§10](#10-spike-and-kill-criteria-revised)).

Other findings that shape the design:

- **Alchemy gives us everything on the infrastructure side with no custom Actions:** `Cloudflare.D1.Database({ migrations: "./migrations" })` applies plain SQL files in dev and on deploy; `Cloudflare.Email.SendEmail` is a Worker binding that the local simulator stubs to `.eml` files; `Alchemy.Random` mints stable secrets held in state; `Config.Redacted` in the Worker's construction phase becomes a secret binding ([§2](#2-infrastructure-with-alchemy)).
- **The Backend should become a `Cloudflare.Worker` that branches on path,** exactly as Alchemy's git-service example does (`refs/alchemy/examples/cloudflare-git-service/src/api/host.ts:22-34`): `/api/auth/*` to Yielded Auth's `HttpRouter`, everything else to `RpcServer.toHttpEffect`. `RpcWorker` adds only a typed `bind` we don't use ([§1](#1-architecture)).
- **Yielded Auth must be built per request on Workers,** and its email delivery queue dies with the request scope. The fix is a `ProofDispatchScheduler` that hands work to `WorkerExecutionContext.waitUntil` ([§4.5](#45-email-delivery-and-the-request-scope)). Default rate limiters reset with every request for the same reason ([§4.7](#47-rate-limits)).
- **`verifySession` fits `RpcMiddleware` directly.** `RpcServer.toHttpEffect` merges HTTP headers, including `cookie`, into every RPC message, and the middleware receives them as `options.headers` ([§7](#7-rpc-guards)).
- **Website side is small:** one more proxy route (`/api/auth/$`), one sign-in page, two layout routes with `beforeLoad` guards, two sidebars from Astryx's `shell-side-nav` template ([§8](#8-website-routes-pages-and-guards)).

**Recommendation:** proceed with the spike on this design, with the two-code sign-up for now (Q1), Alchemy's Drizzle pin (Q3), `.eml`-file email in dev and a Cloudflare Email Service domain for staging (Q4), and no "your devices" page in this slice (Q10). Eleven questions, each with a recommendation, are in [§11](#11-questions-round-1).

## 1. Architecture

Unchanged from the library research §2, now concrete:

```
Browser ─ POST /api/auth/<action> ─► Website: api.auth.$ (GET+POST pass-through) ─binding─► Backend: Yielded Auth HttpRouter ─► D1
Browser ─ POST /api/rpc ──────────► Website: api.rpc (existing)                 ─binding─► Backend: RpcServer
                                                                                            └─ CurrentUserMiddleware: verifySession(cookie)
SSR ──── beforeLoad ─────────────► BackendClient (cookie forwarded, existing)    ─binding─► Backend: Me procedure
```

**Backend `fetch` branches on path.** Alchemy's `fetch` is any `HttpEffect`; every request gets `HttpServerRequest` with `remoteAddress` filled from `cf-connecting-ip` (`refs/alchemy/packages/alchemy/src/Cloudflare/Workers/HttpServer.ts:23-49`). The git-service example is the template:

```ts
// refs/alchemy/examples/cloudflare-git-service/src/api/host.ts:22-34 (shape)
fetch: Effect.scoped(
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (request.url.startsWith("/api/auth")) return yield* authFetch;
    return yield* rpcFetch;
  }),
);
```

- **Switch `Backend` from `Cloudflare.RpcWorker` to `Cloudflare.Worker`.** `RpcWorker` is documented as "functionally identical" to a `Worker` returning `{ fetch: RpcServer.toHttpEffect(...) }` (`RpcWorker.ts:246-248`); its extra is `RpcWorker.bind`, a typed client over the service binding that the Website does not use (it runs its own `RpcClient` over `env.BACKEND.fetch`, `src/backend-client.ts:17-23`). `WebsiteEnv.BACKEND` then types as a plain `Service`, which is all `serverFetch` needs. See Q7.
- **The RPC server is rebuilt per request today already** (`RpcServer.toHttpEffect` forks into the request scope, `node_modules/effect/src/rpc/RpcServer.ts:1286-1316`), so building the auth routes per request ([§4.4](#44-per-request-construction)) is the same cost model.
- **Website forwards everything the Backend needs.** The browser proxy forwards the whole `Request` (`src/routes/api.rpc.ts:42`), so `Cookie`, `Origin`, `x-effect-auth-csrf` and `CF-Connecting-IP` all arrive. SSR calls copy only `cookie` (`src/backend-client.ts:18-23`); they do reads only (`Me`), which need no Origin.

## 2. Infrastructure with Alchemy

### 2.1 D1

`Cloudflare.D1.Database(id, props)` (`refs/alchemy/packages/alchemy/src/Cloudflare/D1/Database.ts:41-109`):

- `migrations: "./migrations"` applies plain `.sql` files in order, tracked in `__alchemy_migrations`. On deploy it runs over the D1 HTTP API; under `alchemy dev` the database is virtual (DO SQLite under `.alchemy/local/d1`) and the same pipeline runs through an ephemeral workerd gateway (`Database.ts:535-660`). This is prior Q12, confirmed.
- `readReplication: { mode: "disabled" }` for now. Yielded Auth wants the primary binding, not a replica session (`docs/.../reference/adapters.md:157-162`).
- Binding it in the Effect Worker is a service, not an `env` key:
  ```ts
  const d1 = yield* Cloudflare.D1.QueryDatabase(AuthDb);   // Construction phase
  ...
  }).pipe(Effect.provide(Cloudflare.D1.QueryDatabaseBinding))
  ```
  `d1.raw` is an `Effect<D1Database>`; `d1.batch` is atomic (`D1/QueryDatabase.ts:111-134`).
- **Effect SQL client:** `alchemy/SQL/D1` exports `SQL.D1(d1)` (a memoized `D1Client`, one per request) and `SQL.D1Layer(d1)` (provides `D1Client` and `SqlClient`) (`packages/alchemy/src/SQL/D1.ts:53-90`). `@effect/sql-d1@4.0.1` is already in the tree as Alchemy's dependency, but importing `@effect/sql-d1/D1Client` from our own code means adding it to `package.json` (it is not hoisted). Yielded Auth's D1 adapter needs `D1Client` provided (`packages/auth-persistence-drizzle/src/D1.ts:82-89`), so `SQL.D1Layer(d1)` is the bridge. Closest example: `refs/alchemy/examples/cloudflare-effect-sql-d1/src/Api.ts`.
- D1 `batch()` is a transaction: "If a statement in the sequence fails ... it aborts or rolls back the entire sequence" (`refs/cloudflare-docs/src/content/docs/d1/worker-api/d1-database.mdx:99`). That is what Yielded Auth's in-batch assertions rely on (prior K2 stays a spike item because the library tests it only against emulated SQLite).

### 2.2 Email

- **Cloudflare Email Service binding.** `Cloudflare.Email.SendEmail("AuthEmail", { allowedSenderAddresses?: [...] })` is a Worker-only binding (`packages/alchemy/src/Cloudflare/Email/SendEmail.ts:7-28`). In the Worker: `const email = yield* Cloudflare.Email.Send(AuthEmail)` plus `Effect.provide(Cloudflare.Email.SendBinding)`; `email.send({ from, to, subject, text, html })` fails with `SendEmailError` (`Email/Send.ts:45-83`). No MIME building needed.
- **Local dev is simulated.** The runtime stubs the binding and writes `.eml` files under `.alchemy/local/email`, logging the path (`packages/cloudflare-runtime/src/core/bindings/send-email/SendEmailBinding.worker.ts`). This is how we read codes in dev. `.pipe(Alchemy.remote())` on the descriptor sends real mail from dev.
- **Staging needs a sending domain.** "Before you onboard a sending domain, you can send emails only to verified destination addresses in your account" (`refs/cloudflare-docs/.../email-service/platform/limits.mdx`). Sends to verified addresses are free and need no domain. See Q4.
- Yielded Auth's docs name this exact path: declare `Cloudflare.Email.SendEmail`, acquire `Cloudflare.Email.Send` in construction, build the delivery layer per request, map `SendEmailError` to `EmailAcceptanceUnknown` (`docs/.../guide/email-delivery.md:90-104`).

### 2.3 Secrets

Yielded Auth needs two keyrings for our configuration, and no `AUTH_SECRET` (uncached stateful sessions don't sign anything, `docs/.../guide/sessions.mdx:45`):

| Key                                                      | Used for                                                                     | Format                                                                                                                              |
| -------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Proof keys (`Proofs.ProofKeys.layer`)                    | HMAC of the 6-digit codes                                                    | `{ activeKeyId, keys: [{ id, material: Redacted }] }`, material base64url of ≥32 bytes (`packages/auth/src/proofs/crypto.ts:18-45`) |
| Request-binding keys (`Auth.RequestBindingConfig.layer`) | The HttpOnly cookie that ties "request code" and "enter code" to one browser | same keyring shape plus `lifetimeMillis` (1 s to 30 min) and `generation` (`packages/auth/src/operations/requestBinding.ts:37-52`)  |

- **Mint them with `Alchemy.Random`.** `yield* Alchemy.Random("AuthProofKey")` mints 32 random bytes once, stores them `Redacted` in state, and returns the same value on every reconcile; `.text` yielded in the construction phase becomes a secret binding (`packages/alchemy/src/Random.ts`; this is what `@alchemy.run/better-auth` does for its secret, `packages/better-auth/src/BetterAuth.ts:151-164`). Each stage gets its own keys automatically. Rotation is a second `Random` with a new id, kept alongside the old one until proofs expire (`adapters.md:236-237`).
- `Random` gives hex text (`Random.ts:8, 53`); the keyring decodes `material` with `Base64Url.decode` and requires ≥32 bytes (`packages/auth/src/proofs/crypto.ts:162-168`). Hex characters are valid base64url, so the 64-character hex string decodes to 48 bytes and would pass, but with only 256 bits of entropy spread over them. Cleaner: decode the hex to bytes and `Base64Url.encode` them once in the construction phase.
- **Scalars from `.env`:** `Config.String("ADMIN_EMAILS")`, `Config.String("AUTH_ORIGIN")` in the construction phase bind as `plain_text`; `Config.Redacted` binds as `secret_text` (`refs/alchemy/website/src/content/docs/environments/secrets.mdx:18-136`). Alchemy loads `.env` itself; per-stage files via `Alchemy.Secrets.DotEnv(({ stage }) => ({ path: [".env", `.env.${stage}`] }))` in the stack options.

### 2.4 Rate limiting

`Cloudflare.RateLimit("AuthIngress", { namespaceId, simple: { limit, period: 60 } })` with `Effect.provide(Cloudflare.Workers.RateLimitBinding)`; `limit({ key })` returns `{ success }`; local dev has an in-memory implementation (`packages/alchemy/src/Cloudflare/Workers/RateLimit.ts:30-43`, `RateLimitBinding.ts:27-45`). Yielded Auth has a documented adapter for it, but only for the network-ingress limiter ([§4.7](#47-rate-limits)).

### 2.5 `alchemy.run.ts` shape

```ts
// src/backend/database.ts (the examples keep descriptors next to the Worker that owns them)
export const AuthDb = Cloudflare.D1.Database("AuthDb", {
  migrations: "./migrations",
  readReplication: { mode: "disabled" },
});
export const AuthEmail = Cloudflare.Email.SendEmail("AuthEmail");
// Backend (src/backend/worker.ts) yields QueryDatabase(AuthDb), Email.Send(AuthEmail),
// Random("AuthProofKey"), Random("AuthBindingKey"), Config.String("AUTH_ORIGIN"), Config.String("ADMIN_EMAILS").
```

Both descriptors are plain functions (`Database = Resource<Database>("Cloudflare.D1Database")`, `Database.ts:264`; `SendEmail: (id, props?) => Effect<SendEmail>`, `SendEmail.ts:98`), unlike the class form `Website` and `Backend` use. Alchemy's examples put them in `src/database.ts` next to the Worker (`examples/cloudflare-effect-sql-d1/src/database.ts:8`, `examples/cloudflare-better-auth/src/database.ts:3`).

## 3. Schema

### 3.1 Our tables

```sql
CREATE TABLE user (
  id                text PRIMARY KEY,          -- SubjectId, random UUID
  email             text NOT NULL UNIQUE,
  role              text NOT NULL CHECK (role IN ('admin','user')),
  active            integer NOT NULL DEFAULT 1,
  security_revision text NOT NULL,
  created_at        integer NOT NULL DEFAULT (unixepoch())
);
```

- Required by the managed subject mapping: an `id` (text or integer), a status column with an explicit `activeValue`, a text `securityRevision`, and a unique `id` (`packages/auth-persistence/src/internal/persistence.ts:184-200, 312-315`). Every other column (here `role`, `email`) is treated as a requirement input re-checked inside D1 batch predicates (`internal/storage-mapping.ts:86-100`; `adapters.md:315-318`).
- `email` on `user` duplicates `auth_identifiers.value`. It is convenient for admin listing and the `Me` procedure; the library's source of truth is the identifier row. Keep it, written at provisioning, or drop it and join. See Q9.
- `session_device` (prior Q10) is deferred to the next slice (Q10 below).

### 3.2 Yielded Auth's tables

With `makeCode` + `makeRegistration` + `Sessions.stateful()`, `Persistence.managed({ prefix: "auth" })` declares `auth_identifiers`, `auth_credentials`, `auth_sessions`, `auth_pending`. Two more are required by email codes and must be declared by us to the same column spec (`internal/storage-tables.ts:53-235`): `auth_proofs` (code issuance and redemption) and `auth_email_credentials` (the "active configured email credential" that `EmailSignInTargets.lookup` joins on).

The verbatim DDL for all six is in `refs/yielded-auth/examples/persistence-drizzle-managed/drizzle/20260915003609_initial/migration.sql` (prefix `customer_auth` there). Column names are snake_case of the camelCase spec; the subject column type follows our `id` type (`storage-tables.ts:243-262`).

### 3.3 How the tables get into D1, and where Drizzle sits

Prior Q4 and Q12 hold, with a larger Drizzle footprint than expected:

| Artifact                                | Written with                                                                | Why                                                                                                                                                                  |
| --------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `migrations/0001_auth.sql`              | Hand-written SQL, copied from the example's `migration.sql` plus our `user` | Applied by Alchemy in dev and deploy. Yielded Auth's `migrationsLayer` is not used.                                                                                  |
| `src/backend/auth/schema.ts`            | Three Drizzle `sqliteTable`s: `user`, `authProofs`, `authEmailCredentials`  | The adapter needs table objects to compile SQL text; it never executes Drizzle queries (`drizzle/native-sql-table.ts:28-30`). `storage.schema` gives the other four. |
| Our own queries (`Me`, admin user list) | `SQL.D1` tagged templates                                                   | No Drizzle in domain code.                                                                                                                                           |

- The adapter validates columns and unique keys against the live database on first use and caches a failure until the layer is rebuilt (`adapters.md:99-102`). With per-request construction ([§4.4](#44-per-request-construction)) that is per request, so a mismatch shows up on the first auth call, not at deploy. Spike item K6.
- Optional: run Drizzle Kit once against the exported tables to regenerate the DDL after a library upgrade (`adapters.md:63-68`), and commit the output into `migrations/`. `drizzle-kit` is a dev dependency then, never a runtime one.

## 4. Yielded Auth in the Backend

### 4.1 Contract (`src/api/auth.ts`, browser-safe)

Copy `refs/yielded-auth/examples/auth/src/login-contract.ts:12-119` minus the OAuth actions. Six actions: `beginEmailSignIn`, `requestEmailCode`, `completeEmailSignIn` (strategy `email`), `beginEmailRegistration`, `registerEmail`, `completeEmailRegistration` (strategy `emailRegistration`). Every contract also gets `getSession`, `requireSession`, `signOut`, `renewSession` (`docs/.../guide/http-and-client.mdx:76`). Routes are `POST /auth/<action>` under `basePath` (`packages/auth/src/operations/actions.ts:287,300`); set `basePath: "/api/auth"` or mount with a prefix.

- Claims: `Schema.Struct({ email: AuthSchema.Email, role: Schema.Literals(["admin","user"]) })`. Claims are resolved at session issuance and stored in the session record, so a role change must bump `security_revision` to take effect (Q9).
- The six action names are the closed auth surface (prior R7): nothing else is routable.

### 4.2 Auth, strategies, persistence (`src/backend/auth/*.ts`)

```ts
export const AppAuth = Auth.make(AuthApi, {
  sessions: Sessions.stateful(), // defaults: maxAge 30 d, idle 7 d, renewAfter 1 d
  strategies: {
    email: Email.makeCode({ namespace: "app/email" }), // digits 6, policy: 5 min, 5 attempts
    emailRegistration: Email.makeRegistration({
      namespace: "app/email",
      registration: Schema.Struct({}),
    }),
  },
  defaultStrategy: "email",
});
export const Persistence = AuthPersistence.make(AppAuth); // from "@yielded/auth-persistence-drizzle/D1"
export const storage = Persistence.managed({
  subjects: {
    table: user,
    id: "id",
    status: "active",
    activeValue: true,
    securityRevision: "securityRevision",
    idCodec: AuthSchema.SubjectId,
    requirements: () => Effect.succeed(emailRequirement),
  },
  prefix: "auth",
});
```

- `makeCode` defaults: `digits ?? 6`, `policy ?? defaultProofPolicy` with `lifetimeMillis: 300_000` and `maximumFailedAttempts: 5` (`packages/auth/src/email/definition.ts:13-17, 103-111`; `packages/auth/src/proofs/policy.ts:62-74`). That is prior Q1 exactly.
- Same `namespace` for both strategies so they share the request-binding cookie (`codes.md:172-173`).
- `emailRequirement` must accept possession-only evidence, which is what a code proves: `{ alternatives: [{ factors: ["possession"], minimumCredentials: 1, userVerified: false, phishingResistant: false }], maximumAgeMillis: ... }` (`examples/auth/src/email-methods-consumer.ts:88-98`). The account examples' knowledge-or-passkey requirement would reject codes.
- `Persistence.layer` requires `Crypto`, `Config` and `SqlClient`/`D1Client` (`packages/auth-persistence/src/internal/configuration.ts:286-295`; `D1.ts:82-89`). No `Provisioning` service: that port is typed only for password strategies.

### 4.3 The explicit email services

Because managed storage does not cover codes ([Summary](#summary)), three more layers are ours to build from the adapter's helpers, following the library's own D1 test (`packages/auth-persistence-drizzle/test/email-registration.test.ts:37-125`):

| Service                                                      | Built from                                                                                  | Notes                                      |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `Email.EmailSignInTargets`                                   | `emailSignInTargetsLayer(D1.makeEmailSignInServices(emailMapping))`                         | the "does this email have an account" join |
| `Proofs.ProofPersistence`                                    | `proofPersistenceLayer(D1.makeProofPersistenceServices(proofMapping))`                      | code issuance and redemption rows          |
| `AppAuth.strategies.emailRegistration.RegistrationAuthority` | `emailRegistrationLayer(..., D1.makeEmailRegistrationServices(emailMapping, proofMapping))` | provisioning lives here                    |

- `emailMapping` is `(yield* makeStorageMappings(storage)).emails()` spread with `mode: "atomic"`, `d1: { primary: true }`, a clock, identifier D1 conditions, constraints, and `provisioning` (`test/email-registration.test.ts:37-117`; `makeStorageMappings` from `@yielded/auth-persistence/Adapter`). The test is the only worked example; the docs do not show this composition. **[unverified in our shape]**: passing our own `proofs` and `emailCredentials` tables to `makeStorageMappings` alongside `storage.tables`. The alternative is adding a hidden `Email.makeAddresses` strategy so managed storage creates both tables, at the cost of providing its `EmailActionEvidence` service with a stub. Spike item K6.
- **Role assignment at sign-up** is `provisioning.encodeSubjectInsert(intent, { nativeSubjectId, securityRevision })`, a pure synchronous function returning the `user` row (`packages/auth-persistence/src/internal/models/email-model.ts:232-249, 377-393`). `intent.identifier.value` is the email; compare it against `ADMIN_EMAILS` and return `{ id, email, role, active: true, securityRevision }`. It runs inside the registration batch, so the subject, identifier, email credential and proof consumption commit atomically (`adapters.md:368-370`). This replaces prior §6 item 2 ("provisions the user row in the same D1 batch"), confirmed.
- `SessionClaims` for the `email` strategy: `resolve({ subjectId, credential })` reads the `user` row with `SQL.D1` and returns `{ email, role }` (`codes.md:144-150`).
- `Email.EmailReturnTargets.exactRoutes(["/app", "/admin"])`: the post-sign-in target the client asks for is validated server-side (`codes.md:148`).

### 4.4 Per-request construction

The only Workers recipe in the docs builds the routes inside `fetch` and says: "Do not cache the built Auth service or the captured `RuntimeContext` across requests" (`docs/.../guide/rate-limits.md:132-185`). In Alchemy terms:

```ts
// Construction phase: bindings and config only (runs once per isolate, scope never closes).
const d1 = yield* Cloudflare.D1.QueryDatabase(AuthDb);
const email = yield* Cloudflare.Email.Send(AuthEmail);
const ctx = yield* Cloudflare.WorkerExecutionContext;      // deferred to the live per-event context
const proofKey = yield* (yield* Alchemy.Random("AuthProofKey")).text;
...
return { fetch: Effect.scoped(Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (request.url.startsWith("/api/auth")) {
    const handle = yield* HttpRouter.toHttpEffect(AuthRoutes).pipe(Effect.orDie);  // AuthRoutes = http.routes() + layers
    return yield* handle;
  }
  return yield* rpcFetch;
})) };
```

- `AuthRoutes` is a Layer description built once outside `fetch` and provided per request; the layers it needs are `SQL.D1Layer(d1)`, the keyrings, `WebCrypto.layerWebCrypto` (enough for stateful sessions and numeric codes; Argon2 Wasm is only for passwords, `reference/crypto.md:62-76`), `HttpPlatform.layer`, `Etag.layerWeak`, and ours from §4.3.
- Cost: one Layer build per auth request. The RPC branch pays the same today. If `cf o11y` shows it matters, `ExecutionMemo` (`alchemy/Runtime/ExecutionMemo`) memoizes per event, which is still per request. Accept for the spike.

### 4.5 Email delivery and the request scope

- `EmailDelivery.send(message)` takes `{ to, subject, text: Redacted, html?: Redacted }` and fails with `EmailNotAccepted | EmailAcceptanceUnknown` (`packages/auth/src/email-delivery/service.ts:15-40`). Our implementation calls `email.send({ from, to, subject, text })` and maps `SendEmailError` to `EmailAcceptanceUnknown` (never retry an uncertain send, `email-delivery.md:6-15`).
- **The default scheduler is an in-process queue forked into Auth's scope; closing the scope cancels delivery** (`packages/auth/src/proofs/ProofDispatchScheduler.ts:27-61`; `email-delivery.md:114-120`). With per-request construction, the scope closes when the response is sent, so the code may never go out. The docs: "Hosts that suspend after a response, including Workers, must keep it alive through their background-work mechanism" and "Override `Proofs.ProofDispatchScheduler` if your host requires a post-response start" (`email-delivery.md:118-123`).
- **Recommended:** a custom `ProofDispatchScheduler` whose `schedule(work)` is `ctx.waitUntil(work)`. Alchemy's `WorkerExecutionContext.waitUntil(effect)` forks with the caller's context and registers with the platform `ctx.waitUntil` (`packages/alchemy/src/Cloudflare/Workers/WorkerRuntime.ts:34-66`). This is the agent's inference from the scheduler interface, not a documented recipe **[unverified]**: spike item K3.
- Alternative: `ProofDispatchScheduler.layerInline` sends inside the request. Simplest, but the docs reserve it for trusted workflows because response timing reveals whether an email has an account (`ProofDispatchScheduler.ts:63-65`). Acceptable for the spike only if the `waitUntil` scheduler fails (Q5).
- Sender address and copy: `from` from `Config.String("AUTH_EMAIL_FROM")`; subject and body come from the library's renderer, overridable via `EmailDelivery.EmailRenderer` (`email-delivery.md:133-140`).

### 4.6 Client IP and Origin

- Proof requests key their abuse budgets on the socket peer and fail closed without one (`reference/http.md:138-156`). Alchemy's Workers `HttpServer` sets `remoteAddress` from `cf-connecting-ip` (`Workers/HttpServer.ts:29-33`), and the Website's proxy forwards the browser's request headers unchanged, so the Backend sees the real client IP. Prior K4 is likely satisfied by construction; keep it as a spike check.
- `Http.make(AppAuth, { origin })` needs the public Website origin, not a `Host` header. The Backend cannot depend on `Website.url` (the Website already depends on the Backend binding), so the origin is `Config.String("AUTH_ORIGIN")` per stage: `http://localhost:<WEBSITE_PORT>` in dev, the stable `workers.dev` URL in staging (`docs/alchemy-stages-and-deployments-research.md:111`). See Q8.
- Cookies: default prefix `__Host-effect-auth-`, `Secure; HttpOnly; SameSite=Lax; Path=/`; `cookie: { secure: false }` is accepted only with a loopback HTTP origin and switches the prefix to `effect-auth-` (`packages/auth/src/http/auth-http.ts:216-245`). Dev gets `secure: false`; staging the default. Prior §8 confirmed.
- CSRF: POST actions need an admitted `Origin`, JSON content type and `x-effect-auth-csrf: 1`; the library's browser client adds the header (`reference/http.md:74-79`; `http-and-client.mdx:247-248`).

### 4.7 Rate limits

- Built-in limiters are process-local and, with per-request construction, reset on every request (`rate-limits.md:10-25`). Prior R6 is therefore not met by defaults on Workers.
- Options: (a) `Persistence.keyValueRateLimiterStore` over Workers KV (`rate-limits.md:201-216`), a new binding; (b) the native rate-limit binding, which the docs wire only into `Proofs.HostIngressLimiter` (network admission, default 20 per hour) (`rate-limits.md:27-128`; `reference/http.md:109-136`); (c) accept no cross-request limiting in the spike. Per-email cooldown (30 s) and attempt limits (5 per code) are enforced in D1 rows, not in memory, so brute-forcing a code is still bounded. See Q6.

### 4.8 Sessions

- `auth.verifySession(Redacted(cookieValue))` returns `Session` = `{ sessionId, subjectId, securityRevision, assurance, issuedAt, expiresAt, absoluteExpiresAt, claims }`, fails with `SessionInvalid`, needs no `AuthRequest`, never renews, and skips the cookie cache (`packages/auth/src/auth/session.ts:31-35, 96-111`; `http-and-client.mdx:167-195`). Cookie name: `__Host-effect-auth-session` (`effect-auth-session` in dev).
- Renewal is explicit: `POST /api/auth/renewSession` (`sessions.mdx:119-127`). With `renewAfter` 1 day and `idleTimeout` 7 days, the Website can call it on navigation when `Me` reports a session older than a day, or we leave it until it matters.
- Sign-out: `POST /api/auth/signOut` (`sessions.mdx:109-117`). Admin "disconnect everywhere" is `UPDATE user SET security_revision = <new>`; stateful verification compares the stored revision on every read (`adapters.md:299-305`). `active = 0` plus a bump is "ban". Prior Q5 and Q11 confirmed.
- List and revoke sessions are not on the facade; they are `AppAuth.sessions.operations.List | Revoke | RevokeAll.invoke(...)` (`packages/auth/src/sessions/contract.ts:154-183`). Deferred with the devices page (Q10).

### 4.9 Drizzle status (prior K1)

| Build                                                          | `TaggedErrorClass`                        | `isLengthBetween`                                                         | `.d.ts` → `effect/unstable/sql` | Verdict                                                                                        |
| -------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------- |
| `1.0.0-rc.4` (npm `rc` tag; what the patch targets)            | yes, crashes at import under Effect 4.0.1 | yes                                                                       | yes                             | needs the patch                                                                                |
| `1.0.0-rc.5-ab785fc` (Alchemy's pin, downloaded and inspected) | **no** (uses `TaggedError`)               | yes, only in `effect-schema/column.js`, which `effect-d1` does not import | yes                             | **works unpatched** for the D1 path; types masked by `skipLibCheck: true` (`tsconfig.json:10`) |

- There is no released `rc.5`; `ab785fc` is a commit snapshot on npm. The adapter's peer is `drizzle-orm >=1.0.0-rc.4`, which it satisfies (`pnpm view`).
- The Yielded patch CLI is Bun-only and rejects snapshots (`packages/drizzle-effect-v4-patch/README.md`). If `ab785fc` fails in practice, the fallback is `rc.4` plus the same patch file through `pnpm patch` (its content is three mechanical renames and one import path, `patches/drizzle-orm@1.0.0-rc.4.patch`).
- New dependencies: `@yielded/auth-persistence-drizzle@0.1.0-beta.32` (pulls `@yielded/auth-persistence`), `drizzle-orm@1.0.0-rc.5-ab785fc`, `@effect/sql-d1@4.0.1`; dev: `drizzle-kit@1.0.0-rc.5-ab785fc` if we want DDL generation. `better-auth` can be removed.

## 5. Effect idioms to hold to

From `docs/effect-idioms-research.md` and `AGENTS.md`, applied to the new code:

- Every service we implement for the library is a `Layer.effect(Tag, Effect.gen(...))` returning `Tag.of({...})`, with handlers as `Effect.fn("Auth.sendEmail")(function* ...)` and error mapping passed as further arguments, as the library's own examples do (`examples/persistence-drizzle-managed/src/delivery.ts:466-478`).
- Decisions on tags use `Match` (completion `_tag`, role). Our errors are `Schema.TaggedError` in `src/api/`. The RPC failures `Unauthorized` and `Forbidden` are declared there so the client sees them typed.
- Config via `Config.*` in the construction phase only; a `Config` yielded inside `fetch` is never bound (`secrets.mdx`).
- No Drizzle outside `src/backend/auth/schema.ts`. No `drizzle-orm` import anywhere else; add an `no-restricted-imports` entry for it.
- `Effect.forkDaemon` is now `forkDetach` and does not keep a Worker alive; use `WorkerExecutionContext.waitUntil` or `Effect.addFinalizer` (the per-event scope closes via `ctx.waitUntil`, `Worker.ts:2181-2188`).

## 6. The sign-in flow and the two-code problem

The browser flow (`examples/auth/src/login-client.ts:51-89`), with the library's client:

1. `beginEmailSignIn({ flowId })` sets the HttpOnly request-binding cookie.
2. `requestEmailCode({ flowId, requestId, email, returnTarget, locale })` returns a receipt with `reference`. A code is sent only if the email has an account. The response is identical either way.
3. `completeEmailSignIn({ flowId, email, returnTarget, reference, secret: code })` returns `{ completion: Authenticated | PendingAuthentication, returnTarget }` and sets the session cookie.

A new user must first run `beginEmailRegistration` → `registerEmail` → `completeEmailRegistration` (returns `RegistrationAccepted`, no session), then steps 1–3 (`codes.md:170-191`; proven in `examples/auth/src/email-methods.ts:152-205`). Wrong, expired, over-attempted and unknown-account all surface as the fieldless `EmailRejected` (`packages/auth/src/email/errors.ts:36-57`); there is no "expired" vs "wrong" distinction, by design.

The user's requirement was one page: enter email, get a code, enter it. Options:

| Option                                   | Flow for a new user                                                                                                                                                                                                                               | Cost                                                                                                                                                                                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Two codes, one page**               | The page always calls `requestEmailCode`. If the Backend knows the email is new it instead calls `registerEmail`. The user enters code 1 (registration), then the page immediately calls `requestEmailCode` and shows "one more code to sign in". | Supported path. Two emails for first-time users. The Backend must not reveal which branch ran; the page shows the same copy. The "which branch" decision needs the `EmailSignInTargets.lookup` in a Backend RPC, which is our own code, not an HTTP action. |
| **B. Registration page vs sign-in page** | Two links on the public page: "Sign in" and "Create account". Each is one code. A wrong choice gives `EmailRejected` and a hint to try the other.                                                                                                 | Simplest to build. Breaks "sign in and sign up are the same thing". Leaks nothing.                                                                                                                                                                          |
| **C. Pre-provision, then sign in**       | On `requestEmailCode` for an unknown email, our Backend first inserts `user` + `auth_identifiers` (verified) + `auth_email_credentials` in one batch, then runs the normal sign-in code. One code.                                                | Our code writes managed tables directly and marks an unproven identifier verified. Junk rows from typos need cleanup. Deviates from the library's model on a beta that changes "internal contracts in place". **Not recommended** now.                      |

Recommendation: **A for the spike**, with the same page and the same copy, and B if A's double email turns out to be unacceptable. See Q1.

## 7. RPC guards

Effect's `RpcMiddleware` fits `verifySession` with no adapter. Facts from `node_modules/effect/src/rpc/RpcMiddleware.ts` and `RpcServer.ts`:

- The server implementation is a plain function `(effect, { headers, rpc, payload, ... }) => Effect` provided as a service (`Layer.succeed(Tag)(Tag.of(fn))`); there is no `RpcMiddleware.layer`. Reference: `refs/effect/packages/platform/node/test/fixtures/rpc-schemas.ts:27-32, 77-87, 107`.
- HTTP headers are merged into every RPC message and arrive lowercased as `options.headers`, so `options.headers.cookie` is the browser's cookie header (`RpcServer.ts:1107, 1165, 266-272`). Both the browser path (full request forwarded) and SSR (`cookie` copied) carry it.
- The typed failure is the `error` option of `RpcMiddleware.Service` (not `failure`); it is added to every guarded RPC's exit schema, so the client sees `Unauthorized` typed (`rpc/Rpc.ts:1179-1192`).
- `RpcGroup.middleware(M)` guards the procedures added so far; the last middleware added is the outermost (`RpcGroup.ts:66-68, 297-305`; `RpcServer.ts:505-516`). `requiredForClient` defaults to false, so the client needs nothing.

```ts
// src/api/backend.ts
export class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", {}) {}
export class Forbidden extends Schema.TaggedError<Forbidden>()("Forbidden", {}) {}
export class CurrentUser extends Context.Service<CurrentUser, { id: string; email: string; role: Role }>()("CurrentUser") {}
export class CurrentUserMiddleware extends RpcMiddleware.Service<CurrentUserMiddleware, { provides: CurrentUser }>()("CurrentUserMiddleware", { error: Unauthorized }) {}
export class RequireAdmin extends RpcMiddleware.Service<RequireAdmin, { requires: CurrentUser }>()("RequireAdmin", { error: Forbidden }) {}

const PublicRpcs = RpcGroup.make(Rpc.make("Hello", ...), Rpc.make("Shout", ...));
const MemberRpcs = RpcGroup.make(Rpc.make("Me", { success: Me })).middleware(CurrentUserMiddleware);
const AdminRpcs  = RpcGroup.make(Rpc.make("ListUsers", ...)).middleware(RequireAdmin).middleware(CurrentUserMiddleware);
export const BackendRpcs = PublicRpcs.merge(MemberRpcs, AdminRpcs);
```

```ts
// src/backend/auth/middleware.ts: parse the cookie with Cookies.parseHeader, verifySession, provide CurrentUser from claims.
// RequireAdmin reads CurrentUser and fails Forbidden unless role === "admin".
// worker.ts provides both layers next to BackendHandlers and RpcSerialization.layerNdjson.
```

- `CurrentUser` comes from session claims (`{ email, role }`), so a guarded RPC costs one D1 read (the session row joined to the subject's revision), not two. `Me` returns the claims.
- `RpcMiddleware` is absent from Effect's AI docs and `LLMS.md`; the fixture above is the reference.

## 8. Website: routes, pages and guards

### 8.1 Routes

| File                                       | Purpose                                                                                                                                                                                                         |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/routes/api.auth.$.ts`                 | `GET`/`POST` → `env.BACKEND.fetch(request)`. Same shape as `api.rpc.ts`; the splat param syntax is `$` (`refs/tan-start/docs/.../server-routes.md:295-313`). The 64 KB cap can be reused; auth bodies are tiny. |
| `src/routes/index.tsx`                     | Public page (existing) plus a "Sign in" link.                                                                                                                                                                   |
| `src/routes/sign-in.tsx`                   | One page, two states: email → code. `validateSearch` for `redirect` (return-to). `beforeLoad`: if `Me` succeeds, redirect to the user's side.                                                                   |
| `src/routes/admin.tsx` + `admin.index.tsx` | Layout with `beforeLoad` guard; admin sidebar; `Outlet`.                                                                                                                                                        |
| `src/routes/app.tsx` + `app.index.tsx`     | Same for members.                                                                                                                                                                                               |

- Guard pattern (`refs/tan-router/docs/router/guide/authenticated-routes.md:34-51`): `beforeLoad: async ({ context, location }) => { const me = await loadMe(context.registry); if (!me) throw redirect({ to: "/sign-in", search: { redirect: location.href } }); if (me.role !== "admin") throw redirect({ to: "/app" }); return { me }; }`. Returned context flows to child loaders (`router-context.md:428-437`). Baton's two disjoint roles bouncing to each other's side avoid loops (`refs/baton/src/lib/MemberServerFnMiddleware.ts:26-43`).
- `Me` is a `BackendClient.query` with `timeToLive: Infinity` and reactivity key `"me"`, per the session-data exception in `src/query.ts`; sign-in and sign-out mutations invalidate `"me"`. `beforeLoad` runs on every navigation and preload (`data-loading.md:172, 324`), which with the keep-alive query is a registry read, not a Backend call, except on first load. Per-layout guards (Baton's shape), not a root `beforeLoad`, so public pages make no auth call (Q11).
- The guard is the outer layer only; the middleware in §7 is the security boundary (prior R5).

### 8.2 Sign-in page client

Two ways to call the auth actions from the browser:

- **The library's client:** `Client.make(AuthApi, { baseUrl: window.location.origin + "/api" })` and `Atom.make(client)` give typed mutations with the CSRF header and `credentials: "include"` set (`reference/client.md:10-64`; `guide/client.mdx:43-121`). It is `@effect/atom-react`-based, which we already use. Recommended.
- Hand-written `fetch` against the six routes. Fewer abstractions, but we re-implement the CSRF header, JSON encoding, and error decoding.

The two-state page (option A) runs: `beginEmailSignIn` → `requestEmailCode` → show code field → `completeEmailSignIn` → on `Authenticated`, invalidate `"me"` and `navigate({ to: search.redirect ?? sideFor(role) })`. On `EmailRejected` show one neutral message ("That code didn't work. Request a new one.") since the library gives no detail.

### 8.3 Astryx

- `astryx build` has no email-code or landing template; the closest are `login-sso` (two-stage card: email, then a second panel) for the sign-in page, `centered-hero` for the public page, and `shell-side-nav` for both sides. `AppShellSideNavOnly` is the block for a plain sidebar.
- `shell-side-nav` frame: `<AppShell contentPadding={0} sideNav={<SideNav collapsible resizable header={<SideNavHeading heading headingHref/>}>…</SideNav>}>` with `<Layout height="fill" contentWidth={768} content={<LayoutContent padding={6}>…`. `SideNavItem` takes `label`, `icon`, `href`, `isSelected`, `as`; set the router `Link` once through `LinkProvider` so items are client-side navigations.
- Code input: `TextInput type="text" autoComplete="one-time-code"`; there is no OTP component. There is no `Form` component; `FormLayout` inside a native `<form>` handles submit-on-enter.
- Templates import `@heroicons/react/24/outline`, which is not installed; use Astryx's semantic icon names (`astryx docs icons`) instead.

## 9. Dev and staging specifics

| Concern            | Dev (`alchemy dev --stage dev`)                                        | Staging                                                                                 |
| ------------------ | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| D1                 | virtual, `.alchemy/local/d1`, migrations applied by the local gateway  | real D1, migrations over HTTP API at deploy                                             |
| Email              | `.eml` files under `.alchemy/local/email`; read the code from the file | Cloudflare Email Service; needs a sending domain or verified destination addresses (Q4) |
| `AUTH_ORIGIN`      | `http://localhost:<WEBSITE_PORT>`                                      | `https://alchemy-sandbox1-website-staging-….workers.dev`                                |
| Cookies            | `secure: false`, prefix `effect-auth-`                                 | default `__Host-effect-auth-`                                                           |
| Keys               | `Random` in the `dev` stage state                                      | `Random` in the `staging` stage state                                                   |
| Rate limit binding | in-memory                                                              | real namespace                                                                          |
| Beta upgrades      | reset `.alchemy/local/d1`                                              | reset the staging database (no stored-data compatibility between betas)                 |

## 10. Spike and kill criteria (revised)

The vertical slice, in build order (each step typechecks on its own):

1. `AuthDb`, `AuthEmail`, `migrations/0001_auth.sql`; Backend becomes `Cloudflare.Worker` with path branching; `SQL.D1` smoke query. (Alchemy only; no Yielded Auth yet.)
2. Dependencies added; `schema.ts`, `AppAuth`, `storage`, the three email services, keyrings from `Random`, `WebCrypto`; auth routes mounted; delivery via `waitUntil` scheduler. Register and sign in with `curl`, reading codes from `.alchemy/local/email`.
3. `CurrentUserMiddleware`, `RequireAdmin`, `Me`, `ListUsers`.
4. `api.auth.$`, sign-in page, `/admin` and `/app` layouts with sidebars, sign-out.
5. Deploy to staging; sign in with a real mailbox.

Kill criteria (fall back to `@alchemy.run/better-auth` on the same architecture):

- **K1 (revised):** `drizzle-orm@1.0.0-rc.5-ab785fc` imports and runs under Effect 4.0.1 in the Worker bundle with no patch.
- **K2:** on real D1, a forced precondition failure rolls back the whole batch (register the same email twice concurrently; no partial rows).
- **K3 (revised):** a custom `ProofDispatchScheduler` over `WorkerExecutionContext.waitUntil` delivers the code after the response. Fallback inside the spike: `layerInline`.
- **K4:** code requests succeed behind the binding (`remoteAddress` from `cf-connecting-ip`); a missing header fails closed as the docs say.
- **K5:** `verifySession` in `RpcMiddleware` works for browser and SSR calls.
- **K6 (new):** `makeStorageMappings` accepts our hand-declared `auth_proofs` and `auth_email_credentials` tables, and the adapter's first-use schema validation passes against the hand-written migration.
- **K7 (new):** the registration-then-sign-in sequence (option A) completes in one browser with two codes, and `EmailRejected` is the only failure surfaced for wrong codes.

## 11. Questions (round 1)

Each has a recommendation; answering "all recommendations" is a valid reply.

| #       | Question                                                                                                                                                                                                                                                                               | Recommendation                                                                                                                                                                                              |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Q1**  | **Sign-up flow.** A: one page, two codes for new users (register, then sign in). B: separate "Create account" and "Sign in" entries, one code each. C: pre-provision the account ourselves on first request so one code suffices ([§6](#6-the-sign-in-flow-and-the-two-code-problem)). | **A** for the spike. It keeps "one page, enter email, enter code" and stays on the supported path. Revisit B if the second email is unacceptable; avoid C on a beta that resets internal contracts.         |
| **Q2**  | **Registration fields.** `makeRegistration` takes a `registration` schema. Collect nothing (`Schema.Struct({})`), or a display name?                                                                                                                                                   | **Nothing.** Email and role are all the `user` row needs; a name can be added later with a column and a settings page.                                                                                      |
| **Q3**  | **Drizzle build.** Alchemy's `1.0.0-rc.5-ab785fc` unpatched, or `rc.4` plus the Yielded patch via `pnpm patch`?                                                                                                                                                                        | **`ab785fc`.** It already carries the Effect 4 fixes the D1 path needs, matches Alchemy's own pin, and avoids a patch file. Fall back to `rc.4` + patch only if K1 fails.                                   |
| **Q4**  | **Staging email.** Do you have (or want to onboard) a domain on Cloudflare for Email Service sending? Without one, staging can send only to verified destination addresses in your account, which is enough for testing with your own mailbox.                                         | **Verified destination addresses for the spike** (free, no DNS), and onboard a sending domain before anyone else signs in. Tell me which address to verify or whether a domain exists.                      |
| **Q5**  | **Delivery scheduling on Workers.** Custom `ProofDispatchScheduler` over `waitUntil`, or `layerInline` (send before responding; timing can reveal whether an email has an account)?                                                                                                    | **`waitUntil` scheduler**, with `layerInline` as the in-spike fallback if K3 fails. Prior R2's enumeration concern was dropped with open sign-up, so `layerInline` is tolerable short-term, not long-term.  |
| **Q6**  | **Rate limiting.** Defaults reset per request on Workers. KV-backed store (new KV binding), native rate-limit binding (ingress only), or nothing for the spike?                                                                                                                        | **Nothing in the spike**; per-code attempt limits and per-email cooldown are enforced in D1 rows regardless. Add the KV store before launch; it is a documented recipe.                                     |
| **Q7**  | **Backend Worker type.** Switch `Backend` to `Cloudflare.Worker` with explicit path branching, or keep `RpcWorker` and nest the branching in its impl?                                                                                                                                 | **`Cloudflare.Worker`.** It is what Alchemy's two auth examples do, `RpcWorker.bind` is unused, and the branching reads plainly.                                                                            |
| **Q8**  | **Trusted origin.** `AUTH_ORIGIN` from `.env` per stage (`.env`, `.env.staging`), or hard-code the staging `workers.dev` URL in `alchemy.run.ts` keyed on stage?                                                                                                                       | **`Config.String("AUTH_ORIGIN")`** with `Alchemy.Secrets.DotEnv` reading `.env.<stage>`; staging's value is committed in `.env.staging` since it is not secret. A custom domain later is a one-line change. |
| **Q9**  | **Role and email in claims.** Put `{ email, role }` in session claims (one D1 read per guarded RPC; a role change requires a `security_revision` bump), or read the `user` row on every RPC (two reads; immediate)?                                                                    | **Claims**, with the rule that every admin action that changes `role` or `active` also bumps `security_revision`. Keep `email` on the `user` table for admin listing.                                       |
| **Q10** | **Scope of this slice.** Include the "your devices" page and `session_device` table (prior Q9/Q10) now, or after the slice?                                                                                                                                                            | **After.** The slice proves sign-in, guards and both sidebars. Devices need `sessions.operations.List                                                                                                       | Revoke` plus a hook at session issuance, both unverified; they are a clean second step. |
| **Q11** | **Where the `Me` check lives.** Per-layout `beforeLoad` on `/admin` and `/app` (public pages make no auth call), or a root `beforeLoad` that loads `me` once for every page (one call per navigation on public pages too)?                                                             | **Per-layout**, with `Me` as a keep-alive query invalidated on sign-in and sign-out. The public page stays free of auth; a "Sign in / Go to app" link can use the same query lazily if wanted.              |

## Appendix A: File plan

| Path                                                                                                  | Role                                                                                                                 |
| ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `alchemy.run.ts`                                                                                      | `AuthDb`, `AuthEmail` descriptors; `Secrets.DotEnv` per stage                                                        |
| `migrations/0001_auth.sql`                                                                            | `user` + six `auth_*` tables                                                                                         |
| `src/api/auth.ts`                                                                                     | `AuthApi` contract and claims (browser-safe)                                                                         |
| `src/api/backend.ts`                                                                                  | `CurrentUser`, `Unauthorized`, `Forbidden`, `CurrentUserMiddleware`, `RequireAdmin`, `Me`, grouped RPCs              |
| `src/backend/auth/schema.ts`                                                                          | three Drizzle tables; `Persistence`, `storage`                                                                       |
| `src/backend/auth/auth.ts`                                                                            | `AppAuth`, requirement, `http = Http.make(...)`                                                                      |
| `src/backend/auth/services.ts`                                                                        | sign-in targets, proof persistence, registration authority + provisioning (role from `ADMIN_EMAILS`), session claims |
| `src/backend/auth/delivery.ts`                                                                        | `EmailDelivery` over `Cloudflare.Email.Send`; `ProofDispatchScheduler` over `waitUntil`                              |
| `src/backend/auth/middleware.ts`                                                                      | `CurrentUserMiddleware` and `RequireAdmin` layers                                                                    |
| `src/backend/worker.ts`                                                                               | `Cloudflare.Worker`; bindings, keyrings, config in construction; path branching in `fetch`                           |
| `src/backend/handlers.ts`                                                                             | `Me`, `ListUsers` added                                                                                              |
| `src/auth-client.ts`                                                                                  | Yielded `Client.make` + atoms for the sign-in page                                                                   |
| `src/routes/api.auth.$.ts`, `sign-in.tsx`, `admin.tsx`, `admin.index.tsx`, `app.tsx`, `app.index.tsx` | Website routes                                                                                                       |
| `src/components/AdminShell.tsx`, `MemberShell.tsx`, `SignInPage.tsx`                                  | Astryx pages from `shell-side-nav` and `login-sso`                                                                   |
