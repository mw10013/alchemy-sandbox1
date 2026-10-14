import * as SqliteClient from "@effect/sql-sqlite-do/SqliteClient";
import * as SqliteMigrator from "@effect/sql-sqlite-do/SqliteMigrator";
import { RuntimeContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { Forbidden } from "../contract/auth.ts";
import { ShopKey } from "../contract/shop.ts";
import {
  CONNECTION_CLOSE_DISPLACED,
  CONNECTION_CLOSE_FORBIDDEN,
  CONNECTION_CLOSE_REVOKED,
  CONNECTION_HEADER,
  COUNT_KEY,
  ConnectionCaller,
  ConnectionMiddleware,
  Count,
  CurrentCaller,
  MAX_CONNECTIONS_PER_MEMBER,
  NoticeFrame,
  RequireMember,
  RequireMerchant,
  ShopActorRpcs,
  type ShopSnapshot,
} from "../contract/shop-actor.ts";
import * as ActorSocket from "./actor-socket.ts";

/** A row of the `count` table. A row that does not decode is a broken invariant, so it dies. */
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Count));
const encodeNotice = Schema.encodeSync(NoticeFrame);
const decodeConnectionHeader = Schema.decodeUnknownOption(Schema.fromJsonString(ConnectionCaller));
const decodeShopKey = Schema.decodeUnknownOption(ShopKey);
const decodeIdentity = Schema.decodeUnknownOption(
  Schema.Struct({ shopActor: ActorSocket.SocketIdentity }),
);

/** The close reasons, Baton's. A reason must stay under 123 bytes. */
const REVOKED_REASON = "membership changed";
const DISPLACED_REASON = "signed in elsewhere";
const EXPIRED_REASON = "session expired";
const UNIDENTIFIED_REASON = "unidentified connection";

/** The schema of one actor's storage, applied on every activation; see {@link ShopActor}. */
const migrations = SqliteMigrator.fromRecord({
  "0001_count": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE count (id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL)`;
    yield* sql`INSERT INTO count (id, value) VALUES (1, 0)`;
  }),
});

/** Each role middleware admits exactly its role; see `MemberRpcs`. */
const requireRole = (role: ConnectionCaller["role"]) =>
  Effect.gen(function* () {
    const caller = yield* CurrentCaller;
    return yield* Match.value(caller.role).pipe(
      Match.when(role, () => Effect.void),
      Match.orElse(() => Effect.fail(new Forbidden())),
    );
  });

const RequireMemberLive = Layer.succeed(RequireMember)(
  RequireMember.of((effect) => Effect.andThen(requireRole("member"), effect)),
);
const RequireMerchantLive = Layer.succeed(RequireMerchant)(
  RequireMerchant.of((effect) => Effect.andThen(requireRole("merchant"), effect)),
);

/**
 * Reads the socket's identity, which `ActorSocket` provides around every dispatch. A message
 * with none is a broken invariant, so it dies.
 */
const ConnectionMiddlewareLive = Layer.succeed(ConnectionMiddleware)(
  ConnectionMiddleware.of((effect) =>
    Effect.gen(function* () {
      const identity = yield* Effect.serviceOption(ActorSocket.ConnectionIdentity);
      if (Option.isNone(identity))
        return yield* Effect.die(new Error("a socket message without its identity"));
      return yield* Effect.provideService(effect, CurrentCaller, identity.value.caller);
    }),
  ),
);

/**
 * The tags a socket is accepted with: only what a fan-out selects sockets by, as Baton's
 * `getConnectionTags`. Cloudflare allows 10 tags of up to 256 characters per socket, and
 * Alchemy's transport adds one of its own.
 */
const tagsOf = (caller: ConnectionCaller) =>
  Match.value(caller).pipe(
    Match.discriminatorsExhaustive("role")({
      member: ({ memberId, sessionId }) => ["member", `member:${memberId}`, `session:${sessionId}`],
      merchant: () => ["merchant"],
    }),
  );

/**
 * One shop's actor, named by its {@link ShopKey}: a `count` in private SQLite. After a write it
 * pushes a `Notice` to every socket so each browser refetches; it never pushes the value.
 *
 * It has two surfaces that never overlap. Browsers call `ShopActorRpcs` with Effect RPC over a
 * hibernating WebSocket; there is no HTTP RPC into the actor. The Backend calls the schemaless
 * methods `revoke` and `snapshot` on its stub, which no browser can reach.
 *
 * Who is on a socket is fixed when the socket is accepted: the Backend's gate resolves the
 * browser and names it in {@link CONNECTION_HEADER} on the upgrade it forwards, and the actor
 * writes that caller into the socket's attachment and tags. Every message is served as that
 * caller ({@link ConnectionMiddleware}); a header that does not decode is accepted and closed
 * with {@link CONNECTION_CLOSE_FORBIDDEN}.
 *
 * Revocation closes sockets with {@link CONNECTION_CLOSE_REVOKED}; a member's newest socket
 * past {@link MAX_CONNECTIONS_PER_MEMBER} displaces the oldest with
 * {@link CONNECTION_CLOSE_DISPLACED}. A member socket whose Better Auth session has expired is
 * closed on its next message, before it is dispatched: the backstop for a revoke that never
 * arrived. A merchant socket has no such backstop: its token is checked at connect only, as in
 * Baton.
 *
 * Everything below `state` runs once per activation, including after a hibernation wake, so
 * the SQL client is rebuilt and the migrator re-checks its table each time. Migrations run
 * inside the `blockConcurrencyWhile` Alchemy wraps construction in, so no request sees a
 * half-migrated store. The client is built on the ambient scope, as Alchemy's
 * `Drizzle.DurableObject` does: it wraps the object's local storage, so nothing behind it needs
 * releasing. A single-statement write needs no transaction; a multi-statement one will need
 * `withTransaction` and Alchemy's `MixedScheduler("sync")` workaround from its
 * `Drizzle.DurableObject`.
 */
export default class ShopActor extends Cloudflare.DurableObject<ShopActor>()(
  "ShopActor",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    return Effect.gen(function* () {
      // Every actor is reached by name (`getByName`), so a nameless id is a broken invariant.
      const shop = yield* Effect.fromOption(decodeShopKey(state.id.name)).pipe(Effect.orDie);
      const runtime = yield* Effect.context<RuntimeContext>();
      const sql = yield* Layer.build(SqliteClient.layer({ storage: state.raw.storage })).pipe(
        Effect.map((context) => Context.get(context, SqlClient.SqlClient)),
      );
      yield* SqliteMigrator.run({ loader: migrations }).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.orDie,
      );
      const activationId = yield* Effect.sync(() => crypto.randomUUID());

      const readCount = Effect.fn("ShopActor.readCount")(function* () {
        const [row] = yield* decodeRows(yield* sql`SELECT value FROM count WHERE id = 1`);
        return yield* Effect.fromNullishOr(row);
      }, Effect.orDie);

      const increment = Effect.fn("ShopActor.increment")(function* () {
        const [row] = yield* decodeRows(
          yield* sql`UPDATE count SET value = value + 1 WHERE id = 1 RETURNING value`,
        );
        return yield* Effect.fromNullishOr(row);
      }, Effect.orDie);

      const resetCount = Effect.fn("ShopActor.resetCount")(function* () {
        const [row] = yield* decodeRows(
          yield* sql`UPDATE count SET value = 0 WHERE id = 1 RETURNING value`,
        );
        return yield* Effect.fromNullishOr(row);
      }, Effect.orDie);

      const notify = Effect.fn("ShopActor.notify")(function* (invalidated: ReadonlyArray<string>) {
        const frame = encodeNotice({ _tag: "ShopActorNotice", invalidated });
        for (const socket of yield* state.getWebSockets())
          // A socket mid-close throws on send, which `send` surfaces as a defect; the next
          // notice or the client's reconnect covers that browser.
          yield* socket.send(frame).pipe(Effect.catchDefect(() => Effect.void));
      });

      /** Closes a socket; a close that throws is logged and never fails the caller. */
      const closeSocket = (socket: Cloudflare.Workers.WebSocket, code: number, reason: string) =>
        socket
          .close(code, reason)
          .pipe(
            Effect.catchDefect((defect) =>
              Effect.logWarning(`ShopActor: close ${code} failed`, defect),
            ),
          );

      /**
       * Baton's `displaceConnections`: after a member's socket is accepted, keeps the member at
       * {@link MAX_CONNECTIONS_PER_MEMBER} by closing the oldest of the others, by
       * `connectedAt`. Best effort: a failure is logged and the new socket is served either way.
       */
      const displace = Effect.fn("ShopActor.displace")(
        function* (memberId: string, newest: Cloudflare.Workers.WebSocket) {
          const others = (yield* state.getWebSockets(`member:${memberId}`)).flatMap((socket) => {
            if (socket.ws === newest.ws || socket.ws.readyState !== WebSocket.OPEN) return [];
            const identity = decodeIdentity(socket.deserializeAttachment<unknown>());
            return Option.isSome(identity)
              ? [{ socket, connectedAt: identity.value.shopActor.connectedAt }]
              : [];
          });
          const displaced = others
            .toSorted((a, b) => b.connectedAt - a.connectedAt)
            .slice(MAX_CONNECTIONS_PER_MEMBER - 1);
          for (const { socket } of displaced) {
            yield* closeSocket(socket, CONNECTION_CLOSE_DISPLACED, DISPLACED_REASON);
            yield* Effect.logInfo(`ShopActor.displace: shop=${shop} memberId=${memberId}`);
          }
        },
        Effect.catchCause((cause) => Effect.logWarning("ShopActor.displace failed", cause)),
      );

      const handlers = ShopActorRpcs.toLayer({
        MemberGetCount: () => readCount(),
        MerchantGetCount: () => readCount(),
        MemberIncrement: () => increment().pipe(Effect.tap(() => notify([COUNT_KEY]))),
        MerchantResetCount: () => resetCount().pipe(Effect.tap(() => notify([COUNT_KEY]))),
        MemberActivation: () => Effect.succeed({ id: activationId }),
        MemberWhoAmI: () => Effect.service(CurrentCaller),
        MerchantWhoAmI: () => Effect.service(CurrentCaller),
      });

      const socket = yield* ActorSocket.make({
        group: ShopActorRpcs,
        handlers: Layer.mergeAll(
          handlers,
          ConnectionMiddlewareLive,
          RequireMemberLive,
          RequireMerchantLive,
        ),
        onAccept: ({ caller }) => ({ tags: tagsOf(caller) }),
        beforeDispatch: ({ caller }, ws) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            if (caller.role !== "member" || caller.sessionExpiresAt > now) return true;
            yield* closeSocket(ws, CONNECTION_CLOSE_REVOKED, EXPIRED_REASON);
            return false;
          }),
      });

      /**
       * Accepts a socket and closes it at once with a code the browser reads; how the actor
       * refuses an upgrade whose identity it cannot read.
       */
      const refuse = (code: number, reason: string) =>
        Effect.sync(() => {
          const pair = new WebSocketPair();
          pair[1].accept();
          pair[1].close(code, reason);
          return HttpServerResponse.setBody(
            HttpServerResponse.empty({ status: 101 }),
            HttpBody.raw(new Response(null, { status: 101, webSocket: pair[0] })),
          );
        });

      const fetch = Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (request.headers.upgrade?.toLowerCase() !== "websocket")
          return HttpServerResponse.empty({ status: 426, headers: { upgrade: "websocket" } });
        const caller = decodeConnectionHeader(request.headers[CONNECTION_HEADER]);
        if (Option.isNone(caller)) {
          yield* Effect.logWarning(`ShopActor.fetch: shop=${shop} unidentified connection`);
          return yield* refuse(CONNECTION_CLOSE_FORBIDDEN, UNIDENTIFIED_REASON);
        }
        const connectedAt = yield* Clock.currentTimeMillis;
        const accepted = yield* socket.fetch({ caller: caller.value, connectedAt });
        if (caller.value.role === "member" && Option.isSome(accepted.socket))
          yield* displace(caller.value.memberId, accepted.socket.value);
        return accepted.response;
      });

      /**
       * Closes every socket of one member (`by: "member"`, Baton's `revokeMemberConnections`) or
       * of one Better Auth session (`by: "session"`) with {@link CONNECTION_CLOSE_REVOKED}.
       */
      const revoke = Effect.fn("ShopActor.revoke")(function* (input: {
        readonly by: "member" | "session";
        readonly id: string;
      }) {
        let closed = 0;
        for (const ws of yield* state.getWebSockets(`${input.by}:${input.id}`)) {
          if (ws.ws.readyState !== WebSocket.OPEN) continue;
          yield* closeSocket(ws, CONNECTION_CLOSE_REVOKED, REVOKED_REASON);
          closed += 1;
        }
        yield* Effect.logInfo(`ShopActor.revoke: shop=${shop} by=${input.by} closed=${closed}`);
        return { closed };
      }, Effect.provide(runtime));

      /** The page's first data, for the Backend's server-rendering read. */
      const snapshot = Effect.fn("ShopActor.snapshot")(function* () {
        const result: ShopSnapshot = {
          count: yield* readCount(),
          activation: { id: activationId },
        };
        return result;
      });

      return {
        fetch,
        webSocketMessage: socket.webSocketMessage,
        webSocketClose: socket.webSocketClose,
        webSocketError: socket.webSocketError,
        revoke,
        snapshot,
      };
    });
  }),
) {}
