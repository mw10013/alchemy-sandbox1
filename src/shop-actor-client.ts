import { createIsomorphicFn } from "@tanstack/react-start";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Atom from "effect/reactivity/Atom";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import * as AtomRpc from "effect/reactivity/AtomRpc";
import * as Reactivity from "effect/reactivity/Reactivity";
import { RpcClient, RpcSerialization } from "effect/rpc";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";
import {
  CONNECTION_CLOSE_DISPLACED,
  COUNT_KEY,
  type Notice,
  NoticeFrame,
  ShopActorRpcs,
} from "./api/shop-actor.ts";
import type { ShopKey } from "./api/shop.ts";
import { BackendRpcs, NotAShopMember, Unauthorized } from "./api/backend.ts";
import { BackendClient, backendProtocol } from "./backend-client.ts";
import { backendTransport } from "./backend-transport.ts";
import { refreshOnFocus } from "./query.ts";
import {
  bindOnConnect,
  type ConnectionState,
  connectionStateAtom,
  isTerminal,
  makeTicketStep,
  merchantExpiredAtom,
  merchantTokenAtom,
  notAMemberAtom,
  reconnectAtom,
  retryPolicy,
  setClient,
  shopKeyAtom,
  ticketMiddleware,
} from "./ticket-client.ts";

/** Notices pulled off the socket by {@link layerSocketWithNotices}; one per browser, like the socket. */
export const notices = Effect.runSync(PubSub.unbounded<Notice>());

const decodeNotice = Schema.decodeUnknownOption(NoticeFrame);

/**
 * The RPC socket with the actor's notice frames taken out: a frame that decodes as
 * {@link Notice} is published to {@link notices} and never reaches the RPC protocol, so the
 * protocol sees only its own messages. Pull again when a chunk held nothing else, because a
 * reader's pull must return a non-empty array.
 *
 * `beforeConnect` runs each time the protocol opens the socket, before it opens: the reader is
 * acquired once per connect. It is where the connect's ticket is fetched, and its failure is
 * the socket's failure, which the retry policy sees. (`Socket.makeWebSocket` also takes the
 * URL as an Effect run per connect, but that Effect cannot fail.)
 */
const layerSocketWithNotices = (
  url: string,
  beforeConnect: Effect.Effect<void, Socket.SocketError>,
) =>
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
            if (Arr.isArrayNonEmpty(rest)) return rest;
          }
        });
      return Socket.make({
        writer: inner.writer,
        reader: beforeConnect.pipe(
          Effect.andThen(inner.reader),
          Effect.map((reader) => ({ ...reader, pull: pullFiltered(reader.pull) })),
        ),
      });
    }),
  );

/** `IssueActorTicket`'s payload: the shop, and the merchant's token when there is one. */
const ticketPayload = (key: ShopKey, merchantToken: Option.Option<string>) =>
  Option.match(merchantToken, {
    onNone: () => ({ key }),
    onSome: (sessionToken) => ({ key, sessionToken }),
  });

const ticketQuery = (key: ShopKey, merchantToken: Option.Option<string>) =>
  BackendClient.query("IssueActorTicket", ticketPayload(key, merchantToken), {
    serializationKey: "actor-ticket",
  });

/**
 * A ticket for the next connect, for this shop and this browser's credential. The route
 * loader primes it with `loadQuery`, so the first ticket comes with the page and the first
 * connect makes no extra call.
 */
export const ticketAtom = Atom.make((get) =>
  get(ticketQuery(get(shopKeyAtom), get(merchantTokenAtom))),
);

const isNotAShopMember = Schema.is(NotAShopMember);
const isUnauthorized = Schema.is(Unauthorized);

/**
 * Primes {@link ticketAtom} in a route loader, as `loadQuery` does, and answers with the exit so
 * the loader can tell "not a member" (which the page shows) from a fault (which it throws).
 * Sets `notAMemberAtom` and `merchantExpiredAtom` from the answer.
 */
export const loadTicket = (registry: AtomRegistry.AtomRegistry) => {
  const query = ticketQuery(registry.get(shopKeyAtom), registry.get(merchantTokenAtom));
  registry.refresh(query);
  return Effect.runPromise(
    AtomRegistry.getResult(registry, query).pipe(
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          const error = Exit.findErrorOption(exit);
          registry.set(notAMemberAtom, Option.exists(error, isNotAShopMember));
          registry.set(
            merchantExpiredAtom,
            Option.isSome(registry.get(merchantTokenAtom)) && Option.exists(error, isUnauthorized),
          );
        }),
      ),
    ),
  );
};

/** This page's origin as a WebSocket origin: `ws:` under `http:`, `wss:` under `https:`. */
const wsOrigin = () => {
  const url = new URL(window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.origin;
};

/** The connection state a socket error leaves: terminal codes are shown, the rest is `lost`. */
const stateAfter = (error: Socket.SocketError): ConnectionState =>
  !isTerminal(error)
    ? "lost"
    : error.reason._tag === "SocketCloseError" && error.reason.code === CONNECTION_CLOSE_DISPLACED
      ? "displaced"
      : "forbidden";

/**
 * One hibernating WebSocket per browser, opened with a fresh ticket each time (see
 * `makeTicketStep`), bound on connect by a call carrying that ticket (see `bindOnConnect` and
 * `ticketMiddleware`), and retried
 * on `retryPolicy`, which stops on a terminal close or a refused ticket. A merchant's token
 * also goes on the URL, where the Backend's gate reads it, as Baton's does.
 */
const browserProtocol = (input: {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly key: ShopKey;
  readonly merchantToken: Option.Option<string>;
}) => {
  const url = new URL(`/api/actor/${input.key}`, wsOrigin());
  if (Option.isSome(input.merchantToken)) url.searchParams.set("token", input.merchantToken.value);
  const setState = (state: ConnectionState) =>
    Effect.sync(() => input.registry.set(connectionStateAtom, state));
  return Layer.effect(
    RpcClient.Protocol,
    RpcClient.makeProtocolSocket({
      retryPolicy: retryPolicy((error) => setState(stateAfter(error))),
    }),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        layerSocketWithNotices(
          url.toString(),
          makeTicketStep({
            registry: input.registry,
            merchantToken: input.merchantToken,
            primed: AsyncResult.value(input.registry.get(ticketAtom)).pipe(
              Option.map(({ ticket }) => ticket),
            ),
            fetch: RpcClient.make(BackendRpcs).pipe(
              Effect.flatMap((client) =>
                client.IssueActorTicket(ticketPayload(input.key, input.merchantToken)),
              ),
              Effect.map(({ ticket }) => ticket),
              Effect.scoped,
              Effect.provide(backendProtocol),
            ),
          }),
        ),
        RpcSerialization.layerJson,
        // Bind, then refetch after every (re)connect: a notice sent while this browser was
        // disconnected is lost.
        Layer.succeed(RpcClient.ConnectionHooks)({
          onConnect: bindOnConnect.pipe(
            Effect.andThen(setState("open")),
            Effect.andThen(
              PubSub.publish(notices, { _tag: "ShopActorNotice", invalidated: [COUNT_KEY] }),
            ),
          ),
          onDisconnect: Effect.sync(() => {
            const state = input.registry.get(connectionStateAtom);
            if (state !== "displaced" && state !== "forbidden")
              input.registry.set(connectionStateAtom, "lost");
          }),
        }),
      ),
    ),
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
    Layer.tap(() => setState("connecting")),
  );
};

/**
 * SSR reads the actor over HTTP through the binding; see {@link backendTransport}. A merchant
 * page sends its token as `authorization: Bearer`, Baton's second form, which the Backend's
 * gate reads instead of the cookie.
 */
const serverProtocol = (input: {
  readonly key: ShopKey;
  readonly merchantToken: Option.Option<string>;
}) =>
  RpcClient.layerProtocolHttp({
    url: `https://backend/api/actor/${input.key}`,
    transformClient: Option.match(input.merchantToken, {
      onNone: () => (client) => client,
      onSome:
        (token) =>
        <E, R>(client: HttpClient.HttpClient.With<E, R>) =>
          HttpClient.mapRequest(client, HttpClientRequest.bearerToken(token)),
    }),
  }).pipe(Layer.provide(RpcSerialization.layerNdjson), Layer.provide(backendTransport()));

/**
 * Browser: {@link browserProtocol}. SSR: {@link serverProtocol}. The socket layer is never
 * built on the server.
 */
const protocol = createIsomorphicFn()
  .client(
    (input: {
      readonly registry: AtomRegistry.AtomRegistry;
      readonly key: ShopKey;
      readonly merchantToken: Option.Option<string>;
    }) => browserProtocol(input),
  )
  .server(
    (input: {
      readonly registry: AtomRegistry.AtomRegistry;
      readonly key: ShopKey;
      readonly merchantToken: Option.Option<string>;
    }) => serverProtocol(input),
  );

/**
 * The ticket middleware is the browser's alone; server rendering is named by the Backend. The
 * browser's client is also the one `bindOnConnect` binds each socket through.
 */
const makeClient = createIsomorphicFn()
  .client(() =>
    RpcClient.make(ShopActorRpcs, { flatten: true }).pipe(
      Effect.tap(setClient),
      Effect.provide(ticketMiddleware),
    ),
  )
  .server(() => RpcClient.make(ShopActorRpcs, { flatten: true }));

/**
 * The actor's procedures as atoms. The protocol reads {@link shopKeyAtom}, `merchantTokenAtom`
 * and `reconnectAtom`, so a change to any of them rebuilds the client and, in the browser,
 * reconnects.
 */
export class ShopActorClient extends AtomRpc.Service<ShopActorClient>()("ShopActorClient", {
  group: ShopActorRpcs,
  protocol: (get) => {
    get(reconnectAtom);
    return protocol({
      registry: get.registry,
      key: get(shopKeyAtom),
      merchantToken: get(merchantTokenAtom),
    });
  },
  makeEffect: makeClient(),
}) {}

/** The shop's count for a member; refetched on every notice naming {@link COUNT_KEY}. */
export const countAtom = ShopActorClient.query("MemberGetCount", undefined, {
  serializationKey: "count",
  timeToLive: "5 minutes",
}).pipe(Atom.withReactivity([COUNT_KEY]), refreshOnFocus);

/** The shop's count for a merchant; see {@link countAtom}. */
export const merchantCountAtom = ShopActorClient.query("MerchantGetCount", undefined, {
  serializationKey: "merchant-count",
  timeToLive: "5 minutes",
}).pipe(Atom.withReactivity([COUNT_KEY]), refreshOnFocus);

export const incrementAtom = ShopActorClient.mutation("MemberIncrement");

export const resetCountAtom = ShopActorClient.mutation("MerchantResetCount");

export const activationAtom = ShopActorClient.query("MemberActivation", undefined, {
  serializationKey: "activation",
});

/** Who the actor says this member is; see `loadQuery`. */
export const whoAmIAtom = ShopActorClient.query("MemberWhoAmI", undefined, {
  serializationKey: "whoami",
});

/** Who the actor says this merchant is; see `loadQuery`. */
export const merchantWhoAmIAtom = ShopActorClient.query("MerchantWhoAmI", undefined, {
  serializationKey: "merchant-whoami",
});

/**
 * Turns notices into invalidations; mounted by the page. The stream never ends. A notice
 * published before this subscribes is dropped, which can happen to the first connect's
 * synthetic notice while the runtime is still being built; the count is primed by then, so
 * nothing is stale. Every reconnect happens with the subscription live.
 */
export const noticesAtom = ShopActorClient.runtime.atom(
  Stream.fromPubSub(notices).pipe(
    Stream.tap((notice) => Reactivity.invalidate(notice.invalidated)),
  ),
);
