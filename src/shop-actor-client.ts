import { createIsomorphicFn } from "@tanstack/react-start";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import type * as AtomRegistry from "effect/reactivity/AtomRegistry";
import * as AtomRpc from "effect/reactivity/AtomRpc";
import * as Reactivity from "effect/reactivity/Reactivity";
import { RpcClient, RpcSerialization } from "effect/rpc";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";
import {
  applyCloseOutcome,
  closeOutcome,
  connectionStateAtom,
  merchantExpiredAtom,
  merchantTokenAtom,
  notAMemberAtom,
  reconnectAtom,
  retryPolicy,
  shopKeyAtom,
} from "./actor-connection.ts";
import type { ShopKey } from "./api/shop.ts";
import {
  COUNT_KEY,
  type ConnectionCaller,
  type Notice,
  NoticeFrame,
  ShopActorRpcs,
  type ShopSnapshot,
} from "./api/shop-actor.ts";
import { refreshOnFocus } from "./query.ts";

/**
 * Notices pulled off the socket by {@link layerSocketWithNotices}; one per registry, like the
 * socket, so a test registry never sees another's. The last one is replayed to a new
 * subscriber: the first connect's refresh notice is published while {@link noticesAtom} may
 * still be subscribing, and dropping it would leave the seeded count unchecked until the next
 * write.
 */
export const noticeBus = Atom.make(() =>
  Effect.runSync(PubSub.unbounded<Notice>({ replay: 1 })),
).pipe(Atom.keepAlive);

const decodeNotice = Schema.decodeUnknownOption(NoticeFrame);

/**
 * The RPC socket with the actor's notice frames taken out: a frame that decodes as
 * {@link Notice} is published to {@link notices} and never reaches the RPC protocol, so the
 * protocol sees only its own messages. Pull again when a chunk held nothing else, because a
 * reader's pull must return a non-empty array.
 */
const layerSocketWithNotices = (url: string, notices: PubSub.PubSub<Notice>) =>
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

type ProtocolInput = {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly notices: PubSub.PubSub<Notice>;
  readonly key: ShopKey;
  readonly merchantToken: Option.Option<string>;
};

/**
 * One hibernating WebSocket per browser, retried on `retryPolicy`, which stops on a terminal
 * close. The gate names the socket on its upgrade, from the cookie or, for a merchant, the
 * Shopify token on the URL (Baton's form), so no call carries a credential. Every close goes
 * through `closeOutcome` to the page's atoms.
 */
const browserProtocol = (input: ProtocolInput) => {
  const url = new URL(`/api/actor/${input.key}`, wsOrigin());
  const merchant = Option.isSome(input.merchantToken);
  if (Option.isSome(input.merchantToken)) url.searchParams.set("token", input.merchantToken.value);
  const setState = (state: "connecting" | "open") =>
    Effect.sync(() => input.registry.set(connectionStateAtom, state));
  return Layer.effect(
    RpcClient.Protocol,
    RpcClient.makeProtocolSocket({
      retryPolicy: retryPolicy((error) =>
        applyCloseOutcome(input.registry, closeOutcome(error, merchant)),
      ),
    }),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        layerSocketWithNotices(url.toString(), input.notices),
        RpcSerialization.layerJson,
        // Refetch after every (re)connect: a notice sent while this browser was disconnected
        // is lost.
        Layer.succeed(RpcClient.ConnectionHooks)({
          onConnect: setState("open").pipe(
            Effect.andThen(
              PubSub.publish(input.notices, {
                _tag: "ShopActorNotice",
                invalidated: [COUNT_KEY],
              }),
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
 * Browser: {@link browserProtocol}. The server never reads a socket atom: a shop page renders
 * its loader's snapshot until it is hydrated, and `seedShop` fills the atoms in the browser.
 */
const protocol = createIsomorphicFn()
  .client((input: ProtocolInput) => browserProtocol(input))
  .server((_input: ProtocolInput) =>
    Layer.effect(
      RpcClient.Protocol,
      Effect.die(new Error("the actor socket's atoms are never read on the server")),
    ),
  );

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
      notices: get(noticeBus),
      key: get(shopKeyAtom),
      merchantToken: get(merchantTokenAtom),
    });
  },
  makeEffect: RpcClient.make(ShopActorRpcs, { flatten: true }),
}) {}

/**
 * The member's count query itself, without the wrappers {@link countAtom} adds: the node
 * {@link seedShop} fills.
 */
export const countQuery = ShopActorClient.query("MemberGetCount", undefined, {
  serializationKey: "count",
});

/** The shop's count for a member; refetched on every notice naming {@link COUNT_KEY}. */
export const countAtom = countQuery.pipe(Atom.withReactivity([COUNT_KEY]), refreshOnFocus);

/** The merchant's count query; see {@link countQuery}. */
export const merchantCountQuery = ShopActorClient.query("MerchantGetCount", undefined, {
  serializationKey: "merchant-count",
});

/** The shop's count for a merchant; see {@link countAtom}. */
export const merchantCountAtom = merchantCountQuery.pipe(
  Atom.withReactivity([COUNT_KEY]),
  refreshOnFocus,
);

export const incrementAtom = ShopActorClient.mutation("MemberIncrement");

export const resetCountAtom = ShopActorClient.mutation("MerchantResetCount");

export const activationAtom = ShopActorClient.query("MemberActivation", undefined, {
  serializationKey: "activation",
});

/** Who the actor says this member is. */
export const whoAmIAtom = ShopActorClient.query("MemberWhoAmI", undefined, {
  serializationKey: "whoami",
});

/** Who the actor says this merchant is. */
export const merchantWhoAmIAtom = ShopActorClient.query("MerchantWhoAmI", undefined, {
  serializationKey: "merchant-whoami",
});

/**
 * Fills a query atom's node with a value the page already has, as if the query had answered.
 * The registry consumes the value when it first creates the node; a node that is already
 * there (a page left less than its idle TTL ago) is refetched instead.
 */
const seed = <A, E>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
  value: A,
) => {
  if (!Atom.isSerializable(atom)) throw new Error("only a query with a serializationKey is seeded");
  const { key, encode } = atom[Atom.SerializableTypeId];
  if (registry.getNodes().has(key)) registry.refresh(atom);
  else registry.setSerializable(key, encode(AsyncResult.success(value)));
};

/**
 * Seeds the socket's atoms from a shop page's loader data: the shop and credential the protocol
 * connects with, a fresh connection state, and the role's count, who-am-I and (for a member)
 * activation, so the page shows them at once and the socket only keeps them current. Run it
 * once, in the browser, before the page reads any socket atom. A second run on the same
 * registry (React's StrictMode doubles a state initializer in development) finds the nodes and
 * refetches instead, which costs one round trip and nothing else.
 */
export const seedShop = (
  registry: AtomRegistry.AtomRegistry,
  input: {
    readonly key: ShopKey;
    readonly merchantToken: Option.Option<string>;
    readonly caller: ConnectionCaller;
    readonly snapshot: ShopSnapshot;
  },
) => {
  registry.set(shopKeyAtom, input.key);
  registry.set(merchantTokenAtom, input.merchantToken);
  registry.set(notAMemberAtom, false);
  registry.set(merchantExpiredAtom, false);
  registry.set(connectionStateAtom, "connecting");
  if (Option.isSome(input.merchantToken)) {
    seed(registry, merchantCountQuery, input.snapshot.count);
    seed(registry, merchantWhoAmIAtom, input.caller);
  } else {
    seed(registry, countQuery, input.snapshot.count);
    seed(registry, whoAmIAtom, input.caller);
    seed(registry, activationAtom, input.snapshot.activation);
  }
};

/**
 * Turns notices into invalidations; mounted by the page. The stream never ends. It sees the
 * last notice published before it subscribed (see {@link noticeBus}), so every connect, the
 * first included, refetches the count.
 */
export const noticesAtom = ShopActorClient.runtime.atom((get) =>
  Stream.fromPubSub(get(noticeBus)).pipe(
    Stream.tap((notice) => Reactivity.invalidate(notice.invalidated)),
  ),
);
