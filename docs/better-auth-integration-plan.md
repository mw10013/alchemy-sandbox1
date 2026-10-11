# Plan: Better Auth sign-in with magic links, invite-only members, admin and member sides

Date: 2026-10-10  
Status: implemented in dev on 2026-10-10, not committed; staging deploy pending (Step 9). Configuration was revised after review: see [Deviations and issues](#deviations-and-issues).  
Background: [research](./better-auth-integration-research.md) (decisions in its §11, all settled). Vocabulary: [glossary](./glossary.md).  
Versions: Alchemy `2.0.0-beta.81`, `@alchemy.run/better-auth` `2.0.0-beta.81` (to add), `better-auth` `1.7.7` (installed), Effect `4.0.1`, `@tanstack/react-start` `1.168.60`, Astryx `0.6.5`. Do not bump dependencies.

## Goal

A visitor opens the public page and clicks "Sign in". They enter an email. If that email is a seeded member, they get a magic link (in dev: shown on the page and in the log; in staging: emailed from `mail.mw10013.com`). Clicking it signs them in and lands them on `/app` (members) or `/admin` (admins), each with its own sidebar. Non-members get the same "check your email" reply and no link. Signed-out users who open `/app` or `/admin` are sent to `/sign-in` and back after signing in. Sign-out works. Every member and admin procedure is guarded in the Backend, not only in the Website.

## Ground rules for the implementer

- Work directly on `main` (AGENTS.md). **Do not commit and do not push.** The reviewer commits after checking. Pushing `main` deploys staging.
- Verify every API against the installed source in `node_modules/alchemy/src`, `node_modules/@alchemy.run/better-auth/src` (after install), `node_modules/better-auth`, `node_modules/effect/src`, and the pinned sources in `refs/`. Line references below were checked at the research stage. If something does not match, follow the source and record it in [Deviations and issues](#deviations-and-issues).
- Effect rules from AGENTS.md: validation and parsing with Schema (never hand-trim or regex-test), `Match` for tag dispatch, `Schema.TaggedError` for errors, `Effect.fn("name")` for reusable effects with combinators passed as further arguments, path imports (`effect/Effect`), no `effect` barrel. The Promise seam with Better Auth is confined to `src/backend/auth.ts`.
- Astryx rules from AGENTS.md apply to every page: start from a template, no raw `<div>`/`<span>` layout, tokens for any style. Run `pnpm exec astryx template <name>` and `pnpm exec astryx component <Name>` before using something not already in the repo. Templates import `@heroicons/react`, which is **not installed**; use Astryx's semantic icon names (`pnpm exec astryx docs icons`).
- Record every deviation, workaround and unverified check in [Deviations and issues](#deviations-and-issues). Be specific: file, what the plan said, what you did, why.
- A dev server may already be running: `vp run dev:status`. Start with `vp run dev:start`, never `vp run dev`. Logs: `logs/dev/current`. Restart dev after changing `.env` or `alchemy.run.ts`.

## Current state (before)

```
alchemy.run.ts              Website (Website.Vite, env: { BACKEND: Backend }); stack returns websiteUrl
src/api/backend.ts          ShoutText, Hello, Shouted, CurrentUser + CurrentUserMiddleware (declared, unattached), BackendRpcs
src/backend/worker.ts       Cloudflare.RpcWorker serving BackendRpcs over ndjson
src/backend/handlers.ts     Hello, Shout
src/backend-client.ts       BackendClient (AtomRpc), serverFetch forwards cookie during SSR, helloAtom, shoutAtom
src/query.ts                loadQuery, refreshOnFocus, the page-query pattern (read it)
src/router.tsx              per-request AtomRegistry, dehydrate/hydrate
src/routes/__root.tsx       createRootRouteWithContext<{ registry }>
src/routes/index.tsx        loader primes helloAtom; HomePage
src/routes/api.rpc.ts       POST proxy to env.BACKEND.fetch with header checks
src/components/HomePage.tsx Astryx shell-top-nav page
package.json                depends on better-auth 1.7.7 and @yielded/auth (unused)
```

## Target state (after)

```
alchemy.run.ts              binds website.url onto the Backend as AUTH_ORIGIN; outputs unchanged
src/backend/resources.ts    AuthDb (D1, migrations + per-stage seed), AuthEmail (send_email), SignInLimit (rate limit)
migrations/0001_member.sql  member table
seed/dev.sql, seed/staging.sql, seed/production.sql   per-stage member rows
src/api/backend.ts          + Email schema, Role, Me, Member, Unauthorized, Forbidden, RequireAdmin; RequestMagicLink, Me, ListMembers; grouped RPCs with middleware
src/backend/auth.ts         BetterAuth({...}) with magicLink + admin, the three callbacks, inline link delivery
src/backend/members.ts      member queries via SQL.D1 (findByEmail, list)
src/backend/middleware.ts   CurrentUserMiddleware + RequireAdmin layers
src/backend/handlers.ts     + RequestMagicLink, Me, ListMembers
src/backend/worker.ts       Cloudflare.Worker: bindings + auth in construction; fetch branches /api/auth → auth.fetch, else RPC
src/backend-client.ts       + meAtom (keep-alive), requestMagicLinkAtom, loadMe
src/routes/api.auth.$.ts    allowlist proxy: GET /api/auth/magic-link/verify, POST /api/auth/sign-out
src/routes/sign-in.tsx      email → "check your email" (dev: link on page); error from search
src/routes/admin.tsx, admin.index.tsx, admin.members.tsx   admin layout + guard + sidebar; home; read-only members list
src/routes/app.tsx, app.index.tsx                          member layout + guard + sidebar; home
src/components/SignInPage.tsx, AdminShell.tsx, MemberShell.tsx, MembersPage.tsx
src/components/HomePage.tsx + "Sign in" link in the top nav
scripts/dev.ts              + db:reset (stop, forget AuthDb state, remove .alchemy/local, start)
(no new env settings; no committed env files)
package.json                + @alchemy.run/better-auth; − @yielded/auth; + db:reset script
```

## Steps

Do them in order. Typecheck (`pnpm typecheck`) after steps 2, 4, 6, 8 and 10. `pnpm check` at the end.

### Step 1. Dependencies

- Add `@alchemy.run/better-auth@2.0.0-beta.81`. Remove `@yielded/auth`. Keep `better-auth@1.7.7`.
- After install, read `node_modules/@alchemy.run/better-auth/package.json` for peer dependencies. The migration Action imports `better-auth/db` and `kysely` at deploy time only (`src/Migrate.ts`); if `kysely` is an unmet peer, add it as a **devDependency** and note the version in Deviations.
- Do not add `drizzle-orm`, `@effect/sql-d1` or `kysely` as runtime dependencies.

### Step 2. Resources, migrations, seeds, config

`src/backend/resources.ts` (the Alchemy examples keep descriptors next to the Worker):

```ts
import * as Cloudflare from "alchemy/Cloudflare";

export const AuthDb = Cloudflare.D1.Database("AuthDb", {
  migrations: "./migrations",
  readReplication: { mode: "disabled" },
  importFiles: [/* per-stage seed, see below */],
});
export const AuthEmail = Cloudflare.Email.SendEmail("AuthEmail");
export const SignInLimit = Cloudflare.RateLimit("SignInLimit", {
  namespaceId: 1001, // any stable integer, unique per limiter in the account
  simple: { limit: 5, period: 60 },
});
```

- `Database` props: `node_modules/alchemy/src/Cloudflare/D1/Database.ts:41-109`. `importFiles` run after migrations, hashed, re-run only on change, in dev and deploy (`:90-97, 499-508, 610-630`).
- `RateLimit` props: `node_modules/alchemy/src/Cloudflare/Workers/RateLimit.ts:30-43`. `SendEmail`: `Cloudflare/Email/SendEmail.ts:7-28`.
- **Per-stage seed selection.** The stack already reads `Alchemy.ALCHEMY_DEV` in `alchemy.run.ts`. For dev, `importFiles: ["./seed/dev.sql"]`. For other stages the file is `./seed/<stage>.sql`. Find how a resource or the stack reads the stage name (candidates: the per-stage override map on resources, `node_modules/alchemy/src/Stack.ts:156-170`; the `secrets` callback's `{ stage }`; `StackContext` in `node_modules/alchemy/src/StackContext.ts`). If none is usable from the resource definition, read `Config.String("SEED_FILE")` with the value set in `.env.<stage>`. Record which you used.

`migrations/0001_member.sql`:

```sql
CREATE TABLE member (
  id         text PRIMARY KEY,
  email      text NOT NULL UNIQUE,
  role       text NOT NULL CHECK (role IN ('admin', 'user')),
  created_at integer NOT NULL DEFAULT (unixepoch())
);
```

`seed/dev.sql` (idempotent):

```sql
INSERT OR IGNORE INTO member (id, email, role) VALUES
  ('seed-admin', 'a@a.com',  'admin'),
  ('seed-m1',    'm1@m.com', 'user'),
  ('seed-m2',    'm2@m.com', 'user');
```

`seed/staging.sql` and `seed/production.sql`: one admin row each. The staging email is the operator's; leave production with a placeholder comment and one row the reviewer fills in. Emails are stored lowercase.

Configuration (revised after review; the original called for `Secrets.DotEnv` per stage, `AUTH_EMAIL_FROM` and `MAGIC_LINK_DELIVERY` in `.env`, and a committed `.env.staging`). No env file is ever committed, because one invites secrets. Nothing is added to `.env`:

- The magic-link origin is the Website's URL Output, bound onto the Backend by the stack (a binding may close the Website ↔ Backend cycle; a prop may not):

  ```ts
  const website = yield * Website;
  const backend = yield * Backend;
  yield * backend.bind("AuthOrigin", { env: { AUTH_ORIGIN: website.url } });
  ```

- The sender `noreply@mail.mw10013.com` (transactional, no mailbox) is a constant in `src/backend/auth.ts`.
- Inline delivery is on exactly when `ALCHEMY_DEV` is true.
- Secrets: `Alchemy.Random` for generated ones (the Better Auth secret); anything else from CI secrets or a secrets provider per stage, read with `Config.Redacted`.

### Step 3. API definition: `src/api/backend.ts`

Schemas only; no runtime imports from `src/backend/` or Alchemy. Keep the existing `ShoutText`, `Hello`, `Shouted`.

```ts
// Lowercased, trimmed email. Decode raw input with EmailFromInput.
export const Email = Schema.String.check(Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/u), Schema.isMaxLength(320)).pipe(Schema.brand("Email"));
export const EmailFromInput = Schema.Trim.pipe(Schema.decodeTo(Schema.String), /* lowercase transform */, Schema.decodeTo(Email));
export const Role = Schema.Literals(["admin", "user"]);
export const Me = Schema.Struct({ id: Schema.String, email: Email, role: Role });
export const Member = Schema.Struct({ id: Schema.String, email: Email, role: Role, createdAt: Schema.Number });
export const MagicLinkRequested = Schema.Struct({ link: Schema.Option(Schema.String) }); // Some only in dev inline mode

export class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", {}) {}
export class Forbidden extends Schema.TaggedError<Forbidden>()("Forbidden", {}) {}
export class TooManyRequests extends Schema.TaggedError<TooManyRequests>()("TooManyRequests", {}) {}

export class CurrentUser extends Context.Service<CurrentUser, typeof Me.Type>()("CurrentUser") {}
export class CurrentUserMiddleware extends RpcMiddleware.Service<CurrentUserMiddleware, { provides: CurrentUser }>()("CurrentUserMiddleware", { error: Unauthorized }) {}
export class RequireAdmin extends RpcMiddleware.Service<RequireAdmin, { requires: CurrentUser }>()("RequireAdmin", { error: Forbidden }) {}

const PublicRpcs = RpcGroup.make(
  Rpc.make("Hello", { success: Hello }),
  Rpc.make("Shout", { payload: { input: ShoutText }, success: Shouted }),
  Rpc.make("RequestMagicLink", { payload: { email: Email }, success: MagicLinkRequested, error: TooManyRequests }),
);
const MemberRpcs = RpcGroup.make(Rpc.make("Me", { success: Me })).middleware(CurrentUserMiddleware);
const AdminRpcs = RpcGroup.make(Rpc.make("ListMembers", { success: Schema.Array(Member) }))
  .middleware(RequireAdmin)            // inner: needs CurrentUser
  .middleware(CurrentUserMiddleware);  // outer: provides it (last added = outermost)
export const BackendRpcs = PublicRpcs.merge(MemberRpcs, AdminRpcs);
```

- Lowercasing: find the Schema transform for it in `node_modules/effect/src/Schema.ts` (there is a `Lowercase`/`toLowerCase` transformation next to `Trim`); if absent, build one with `Schema.transform`. Do not call `.toLowerCase()` outside the codec.
- `RpcMiddleware.Service` options: `node_modules/effect/src/rpc/RpcMiddleware.ts:278-336` (`error`, `requiredForClient` default false). `RpcGroup.middleware` scope and ordering: `rpc/RpcGroup.ts:66-68, 297-305`; `rpc/RpcServer.ts:505-516`. Reference fixture: `refs/effect/packages/platform/node/test/fixtures/rpc-schemas.ts:27-32, 77-87, 107`.
- The client needs nothing for these middlewares (`requiredForClient` is false).

### Step 4. Backend Worker, auth module, members, middleware, handlers

`src/backend/worker.ts` becomes a `Cloudflare.Worker` (not `RpcWorker`):

```ts
export default class Backend extends Cloudflare.Worker<Backend>()(
  "Backend",
  {
    main: import.meta.filename,
    workersDev: false,
    dev: { port: 0 },
    compatibility: { date: "2026-07-01", flags: ["nodejs_compat"] },
  },
  Effect.gen(function* () {
    const auth = yield* makeAuth; // src/backend/auth.ts (yields BetterAuth(...))
    const rpcFetch = RpcServer.toHttpEffect(BackendRpcs).pipe(
      Effect.provide(
        Layer.mergeAll(
          BackendHandlers,
          CurrentUserLive,
          RequireAdminLive,
          RpcSerialization.layerNdjson,
        ),
      ),
    );
    return {
      fetch: Effect.scoped(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (request.url.startsWith("/api/auth")) return yield* auth.fetch;
          return yield* yield* rpcFetch;
        }),
      ),
    };
  }).pipe(
    Effect.provide(CloudflareD1(AuthDb)),
    Effect.provide(Cloudflare.Email.SendBinding),
    Effect.provide(Cloudflare.Workers.RateLimitBinding),
    Effect.provide(Cloudflare.D1.QueryDatabaseBinding),
  ),
) {}
```

- Pattern: `refs/alchemy/examples/cloudflare-git-service/src/api/host.ts:22-34` and the wrapper's doc comment (`node_modules/@alchemy.run/better-auth/src/BetterAuth.ts:96-108`). `RpcServer.toHttpEffect` is `Effect<HttpEffect>` needing `Scope`; the existing worker returns it from `Effect.sync`. Check how the `Worker` impl types `fetch` versus the old `RpcWorker` and adjust the nesting (`node_modules/alchemy/src/Cloudflare/Workers/Worker.ts`, `RpcWorker.ts:460-532`).
- `WebsiteEnv.BACKEND` changes from an RPC-typed binding to a plain service; `src/backend-client.ts` only calls `env.BACKEND.fetch`, so nothing else changes. Confirm with typecheck.

`src/backend/auth.ts`:

```ts
export const makeAuth = Effect.gen(function* () {
  const dev = yield* Alchemy.ALCHEMY_DEV;                               // verify: node_modules/alchemy/src/Phase.ts
  const authOrigin = yield* Config.option(Config.String("AUTH_ORIGIN")); // revised: bound by the stack; absent while planning
  const inline = dev;                                                    // revised: no MAGIC_LINK_DELIVERY; sender is a constant
  const email = yield* Cloudflare.Email.Send(AuthEmail);
  const d1 = yield* Cloudflare.D1.QueryDatabase(AuthDb);
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>()); // construction-time snapshot (Baton LayerEx.ts:110-123)
  const pendingLinks = new Map<string, string>();                        // inline mode only; same request writes and reads

  const findMember = (address: string) => /* d1.prepare("select ... from member where email = ?").bind(address).first() */;

  const auth = yield* BetterAuth({
    basePath: "/api/auth",
    baseURL: authOrigin,
    user: {
      validateUserInfo: ({ email }) => runPromise(findMember(email).pipe(Effect.map((m) => (m ? undefined : { error: "not_invited" })))),
    },
    databaseHooks: { user: { create: { before: (user) => runPromise(findMember(user.email).pipe(Effect.map((m) => ({ data: { ...user, role: m?.role ?? "user" } })))) } } },
    plugins: [
      magicLink({
        expiresIn: 300,
        storeToken: "hashed",
        sendMagicLink: ({ email: to, url }) =>
          inline
            ? runPromise(Effect.gen(function* () { pendingLinks.set(to, url); yield* Effect.logInfo("magic link (dev inline)", { to, url }); }))
            : runPromise(email.send({ from, to, subject: "Your sign-in link", text: `Sign in: ${url}\n\nThis link expires in 5 minutes.`, html: ... }).pipe(Effect.asVoid, Effect.provide(RuntimeContext.phantom))),
      }),
      admin(),
    ],
    advanced: { ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] } },
    rateLimit: { enabled: false },
  });

  const takeInlineLink = (to: string) => Effect.sync(() => { const url = pendingLinks.get(to); pendingLinks.delete(to); return Option.fromNullable(url); });
  return { auth, takeInlineLink, inline };
});
export class Auth extends Context.Service<Auth, Effect.Success<typeof makeAuth>>()("app/Auth") { static readonly layer = Layer.effect(Auth, makeAuth); }
```

- `BetterAuth` props and return: `node_modules/@alchemy.run/better-auth/src/BetterAuth.ts:30-120`. Secret: omit (`Random` managed). Migrations: default on with `CloudflareD1`.
- `validateUserInfo` contract: `node_modules/better-auth` → `@better-auth/core` `types/init-options.ts:950-976`; magic-link verify maps its error to `?error=<code>` (`refs/better-auth/packages/better-auth/src/plugins/magic-link/index.ts:455-462`). `create.before` contract: `db/with-hooks.ts:42-66`. Admin plugin's default role hook runs after ours and keeps an existing `role` (`plugins/admin/admin.ts:77-87`); confirm order (S6).
- `findMember` must use the raw `QueryDatabase` client (`prepare/bind/first`, `node_modules/alchemy/src/Cloudflare/D1/QueryDatabase.ts:111-134`), **not** `SQL.D1`, because the latter is memoized on the per-event execution scope that a construction snapshot does not carry. Decode the row with Schema.
- `runPromise` from a construction snapshot works because the binding clients read `env` captured at init (`Cloudflare/Email/SendBinding.ts:13-34`) and `RuntimeContext` is a phantom marker (`RuntimeContext.ts:178`). This is spike check S2; if it fails, fall back to `WorkerEnvironment` and record it.
- `sendMagicLink` is awaited by the endpoint (`magic-link/index.ts:293-301`); a failed send rejects `signInMagicLink`, which the handler sees.
- `Alchemy.ALCHEMY_DEV` inside a Worker construction effect: verify it is available there (it is used in `alchemy.run.ts`); if not, use `Config.Boolean` of an env the stack sets only in dev, and record it.

`src/backend/members.ts`: `const sql = yield* SQL.D1(d1)` (`node_modules/alchemy/src/SQL/D1.ts:53-63`) with tagged-template queries, rows decoded with Schema: `findByEmail`, `list` (ordered by `created_at`).

`src/backend/middleware.ts`:

```ts
export const CurrentUserLive = Layer.effect(
  CurrentUserMiddleware,
  Effect.gen(function* () {
    const { auth } = yield* Auth;
    return CurrentUserMiddleware.of((effect, { headers }) =>
      Effect.gen(function* () {
        const session = yield* auth.getSession(new Headers({ cookie: headers.cookie ?? "" })).pipe(
          Effect.mapError(() => new Unauthorized()),
          Effect.catchDefect(() => Effect.fail(new Unauthorized())),
        );
        if (session === null) return yield* new Unauthorized();
        const me = yield* Schema.decodeUnknownEffect(Me)({
          id: session.user.id,
          email: session.user.email,
          role: session.user.role,
        }).pipe(Effect.mapError(() => new Unauthorized()));
        return yield* Effect.provideService(effect, CurrentUser, me);
      }).pipe(Effect.provide(RuntimeContext.phantom)),
    );
  }),
).pipe(Layer.provide(Auth.layer));

export const RequireAdminLive = Layer.succeed(RequireAdmin)(
  RequireAdmin.of((effect) =>
    Effect.gen(function* () {
      const user = yield* CurrentUser;
      return yield* Match.value(user.role).pipe(
        Match.when("admin", () => effect),
        Match.orElse(() => Effect.fail(new Forbidden())),
      );
    }),
  ),
);
```

- Headers are lowercased and include `cookie` for both browser and SSR calls (`rpc/RpcServer.ts:1107, 1165, 266-272`). `RuntimeContext.phantom` as in `refs/alchemy/examples/cloudflare-better-auth/src/middleware.ts:21-45`.
- Build `Auth.layer` once and share it between the middleware and the handlers (memoize the layer in `worker.ts`; do not construct `BetterAuth` twice).

`src/backend/handlers.ts` additions:

```ts
RequestMagicLink: ({ email }, { headers }) => Effect.gen(function* () {      // check Rpc handler signature for headers access
  const ip = headers["cf-connecting-ip"] ?? "unknown";
  const { success } = yield* limit.limit({ key: ip });
  if (!success) return yield* new TooManyRequests();
  const member = yield* members.findByEmail(email);
  if (Option.isNone(member)) { yield* Effect.logInfo("sign-in for non-member"); return { link: Option.none() }; }
  yield* auth.api.signInMagicLink({ body: { email, callbackURL: "/app", errorCallbackURL: "/sign-in" }, headers: new Headers(headers) });
  return { link: inline ? yield* takeInlineLink(email) : Option.none() };
}),
Me: () => CurrentUser.asEffect(),   // or Effect.gen reading CurrentUser
ListMembers: () => members.list(),
```

- How a handler reads the request headers: check `Rpc.make` handler context in `node_modules/effect/src/rpc/Rpc.ts` (the fixture reads `options.headers` in middleware; handlers may receive headers via a service or a second argument). Record what you used.
- `auth.api.signInMagicLink` needs `headers` (`requireHeaders: true`, `magic-link/index.ts:231`). A `BetterAuthApiError` here is left as a defect: the caller must not learn why.
- Do not log the email of a non-member at info level with the address in staging; a count is enough. In dev, logging it is fine.

### Step 5. Website client and proxy route

`src/backend-client.ts` additions, per the pattern in `src/query.ts`:

```ts
export const meAtom = BackendClient.query("Me", undefined, {
  serializationKey: "me",
  timeToLive: Infinity,
}).pipe(Atom.withReactivity(["me"]));
export const requestMagicLinkAtom = BackendClient.mutation("RequestMagicLink");
export const membersAtom = BackendClient.query("ListMembers", undefined, {
  serializationKey: "members",
  timeToLive: "5 minutes",
}).pipe(Atom.withReactivity(["members"]), refreshOnFocus);
// loadMe: like loadQuery, but an Unauthorized failure resolves to Option.none() instead of rejecting.
```

`src/routes/api.auth.$.ts`:

```ts
const allowed = (method: string, path: string) =>
  (method === "GET" && path === "/api/auth/magic-link/verify") ||
  (method === "POST" && path === "/api/auth/sign-out");
// handlers: GET and POST → allowed ? env.BACKEND.fetch(request) : 404 text. Everything else 404.
```

- Splat route file name `api.auth.$.ts`; param is `params._splat` (`refs/tan-start/docs/.../server-routes.md:295-313`). Use the request URL's pathname for the check, not the splat, so query strings don't matter.
- **S3:** the verify route answers 302 with `Set-Cookie`. Confirm the browser receives the redirect through the proxy. If `env.BACKEND.fetch` follows redirects, forward `new Request(request, { redirect: "manual" })` and record it.

### Step 6. Website routes and pages

Guard helper (`src/routes/-guards.ts` or inline; TanStack ignores `-` prefixed files):

```ts
export const requireRole =
  (role: Role) =>
  async ({ context, location }: BeforeLoadCtx) => {
    const me = await loadMe(context.registry);
    if (Option.isNone(me)) throw redirect({ to: "/sign-in", search: { redirect: location.href } });
    if (me.value.role !== role)
      throw redirect({ to: me.value.role === "admin" ? "/admin" : "/app" });
    return { me: me.value };
  };
```

- `beforeLoad` + `redirect` with return-to: `refs/tan-router/docs/router/guide/authenticated-routes.md:34-51`. Returned context flows to children (`router-context.md:428-437`).

Routes:

| File                         | Content                                                                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `sign-in.tsx`                | `validateSearch` with Schema (`redirect?`, `error?`). `beforeLoad`: if `loadMe` is `Some`, redirect to their side. Component `SignInPage`. |
| `admin.tsx`                  | `beforeLoad: requireRole("admin")`; component renders `AdminShell` with `<Outlet/>`.                                                       |
| `admin.index.tsx`            | Heading "Admin" and the signed-in email from `context.me`.                                                                                 |
| `admin.members.tsx`          | loader primes `membersAtom`; `MembersPage` table (email, role, created).                                                                   |
| `app.tsx`                    | `beforeLoad: requireRole("user")`; `MemberShell` with `<Outlet/>`.                                                                         |
| `app.index.tsx`              | Heading "Member area" and the email.                                                                                                       |
| `index.tsx` / `HomePage.tsx` | a "Sign in" link in the `TopNav` (`TopNavItem` or the nav's link slot; check `astryx component TopNav`).                                   |

Pages (Astryx):

- `SignInPage`: start from `pnpm exec astryx template login` (centered card). One `TextInput type="email"` and a primary `Button`. Decode with `EmailFromInput` before calling the mutation (the `HomePage` `Shout` pattern). States: idle; sent ("Check your email for a sign-in link"); sent with a link (dev): render the link as an Astryx `Link`/`Button href` labelled "Open your sign-in link"; error from `search.error`: one neutral message for any code ("That link didn't work. Request a new one."). `TooManyRequests` failure: "Too many attempts. Try again in a minute."
- `AdminShell` and `MemberShell`: start from `pnpm exec astryx template shell-side-nav`. `SideNavHeading` with the app name; `SideNavSection` with `SideNavItem`s: admin has "Home" (`/admin`) and "Members" (`/admin/members`); member has "Home" (`/app`). A "Sign out" item in the `SideNav` footer. Set the router `Link` once through Astryx's `LinkProvider` (see `astryx component Link`) so items navigate client-side; mark `isSelected` from the current route.
- `MembersPage`: `pnpm exec astryx template table`; dense data is a `Table`, not cards.
- Sign-out: `fetch("/api/auth/sign-out", { method: "POST", credentials: "include", headers: { "content-type": "application/json" } })`, then invalidate the `"me"` reactivity key (a no-op mutation with `reactivityKeys: ["me"]`, or `registry.refresh(meAtom)`) and `navigate({ to: "/" })`. Keep this in one small module, not in a component body.

### Step 7. `db:reset` script

In `scripts/dev.ts` style (Effect CLI, `Effect.fn`, Schema for parsing), add a `db:reset` command and the `package.json` script `"db:reset": "node --env-file-if-exists=.env scripts/dev.ts db:reset"`:

1. `dev:stop` if running (reuse `stopServer`).
2. `alchemy state delete <stack>/dev/<AuthDb path>` via the existing spawner. Discover the path first with `alchemy state list Alchemy-sandbox1/dev -r` and hard-code the resulting pattern; if the record path contains a namespace, record it in Deviations.
3. Remove `.alchemy/local` (local D1 data and simulated email; all virtual).
4. `dev:start`.

Print what it did at each step. Document it in `docs/worktrees-runbook.md` or `docs/website-port-runbook.md` only if those already describe dev-data handling; otherwise a line in README under the dev commands.

### Step 8. Dev run and spike checks

With the dev server up:

1. **S1 migrations and seed.** `alchemy dev` output or `logs/dev/current` shows the member migration, the seed import, and Better Auth's migration Action. Query via a temporary log line or the sign-in flow: `a@a.com` must be a member.
2. **Sign-in, inline.** On `/sign-in`, enter `a@a.com`. The page shows "Open your sign-in link"; the same URL is in `logs/dev/current`. Click it: land on `/admin` (bounced from `/app`). Sidebar shows Home and Members; Members lists three rows.
3. **Member.** Sign out. Enter `m1@m.com`, click the link, land on `/app`. Open `/admin`: redirected to `/app`.
4. **S5 non-member.** Enter `nobody@x.com`: same "Check your email" text, no link, no log line with a URL. Craft a verify URL for a non-member by temporarily seeding a member, requesting a link, then deleting the row: clicking must land on `/sign-in?error=not_invited`. Remove any temporary changes.
5. **Guards.** Signed out, open `/app`: redirected to `/sign-in?redirect=/app`; after sign-in, back on `/app`. Call `Me` and `ListMembers` with `curl` against the proxy without a cookie: `Unauthorized` typed failure; as a member, `ListMembers` is `Forbidden`.
6. **S4 SSR.** Hard-refresh `/admin` while signed in: the page renders server-side without a flash to `/sign-in` (the cookie reaches `Me` through `serverFetch`).
7. **S2** is proven by steps 2 and 4 (the callbacks ran). **S3** is proven by step 2 (the redirect landed with the cookie set).
8. **S6** admin role: `a@a.com` shows `role: admin` in `Me` (our hook ran before the plugin's default).
9. **Rate limit.** Six requests in a minute from one IP: the sixth returns `TooManyRequests` and the page shows the message.
10. **`db:reset`.** Run it; sign in as `a@a.com` again from scratch.

Record every check's result, and every one you could not perform, in Deviations and issues.

### Step 9. Staging (only if the reviewer asks; it deploys)

Not part of this plan's deliverable. The reviewer deploys with `vp run deploy:staging` and signs in as the seeded staging admin with real mail from `mail.mw10013.com`.

### Step 10. Cleanup and checks

- Remove `@yielded/auth` from `package.json` and the lockfile. Delete nothing under `docs/`.
- `pnpm typecheck`, `pnpm check` (lint + format), `pnpm test`.
- Self-check every page against AGENTS.md's Astryx rules.
- Update `README.md`'s dev commands with `db:reset` and the seeded dev accounts.

## Deviations and issues

The implementer records here. One bullet per item: file, what the plan said, what was done, why, and what the reviewer should look at.

- **Status (2026-10-10):** implemented on `main`, not committed. `pnpm typecheck`, `pnpm check`, `pnpm test` (no test files), `vp build` and `astryx doctor` pass.
- **Step 1, kysely.** Not added. `@alchemy.run/better-auth` lists it as an optional peer and `better-auth` already brings `kysely@0.29.6`; the deploy-time migration ran in dev. Also removed the four stale `@yielded/*` entries from `minimumReleaseAgeExclude` in `pnpm-workspace.yaml`.
- **Step 2, per-stage seed** (`src/backend/resources.ts`). Used the `Alchemy.Stage` service from an Effect passed as the D1 props: `Effect.serviceOption(Alchemy.Stage)` → `./seed/<stage>.sql`. Resource props Effects are evaluated in the resource constructor (`Resource.ts:479`), which also runs at Worker runtime, where `Stage` may be absent; `serviceOption` falls back to no seed there, where props are unused. No `SEED_FILE` config.
- **Step 2, configuration and secrets (revised after review).** No `.env.staging`, no `secrets` option and no auth settings in `.env`: a committed env file invites secrets. `MAGIC_LINK_DELIVERY` is gone (inline delivery is simply `ALCHEMY_DEV`); `AUTH_EMAIL_FROM` is a constant in `src/backend/auth.ts`. `AUTH_ORIGIN` is not configuration at all: `alchemy.run.ts` binds the Website's URL Output onto the Backend with `backend.bind("AuthOrigin", { env: { AUTH_ORIGIN: website.url } })`. A Worker's binding contract accepts `env` for exactly this (`Cloudflare/Workers/Worker.ts`, "attach env without the Worker init depending on that resource"); strings deploy as `plain_text`; a binding may close a cycle where a prop may not (the Website already binds the Backend), see `refs/alchemy/website/src/content/docs/infrastructure-as-effects/circular-bindings.mdx` and the props-plus-binding cycle test in `packages/alchemy/test/apply.test.ts`. Under `alchemy dev` it is the local URL; on deploy, the workers.dev URL or a future custom domain. The Backend reads it with `Config.option(Config.String("AUTH_ORIGIN"))` (absent while planning) and dies at runtime if it is missing; verified by removing the bind (Backend fails "AUTH_ORIGIN is not bound") and by `alchemy plan --stage staging` (`[Backend/AuthOrigin] create`, no settings needed). Real secrets: `Alchemy.Random` (the Better Auth secret), CI secrets or a secrets provider (Doppler, Infisical) per stage, never a committed file.
- **Step 2, seeds.** `seed/staging.sql` holds `support@mw10013.com` as the staging admin (chosen by the reviewer). `seed/production.sql` holds a placeholder `admin@example.com` with a TODO.
- **Step 3, schemas** (`src/api/backend.ts`). `EmailFromInput` = `String` → `decode(trim())` → `decode(toLowerCase())` → `Email`; `Email` also checks `isLowercased`, so the server rejects an unnormalized address (seen: `" M1@m.com "` sent raw is a defect, the UI decodes first). Added an optional `returnTo: ReturnPath` to the `RequestMagicLink` payload (a same-origin path schema, never `//host`) and used it as the magic link `callbackURL`, defaulting to `/app`. Without it the plan's own check 5 ("after sign-in, back on /app") only worked for `/app`; `/admin/members` now returns to `/admin/members`.
- **Step 4, Worker init and layers** (`src/backend/worker.ts`). `Auth.layer`, `Members.layer` and `SignInLimiter.layer` (a `Context.Service` around the `SignInLimit` binding client) are provided on the init effect, so they are built once and their bindings attach to the Worker at plan. The RPC server is still built per request (as `RpcWorker` did, `HttpServer.ts:16-47`): workerd pins I/O to the creating request. The init context is handed to the per-request RPC layers with `Layer.succeedContext`. `fetch` had to be bound to a `const` before `return { fetch }`; inline, the generator's requirement type inferred as `unknown` against `WorkerShape`.
- **Step 4, request headers in handlers.** Handlers receive `{ headers }` as the second argument (`rpc/Rpc.ts:220-229`); used for `cf-connecting-ip` and for `signInMagicLink`. In dev no `cf-connecting-ip` arrives from a browser, so all dev sign-ins share the rate-limit key `"unknown"`; Cloudflare sets the header in staging.
- **Step 4, `ALCHEMY_DEV` in the Worker.** Works: Config reads in Worker init are bound into the Worker env at plan (`Platform.ts:498-530`) and read back at runtime. Inline links appeared only under `alchemy dev`.
- **Step 4, `CurrentUser.asEffect()`** does not exist on `Context.Service` classes; `Me` yields `CurrentUser` in `Effect.gen`.
- **Step 4, email failures.** A `SendEmailError` in `sendMagicLink`, and any `BetterAuthApiError` from `signInMagicLink`, are defects (`Effect.orDie`), as the plan says. Staging email delivery is unverified (Step 9 is the reviewer's).
- **Step 5, proxy.** Forwards `new Request(request, { redirect: "manual" })` defensively; the 302 with `Set-Cookie` reached the client (S3). Non-allowlisted paths (`GET /api/auth/get-session`, `POST /api/auth/sign-in/magic-link`) return 404.
- **Step 5, `loadMe`** lives in `src/session.ts` with `signOut`. It does not refresh a cached `meAtom` (keep-alive; invalidated on sign-out with `registry.refresh(meAtom)`); sign-in is always a full page load, so a fresh registry fetches it.
- **Step 6, `/sign-in` search.** `validateSearch` decodes each field separately with Schema (`redirect` as `ReturnPath`), dropping a malformed field instead of failing the route.
- **Step 6, pages.** Shared frame `src/components/SideNavShell.tsx` (from `shell-side-nav`) behind `AdminShell`/`MemberShell`; `HomePanel` for the two home pages; `RouterLink` + `LinkProvider` in `__root.tsx`. No nav icons: Astryx's semantic icon set has no home/users/sign-out names and `@heroicons/react` is not installed. The dev magic link is a `Button as="a"` so it bypasses the router link (the verify URL is a server route). Kept the login template's `maxWidth: 400` frame; changed its `minHeight: "100%"` to `"100dvh"` because the page background stopped short of the viewport. `MembersPage` got `Layout padding={6}` inside the shell (the template assumes no `contentPadding={0}` shell). Roles render as `Token`.
- **Step 7, `db:reset`.** State paths (no namespace): `Alchemy-sandbox1/dev/AuthDb` **and** `Alchemy-sandbox1/dev/BetterAuthMigrate`; the migration Action's record is deleted too so Better Auth's tables are recreated in the fresh database. `start`'s body was extracted into `startServer` for reuse. Documented in README (no runbook covered dev data).
- **Spike S5 method.** Inserted a temporary `member` row directly in the local D1 SQLite file under `.alchemy/local/d1`, requested a link, deleted the row, then followed the link. Row removed afterwards (`member` count back to 3, no `user` row for it).

### Spike check results

| Check                                                                 | Result | Notes                                                                                                                                                                              |
| --------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1 migrations + seed in dev                                           | Pass   | Log shows `[AuthDb] created`, `[BetterAuthMigrate] ran`; the D1 migration and seed import have no own log lines, but `ListMembers` returns the 3 seeded rows and the tables exist. |
| S2 callbacks with the construction snapshot                           | Pass   | `sendMagicLink`, `validateUserInfo` and `create.before` all ran (inline link, `not_invited`, role copied).                                                                         |
| S3 verify redirect + cookie through the proxy                         | Pass   | `302 Location: /admin/members` with `Set-Cookie: better-auth.session_token=…` via `/api/auth/magic-link/verify`.                                                                   |
| S4 `getSession` in RpcMiddleware, browser and SSR                     | Pass   | curl with cookie and browser: `Me` succeeds; hard-loading `/admin/members` server-renders the table with `Me` and `ListMembers` dehydrated.                                        |
| S5 non-member: same reply, no link, `not_invited` on a crafted verify | Pass   | `nobody@x.com` → `{ link: None }`, log line without address or URL; crafted verify → `/sign-in?error=not_invited`, no user created.                                                |
| S6 our role hook runs before the admin plugin's default               | Pass   | `a@a.com` → `Me.role = "admin"`; `m1@m.com` → `"user"`.                                                                                                                            |
| Rate limit                                                            | Pass   | 6th request in a minute from one `cf-connecting-ip` → `TooManyRequests`. UI message not exercised in the browser.                                                                  |
| `db:reset`                                                            | Pass   | Stopped, forgot both records, removed `.alchemy/local`, restarted; fresh DB seeded and `a@a.com` signed in.                                                                        |

Other checks: signed out, `/app` and `/admin/members` → 307 to `/sign-in?redirect=…`; member on `/admin` → `/app`; admin on `/app` → `/admin`; signed-in user on `/sign-in` → their home; `ListMembers` without cookie → `Unauthorized`, as member → `Forbidden`; sign-out clears the cookie and `Me` turns `Unauthorized`; in the browser, sign-out lands on `/` and re-opening `/admin/members` asks to sign in again.
