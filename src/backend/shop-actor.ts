import * as SqliteClient from "@effect/sql-sqlite-do/SqliteClient";
import * as SqliteMigrator from "@effect/sql-sqlite-do/SqliteMigrator";
import { RuntimeContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { Forbidden, Unauthorized } from "../api/backend.ts";
import { ShopKey } from "../api/shop.ts";
import {
  CALLER_HEADER,
  CONNECTION_CLOSE_DISPLACED,
  CONNECTION_CLOSE_REVOKED,
  COUNT_KEY,
  Caller,
  CallerMiddleware,
  Count,
  CurrentCaller,
  MAX_CONNECTIONS_PER_MEMBER,
  NoticeFrame,
  RequireMember,
  RequireMerchant,
  RequireSystem,
  ShopActorRpcs,
  SocketIdentity,
  TICKET_HEADER,
} from "../api/shop-actor.ts";
import { Tickets } from "./ticket.ts";

/** A row of the `count` table. A row that does not decode is a broken invariant, so it dies. */
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Count));
const encodeNotice = Schema.encodeSync(NoticeFrame);
const decodeCallerHeader = Schema.decodeUnknownOption(Schema.fromJsonString(Caller));
const decodeShopKey = Schema.decodeUnknownOption(ShopKey);

/**
 * A socket's attachment as the actor reads it: Alchemy's own record, whose `clientId` is the
 * RPC server's `client.id` for that socket, beside the actor's `shopActor` key once the socket
 * is bound. Alchemy rewrites its record by spreading the previous attachment, so the actor's
 * key survives its writes and a hibernation; the actor writes the same way, spreading the raw
 * previous value so Alchemy's other fields survive too.
 */
const Attachment = Schema.Struct({
  __alchemyRpcWebSocket: Schema.Struct({ clientId: Schema.Int }),
  shopActor: Schema.optional(SocketIdentity),
});
const decodeAttachment = Schema.decodeUnknownOption(Attachment);

/** The close reasons, Baton's. A reason must stay under 123 bytes. */
const REVOKED_REASON = "membership changed";
const DISPLACED_REASON = "signed in elsewhere";
const EXPIRED_REASON = "session expired";

/**
 * How long a close waits so the failure that explains it is written first. The RPC server
 * writes a call's exit after the middleware returns; a close issued inside the middleware
 * would race it.
 */
const CLOSE_AFTER_RESPONSE = "50 millis";

/** The schema of one actor's storage, applied on every activation; see {@link ShopActor}. */
const migrations = SqliteMigrator.fromRecord({
  "0001_count": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE count (id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL)`;
    yield* sql`INSERT INTO count (id, value) VALUES (1, 0)`;
  }),
});

/** Each role middleware admits exactly its role; see `MemberRpcs`. */
const requireRole = (role: Caller["role"]) =>
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
const RequireSystemLive = Layer.succeed(RequireSystem)(
  RequireSystem.of((effect) => Effect.andThen(requireRole("system"), effect)),
);

/**
 * One shop's actor, named by its {@link ShopKey}: a `count` in private SQLite, read and written
 * over Effect RPC on HTTP or a hibernating WebSocket (both provided by `RpcDurableObject`).
 * After a write it pushes a `Notice` to every socket so each browser refetches; it never
 * pushes the value.
 *
 * Who is calling is {@link CallerMiddleware}'s answer, by path. On HTTP the only callers are
 * the Backend's stub and requests the Backend forwarded after its gate; both carry
 * {@link CALLER_HEADER}, which the RPC server merges from the request into each message's
 * headers. That is the whole trust argument for a header: those messages were written by the
 * Backend or by the Website's server code during server rendering, never by a browser, which
 * has no HTTP route into the actor. On a socket the identity is bound to the socket itself, in
 * its attachment, from the {@link TICKET_HEADER} of its first call; no later header is read.
 * A bad or missing ticket fails that call {@link Unauthorized} and leaves the socket open, so
 * the browser can fetch a fresh ticket and retry.
 *
 * Revocation closes sockets with {@link CONNECTION_CLOSE_REVOKED}; a member's newest socket
 * past {@link MAX_CONNECTIONS_PER_MEMBER} displaces the oldest with
 * {@link CONNECTION_CLOSE_DISPLACED}. A member socket whose Better Auth session has expired is
 * closed on its next call, the backstop for a revoke that never arrived. A merchant socket has
 * no such backstop: its token is checked at connect only, as in Baton.
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
export default class ShopActor extends Cloudflare.RpcDurableObject<ShopActor>()(
  "ShopActor",
  { schema: ShopActorRpcs },
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    const tickets = yield* Tickets;
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
      /**
       * Socket identities by `client.id`, for this activation only: rebuilt from attachments
       * after a wake, and dropped for a socket the actor closes. Alchemy restores the same ids
       * after a wake and reuses one only after a restart, when this map is new anyway.
       */
      const bound = new Map<number, SocketIdentity>();

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

      /** Every open socket with its decoded attachment; a closing one is no longer counted. */
      const openSockets = Effect.fn("ShopActor.openSockets")(function* () {
        const sockets = yield* state.getWebSockets();
        return sockets.flatMap((socket) => {
          if (socket.ws.readyState !== WebSocket.OPEN) return [];
          const attachment = decodeAttachment(socket.deserializeAttachment<unknown>());
          return Option.isSome(attachment) ? [{ socket, attachment: attachment.value }] : [];
        });
      });

      /** The socket an RPC client id names. A socket call with no socket is a broken invariant. */
      const findSocket = Effect.fn("ShopActor.findSocket")(function* (clientId: number) {
        const found = (yield* openSockets()).find(
          ({ attachment }) => attachment.__alchemyRpcWebSocket.clientId === clientId,
        );
        if (found === undefined)
          return yield* Effect.die(new Error(`no socket for client ${clientId}`));
        return found;
      });

      /** Closes a socket; a close that throws is logged and never fails the caller. */
      const closeSocket = (
        socket: Cloudflare.Workers.WebSocket,
        clientId: number,
        code: number,
        reason: string,
      ) =>
        Effect.suspend(() => {
          bound.delete(clientId);
          return socket.close(code, reason);
        }).pipe(
          Effect.catchDefect((defect) =>
            Effect.logWarning(`ShopActor: close ${code} failed`, defect),
          ),
        );

      /** Closes a socket once the response to the call in hand has been written. */
      const closeAfterResponse = (
        socket: Cloudflare.Workers.WebSocket,
        clientId: number,
        code: number,
        reason: string,
      ) =>
        Effect.sync(() => bound.delete(clientId)).pipe(
          Effect.andThen(
            state.waitUntil(
              Effect.sleep(CLOSE_AFTER_RESPONSE).pipe(
                Effect.andThen(closeSocket(socket, clientId, code, reason)),
              ),
            ),
          ),
        );

      /**
       * Baton's `displaceConnections`: after a member's socket binds, keeps the member at
       * {@link MAX_CONNECTIONS_PER_MEMBER} by closing the oldest of the others, by `boundAt`.
       * The socket binding now is the newest by definition. Best effort: a failure is logged
       * and the new socket is served either way.
       */
      const displace = Effect.fn("ShopActor.displace")(
        function* (memberId: string, newest: number) {
          const others = (yield* openSockets()).flatMap(({ socket, attachment }) => {
            const clientId = attachment.__alchemyRpcWebSocket.clientId;
            const identity = attachment.shopActor;
            return clientId !== newest &&
              identity?.caller.role === "member" &&
              identity.caller.memberId === memberId
              ? [{ socket, clientId, boundAt: identity.boundAt }]
              : [];
          });
          const displaced = others
            .toSorted((a, b) => b.boundAt - a.boundAt)
            .slice(MAX_CONNECTIONS_PER_MEMBER - 1);
          for (const { socket, clientId } of displaced) {
            yield* closeSocket(socket, clientId, CONNECTION_CLOSE_DISPLACED, DISPLACED_REASON);
            yield* Effect.logInfo(
              `ShopActor.displace: shop=${shop} memberId=${memberId} clientId=${clientId}`,
            );
          }
        },
        Effect.catchCause((cause) => Effect.logWarning("ShopActor.displace failed", cause)),
      );

      /**
       * The socket's identity: the cache, else the attachment, else a bind from the ticket the
       * call carries. Binding writes the identity into the attachment, then displaces.
       */
      const socketIdentity = Effect.fn("ShopActor.socketIdentity")(function* (
        clientId: number,
        ticket: string | undefined,
      ) {
        const cached = bound.get(clientId);
        if (cached !== undefined) return cached;
        const { socket, attachment } = yield* findSocket(clientId);
        if (attachment.shopActor !== undefined) {
          bound.set(clientId, attachment.shopActor);
          return attachment.shopActor;
        }
        if (ticket === undefined) return yield* new Unauthorized();
        const now = yield* Clock.currentTimeMillis;
        const claims = yield* tickets.verify(ticket, { shop, now });
        const identity: SocketIdentity = { caller: claims.caller, boundAt: now };
        const previous = socket.deserializeAttachment<object>();
        socket.serializeAttachment({ ...previous, shopActor: identity });
        bound.set(clientId, identity);
        if (identity.caller.role === "member") yield* displace(identity.caller.memberId, clientId);
        return identity;
      });

      const CallerLive = Layer.succeed(CallerMiddleware)(
        CallerMiddleware.of((effect, { client, headers }) =>
          Effect.gen(function* () {
            const request = yield* Effect.serviceOption(HttpServerRequest.HttpServerRequest);
            if (Option.isSome(request)) {
              const caller = decodeCallerHeader(headers[CALLER_HEADER]);
              if (Option.isNone(caller)) return yield* new Unauthorized();
              return yield* Effect.provideService(effect, CurrentCaller, caller.value);
            }
            const identity = yield* socketIdentity(client.id, headers[TICKET_HEADER]);
            const now = yield* Clock.currentTimeMillis;
            if (identity.caller.role === "member" && identity.caller.sessionExpiresAt <= now) {
              const { socket } = yield* findSocket(client.id);
              yield* closeAfterResponse(
                socket,
                client.id,
                CONNECTION_CLOSE_REVOKED,
                EXPIRED_REASON,
              );
              return yield* new Unauthorized();
            }
            return yield* Effect.provideService(effect, CurrentCaller, identity.caller);
          }).pipe(Effect.provide(runtime)),
        ),
      );

      const handlers = ShopActorRpcs.toLayer({
        MemberGetCount: () => readCount(),
        MerchantGetCount: () => readCount(),
        MemberIncrement: () => increment().pipe(Effect.tap(() => notify([COUNT_KEY]))),
        MerchantResetCount: () => resetCount().pipe(Effect.tap(() => notify([COUNT_KEY]))),
        MemberActivation: () => Effect.succeed({ id: activationId }),
        MemberWhoAmI: () => Effect.service(CurrentCaller),
        MerchantWhoAmI: () => Effect.service(CurrentCaller),
        SystemRevoke: ({ by, id }) =>
          Effect.gen(function* () {
            let closed = 0;
            for (const { socket, attachment } of yield* openSockets()) {
              const caller = attachment.shopActor?.caller;
              if (caller?.role !== "member") continue;
              if ((by === "member" ? caller.memberId : caller.sessionId) !== id) continue;
              yield* closeSocket(
                socket,
                attachment.__alchemyRpcWebSocket.clientId,
                CONNECTION_CLOSE_REVOKED,
                REVOKED_REASON,
              );
              closed += 1;
            }
            yield* Effect.logInfo(`ShopActor.SystemRevoke: shop=${shop} by=${by} closed=${closed}`);
            return { closed };
          }),
      });

      return Layer.mergeAll(
        handlers,
        CallerLive,
        RequireMemberLive,
        RequireMerchantLive,
        RequireSystemLive,
      );
    });
  }),
) {}
