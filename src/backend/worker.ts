import { CloudflareD1 } from "@alchemy.run/better-auth/CloudflareD1";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Output from "alchemy/Output";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as HttpBody from "effect/http/HttpBody";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import { RpcSerialization, RpcServer } from "effect/rpc";
import * as Schema from "effect/Schema";
import { ShopKey } from "../contract/shop.ts";
import {
  CONNECTION_CLOSE_FORBIDDEN,
  CONNECTION_CLOSE_NOT_A_MEMBER,
  CONNECTION_CLOSE_TRY_AGAIN,
  CONNECTION_CLOSE_UNAUTHENTICATED,
  CONNECTION_HEADER,
  ConnectionCaller,
} from "../contract/shop-actor.ts";
import { TestControlRpcs } from "../contract/test-control.ts";
import { ShopActors } from "./shop-actors.ts";
import { BackendApi, SignInLimiter } from "./api.ts";
import { Auth } from "./auth.ts";
import { MagicLinkDelivery } from "./magic-link-delivery.ts";
import { Mailer } from "./mailer.ts";
import { Members } from "./members.ts";
import { AuthDb } from "./resources.ts";
import { ShopAccess, type ShopAccessDenied } from "./shop-access.ts";
import { Shopify } from "./shopify.ts";
import { ShopSessions } from "./shop-sessions.ts";
import { workerNameOf } from "./stage.ts";
import ShopActor from "./shop-actor.ts";
import {
  TestControlAuthLive,
  TestControlHandlers,
  TestControlToken,
  testControlCaller,
} from "./test-control.ts";

/** Under `alchemy dev` the limiter is open; see {@link SignInLimiter.layerOpen}. */
const signInLimiter = Layer.unwrap(
  Effect.map(Alchemy.ALCHEMY_DEV, (dev) => (dev ? SignInLimiter.layerOpen : SignInLimiter.layer)),
);

/**
 * `/api/actor/<key>` split on `/`, optionally with a trailing slash, where the key decodes as
 * {@link ShopKey}. A tuple rejects extra segments.
 */
const ActorPath = Schema.Union([
  Schema.Tuple([Schema.Literal(""), Schema.Literal("api"), Schema.Literal("actor"), ShopKey]),
  Schema.Tuple([
    Schema.Literal(""),
    Schema.Literal("api"),
    Schema.Literal("actor"),
    ShopKey,
    Schema.Literal(""),
  ]),
]);
const decodeActorPath = Schema.decodeUnknownOption(ActorPath);

/** `/api/test-control/actor/<key>`, as {@link ActorPath}; see `testControlCaller`. */
const TestActorPath = Schema.Tuple([
  Schema.Literal(""),
  Schema.Literal("api"),
  Schema.Literal("test-control"),
  Schema.Literal("actor"),
  ShopKey,
]);
const decodeTestActorPath = Schema.decodeUnknownOption(TestActorPath);

/** The shop key of an {@link ActorPath}; None for any other path. */
const actorKeyFromPath = (pathname: string): Option.Option<ShopKey> =>
  Option.map(decodeActorPath(pathname.split("/")), (segments) => segments[3]);

/** The shop key of a {@link TestActorPath}; None for any other path. */
const testActorKeyFromPath = (pathname: string): Option.Option<ShopKey> =>
  Option.map(decodeTestActorPath(pathname.split("/")), (segments) => segments[4]);

/** Whether a path is addressed to an actor at all, so one that names no {@link ShopKey} is 404. */
const isActorPath = (pathname: string) =>
  pathname === "/api/actor" || pathname.startsWith("/api/actor/");

/**
 * The headers a WebSocket handshake itself needs: the only ones an upgrade forwarded to the
 * actor keeps (Baton's list, without its PartyKit namespace header, which nothing here uses).
 */
const FORWARDED_HANDSHAKE_HEADERS = [
  "upgrade",
  "connection",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-protocol",
  "sec-websocket-extensions",
] as const;

const encodeConnectionHeader = Schema.encodeSync(Schema.fromJsonString(ConnectionCaller));

/** The gate's refusal as the close code the browser reads, with a short reason. */
const refusalClose = (status: ShopAccessDenied["status"]) =>
  Match.value(status).pipe(
    Match.when(401, () => ({ code: CONNECTION_CLOSE_UNAUTHENTICATED, reason: "unauthenticated" })),
    Match.when(403, () => ({ code: CONNECTION_CLOSE_FORBIDDEN, reason: "forbidden" })),
    Match.when(404, () => ({ code: CONNECTION_CLOSE_NOT_A_MEMBER, reason: "not a member" })),
    Match.when(503, () => ({ code: CONNECTION_CLOSE_TRY_AGAIN, reason: "try again" })),
    Match.exhaustive,
  );

/**
 * Accepts an upgrade the gate refused and closes it at once with {@link refusalClose}'s code. A
 * refused handshake reaches a browser's `WebSocket` only as a bare 1006 with no status, and the
 * Website's dev server drops it altogether, so the answer travels as a close code instead.
 */
const refuseUpgrade = (status: ShopAccessDenied["status"]) =>
  Effect.sync(() => {
    const { code, reason } = refusalClose(status);
    const pair = new WebSocketPair();
    pair[1].accept();
    pair[1].close(code, reason);
    return HttpServerResponse.setBody(
      HttpServerResponse.empty({ status: 101 }),
      HttpBody.raw(new Response(null, { status: 101, webSocket: pair[0] })),
    );
  });

/**
 * The upgrade the actor sees: rebuilt from nothing but {@link FORWARDED_HANDSHAKE_HEADERS} and
 * {@link CONNECTION_HEADER} naming `caller`. The cookie, `authorization`, the merchant's
 * `?token=` and any incoming `x-actor-*` header never reach the actor, so a browser cannot name
 * itself.
 */
const forwardedUpgrade = (
  request: HttpServerRequest.HttpServerRequest,
  pathname: string,
  caller: ConnectionCaller,
) => {
  const headers = new Headers();
  for (const name of FORWARDED_HANDSHAKE_HEADERS) {
    const value = request.headers[name];
    if (value !== undefined) headers.set(name, value);
  }
  headers.set(CONNECTION_HEADER, encodeConnectionHeader(caller));
  return HttpServerRequest.fromWeb(
    new Request(new URL(pathname, "http://backend"), { method: "GET", headers }),
  );
};

const isUpgrade = (request: HttpServerRequest.HttpServerRequest) =>
  request.method === "GET" && request.headers.upgrade?.toLowerCase() === "websocket";

const upgradeRequired = HttpServerResponse.empty({
  status: 426,
  headers: { upgrade: "websocket" },
});

/**
 * The private Effect Worker. It has no public URL: the browser reaches it only through the
 * Website, which calls it over the `BACKEND` service binding (browser → Website → Backend).
 * The binding ignores the request's host, so a caller may use any absolute URL.
 *
 * The Website's server functions call {@link BackendApi}'s methods, which this Worker returns
 * beside `fetch` and which the binding carries schemaless. `fetch` serves Better Auth's routes
 * under `/api/auth`, `TestControlRpcs` on `/api/test-control`, and the actor's sockets;
 * anything else is 404.
 *
 * It hosts {@link ShopActor} and forwards a WebSocket upgrade on `/api/actor/<key>` (see
 * {@link actorKeyFromPath}) to the actor named by the key, after {@link ShopAccess}, the gate,
 * has resolved the browser: the forwarded request names the caller in {@link CONNECTION_HEADER}
 * (see {@link forwardedUpgrade}), and a refusal is a socket closed at once with a close code
 * (see {@link refuseUpgrade}). Anything but an upgrade there is 426: there is no HTTP RPC into
 * the actor. A path under `/api/actor/` that names no key is 404.
 *
 * Test control exists only with the `E2E_TOKEN` binding, which the stack sets only when the test
 * runner supplies the token; without it `/api/test-control` and its upgrade route are 404.
 */
export default class Backend extends Cloudflare.Worker<Backend>()(
  "Backend",
  {
    name: Output.fromEffect(Effect.map(Alchemy.Stage, (stage) => workerNameOf(stage, "backend"))),
    main: import.meta.filename,
    workersDev: false,
    // Only reached through the service binding, so any free port will do.
    dev: { port: 0 },
    compatibility: { date: "2026-07-01", flags: ["nodejs_compat"] },
  },
  Effect.gen(function* () {
    // Built once per isolate. Yielding the bindings here attaches them to the Worker.
    const { auth } = yield* Auth;
    const actors = yield* ShopActor;
    const shopAccess = yield* ShopAccess;
    const api = yield* BackendApi;
    const services = yield* Effect.context<
      Auth | MagicLinkDelivery | Members | Shopify | ShopActors | ShopSessions
    >();
    const e2eToken = yield* Config.option(Config.String("E2E_TOKEN"));
    // The RPC server is built per request, inside the request's scope (workerd pins I/O to
    // the request that created it).
    const testControl = Option.map(e2eToken, (token) =>
      RpcServer.toHttpEffect(TestControlRpcs).pipe(
        Effect.provide(
          Layer.mergeAll(
            TestControlHandlers,
            TestControlAuthLive,
            RpcSerialization.layerNdjson,
          ).pipe(
            Layer.provide(Layer.succeedContext(services)),
            Layer.provide(Layer.succeed(TestControlToken, token)),
          ),
        ),
      ),
    );

    /**
     * The actor branch: the gate on the upgrade, then the upgrade forwarded as the caller it
     * resolved. A merchant's Shopify session token arrives as `?token=`, Baton's form for a
     * socket; a member is resolved from the cookie.
     */
    const forwardToActor = Effect.fn("Backend.forwardToActor")(function* (
      key: ShopKey,
      request: HttpServerRequest.HttpServerRequest,
    ) {
      if (!isUpgrade(request)) return upgradeRequired;
      const url = new URL(request.url, "http://backend");
      const caller = yield* shopAccess
        .resolve({
          key,
          cookie: request.headers.cookie,
          sessionToken: Option.getOrUndefined(Option.fromNullishOr(url.searchParams.get("token"))),
        })
        .pipe(Effect.result);
      if (caller._tag === "Failure") return yield* refuseUpgrade(caller.failure.status);
      return yield* actors
        .getByName(key)
        .fetch(forwardedUpgrade(request, url.pathname, caller.success));
    });

    const fetch = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const { pathname } = new URL(request.url, "http://backend");
      if (pathname === "/api/auth" || pathname.startsWith("/api/auth/")) return yield* auth.fetch;
      if (isActorPath(pathname))
        return yield* Option.match(actorKeyFromPath(pathname), {
          onNone: () => Effect.succeed(HttpServerResponse.empty({ status: 404 })),
          onSome: (key) => forwardToActor(key, request),
        });
      const testKey = testActorKeyFromPath(pathname);
      if (Option.isSome(testKey)) {
        const caller = Option.flatMap(e2eToken, (token) =>
          testControlCaller(token, request.headers),
        );
        if (Option.isNone(caller)) return HttpServerResponse.empty({ status: 404 });
        if (!isUpgrade(request)) return upgradeRequired;
        return yield* actors
          .getByName(testKey.value)
          .fetch(forwardedUpgrade(request, `/api/actor/${testKey.value}`, caller.value));
      }
      // Effect's HTTP RPC client posts to its URL with a trailing slash.
      if (pathname === "/api/test-control" || pathname === "/api/test-control/")
        return Option.isSome(testControl)
          ? yield* yield* testControl.value
          : HttpServerResponse.empty({ status: 404 });
      return HttpServerResponse.empty({ status: 404 });
    });
    return { fetch, ...api };
  }).pipe(
    Effect.provide(BackendApi.layer),
    Effect.provide(ShopAccess.layer),
    Effect.provide(Auth.layer),
    Effect.provide(ShopActors.layer),
    Effect.provide(MagicLinkDelivery.layer),
    Effect.provide(
      Layer.mergeAll(
        Members.layer,
        Mailer.layer,
        signInLimiter,
        Shopify.layer.pipe(Layer.provideMerge(ShopSessions.layer)),
      ),
    ),
    Effect.provide(CloudflareD1(AuthDb)),
    Effect.provide(Cloudflare.Email.SendBinding),
    Effect.provide(Cloudflare.Workers.RateLimitBinding),
    Effect.provide(Cloudflare.D1.QueryDatabaseBinding),
  ),
) {}
