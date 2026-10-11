import { NodeSocket } from "@effect/platform-node";
import { assert } from "@effect/vitest";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Cookies from "effect/http/Cookies";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import { RpcClient, RpcSerialization } from "effect/rpc";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";
import http from "node:http";
import { BackendRpcs, EmailFromInput } from "../../src/api/backend.ts";
import { COUNT_KEY, type Notice, NoticeFrame, ShopActorRpcs } from "../../src/api/shop-actor.ts";
import Stack from "./stack.ts";

/**
 * Deploys the Backend with `ShopActor` into workerd and drives the actor over WebSockets, as a
 * browser tab does, straight at the Backend (no Website or Vite in front).
 */
const { test, beforeAll, deploy } = Test.make({
  providers: Cloudflare.providers(),
});

/** Never destroyed; see the same declaration in `auth.test.ts`. */
const stack = beforeAll(deploy(Stack));

/** A key of this file's own, so the count it asserts on is not shared with dev or e2e. */
const key = "integ-shop";

const member = Schema.decodeUnknownSync(EmailFromInput)("m1@m.com");

/** Signs in through an inline magic link, as `auth.test.ts` does, and returns the cookie. */
const signIn = (backendUrl: string) =>
  Effect.gen(function* () {
    const client = yield* RpcClient.make(BackendRpcs);
    const { link } = yield* client.RequestMagicLink({ email: member });
    // A reused stack names a dead port in the link; only its path and query carry the token.
    const url = new URL(Option.getOrThrow(link));
    const verify = yield* HttpClient.get(new URL(url.pathname + url.search, backendUrl)).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
    );
    assert.strictEqual(verify.status, 302);
    return Cookies.toCookieHeader(verify.cookies);
  }).pipe(Effect.scoped, Effect.provide(Test.rpcClientLayer(`${backendUrl}/rpc`)));

const decodeNotice = Schema.decodeUnknownOption(NoticeFrame);

/**
 * One tab's worth of client: a WebSocket to the actor with the cookie in the handshake, the
 * notice frames taken out of the socket onto this client's own PubSub (the same tap as
 * `ShopActorClient`'s socket, which cannot be imported here because it needs Start and the
 * Worker env), and Effect RPC on the rest. Lives in the caller's scope.
 */
const connect = (url: string, cookie: string) =>
  Effect.gen(function* () {
    const notices = yield* PubSub.unbounded<Notice>();
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
      RpcClient.layerProtocolSocket().pipe(
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
    return { client, received };
  });

test(
  "two sockets share one actor: a write on one notifies both",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    const cookie = yield* signIn(backendUrl);
    const url = `${backendUrl.replace(/^http/u, "ws")}/api/actor/${key}`;
    yield* Effect.gen(function* () {
      const a = yield* connect(url, cookie);
      const b = yield* connect(url, cookie);
      const before = yield* a.client.GetCount();
      const after = yield* a.client.Increment();
      assert.strictEqual(after.value, before.value + 1);

      const notice = yield* PubSub.take(b.received).pipe(Effect.timeout("5 seconds"));
      assert.deepStrictEqual(notice, { _tag: "ShopActorNotice", invalidated: [COUNT_KEY] });
      assert.deepStrictEqual(yield* b.client.GetCount(), after);
    }).pipe(Effect.scoped);
  }),
);

test(
  "an upgrade without a session is refused",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    // Node's fetch rejects an `upgrade` header, so the handshake goes through node:http, whose
    // `response` event carries any non-101 answer.
    const status = yield* Effect.callback<number | undefined>((resume) => {
      const request = http.get(`${backendUrl}/api/actor/${key}`, {
        headers: {
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
    assert.strictEqual(status, 401);
  }),
);

test(
  "a path under /api/actor/ that names no key is 404",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    const response = yield* HttpClient.get(`${backendUrl}/api/actor/NOT-A-KEY`);
    assert.strictEqual(response.status, 404);
  }).pipe(Effect.provide(FetchHttpClient.layer)),
);

test(
  "the actor hibernates while its sockets stay open",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    const cookie = yield* signIn(backendUrl);
    const url = `${backendUrl.replace(/^http/u, "ws")}/api/actor/${key}`;
    yield* Effect.gen(function* () {
      const a = yield* connect(url, cookie);
      yield* connect(url, cookie);
      const first = yield* a.client.Activation();
      // Each call is an event that keeps the object awake, and local workerd evicts an idle
      // one after about 10 s, so the polls are spaced wider than that. The clients' pings are
      // answered by the auto-response and do not wake it.
      const later = yield* a.client.Activation().pipe(
        Effect.repeat({
          schedule: Schedule.spaced("12 seconds"),
          until: (activation) => activation.id !== first.id,
          times: 5,
        }),
      );
      assert.notStrictEqual(later.id, first.id);
    }).pipe(Effect.scoped);
  }),
  { timeout: 90_000 },
);
