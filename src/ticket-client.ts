import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Headers from "effect/http/Headers";
import * as Option from "effect/Option";
import * as Atom from "effect/reactivity/Atom";
import type * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { RpcMiddleware } from "effect/rpc";
import type * as RpcClient from "effect/rpc/RpcClient";
import type { RpcClientError } from "effect/rpc/RpcClientError";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";
import type { NotAShopMember, Ticket, Unauthorized } from "./api/backend.ts";
import { ReturnPath } from "./api/backend.ts";
import { SANDBOX_SHOP, ShopKey } from "./api/shop.ts";
import {
  CONNECTION_CLOSE_DISPLACED,
  CONNECTION_CLOSE_FORBIDDEN,
  CallerMiddleware,
  type ShopActorRpcs,
  TICKET_HEADER,
  TicketClaims,
} from "./api/shop-actor.ts";

/**
 * The shop whose actor this registry's client talks to. A route loader sets it before priming.
 * This and the other plain state atoms here are kept alive: a loader or the protocol sets them
 * while nothing on the page reads them yet, and an unread atom would drop the value. Those a
 * loader sets are serializable too: the loader runs on the server only for the first page, so
 * the browser gets their values by hydration, as it gets the queries'.
 */
export const shopKeyAtom = Atom.make<ShopKey>(SANDBOX_SHOP).pipe(
  Atom.serializable({ key: "shop-key", schema: ShopKey }),
  Atom.keepAlive,
);

/**
 * The merchant's Shopify session token, set by the merchant route from its `token` search
 * param; None on the member page. Its presence is what makes this browser a merchant.
 */
export const merchantTokenAtom = Atom.make<Option.Option<string>>(Option.none()).pipe(
  Atom.serializable({ key: "merchant-token", schema: Schema.OptionFromNullOr(Schema.String) }),
  Atom.keepAlive,
);

/** Set when the Backend answers that this member may not open the shop. */
export const notAMemberAtom = Atom.make(false).pipe(
  Atom.serializable({ key: "not-a-member", schema: Schema.Boolean }),
  Atom.keepAlive,
);

/** Set when the Backend no longer accepts the merchant's Shopify session token. */
export const merchantExpiredAtom = Atom.make(false).pipe(
  Atom.serializable({ key: "merchant-expired", schema: Schema.Boolean }),
  Atom.keepAlive,
);

/**
 * The actor socket as the page shows it. `displaced` and `forbidden` are terminal: the socket
 * stays closed until the person asks again ({@link reconnectAtom}).
 */
export type ConnectionState = "connecting" | "open" | "lost" | "displaced" | "forbidden";
export const connectionStateAtom = Atom.make<ConnectionState>("connecting").pipe(Atom.keepAlive);

/** Bumped by the displaced banner's Reconnect; the protocol reads it, so a bump rebuilds it. */
export const reconnectAtom = Atom.make(0).pipe(Atom.keepAlive);

/** How long a lost socket stays quiet before the page says so; most reconnects are faster. */
const LOST_GRACE = 4_000;

/** True once {@link connectionStateAtom} has been `lost` for {@link LOST_GRACE}. */
export const lostAtom = Atom.make((get) => {
  if (get(connectionStateAtom) !== "lost") return false;
  const timer = setTimeout(() => get.setSelf(true), LOST_GRACE);
  get.addFinalizer(() => clearTimeout(timer));
  return false;
});

/** A ticket's claims, readable without the secret; only the expiry is read here. */
const TicketParts = Schema.TemplateLiteralParser([
  Schema.StringFromBase64Url.pipe(Schema.decodeTo(Schema.fromJsonString(TicketClaims))),
  ".",
  Schema.String,
]);
const decodeTicketParts = Schema.decodeUnknownOption(TicketParts);

/** Whether a ticket's claims say it is still good at `now`. */
export const isFresh = (ticket: Ticket, now: number) =>
  Option.match(decodeTicketParts(ticket), {
    onNone: () => false,
    onSome: ([claims]) => claims.expiresAt > now,
  });

/**
 * The Backend refused this browser a ticket: the reason a connect will not be retried. It
 * rides in a {@link Socket.SocketOpenError}'s cause, because the socket's error channel is
 * the only one the retry policy sees.
 */
export class TicketRefused extends Schema.TaggedError<TicketRefused>()("TicketRefused", {
  reason: Schema.Literals(["Unauthorized", "NotAShopMember"]),
}) {}

const openError = (cause: unknown) =>
  new Socket.SocketError({ reason: new Socket.SocketOpenError({ kind: "Unknown", cause }) });

/** Whether a socket error ends the retries: a terminal close code, or a refused ticket. */
export const isTerminal = (error: Socket.SocketError) =>
  (error.reason._tag === "SocketCloseError" &&
    (error.reason.code === CONNECTION_CLOSE_FORBIDDEN ||
      error.reason.code === CONNECTION_CLOSE_DISPLACED)) ||
  (error.reason._tag === "SocketOpenError" && error.reason.cause instanceof TicketRefused);

/**
 * The socket's retry policy: exponential from 250 ms, capped at 4 s, forever, except after a
 * terminal error ({@link isTerminal}). Every error the policy sees goes to `onError` first,
 * which is how the page learns the close code.
 */
export const retryPolicy = (onError: (error: Socket.SocketError) => Effect.Effect<void>) =>
  Schedule.min([Schedule.exponential("250 millis"), Schedule.spaced("4 seconds")]).pipe(
    Schedule.setInputType<Socket.SocketError>(),
    Schedule.tap(({ input }) => onError(input)),
    Schedule.while(({ input }) => !isTerminal(input)),
  );

/**
 * This browser's one actor connection, as the ticket middleware sees it: whether the current
 * socket is bound, the ticket its first call will carry, and how to fetch a fresh one. One
 * per browser, like the socket; the browser protocol replaces it on every build.
 */
const connection: {
  bound: boolean;
  ticket: Option.Option<Ticket>;
  refresh: Effect.Effect<void, Socket.SocketError>;
  /** The current build's client, for {@link bindOnConnect}; completed by {@link setClient}. */
  client: Deferred.Deferred<ActorClient>;
  merchant: boolean;
} = {
  bound: false,
  ticket: Option.none(),
  refresh: Effect.void,
  client: Deferred.makeUnsafe(),
  merchant: false,
};

type ActorClient = RpcClient.RpcClient.Flat<RpcGroup.Rpcs<typeof ShopActorRpcs>, RpcClientError>;

const decodeReturnPath = Schema.decodeUnknownOption(ReturnPath);

/** A full page load to sign-in, back here afterwards; the same shape as the `/app` route guard. */
const goToSignIn = Effect.sync(() => {
  const url = new URL("/sign-in", window.location.origin);
  const back = decodeReturnPath(window.location.pathname + window.location.search);
  if (Option.isSome(back)) url.searchParams.set("redirect", back.value);
  window.location.assign(url);
});

/**
 * The step every connect runs before its socket opens: take the ticket the page came with if
 * it is still fresh (only on the first connect), else ask the Backend for one. Asking is how
 * the browser learns why it was cut off: `Unauthorized` sends a member to sign-in or marks a
 * merchant's token expired; `NotAShopMember` marks the page; both end the retries. An
 * unreachable Backend is transient and retried.
 */
export const makeTicketStep = (options: {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly merchantToken: Option.Option<string>;
  /** The ticket the page came with, if any; spent on the first connect only. */
  readonly primed: Option.Option<Ticket>;
  /** `IssueActorTicket` for this shop and credential. */
  readonly fetch: Effect.Effect<Ticket, Unauthorized | NotAShopMember | RpcClientError>;
}) => {
  let primed = options.primed;
  const fetch = options.fetch;
  connection.client = Deferred.makeUnsafe();
  connection.merchant = Option.isSome(options.merchantToken);
  const refused = (reason: TicketRefused["reason"]) =>
    Effect.fail(openError(new TicketRefused({ reason })));
  const step = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const fresh = Option.filter(primed, (ticket) => isFresh(ticket, now));
    primed = Option.none();
    const ticket = Option.isSome(fresh)
      ? fresh.value
      : yield* fetch.pipe(
          Effect.catchTags({
            Unauthorized: () =>
              Option.isSome(options.merchantToken)
                ? Effect.sync(() => options.registry.set(merchantExpiredAtom, true)).pipe(
                    Effect.andThen(refused("Unauthorized")),
                  )
                : goToSignIn.pipe(Effect.andThen(refused("Unauthorized"))),
            NotAShopMember: () =>
              Effect.sync(() => options.registry.set(notAMemberAtom, true)).pipe(
                Effect.andThen(refused("NotAShopMember")),
              ),
            RpcClientError: (error) => Effect.fail(openError(error)),
          }),
        );
    connection.ticket = Option.some(ticket);
  });
  connection.refresh = step;
  return step;
};

/** A new socket is unbound until a call carrying its ticket succeeds. */
export const resetBinding = Effect.sync(() => {
  connection.bound = false;
});

/** Hands the client made for the current build to {@link bindOnConnect}. */
export const setClient = (client: ActorClient) =>
  Effect.suspend(() => Deferred.succeed(connection.client, client));

/**
 * The socket's `onConnect`: binds the new socket at once with a who-am-I call carrying its
 * ticket, rather than waiting for the page's first data call. A page's first data comes with
 * the page, so an idle window would otherwise hold an unbound socket, which the actor cannot
 * name: `SystemRevoke` and displacement skip it and it does not count toward the member's
 * cap. Forked, because `onConnect` runs before the protocol reads the socket, so awaiting the
 * reply here would never end. Failures are left to {@link ticketMiddleware}'s retry and the
 * next data call.
 */
export const bindOnConnect = resetBinding.pipe(
  Effect.andThen(
    Effect.suspend(() => {
      const merchant = connection.merchant;
      return Deferred.await(connection.client).pipe(
        Effect.flatMap((client) =>
          merchant ? client("MerchantWhoAmI", undefined) : client("MemberWhoAmI", undefined),
        ),
      );
    }).pipe(Effect.ignore, Effect.forkChild),
  ),
  Effect.asVoid,
);

/**
 * The browser half of {@link CallerMiddleware}: while the socket is unbound, every call carries
 * the connect's ticket in {@link TICKET_HEADER}, and the first success marks it bound. Several
 * first calls in flight all carry it; binding is idempotent. An `Unauthorized` (a ticket that
 * expired before it was spent, or a socket the actor no longer knows) fetches a fresh ticket
 * and retries the call once.
 */
export const ticketMiddleware = RpcMiddleware.layerClient(CallerMiddleware, ({ request, next }) => {
  const send = Effect.suspend(() =>
    next(
      connection.bound || Option.isNone(connection.ticket)
        ? request
        : {
            ...request,
            headers: Headers.set(request.headers, TICKET_HEADER, connection.ticket.value),
          },
    ),
  ).pipe(Effect.tap(() => Effect.sync(() => (connection.bound = true))));
  return send.pipe(
    Effect.catchTag("Unauthorized", () =>
      Effect.sync(() => (connection.bound = false)).pipe(
        Effect.andThen(connection.refresh.pipe(Effect.ignore)),
        Effect.andThen(send),
      ),
    ),
  );
});
