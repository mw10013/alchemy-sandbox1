# Plan: ShopActor proof of concept

Date: 2026-10-11.
Status: approved design, not implemented. Every decision below was accepted in Plannotator on 2026-10-11 ([research §13](./shop-actor-poc-research.md#13-questions-with-recommendations)); do not reopen them. Record anything that differs from this plan in [§9](#9-deviations-and-issues).
Research: [shop-actor-poc-research.md](./shop-actor-poc-research.md) (the why; this file is the what). Vocabulary: [glossary](./glossary.md): **Actor**, **Procedure**, **Query atom**, **Reactivity key**, **Prime**.
Versions: Alchemy `2.0.0-beta.81`, Effect `4.0.1`, `@effect/atom-react` `4.0.1`, `@effect/sql-sqlite-do` `4.0.1` (the one new dependency), Playwright `1.64.0`, Vite+ `1.1.0`. Do not bump anything.

## 1. Outcome

A `ShopActor` Durable Object hosted by the Backend, with a one-row `count` table in its SQLite storage. A signed-in member opens `/app/shop/alchemy-sandbox1`, sees the count, and clicks **Increment**. The browser talks to the actor over one hibernating WebSocket with Effect RPC; the SSR render reads the same actor over HTTP through the service binding. After a write the actor sends a notice to every connected socket, every tab invalidates its `count` query, and refetches over its socket. The actor hibernates while tabs stay connected, and an `Activation` procedure proves it: its id changes after an idle period. `vp check`, `vp test` and `vp run test:e2e` stay green at every step.

## 2. Rules the implementer must follow

- Read `AGENTS.md` first: Effect Schema for all validation (never a hand-rolled regex test on input), `Match` for tag dispatch, `Schema.TaggedError` for errors, `Effect.fn("name")` for reusable effects, JSDoc on declarations with each rule stated once, no `//` above a declaration, no reference to this plan or the research in code.
- Tooling through `vp` (`vp check --fix`, `vp test`, `vp run test:e2e`, `vp exec alchemy`); the package manager is `pnpm` (one `pnpm add`). Never `npm` or `npx`.
- Do not commit. Do not create branches. Do not touch `.env`.
- Follow the existing seams exactly: the `api/` vs `backend/` split, `Effect.fn("Service.method")` plus `Effect.orDie` for storage code as in `members.ts`, the `createIsomorphicFn` pattern of `backend-client.ts`, `loadQuery` for every SSR-rendered query, copy rules on `RootDocument`, Astryx components only (start from `astryx component Button`, no raw `<div>`).
- Alchemy's Durable Object contract: the **outer** Effect resolves dependencies and the `Cloudflare.DurableObjectState` reference; everything that touches `state.*`, storage or sockets runs in the **inner** Effect or a handler (those APIs are coloured with `RuntimeContext`). Nothing acquired in the inner Effect may be a disposable resource; the SQL client over local storage is fine (Alchemy's own `Drizzle.DurableObject` does the same).
- Keep every step green: `vp check`, `vp test` (unit, browser, integ) after each step; `vp run test:e2e` after Step 9.
- Where this plan says **confirm**, the API name or behaviour was read from source but not run; check it before relying on it and note any difference in [§9](#9-deviations-and-issues).

## 3. The pieces, in dependency order

| Step | Piece                                                           | Files                                                                                                                                   |
| ---- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Dependency                                                      | `package.json`, `pnpm-lock.yaml`                                                                                                        |
| 2    | API definition: the group, schemas, the notice, the key         | `src/api/shop-actor.ts`                                                                                                                 |
| 3    | The actor: SQLite client, migration, handlers, notify           | `src/backend/shop-actor.ts`                                                                                                             |
| 4    | Backend: host the actor, gate and forward `/api/actor/:key`     | `src/backend/worker.ts`, `src/backend/middleware.ts`                                                                                    |
| 5    | Website route for the upgrade and the SSR call                  | `src/routes/api.actor.$key.ts`, `src/routes/api.rpc.ts`                                                                                 |
| 6    | Spike check: the upgrade hop, end to end, with a scratch client | nothing in the repo (a script under `/tmp`)                                                                                             |
| 7    | Client: socket with notice tap, isomorphic protocol, atoms      | `src/shop-actor-client.ts`                                                                                                              |
| 8    | Page and navigation                                             | `src/routes/app.shop.$key.tsx`, `src/components/ShopPage.tsx`, `src/components/MemberShell.tsx`                                         |
| 9    | Tests: browser, integ, e2e                                      | `test/browser/shop-actor.ts`, `src/components/ShopPage.test.tsx`, `test/integ/shop-actor.test.ts`, `e2e/shop.spec.ts`, `e2e/screens.ts` |
| 10   | Glossary and README                                             | `docs/glossary.md`, `README.md`                                                                                                         |

## 4. Steps

### Step 1: dependency

`pnpm add @effect/sql-sqlite-do@4.0.1`. It is already in the pnpm store as Alchemy's dependency, so this only hoists it. Imports: `@effect/sql-sqlite-do/SqliteClient`, `@effect/sql-sqlite-do/SqliteMigrator`; the core is `effect/sql/SqlClient`.

Verify: `vp check` passes; `vp run typecheck` (or the `vp check` type step) resolves the import in an empty scratch file, then delete it.

### Step 2: API definition

`src/api/shop-actor.ts`, schemas only, imported by both Workers and the browser.

```ts
import * as Schema from "effect/Schema";
import { Rpc, RpcGroup } from "effect/rpc";

/**
 * Names one shop's actor. A shop is identified by its domain in the product this grows into;
 * until shops exist the key is any lowercase slug. The route param and the Backend path decode
 * through this, so an unknown shape never reaches `getByName`.
 */
export const ShopKey = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,62}$/u)).pipe(
  Schema.brand("ShopKey"),
);
export type ShopKey = typeof ShopKey.Type;

/** The one shop the sandbox has. The member navigation links to it. */
export const SANDBOX_SHOP: ShopKey = Schema.decodeUnknownSync(ShopKey)("alchemy-sandbox1");

export const Count = Schema.Struct({ value: Schema.Int });
export type Count = typeof Count.Type;

export const Activation = Schema.Struct({ id: Schema.String });

/**
 * What the actor pushes to every connected socket after a write: the reactivity keys whose
 * queries are stale. Never the data; a tab refetches what it renders. Carried on the RPC
 * socket as its own frame, outside the RPC protocol; see `ShopActorClient`.
 */
export const Notice = Schema.Struct({
  _tag: Schema.Literal("ShopActorNotice"),
  invalidated: Schema.Array(Schema.String),
});
export type Notice = typeof Notice.Type;

/** The `count` reactivity key. */
export const COUNT_KEY = "count";

export const ShopActorRpcs = RpcGroup.make(
  Rpc.make("GetCount", { success: Count }),
  Rpc.make("Increment", { success: Count }),
  Rpc.make("Activation", { success: Activation }),
);
```

Notes:

- `Schema.isPattern` on a string schema is how `backend.ts` validates `Email` and `ReturnPath`; the pattern lives in the schema, not in a hand-rolled test.
- No middleware on the group: the Backend gates the whole path on the session before forwarding ([Step 4](#step-4-backend)), and a procedure does not need to know who called it in this POC. When procedures need the member, add a `CurrentUser`-style middleware here and resolve it in the Backend before forwarding (headers to the actor), not inside the actor, which never sees cookies.
- `Activation` is a dev aid and its JSDoc says so: it returns an id minted once per activation, so a changed id after idle shows the object hibernated and was rebuilt.

### Step 3: the actor

`src/backend/shop-actor.ts`.

```ts
import * as SqliteClient from "@effect/sql-sqlite-do/SqliteClient";
import * as SqliteMigrator from "@effect/sql-sqlite-do/SqliteMigrator";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { COUNT_KEY, Count, Notice, ShopActorRpcs } from "../api/shop-actor.ts";

const CountRow = Schema.Struct({ value: Schema.Int });
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(CountRow));
const encodeNotice = Schema.encodeSync(Schema.fromJsonString(Notice)); // confirm: encodes Notice -> JSON string

/** The schema of one actor's storage, applied on every activation; see {@link ShopActor}. */
const migrations = SqliteMigrator.fromRecord({
  "0001_count": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE count (id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL)`;
    yield* sql`INSERT INTO count (id, value) VALUES (1, 0)`;
  }),
});

/**
 * One shop's actor: a `count` in private SQLite, read and written over Effect RPC on HTTP or a
 * hibernating WebSocket (both provided by `RpcDurableObject`). After a write it pushes a
 * {@link Notice} to every socket so each tab refetches; it never pushes the value.
 *
 * Everything below `state` runs once per activation, including after a hibernation wake, so
 * the SQL client is rebuilt and the migrator re-checks its table each time. Migrations run
 * inside the `blockConcurrencyWhile` Alchemy wraps construction in, so no request sees a
 * half-migrated store. A single-statement write needs no transaction; a multi-statement one
 * will need `withTransaction` and Alchemy's `MixedScheduler("sync")` workaround from its
 * `Drizzle.DurableObject`.
 */
export default class ShopActor extends Cloudflare.RpcDurableObject<ShopActor>()(
  "ShopActor",
  { schema: ShopActorRpcs },
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    return Effect.gen(function* () {
      const sql = yield* Layer.build(SqliteClient.layer({ storage: state.raw.storage })).pipe(
        Effect.map((context) => Context.get(context, SqlClient.SqlClient)),
      ); // confirm: or yield* SqlClient.SqlClient under Effect.provide(SqliteClient.layer(...)); pick the form that keeps the client for the activation
      yield* SqliteMigrator.run({ loader: migrations }).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.orDie,
      );
      const activationId = yield* Effect.sync(() => crypto.randomUUID());

      const readCount = Effect.fn("ShopActor.readCount")(function* () {
        const [row] = yield* decodeRows(yield* sql`SELECT value FROM count WHERE id = 1`);
        return yield* Effect.fromNullishOr(row); // confirm name; a missing row is a broken invariant
      }, Effect.orDie);

      const notify = Effect.fn("ShopActor.notify")(function* (invalidated: ReadonlyArray<string>) {
        const frame = encodeNotice({ _tag: "ShopActorNotice", invalidated });
        // A socket mid-close rejects the send; the next notice or the client's reconnect covers it.
        for (const socket of yield* state.getWebSockets())
          yield* socket.send(frame).pipe(Effect.ignore);
      });

      return ShopActorRpcs.toLayer({
        GetCount: () => readCount(),
        Increment: () =>
          Effect.gen(function* () {
            const [row] = yield* decodeRows(
              yield* sql`UPDATE count SET value = value + 1 WHERE id = 1 RETURNING value`,
            );
            const count = yield* Effect.fromNullishOr(row);
            yield* notify([COUNT_KEY]);
            return count;
          }).pipe(Effect.orDie),
        Activation: () => Effect.succeed({ id: activationId }),
      });
    });
  }),
) {}
```

Points to settle while writing (record in [§9](#9-deviations-and-issues)):

- The SQL client's lifetime. `SqliteClient.layer` needs a `Scope`; the inner Effect has one (`Scope` is in its requirements per `DurableObject.ts`). Building the layer into the inner Effect's scope keeps the client for the activation, which is what `Drizzle.DurableObject` does. If `Layer.build` inside the inner Effect does not type-check against `RpcDurableObject`'s `InnerR`, provide `SqliteClient.layer(...)` to the handler layer instead (`ShopActorRpcs.toLayer(...).pipe(Layer.provide(SqliteClient.layer({ storage: state.raw.storage })))`) and run the migrator in the inner Effect under its own `Effect.provide`. Both are fine; the first avoids building two clients.
- `state.getWebSockets()` is coloured with `RuntimeContext`; a handler has it. The sockets returned are Alchemy's RPC sockets (tag `alchemy:rpc`), which is what we want; do not filter by that tag, it is Alchemy's internal.
- `Schema.fromJsonString(Notice)` is the Effect 4 name for the JSON-string transformation (`Schema.ts` has `fromJsonString` and `UnknownFromJsonString`); **confirm** the direction of `encodeSync` on it produces the string.
- The migrator writes its history to `effect_sql_migrations`. Do not also use `Cloudflare.SqlMigrations` on this object.

### Step 4: Backend

`src/backend/middleware.ts`: extract the session resolution from `CurrentUserLive` into an exported `Effect.fn("currentUserFromCookie")` taking the cookie header value (string or undefined) and failing `Unauthorized`; `CurrentUserLive` calls it. No behaviour change.

`src/backend/worker.ts`:

1. In the init Effect, `const actors = yield* ShopActor;` next to the other service resolutions. This exports the class from the Backend bundle and declares the namespace binding; nothing in `alchemy.run.ts` changes.
2. In `fetch`, before the `rpc` fallthrough:
   ```ts
   const actorKey = actorKeyFromPath(pathname); // Option<ShopKey>
   if (Option.isSome(actorKey)) {
     yield *
       currentUserFromCookie(request.headers.cookie).pipe(
         Effect.catchTag("Unauthorized", () => Effect.succeed(undefined)), // see below
       );
     return yield * actors.fetch(actorKey.value, request);
   }
   ```
   On `Unauthorized`, return `HttpServerResponse.empty({ status: 401 })` instead of forwarding (write it with `Effect.matchEffect` or `Match`, not the placeholder above). `actorKeyFromPath` splits the pathname on `/`, accepts exactly `["", "api", "actor", key]` with an optional trailing empty segment (Effect's HTTP RPC client posts to `<url>/`), and decodes `key` with `Schema.decodeUnknownOption(ShopKey)`. Anything else is `None`.
3. Update the Worker's JSDoc: it also hosts `ShopActor` and forwards `/api/actor/:key` to the named actor after a session check; the actor serves the RPC itself, over HTTP for the SSR call and over a WebSocket for the browser; any member may open any key for now, which is a product decision not yet taken.

`actors.fetch(key, request)` is Alchemy's: it selects the named instance and forwards the request or upgrade, and the 101 comes back as a raw body that the Backend's HTTP bridge passes through (`Fetcher.ts`, `HttpServerResponse.toWeb`).

Verify: `vp test --project integ` still passes (the stack now deploys the actor; a `.alchemy/local` namespace appears). `curl -i http://localhost:<backend-port>/api/actor/alchemy-sandbox1/` with no cookie is 401; with a session cookie and an ndjson `GetCount` body it returns the count. Get a cookie the way `test/integ/auth.test.ts` does, or wait for Step 6.

### Step 5: Website route

`src/routes/api.actor.$key.ts`:

```ts
import { createFileRoute } from "@tanstack/react-router";
import { env } from "../env.server.ts";
import { rejectRequest, text } from "../rpc-proxy.ts";

/**
 * Forwards one shop's actor traffic to `Backend`, which checks the session and selects the
 * actor: a WebSocket upgrade on GET, Effect RPC on POST (after {@link rejectRequest}). The key
 * is decoded by the Backend; this route only carries it.
 */
export const Route = createFileRoute("/api/actor/$key")({
  server: {
    handlers: {
      GET: ({ request }) =>
        request.headers.get("upgrade")?.toLowerCase() === "websocket"
          ? env.BACKEND.fetch(request)
          : text(426, "Upgrade Required", { upgrade: "websocket" }),
      POST: ({ request }) => rejectRequest(request) ?? env.BACKEND.fetch(request),
    },
  },
});
```

`src/routes/api.rpc.ts`: replace the `GET` handler's comment ("WebSocket upgrades are GETs too; they get 405 until the Durable Object phase") with one line pointing at the actor route: upgrades go to `/api/actor/$key`; this route is HTTP only.

Start returns a handler's `Response` unchanged, so the 101 with its `webSocket` reaches workerd. `routeTree.gen.ts` regenerates on the next dev start or `vp check`; commit nothing.

### Step 6: spike check, the upgrade hop

Before writing the browser client, prove the chain browser → Vite dev proxy → Website → binding → Backend → actor with a scratch script outside the repo (`/tmp/shop-actor-spike/`), Node 24's global `WebSocket`, no new dependencies, Effect imported from the checkout's `node_modules` by absolute path if needed.

1. `vp run dev:start`. Sign in as `m1@m.com` in a browser, copy the session cookie (or obtain one through the test-control `IssueMagicLink` as `e2e/auth.setup.ts` does, with `E2E_TOKEN` set for this dev run).
2. Open `ws://localhost:$(pnpm port)/api/actor/alchemy-sandbox1` with the cookie header. Node's `WebSocket` (undici) accepts `{ headers }` as the second argument; **confirm**, otherwise use `Socket.fromWebSocket` with any `WebSocketLike`.
3. Send `{"_tag":"Request","id":"1","tag":"GetCount","payload":{},"headers":[]}` and expect an `Exit` frame with `{"value":0}` (the exact `Request` shape is in `RpcMessage.ts`; copying it by hand here is fine because it is a throwaway).
4. Send `Increment` and observe both the `Exit` and a `{"_tag":"ShopActorNotice","invalidated":["count"]}` frame.
5. Open a second socket and confirm the notice arrives there too.
6. Send `{"_tag":"Ping"}` and expect `{"_tag":"Pong"}`; the auto-response answers it.
7. Leave both sockets idle for 20 s, call `Activation` on each before and after, and confirm the id changed and both sockets still work.

Record the outcome of each in [§9](#9-deviations-and-issues). If the hop fails at the Vite proxy or the Start route, that is the one place where the plan's architecture could change; stop and report rather than working around it.

### Step 7: client

`src/shop-actor-client.ts`. Mirrors `backend-client.ts`.

```ts
/** Notices pulled off the socket by {@link layerSocketWithNotices}; one per tab, like the socket. */
export const notices = Effect.runSync(PubSub.unbounded<Notice>());

const decodeNotice = Schema.decodeUnknownOption(Schema.fromJsonString(Notice)); // confirm

/**
 * The RPC socket with the actor's notice frames taken out: a frame that decodes as
 * {@link Notice} is published to {@link notices} and never reaches the RPC protocol, so the
 * protocol sees only its own messages. Pull again when a chunk held nothing else, because a
 * reader's pull must return a non-empty array.
 */
const layerSocketWithNotices = (url: string) =>
  Layer.effect(
    Socket.Socket,
    Effect.gen(function* () {
      const inner = yield* Socket.makeWebSocket(url);
      const pullFiltered = (pull: Socket.Reader["pull"]): Socket.Reader["pull"] =>
        Effect.gen(function* () {
          while (true) {
            const rest: Array<Uint8Array | string> = [];
            for (const frame of yield* pull) {
              const notice = typeof frame === "string" ? decodeNotice(frame) : Option.none();
              if (Option.isSome(notice)) yield* PubSub.publish(notices, notice.value);
              else rest.push(frame);
            }
            if (Arr.isNonEmptyArray(rest)) return rest;
          }
        });
      return Socket.make({
        writer: inner.writer,
        reader: Effect.map(inner.reader, (reader) => ({
          ...reader,
          pull: pullFiltered(reader.pull),
        })),
      });
    }),
  );
```

Protocol, isomorphic:

```ts
const browserProtocol = (key: ShopKey) =>
  RpcClient.layerProtocolSocket({ retryTransientErrors: true }).pipe(
    Layer.provide(
      Layer.mergeAll(
        layerSocketWithNotices(`${wsOrigin()}/api/actor/${key}`),
        RpcSerialization.layerJson,
        // Refetch after every (re)connect: a notice sent while this tab was disconnected is lost.
        Layer.succeed(RpcClient.ConnectionHooks)({
          onConnect: PubSub.publish(notices, { _tag: "ShopActorNotice", invalidated: [COUNT_KEY] }),
          onDisconnect: Effect.void,
        }),
      ),
    ),
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
  );

const serverProtocol = (key: ShopKey) =>
  RpcClient.layerProtocolHttp({ url: `https://backend/api/actor/${key}` }).pipe(
    Layer.provide(RpcSerialization.layerNdjson),
    Layer.provide(
      /* the same FetchHttpClient over env.BACKEND.fetch with the cookie as backend-client.ts; extract that transport to a shared module rather than copy it */
    ),
  );

const protocol = createIsomorphicFn().client(browserProtocol).server(serverProtocol);

/** The shop whose actor this registry's client talks to. A route loader sets it before priming. */
export const shopKeyAtom = Atom.make<ShopKey>(SANDBOX_SHOP);

export class ShopActorClient extends AtomRpc.Service<ShopActorClient>()("ShopActorClient", {
  group: ShopActorRpcs,
  protocol: (get) => protocol()(get(shopKeyAtom)),
}) {}

export const countAtom = ShopActorClient.query("GetCount", undefined, {
  serializationKey: "count",
  timeToLive: "5 minutes",
}).pipe(Atom.withReactivity([COUNT_KEY]), refreshOnFocus);

export const incrementAtom = ShopActorClient.mutation("Increment");

export const activationAtom = ShopActorClient.query("Activation", undefined, {
  serializationKey: "activation",
});

/** Turns notices into invalidations; mounted by the page. The stream never ends. */
export const noticesAtom = ShopActorClient.runtime.atom(
  Stream.fromPubSub(notices).pipe(
    Stream.tap((notice) => Reactivity.invalidate(notice.invalidated)),
  ),
);
```

Notes and things to **confirm**:

- `wsOrigin()` is `window.location.origin` with `http` replaced by `ws`; do it with `new URL` (`protocol = protocol === "https:" ? "wss:" : "ws:"`), not string surgery.
- `protocol` as a function of `get` is `AtomRpc.ts`'s second overload; reading `shopKeyAtom` there makes the runtime layer depend on the key, so a key change rebuilds the client (and reconnects). The POC links one key; the param exists so a second key can be tried by hand.
- `ConnectionHooks` is read with `Effect.serviceOption` inside `makeProtocolSocket` (`RpcClient.ts` ~1071), so providing it in the protocol layer is enough. `onConnect` runs on every successful (re)connect. Publishing a synthetic notice keeps the invalidation path single.
- `Reactivity.invalidate` requires `Reactivity`; the runtime provides it, and `Atom.withReactivity` registers against the same instance because both come from the default runtime factory. If the stream atom's requirement does not type-check, use `ShopActorClient.runtime.atom` as written (its `R` admits `Reactivity`).
- The stream atom's value is `AsyncResult` and nobody reads it; the page mounts it with `useAtomMount(noticesAtom)` so the subscription lives while the page does.
- One `notices` PubSub per module is one per browser tab, which matches one socket per registry; the server never pulls from it. If a second actor client ever needs its own notices, move the PubSub into the protocol layer and expose it as a service.
- The shared SSR transport: `backend-client.ts` builds `serverFetch` and `transport`; move them to `src/backend-transport.ts` (or similar) and import from both clients. No behaviour change for `BackendClient`.
- On SSR the socket layer is never built (`createIsomorphicFn` picks `.server`), so `Socket.layerWebSocketConstructorGlobal` does not run in workerd.

### Step 8: page and navigation

`src/routes/app.shop.$key.tsx`:

```ts
export const Route = createFileRoute("/app/shop/$key")({
  params: { parse: ({ key }) => ({ key: Schema.decodeUnknownSync(ShopKey)(key) }), stringify: (p) => p }, // confirm Start's params API shape
  loader: async ({ context, params }) => {
    context.registry.set(shopKeyAtom, params.key);
    await Promise.all([loadQuery(context.registry, countAtom), loadQuery(context.registry, activationAtom)]);
  },
  component: function ShopRoute() { return <ShopPage />; },
});
```

A bad key must 404 or render the route error boundary, not reach the Backend; the `parse` throw does that.

`src/components/ShopPage.tsx`: `useAtomMount(noticesAtom)`; `useAtomValue(countAtom)`; `useAtom(incrementAtom)`; `useAtomValue(activationAtom)`. Render with Astryx (`astryx build "a panel with a number, a button and a caption"` first; keep the template's frame): a `Heading` "Shop", the count as `Text` with a visible label "Count", a `Button` "Increment" (disabled while the mutation is `waiting`), and the activation id as a small caption labelled "Activation". Copy follows `RootDocument`'s rules: no "demo", no protocol words. Failures: the count's `AsyncResult` failure renders "Couldn't reach the shop. Try again." like `Playground` does for `Shout`.

`src/components/MemberShell.tsx`: add `{ label: "Shop", href: \`/app/shop/${SANDBOX_SHOP}\` }`to`ITEMS`.

Verify in two browser tabs under `vp run dev:start`: both show the count; a click in one updates both within a second; the activation id is equal in both tabs, and after about 20 s with no clicks a reload (or the `refreshOnFocus` refetch) shows a new id in both.

### Step 9: tests

**Browser** (`src/components/ShopPage.test.tsx`, `test/browser/shop-actor.ts`): a helper like `test/browser/backend.ts` that seeds `ShopActorClient.runtime.layer` with `RpcTest.makeClient(ShopActorRpcs, { flatten: true })` over the test's handlers (no middleware to stub). Tests: the page shows the count from `GetCount`; clicking Increment calls the handler and shows the new value; publishing `{ _tag: "ShopActorNotice", invalidated: ["count"] }` to the exported `notices` PubSub makes the page refetch (the handler's second answer appears). The socket and the tap are not exercised here.

**Integ** (`test/integ/shop-actor.test.ts`, reusing `test/integ/stack.ts`): sign in as in `auth.test.ts` to get the cookie, then:

1. Two WebSocket clients to `ws://<backendUrl host>/api/actor/<key>`, each `RpcClient.make(ShopActorRpcs)` over `RpcClient.layerProtocolSocket` + the same `layerSocketWithNotices`-style tap (import the production socket layer if it is exported, else duplicate the few lines) + `RpcSerialization.layerJson` + a `WebSocketConstructor` layer that passes the cookie header (`Layer.succeed(Socket.WebSocketConstructor)((url) => new WebSocket(url, { headers: { cookie } }))`; **confirm** undici accepts `headers`).
2. `GetCount` on A; `Increment` on A; assert B's notice arrives (take from a subscription on the test's PubSub with a bounded timeout) and B's `GetCount` equals A's result.
3. An upgrade without a cookie is refused: a plain `fetch` with `upgrade: websocket` headers returns 401, or the `Socket` open fails. Assert whichever is observable from Node.
4. Hibernation: `Activation` on A, then `Effect.repeat` of `Activation` on A with `Schedule.spaced("5 seconds")`, `until` the id differs, `times: 10`. Both sockets stay open and idle meanwhile (their pings are answered by the auto-response). Set this test's timeout to 90 s; the project default is 30 s.

Use `Test.rpcClientLayer` from `alchemy/Test/Vitest` only for HTTP; the socket clients are built by hand as above.

**E2E** (`e2e/shop.spec.ts`, `e2e/screens.ts`): `test.use({ storageState: "playwright/.auth/member.json" })`; add `shop(page)` locators to `screens.ts` (count text, Increment button, activation caption). Spec: open `/app/shop/alchemy-sandbox1` in `page` and in `const other = await context.newPage()` (same storage state), read the count in `other`, click Increment in `page`, `await expect(shop(other).count).toHaveText(String(before + 1))`. Values are relative because the e2e stage's actor storage persists under `.alchemy/` across runs. The e2e stage is a deployed Worker, not the Vite dev proxy, so this also verifies the hop without Vite in front.

### Step 10: glossary and README

`docs/glossary.md`: extend the **Actor** row with "hosted by the Backend; reached at `/api/actor/<key>`"; add **Notice** ("a frame an actor pushes to its sockets naming the reactivity keys to invalidate; never carries data") and **Shop key** ("the string that names one shop's actor; `ShopKey`"). Avoid column: "event", "broadcast message".

`README.md`: one paragraph under the architecture notes: the Backend hosts Durable Objects; a browser reaches an actor over one WebSocket at `/api/actor/<key>`, with Effect RPC on it and notices for invalidation; `vp run test:e2e` covers two tabs.

## 5. Verification checklist

- [ ] `vp check` clean after every step.
- [ ] `vp test` green: unit unchanged, browser includes `ShopPage.test.tsx`, integ includes `shop-actor.test.ts`.
- [ ] `vp run test:e2e` green with `shop.spec.ts`.
- [ ] Step 6 spike items 1 to 7 all observed and recorded.
- [ ] Two tabs under `alchemy dev`: a click updates both; the activation id changes after idle.
- [ ] No cookie → 401 on `/api/actor/<key>`; bad key in the URL → route error, no Backend call.
- [ ] `git status` shows only the files in [§7](#7-file-plan) plus `routeTree.gen.ts` and the lockfile; `.alchemy/` and `.vitest/` untracked as before.
- [ ] No `//` comment above a declaration, no reference to this plan or the research, no raw `<div>`.

## 6. Out of scope

Per-connection identity or role tags on sockets; authorization of which member may open which key; more than one procedure that writes; alarms and scheduling; `withTransaction` and the scheduler workaround; a per-key client family; presence; the Baton port itself. Each has its home in the research (§9) and should be a new plan.

## 7. File plan

| File                                   | Change                                                                                        |
| -------------------------------------- | --------------------------------------------------------------------------------------------- |
| `package.json`, `pnpm-lock.yaml`       | `@effect/sql-sqlite-do@4.0.1`                                                                 |
| `src/api/shop-actor.ts`                | new: `ShopKey`, `SANDBOX_SHOP`, `Count`, `Activation`, `Notice`, `COUNT_KEY`, `ShopActorRpcs` |
| `src/backend/shop-actor.ts`            | new: `ShopActor`                                                                              |
| `src/backend/middleware.ts`            | extract `currentUserFromCookie`                                                               |
| `src/backend/worker.ts`                | host the actor; gate and forward `/api/actor/:key`; JSDoc                                     |
| `src/routes/api.actor.$key.ts`         | new: GET upgrade and POST RPC forwarders                                                      |
| `src/routes/api.rpc.ts`                | GET comment points at the actor route                                                         |
| `src/backend-transport.ts` (name free) | new: the SSR fetch over the binding, shared by both clients                                   |
| `src/backend-client.ts`                | import the shared transport                                                                   |
| `src/shop-actor-client.ts`             | new: notices, socket tap, protocols, `ShopActorClient`, atoms                                 |
| `src/routes/app.shop.$key.tsx`         | new                                                                                           |
| `src/components/ShopPage.tsx`          | new                                                                                           |
| `src/components/MemberShell.tsx`       | "Shop" nav item                                                                               |
| `test/browser/shop-actor.ts`           | new: test registry for `ShopActorClient`                                                      |
| `src/components/ShopPage.test.tsx`     | new                                                                                           |
| `test/integ/shop-actor.test.ts`        | new                                                                                           |
| `e2e/shop.spec.ts`, `e2e/screens.ts`   | new spec; `shop(page)` locators                                                               |
| `docs/glossary.md`, `README.md`        | terms; one paragraph                                                                          |
| `src/routeTree.gen.ts`                 | regenerated                                                                                   |

## 8. Order of work and stopping points

Steps 1 to 5 are server-only and leave the app unchanged for users. Step 6 is the gate: if the upgrade hop does not work through the Vite dev proxy and the Start route, stop and report with the observations; the fallback routes are in research §5 (option D for notices, option A if hibernation is deferred) and need the user's decision. Steps 7 to 10 follow only after Step 6 passes.

## 9. Deviations and issues

For the implementer. Append as you go; keep each entry short and dated. A deviation is anything built differently from the step that specified it; an issue is anything observed that the plan did not predict (a failing assumption, an API that differs from the sketch, a flaky test, a limit hit). Do not rewrite the steps above; this section is the record.

### Deviations

- 2026-10-11, Step 2: added `NoticeFrame = Schema.fromJsonString(Notice)` to `src/api/shop-actor.ts`, so the actor (encode) and the client (decode) share one JSON-frame schema instead of each wrapping `Notice`. `Activation` got the dev-aid JSDoc the step asked for.
- 2026-10-11, Step 3: `notify` catches a failed send with `Effect.catchDefect`, not `Effect.ignore`. Alchemy's `WebSocket.send` is `Effect.sync(() => ws.send(...))` with no error channel, so a throw on a closing socket is a defect, which `Effect.ignore` does not catch. `Increment` is written as `increment().pipe(Effect.tap(() => notify([COUNT_KEY])))` with `increment` an `Effect.fn` + `Effect.orDie` like `readCount`; same behaviour as the sketch.
- 2026-10-11, Step 4: `actorKeyFromPath` decodes the split path with a Schema union of two tuples (`["", "api", "actor", ShopKey]` and the same with a trailing `""`) instead of hand-matching segments. `Match.when` with a tuple pattern does not check array length (`/api/actor/a/b` matched `["", "api", "actor", Match.string]` in a quick run), and a Schema tuple rejects extra elements. The 401 branch is `Effect.matchEffect`. `currentUserFromCookie` needs `Auth`, so the Worker yields the `Auth` service once at init and provides it to the call; `CurrentUserLive` does the same.
- 2026-10-11, Step 7: `protocol: (get) => protocol(get(shopKeyAtom))`; the isomorphic function takes the key itself rather than returning a function of it (`protocol()(key)` in the sketch). The shared SSR transport is `src/backend-transport.ts`, exporting `backendTransport` (`serverFetch` moved with it); `BackendClient` imports it, no behaviour change.
- 2026-10-11, Step 8: the page is `Layout` > `LayoutContent padding={6}` (as `HomePanel`) with the count, button and alert in a `Card`; `astryx build` matched no template, and the page lives inside the existing `MemberShell`, so no shell was scaffolded. The count is a `Text role="status"` labelled by the visible "Count" label (`aria-labelledby`), so tests find it as `getByRole("status", { name: "Count" })`. The button uses `isLoading` while the mutation waits (it disables interaction, as `Playground`'s Shout does). An `Increment` failure shows the same "Couldn't reach the shop. Try again." alert. `params.stringify` is `({ key }) => ({ key })`.
- 2026-10-11, Step 9 (browser): the seeded runtime layer merges `Reactivity.layer` and is cast to `Layer.Layer<ShopActorClient>`. Seeding `ShopActorClient.runtime.layer` replaces the factory's layer, which is where `Reactivity` normally comes from, and `noticesAtom` needs it; the runtime's layer type names only the client, so the wider layer needs the cast. Four tests: count and activation shown; Increment calls the handler and the page shows the new value after a notice; a published notice refetches; a dead `GetCount` shows the alert.
- 2026-10-11, Step 9 (integ): (a) the hibernation poll is `Schedule.spaced("12 seconds")`, `times: 5`, not 5 s × 10: every `Activation` call is an event that keeps the object awake, and local workerd evicted an idle actor after about 10 s (measured: same activation after 5 s and 8 s idle, a new one after 11 s and 14 s), so 5 s polls never see a new id. The test passed in ~13 s. (b) The cookie goes in through `NodeSocket.layerWebSocketConstructor` from `@effect/platform-node` (already a dependency), wrapped to always pass `{ headers: { cookie } }`; the repo's DOM lib types hide undici's `headers` option on `globalThis.WebSocket`. (c) The refused upgrade is asserted as a 401 through `node:http` (Node's `fetch` throws `invalid upgrade header` on an `upgrade` request header). (d) The notice tap is duplicated in the test, as the step allows: `shop-actor-client.ts` imports Start and the Worker env, which do not load in Node. (e) The actor key is `integ-shop`, not the sandbox shop, so the test's counts are its own.
- 2026-10-11, Step 9 (e2e): the spec also asserts the clicking tab reaches `before + 1`.
- 2026-10-11, Step 10: the README has no architecture-notes section, so the paragraph went right after the intro paragraph, which is where the README describes the two Workers.

### Review changes (after implementation)

- 2026-10-11, Step 4: a path under `/api/actor/` whose key does not decode is now 404 from the Backend instead of falling through to the `BackendRpcs` server; the integ test asserts it. This also removes the `Cause.Done` log entries below: they were the fall-through path, not the 401 path (reproduced three for three with a bad-key upgrade; none with a cookieless POST or upgrade).
- 2026-10-11, Step 8: `params.parse` returns `false` for a key that does not decode, so `/app/shop/NOT_A_KEY` is the root's "Page not found" with a 404, not the error boundary with a 500.
- 2026-10-11, Step 7: `noticesAtom`'s JSDoc notes that a notice published before the stream subscribes is dropped (the first connect's synthetic notice can race the runtime build; harmless because the count is primed).

- 2026-10-11, Step 7: a dead session no longer retries the upgrade forever unnoticed. `src/socket-session.ts` (`makeSessionGuard`) counts consecutive failed opens through `layerProtocolSocket`'s `onTransientError`; after three it calls `Me` over HTTP (where a 401 is visible) and, on `Unauthorized`, does a full page load to `/sign-in?redirect=<path>`, the `/app` guard's shape. An outage leaves the retry alone, and a successful open resets the count. `backendProtocol` is exported from `backend-client.ts` for the one-off call. Unit-tested in `src/socket-session.test.ts`; observed in Chromium against the dev server: sign out, restart the Backend, three refused opens in ~2 s, redirect. A session that ends while the socket stays open is still unnoticed (the actor never rechecks it); that is the per-connection identity work in §6.

### Issues

- 2026-10-11, Step 4: the `/api/actor/:key` 401 path sometimes logs `[Backend] HTTP handler failed` / `Error: {"_tag":"Done"}` in `logs/dev/current` (seen on 3 of ~6 cookieless or bad-key requests); the client still receives the 401 (or, for an upgrade, a failed open). Not chased.
- 2026-10-11, Step 4: a path under `/api/actor/` whose key does not decode falls through to the `BackendRpcs` HTTP server, as specified. A POST there behaves like `/api/rpc` (no new exposure). A GET upgrade there, and any upgrade the Backend answers with a non-101 (the cookieless 401), reaches a Node WebSocket client through the Vite dev proxy as an immediate error + close `1006`; `curl` sees no HTTP status at all. Browsers never see a status for a refused upgrade anyway.
- 2026-10-11, Step 6: a payload-less procedure's `Request` frame needs `"payload": null`, not `{}` (Effect encodes `Schema.Void` as `null` in JSON; `{}` dies with `Expected null`). The plan's sample frame in Step 6.3 had `{}`.
- 2026-10-11, Step 8: a bad key (`/app/shop/NOT_A_KEY`) renders the router's default error component ("Something went wrong!" with the Schema message `Expected a string matching the RegExp ...`) and the SSR response is a 500, not a 404. No Backend call is made (the throw is in `params.parse`, before the loader). The plan allowed either.
- 2026-10-11, Step 9: the first `vp test --project browser` after adding the new imports failed `ShopPage.test.tsx` with "Failed to fetch dynamically imported module", because Vite re-optimized deps mid-run (`effect/PubSub`, `effect/Stream`, `effect/socket/Socket`, ...) and reloaded. A rerun passed, and a run with `node_modules/.vite/vitest` cleared also passed with no reload, so it happens only when an existing optimizer cache lacks newly imported deps. No config change.
- 2026-10-11, Step 9: Step 9 says the e2e stage "is a deployed Worker, not the Vite dev proxy". It is not: `playwright.config.ts` starts `vp exec alchemy dev` on stage `e2e_<user>`, so e2e also goes through Vite. The hop without Vite is covered by the integ test, which connects straight to the Backend's URL.
- 2026-10-11, Step 9: integ ran in ~22 s for both files and exited cleanly; the stack-destroy hang noted for `auth.test.ts` did not show up (the stack is still never destroyed).
- 2026-10-11, all steps: a dev server was already running on :3900 (in a herdr pane) before this work. It hot-reloaded every change, was used for Steps 6 and 8, and was left running. `vp run test:e2e` started and stopped its own server on :4000 each run.

### Step 6 spike results

| Check                                               | Result | Notes                                                                                                                                                                                                                                          |
| --------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. dev stack up, cookie obtained                    | pass   | 2026-10-11. A dev server was already running on :3900 (adopted, not started). Cookie from `RequestMagicLink` over `/api/rpc` (dev delivers inline) then the verify link with `redirect: "manual"` (302 + `set-cookie`); no `E2E_TOKEN` needed. |
| 2. upgrade through Vite → Website → Backend → actor | pass   | Node 24 `new WebSocket(url, { headers: { cookie } })` opened `ws://localhost:3900/api/actor/alchemy-sandbox1` in ~15 ms. Without a cookie: error + close `1006` at once.                                                                       |
| 3. `GetCount` over the socket                       | pass   | `{"value":0}` on a fresh actor. Needed `"payload": null` (see Issues).                                                                                                                                                                         |
| 4. `Increment` + notice on same socket              | pass   | The notice frame `{"_tag":"ShopActorNotice","invalidated":["count"]}` arrives before the `Exit` with `{"value":1}`.                                                                                                                            |
| 5. notice on a second socket                        | pass   | `Increment` on B: notice on both A and B.                                                                                                                                                                                                      |
| 6. `Ping` answered by auto-response                 | pass   | `{"_tag":"Ping"}` → `{"_tag":"Pong"}` within 1 ms.                                                                                                                                                                                             |
| 7. activation id changes after idle                 | pass   | Same id on A and B before; after 20 s idle (no pings sent) a new id, equal on A and B; both sockets still worked and `GetCount` returned the persisted `2`.                                                                                    |

### API confirmations

| Sketch in this plan                                      | Confirmed as                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Schema.fromJsonString(Notice)` encode/decode direction  | Confirmed (`Schema.ts`): `JsonString.pipe(decodeTo(schema, ...))`, so Encoded is the JSON string and `encodeSync` yields the string; `decodeUnknownOption` parses it.                                                                                                                                                                                                                                                                                       |
| SQL client lifetime form in the inner Effect (Step 3)    | The first form (`Layer.build(SqliteClient.layer({ storage }))` in the inner Effect) type-checks: `Scope` is part of `DurableObjectServices` through Alchemy's `PlatformServices` → `StackServices`, which is how `Drizzle.DurableObject` does the same. Runs in workerd (spike, integ).                                                                                                                                                                     |
| `Effect.fromNullishOr` name                              | Confirmed (`Effect.ts`): `fromNullishOr: <A>(value: A) => Effect<NonNullable<A>, NoSuchElementError>`.                                                                                                                                                                                                                                                                                                                                                      |
| Start route `params.parse` shape (Step 8)                | Confirmed (`@tanstack/router-core` 1.171.34 `route.d.ts`): `params: { parse?, stringify?, priority? }`; `parse` may also return `false` to not match. A throw in `parse` is swallowed during matching, then rethrown by `extractStrictParams` while loading, so it reaches the route error boundary (observed: the default error component, SSR status 500).                                                                                                |
| undici `WebSocket(url, { headers })` (Steps 6, 9)        | Confirmed on Node 24.21.0 against a local `upgrade` listener: the `cookie` header arrives.                                                                                                                                                                                                                                                                                                                                                                  |
| `Reactivity.invalidate` requirement under `runtime.atom` | Confirmed (`Reactivity.ts`, `Atom.ts`): `invalidate` is `Effect<void, never, Reactivity>`; `ShopActorClient.runtime.atom(stream)` type-checks with it, because the factory's global layer is `Reactivity.layer` and `runtime.atom` admits `Reactivity`. `Atom.withReactivity` builds `Reactivity.layer` in the same registry memo map, so both see one instance; a published notice refetching the count in the browser test and in two real tabs shows it. |
