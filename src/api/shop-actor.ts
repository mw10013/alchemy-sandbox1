import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import { Rpc, RpcGroup, RpcMiddleware } from "effect/rpc";
import { Email, Forbidden, Unauthorized } from "./backend.ts";
import { ShopKey } from "./shop.ts";

export const Count = Schema.Struct({ value: Schema.Int });
export type Count = typeof Count.Type;

/**
 * A dev aid: an id minted once per activation of the actor. The same id across calls means the
 * same activation; a new id after an idle period shows the object hibernated and was rebuilt.
 */
export const Activation = Schema.Struct({ id: Schema.String });

/**
 * What the actor pushes to every connected socket after a write: the reactivity keys whose
 * queries are stale. Never the data; a browser refetches what it renders. Carried on the RPC
 * socket as its own frame, outside the RPC protocol; see `ShopActorClient`.
 */
export const Notice = Schema.Struct({
  _tag: Schema.Literal("ShopActorNotice"),
  invalidated: Schema.Array(Schema.String),
});
export type Notice = typeof Notice.Type;

/** A {@link Notice} as the JSON text frame it travels in. */
export const NoticeFrame = Schema.fromJsonString(Notice);

/** The `count` reactivity key. */
export const COUNT_KEY = "count";

/**
 * A member on a socket: Baton's `ConnectionState` for the `member` role (`memberId`,
 * `memberEmail`, `teamIds`), plus the Better Auth session it was resolved from. `sessionId`
 * scopes a revoke to one session; `sessionExpiresAt` (epoch ms, the session's `expiresAt`) is
 * the backstop for a missed revoke, checked on every call. `teamIds` is carried as Baton
 * carries it; nothing reads it yet.
 */
export const MemberCaller = Schema.Struct({
  role: Schema.Literal("member"),
  memberId: Schema.String,
  memberEmail: Email,
  teamIds: Schema.Array(Schema.String),
  userId: Schema.String,
  sessionId: Schema.String,
  sessionExpiresAt: Schema.Number,
});
export type MemberCaller = typeof MemberCaller.Type;

/**
 * A merchant: whoever presented a Shopify session token for the shop. It carries nothing beyond
 * its role, as in Baton, and its token is checked at connect only.
 */
export const MerchantCaller = Schema.Struct({ role: Schema.Literal("merchant") });
export type MerchantCaller = typeof MerchantCaller.Type;

/** The Backend's own calls through the stub (Baton's `rpc` role). Never on a socket. */
export const SystemCaller = Schema.Struct({ role: Schema.Literal("system") });
export type SystemCaller = typeof SystemCaller.Type;

/** What a socket can carry: a member or a merchant, never the system. */
export const ConnectionCaller = Schema.Union([MemberCaller, MerchantCaller]);
export type ConnectionCaller = typeof ConnectionCaller.Type;

/** Who is making a call: Baton's `CallerRole`, with `system` for `rpc`. */
export const Caller = Schema.Union([MemberCaller, MerchantCaller, SystemCaller]);
export type Caller = typeof Caller.Type;

/** The caller of the current procedure, provided by {@link CallerMiddleware}. */
export class CurrentCaller extends Context.Service<CurrentCaller, Caller>()("CurrentCaller") {}

/**
 * What a `Ticket` says: who may bind a socket on which shop, until when (epoch ms). A
 * ticket is minted immediately before a connect and spent on that connect's first call, so
 * its life ({@link TICKET_TTL_MILLIS}) only has to cover that gap; it is not a session.
 */
export const TicketClaims = Schema.Struct({
  shop: ShopKey,
  caller: ConnectionCaller,
  expiresAt: Schema.Number,
});
export type TicketClaims = typeof TicketClaims.Type;

/** The RPC header a socket's first call carries its `Ticket` in. */
export const TICKET_HEADER = "x-actor-ticket";

/**
 * The header that names the {@link Caller} on the HTTP path into the actor: set by the Backend
 * on its stub calls and on the requests it forwards. Never read on the socket path.
 */
export const CALLER_HEADER = "x-actor-caller";

export const TICKET_TTL_MILLIS = 60_000;

/**
 * Who is on a socket, as the actor writes it into the socket's attachment when it binds:
 * the caller from the ticket and when it was bound (Baton's `connectedAt`).
 */
export const SocketIdentity = Schema.Struct({ caller: ConnectionCaller, boundAt: Schema.Number });
export type SocketIdentity = typeof SocketIdentity.Type;

/**
 * Provides {@link CurrentCaller}. On the HTTP path it reads {@link CALLER_HEADER}; on the
 * socket path it reads the identity bound to the socket, binding it from the first call's
 * {@link TICKET_HEADER} if there is none yet. No identity is {@link Unauthorized}.
 */
export class CallerMiddleware extends RpcMiddleware.Service<
  CallerMiddleware,
  { provides: CurrentCaller }
>()("CallerMiddleware", { error: Unauthorized }) {}

/** Admits a `merchant` caller only. */
export class RequireMerchant extends RpcMiddleware.Service<
  RequireMerchant,
  { requires: CurrentCaller }
>()("RequireMerchant", { error: Forbidden }) {}

/** Admits a `member` caller only. */
export class RequireMember extends RpcMiddleware.Service<
  RequireMember,
  { requires: CurrentCaller }
>()("RequireMember", { error: Forbidden }) {}

/** Admits the Backend's own `system` caller only. */
export class RequireSystem extends RpcMiddleware.Service<
  RequireSystem,
  { requires: CurrentCaller }
>()("RequireSystem", { error: Forbidden }) {}

/** Close code for a socket whose identity was revoked (Baton's): the browser asks again. */
export const CONNECTION_CLOSE_REVOKED = 3401;

/**
 * Close code for a socket the actor will not serve (Baton's); terminal to the browser. Nothing
 * sends it yet: a bad ticket fails the call that carried it and leaves the socket open.
 */
export const CONNECTION_CLOSE_FORBIDDEN = 4403;

/**
 * Close code for a member's oldest socket when a newer one takes the last of
 * {@link MAX_CONNECTIONS_PER_MEMBER} (Baton's). Terminal to the browser, so two windows never
 * displace each other in turn; only the person's Reconnect opens a new socket.
 */
export const CONNECTION_CLOSE_DISPLACED = 4409;

/** At most this many sockets per member (Baton's `maxConnectionsPerMember`); merchants are not capped. */
export const MAX_CONNECTIONS_PER_MEMBER = 2;

/**
 * A member's procedures. Each `Require…` admits exactly its role, so a read both roles may make
 * is declared once per role, as Baton does, never with a role switch inside a handler. The
 * first middleware added runs innermost: the role check reads the caller
 * {@link CallerMiddleware} provides.
 */
export const MemberRpcs = RpcGroup.make(
  Rpc.make("MemberGetCount", { success: Count }),
  Rpc.make("MemberIncrement", { success: Count }),
  Rpc.make("MemberActivation", { success: Activation }),
  Rpc.make("MemberWhoAmI", { success: Caller }),
)
  .middleware(RequireMember)
  .middleware(CallerMiddleware);

/** A merchant's procedures; see {@link MemberRpcs} for the role rule. */
export const MerchantRpcs = RpcGroup.make(
  Rpc.make("MerchantGetCount", { success: Count }),
  Rpc.make("MerchantResetCount", { success: Count }),
  Rpc.make("MerchantWhoAmI", { success: Caller }),
)
  .middleware(RequireMerchant)
  .middleware(CallerMiddleware);

/**
 * The Backend's procedures, through the stub. `SystemRevoke` closes sockets with
 * {@link CONNECTION_CLOSE_REVOKED}: `by: "member"` every socket of one member (Baton's
 * `revokeMemberConnections`), `by: "session"` every socket of one Better Auth session.
 */
export const SystemRpcs = RpcGroup.make(
  Rpc.make("SystemRevoke", {
    payload: { by: Schema.Literals(["member", "session"]), id: Schema.String },
    success: Schema.Struct({ closed: Schema.Int }),
  }),
)
  .middleware(RequireSystem)
  .middleware(CallerMiddleware);

export const ShopActorRpcs = MemberRpcs.merge(MerchantRpcs, SystemRpcs);
