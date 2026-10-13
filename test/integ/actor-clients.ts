import { NodeSocket } from "@effect/platform-node";
import { assert } from "@effect/vitest";
import * as Test from "alchemy/Test/Vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Cookies from "effect/http/Cookies";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import { RpcClient, type RpcClientError, type RpcGroup, RpcSerialization } from "effect/rpc";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";
import { type Email, EmailFromInput } from "../../src/api/backend.ts";
import type { ShopKey } from "../../src/api/shop.ts";
import {
  CONNECTION_CLOSE_DISPLACED,
  CONNECTION_CLOSE_FORBIDDEN,
  CONNECTION_CLOSE_NOT_A_MEMBER,
  CONNECTION_CLOSE_UNAUTHENTICATED,
  type ConnectionCaller,
  type Notice,
  NoticeFrame,
  ShopActorRpcs,
} from "../../src/api/shop-actor.ts";
import { TestControlRpcs } from "../../src/api/test-control.ts";

/**
 * Clients for the integ tests, straight at the Backend (no Website or Vite in front): Better
 * Auth sign-in, test control, and the actor's socket as a browser opens it.
 */

export const email = Schema.decodeUnknownSync(EmailFromInput);

/** One call against test control with the stage's token. */
export const control = <A, E>(
  backendUrl: string,
  e2eToken: string,
  f: (
    client: RpcClient.RpcClient<
      RpcGroup.Rpcs<typeof TestControlRpcs>,
      RpcClientError.RpcClientError
    >,
  ) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const client = yield* RpcClient.make(TestControlRpcs);
    return yield* f(client).pipe(RpcClient.withHeaders({ "x-e2e-token": e2eToken }));
  }).pipe(Effect.scoped, Effect.provide(Test.rpcClientLayer(`${backendUrl}/api/test-control`)));

/** A magic link for `address` from test control's `IssueMagicLink`. */
const magicLink = (backendUrl: string, e2eToken: string, address: Email) =>
  control(backendUrl, e2eToken, (c) => c.IssueMagicLink({ email: address })).pipe(
    Effect.map(({ link }) => new URL(link)),
  );

/** Signs in through an inline magic link and returns the session cookie. */
export const signIn = (backendUrl: string, e2eToken: string, address: Email) =>
  Effect.gen(function* () {
    // A reused stack names a dead port in the link; only its path and query carry the token.
    const url = yield* magicLink(backendUrl, e2eToken, address);
    const verify = yield* HttpClient.get(new URL(url.pathname + url.search, backendUrl)).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
    );
    assert.strictEqual(verify.status, 302);
    return Cookies.toCookieHeader(verify.cookies);
  }).pipe(Effect.provide(FetchHttpClient.layer));

/**
 * The origin Better Auth trusts (the stack's `AUTH_ORIGIN`), read off a magic link. A reused
 * stack binds the previous run's port, so it is not the Backend's URL; a POST to Better Auth
 * with a cookie must name it as its `Origin`.
 */
export const authOrigin = (backendUrl: string, e2eToken: string, address: Email) =>
  magicLink(backendUrl, e2eToken, address).pipe(Effect.map((url) => url.origin));

/** How a browser proves itself to the Backend: a member's cookie or a merchant's token. */
export type Credential = { readonly cookie: string } | { readonly token: string };

/** The socket URL a browser opens for a shop: the merchant's token, if any, in the query. */
export const socketUrl = (backendUrl: string, key: ShopKey, credential?: Credential) => {
  const url = new URL(`/api/actor/${key}`, backendUrl.replace(/^http/u, "ws"));
  if (credential !== undefined && "token" in credential)
    url.searchParams.set("token", credential.token);
  return url.toString();
};

const decodeNotice = Schema.decodeUnknownOption(NoticeFrame);

/** The close codes a browser does not reconnect after; the test socket stops on them too. */
const TERMINAL_CODES: ReadonlySet<number> = new Set([
  CONNECTION_CLOSE_UNAUTHENTICATED,
  CONNECTION_CLOSE_FORBIDDEN,
  CONNECTION_CLOSE_NOT_A_MEMBER,
  CONNECTION_CLOSE_DISPLACED,
]);
const isTerminal = (error: Socket.SocketError) =>
  error.reason._tag === "SocketCloseError" && TERMINAL_CODES.has(error.reason.code);

/**
 * One browser's socket to a shop's actor: `headers` in the handshake (a member's cookie, or
 * anything a test forges), notice frames taken out onto `received`, and Effect RPC on the
 * rest. Every socket error is offered to `closes`, which is how a test sees the code a socket
 * was closed with; the protocol then reconnects on its own, except after a code a browser
 * treats as terminal. Lives in the caller's scope.
 */
export const connect = (url: string, headers: Record<string, string> = {}) =>
  Effect.gen(function* () {
    const notices = yield* PubSub.unbounded<Notice>();
    const closes = yield* Queue.unbounded<Socket.SocketError>();
    const socket = Layer.effect(
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
    const protocol = yield* Layer.build(
      Layer.effect(
        RpcClient.Protocol,
        RpcClient.makeProtocolSocket({
          retryPolicy: Schedule.spaced("200 millis").pipe(
            Schedule.setInputType<Socket.SocketError>(),
            Schedule.tap(({ input }) => Queue.offer(closes, input)),
            Schedule.while(({ input }) => !isTerminal(input)),
          ),
        }),
      ).pipe(
        Layer.provide(Layer.mergeAll(socket, RpcSerialization.layerJson)),
        Layer.provide(
          Layer.effect(
            Socket.WebSocketConstructor,
            Effect.gen(function* () {
              const make = yield* Socket.WebSocketConstructor;
              return (url: string) => make(url, { headers });
            }),
          ).pipe(Layer.provide(NodeSocket.layerWebSocketConstructor)),
        ),
      ),
    );
    const client = yield* RpcClient.make(ShopActorRpcs).pipe(Effect.provideContext(protocol));
    const received = yield* PubSub.subscribe(notices);
    return { client, received, closes };
  });

/** A browser's socket through the gate, with its credential as the browser sends it. */
export const connectAs = (backendUrl: string, key: ShopKey, credential: Credential) =>
  connect(
    socketUrl(backendUrl, key, credential),
    "cookie" in credential ? { cookie: credential.cookie } : {},
  );

/**
 * A socket opened as any caller through test control's upgrade route, skipping the gate: how
 * a test gets an identity no sign-in produces, such as an expired session.
 */
export const openAs = (
  backendUrl: string,
  e2eToken: string,
  key: ShopKey,
  caller: ConnectionCaller,
) =>
  connect(
    new URL(`/api/test-control/actor/${key}`, backendUrl.replace(/^http/u, "ws")).toString(),
    { "x-e2e-token": e2eToken, "x-test-caller": JSON.stringify(caller) },
  );

/** The next close code a socket saw, within a few seconds. */
export const nextCloseCode = (closes: Queue.Dequeue<Socket.SocketError>) =>
  Queue.take(closes).pipe(
    Effect.timeout("5 seconds"),
    Effect.map((error) => (error.reason._tag === "SocketCloseError" ? error.reason.code : -1)),
  );
