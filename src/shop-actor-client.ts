import { createIsomorphicFn } from "@tanstack/react-start";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Atom from "effect/reactivity/Atom";
import * as AtomRpc from "effect/reactivity/AtomRpc";
import * as Reactivity from "effect/reactivity/Reactivity";
import { RpcClient, RpcSerialization } from "effect/rpc";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";
import {
  COUNT_KEY,
  type Notice,
  NoticeFrame,
  SANDBOX_SHOP,
  type ShopKey,
  ShopActorRpcs,
} from "./api/shop-actor.ts";
import { BackendRpcs, ReturnPath } from "./api/backend.ts";
import { backendProtocol } from "./backend-client.ts";
import { backendTransport } from "./backend-transport.ts";
import { refreshOnFocus } from "./query.ts";
import { makeSessionGuard } from "./socket-session.ts";

/** Notices pulled off the socket by {@link layerSocketWithNotices}; one per tab, like the socket. */
export const notices = Effect.runSync(PubSub.unbounded<Notice>());

const decodeNotice = Schema.decodeUnknownOption(NoticeFrame);

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
            if (Arr.isArrayNonEmpty(rest)) return rest;
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

/** This page's origin as a WebSocket origin: `ws:` under `http:`, `wss:` under `https:`. */
const wsOrigin = () => {
  const url = new URL(window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.origin;
};

/** One `Me` over HTTP: false only on `Unauthorized`; an outage counts as signed in. */
const isSignedIn = RpcClient.make(BackendRpcs).pipe(
  Effect.flatMap((client) => client.Me()),
  Effect.as(true),
  Effect.catchTag("Unauthorized", () => Effect.succeed(false)),
  Effect.orElseSucceed(() => true),
  Effect.scoped,
  Effect.provide(backendProtocol),
);

const decodeReturnPath = Schema.decodeUnknownOption(ReturnPath);

/** A full page load to sign-in, back here afterwards; the same shape as the `/app` route guard. */
const goToSignIn = Effect.sync(() => {
  const url = new URL("/sign-in", window.location.origin);
  const back = decodeReturnPath(window.location.pathname + window.location.search);
  if (Option.isSome(back)) url.searchParams.set("redirect", back.value);
  window.location.assign(url);
});

/** Failed opens in a row before the session is checked; see {@link makeSessionGuard}. */
const OPEN_FAILURES_BEFORE_SESSION_CHECK = 3;

const browserProtocol = (key: ShopKey) => {
  const guard = makeSessionGuard({
    failuresBeforeCheck: OPEN_FAILURES_BEFORE_SESSION_CHECK,
    isSignedIn,
    onSignedOut: goToSignIn,
  });
  return RpcClient.layerProtocolSocket({
    retryTransientErrors: true,
    onTransientError: () => guard.onOpenFailed,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        layerSocketWithNotices(`${wsOrigin()}/api/actor/${key}`),
        RpcSerialization.layerJson,
        // Refetch after every (re)connect: a notice sent while this tab was disconnected is lost.
        Layer.succeed(RpcClient.ConnectionHooks)({
          onConnect: guard.onConnect.pipe(
            Effect.andThen(
              PubSub.publish(notices, { _tag: "ShopActorNotice", invalidated: [COUNT_KEY] }),
            ),
          ),
          onDisconnect: Effect.void,
        }),
      ),
    ),
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
  );
};

/** SSR reads the actor over HTTP through the binding; see {@link backendTransport}. */
const serverProtocol = (key: ShopKey) =>
  RpcClient.layerProtocolHttp({ url: `https://backend/api/actor/${key}` }).pipe(
    Layer.provide(RpcSerialization.layerNdjson),
    Layer.provide(backendTransport()),
  );

/**
 * Browser: one hibernating WebSocket per tab with notices tapped off it. SSR: HTTP over the
 * binding. The socket layer is never built on the server.
 */
const protocol = createIsomorphicFn().client(browserProtocol).server(serverProtocol);

/** The shop whose actor this registry's client talks to. A route loader sets it before priming. */
export const shopKeyAtom = Atom.make<ShopKey>(SANDBOX_SHOP);

/**
 * The actor's procedures as atoms. The protocol reads {@link shopKeyAtom}, so a key change
 * rebuilds the client and, in the browser, reconnects.
 */
export class ShopActorClient extends AtomRpc.Service<ShopActorClient>()("ShopActorClient", {
  group: ShopActorRpcs,
  protocol: (get) => protocol(get(shopKeyAtom)),
}) {}

/** The shop's count; refetched on every notice naming {@link COUNT_KEY}; see `loadQuery`. */
export const countAtom = ShopActorClient.query("GetCount", undefined, {
  serializationKey: "count",
  timeToLive: "5 minutes",
}).pipe(Atom.withReactivity([COUNT_KEY]), refreshOnFocus);

export const incrementAtom = ShopActorClient.mutation("Increment");

export const activationAtom = ShopActorClient.query("Activation", undefined, {
  serializationKey: "activation",
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
