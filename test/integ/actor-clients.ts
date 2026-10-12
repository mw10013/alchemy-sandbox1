import { NodeSocket } from "@effect/platform-node";
import { assert } from "@effect/vitest";
import * as Test from "alchemy/Test/Vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Cookies from "effect/http/Cookies";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import { RpcClient, type RpcClientError, type RpcGroup, RpcSerialization } from "effect/rpc";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";
import http from "node:http";
import { BackendRpcs, type Email, EmailFromInput, type Ticket } from "../../src/api/backend.ts";
import type { ShopKey } from "../../src/api/shop.ts";
import {
  type Notice,
  NoticeFrame,
  ShopActorRpcs,
  TICKET_HEADER,
} from "../../src/api/shop-actor.ts";
import { TestControlRpcs } from "../../src/api/test-control.ts";

/**
 * Clients for the integ tests, straight at the Backend (no Website or Vite in front): Better
 * Auth sign-in, test control, the actor's socket as a browser opens it, and the actor over
 * HTTP as server rendering reads it.
 */

export const email = Schema.decodeUnknownSync(EmailFromInput);

const backendRpc = (backendUrl: string) => Test.rpcClientLayer(`${backendUrl}/rpc`);

/** Signs in through an inline magic link and returns the session cookie. */
export const signIn = (backendUrl: string, address: Email) =>
  Effect.gen(function* () {
    const client = yield* RpcClient.make(BackendRpcs);
    const { link } = yield* client.RequestMagicLink({ email: address });
    // A reused stack names a dead port in the link; only its path and query carry the token.
    const url = new URL(Option.getOrThrow(link));
    const verify = yield* HttpClient.get(new URL(url.pathname + url.search, backendUrl)).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
    );
    assert.strictEqual(verify.status, 302);
    return Cookies.toCookieHeader(verify.cookies);
  }).pipe(Effect.scoped, Effect.provide(backendRpc(backendUrl)));

/**
 * The origin Better Auth trusts (the stack's `AUTH_ORIGIN`), read off a magic link. A reused
 * stack binds the previous run's port, so it is not the Backend's URL; a POST to Better Auth
 * with a cookie must name it as its `Origin`.
 */
export const authOrigin = (backendUrl: string, address: Email) =>
  Effect.gen(function* () {
    const client = yield* RpcClient.make(BackendRpcs);
    const { link } = yield* client.RequestMagicLink({ email: address });
    return new URL(Option.getOrThrow(link)).origin;
  }).pipe(Effect.scoped, Effect.provide(backendRpc(backendUrl)));

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

/** How a browser proves itself to the Backend: a member's cookie or a merchant's token. */
export type Credential = { readonly cookie: string } | { readonly token: string };

/** `IssueActorTicket` as the browser calls it before each connect. */
export const issueTicket = (backendUrl: string, key: ShopKey, credential: Credential) =>
  Effect.gen(function* () {
    const client = yield* RpcClient.make(BackendRpcs);
    return yield* "cookie" in credential
      ? client.IssueActorTicket({ key }).pipe(RpcClient.withHeaders({ cookie: credential.cookie }))
      : client.IssueActorTicket({ key, sessionToken: credential.token });
  }).pipe(
    Effect.map(({ ticket }) => ticket),
    Effect.scoped,
    Effect.provide(backendRpc(backendUrl)),
  );

export const socketUrl = (backendUrl: string, key: ShopKey, credential?: Credential) => {
  const url = new URL(`/api/actor/${key}`, backendUrl.replace(/^http/u, "ws"));
  if (credential !== undefined && "token" in credential)
    url.searchParams.set("token", credential.token);
  return url.toString();
};

const decodeNotice = Schema.decodeUnknownOption(NoticeFrame);

/**
 * One browser's socket to a shop's actor: the cookie (if any) in the handshake, the merchant's
 * token (if any) in the query, notice frames taken out onto `received`, and Effect RPC on the
 * rest. Every socket error the protocol retries on is offered to `closes`, which is how a test
 * sees the code a socket was closed with; the protocol then reconnects on its own, unbound.
 * `bind` sends a ticket on one call, as the browser's first call after a connect does. Lives
 * in the caller's scope.
 */
export const connect = (url: string, credential?: Credential) =>
  Effect.gen(function* () {
    const notices = yield* PubSub.unbounded<Notice>();
    const closes = yield* Queue.unbounded<Socket.SocketError>();
    const cookie = credential !== undefined && "cookie" in credential ? credential.cookie : "";
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
            Schedule.tap(({ input }) => Queue.offer(closes, input)),
          ),
        }),
      ).pipe(
        Layer.provide(Layer.mergeAll(socket, RpcSerialization.layerJson)),
        Layer.provide(
          Layer.effect(
            Socket.WebSocketConstructor,
            Effect.gen(function* () {
              const make = yield* Socket.WebSocketConstructor;
              return (url: string) => make(url, { headers: { cookie } });
            }),
          ).pipe(Layer.provide(NodeSocket.layerWebSocketConstructor)),
        ),
      ),
    );
    const client = yield* RpcClient.make(ShopActorRpcs).pipe(Effect.provideContext(protocol));
    const received = yield* PubSub.subscribe(notices);
    const bind = <A, E, R>(ticket: Ticket, call: Effect.Effect<A, E, R>) =>
      call.pipe(RpcClient.withHeaders({ [TICKET_HEADER]: ticket }));
    return { client, received, closes, bind };
  });

/** The next close code a socket saw, within a few seconds. */
export const nextCloseCode = (closes: Queue.Dequeue<Socket.SocketError>) =>
  Queue.take(closes).pipe(
    Effect.timeout("5 seconds"),
    Effect.map((error) => (error.reason._tag === "SocketCloseError" ? error.reason.code : -1)),
  );

/**
 * The actor over HTTP through the Backend's `/api/actor/:key`, as server rendering reads it:
 * a member forwards its cookie, a merchant its token as `authorization: Bearer`.
 */
export const httpActor = (backendUrl: string, key: ShopKey, credential: Credential) =>
  RpcClient.make(ShopActorRpcs).pipe(
    Effect.provide(
      RpcClient.layerProtocolHttp({
        url: `${backendUrl}/api/actor/${key}`,
        transformClient: HttpClient.mapRequest(
          "cookie" in credential
            ? HttpClientRequest.setHeader("cookie", credential.cookie)
            : HttpClientRequest.bearerToken(credential.token),
        ),
      }).pipe(Layer.provide(Layer.mergeAll(RpcSerialization.layerNdjson, FetchHttpClient.layer))),
    ),
  );

/**
 * The status of a WebSocket upgrade on a URL with the given headers. Node's fetch rejects an
 * `upgrade` header, so the handshake goes through node:http, whose `response` event carries
 * any non-101 answer.
 */
export const upgradeStatus = (url: string, headers: Record<string, string> = {}) =>
  Effect.callback<number | undefined>((resume) => {
    const request = http.get(url, {
      headers: {
        ...headers,
        upgrade: "websocket",
        connection: "Upgrade",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
    });
    request.on("response", (response) => {
      response.resume();
      resume(Effect.succeed(response.statusCode));
    });
    request.on("upgrade", (_, socket) => {
      socket.destroy();
      resume(Effect.succeed(101));
    });
    request.on("error", (error) => resume(Effect.die(error)));
    return Effect.sync(() => request.destroy());
  });
