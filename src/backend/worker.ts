import { CloudflareD1 } from "@alchemy.run/better-auth/CloudflareD1";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { RpcSerialization, RpcServer } from "effect/rpc";
import * as Schema from "effect/Schema";
import { BackendRpcs } from "../api/backend.ts";
import { ShopKey } from "../api/shop.ts";
import { CALLER_HEADER } from "../api/shop-actor.ts";
import { TestControlRpcs } from "../api/test-control.ts";
import { Auth } from "./auth.ts";
import { SystemActors, encodeCallerHeader } from "./actor-client.ts";
import { BackendHandlers, SignInLimiter } from "./handlers.ts";
import { MagicLinkDelivery } from "./magic-link-delivery.ts";
import { Mailer } from "./mailer.ts";
import { Members } from "./members.ts";
import { CurrentUserLive, RequireAdminLive } from "./middleware.ts";
import { AuthDb } from "./resources.ts";
import { ShopAccess } from "./shop-access.ts";
import { Shopify } from "./shopify.ts";
import { Tickets } from "./ticket.ts";
import ShopActor from "./shop-actor.ts";
import {
  TestControlAuthLive,
  TestControlHandlers,
  TestControlToken,
  TestData,
} from "./test-control.ts";

/** Under `alchemy dev` the limiter is open; see {@link SignInLimiter.layerOpen}. */
const signInLimiter = Layer.unwrap(
  Effect.map(Alchemy.ALCHEMY_DEV, (dev) => (dev ? SignInLimiter.layerOpen : SignInLimiter.layer)),
);

/**
 * An actor path split on `/`: exactly `/api/actor/<key>`, optionally with a trailing slash
 * (Effect's HTTP RPC client posts to its URL with one), where the key decodes as
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

/** The shop key of an {@link ActorPath}; None for any other path. */
const actorKeyFromPath = (pathname: string): Option.Option<ShopKey> =>
  Option.map(decodeActorPath(pathname.split("/")), (segments) => segments[3]);

/**
 * Whether a path is addressed to an actor at all, so one under `/api/actor/` that names no
 * {@link ShopKey} is 404 rather than falling through to the RPC server. A GET upgrade that
 * reached that server would fail its body read and log a handler failure.
 */
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

/** The token of an `authorization: Bearer <token>` header, Baton's second form for a merchant. */
const BearerToken = Schema.TemplateLiteralParser(["Bearer ", Schema.NonEmptyString]);
const decodeBearerOption = Schema.decodeUnknownOption(BearerToken);
const decodeBearer = (header: string | undefined) =>
  Option.map(decodeBearerOption(header), ([, token]) => token);

/**
 * The private Effect Worker. It has no public URL: the browser reaches it only through the
 * Website, which forwards over the `BACKEND` service binding (browser → Website → Backend).
 * The binding ignores the request's host, so a caller may use any absolute URL.
 *
 * It serves Better Auth's routes under `/api/auth`, `TestControlRpcs` on `/api/test-control`,
 * and Effect RPC over HTTP (ndjson) for everything else; `RpcServer` ignores the path.
 *
 * It also hosts {@link ShopActor} and forwards `/api/actor/:key` (see {@link actorKeyFromPath})
 * to the actor named by the key, after {@link ShopAccess}, the gate, has answered for the
 * caller: a refusal is its status, and a path under `/api/actor/` that names no key is 404 (see
 * {@link isActorPath}). The actor serves the RPC itself, over HTTP for the SSR call and over a
 * WebSocket for the browser.
 *
 * The test-control server exists only with the `E2E_TOKEN` binding, which the stack sets off
 * production; without it `/api/test-control` is 404.
 */
export default class Backend extends Cloudflare.Worker<Backend>()(
  "Backend",
  {
    main: import.meta.filename,
    workersDev: false,
    // Only reached through the service binding, so any free port will do.
    dev: { port: 0 },
    compatibility: { date: "2026-07-01", flags: ["nodejs_compat"] },
  },
  Effect.gen(function* () {
    // Built once per isolate. Yielding the bindings here attaches them to the Worker.
    const authService = yield* Auth;
    const { auth } = authService;
    const actors = yield* ShopActor;
    const shopAccess = yield* ShopAccess;
    const services = yield* Effect.context<
      | Auth
      | MagicLinkDelivery
      | Members
      | ShopAccess
      | Shopify
      | SignInLimiter
      | SystemActors
      | TestData
      | Tickets
    >();
    // The RPC server is built per request, inside the request's scope (workerd pins I/O to
    // the request that created it).
    const rpc = RpcServer.toHttpEffect(BackendRpcs).pipe(
      Effect.provide(
        Layer.mergeAll(
          BackendHandlers,
          CurrentUserLive,
          RequireAdminLive,
          RpcSerialization.layerNdjson,
        ).pipe(Layer.provide(Layer.succeedContext(services))),
      ),
    );
    const testControl = Option.map(yield* Config.option(Config.String("E2E_TOKEN")), (token) =>
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
     * The actor branch: the gate, then a request rebuilt from nothing but what the actor may
     * see. A WebSocket upgrade keeps only {@link FORWARDED_HANDSHAKE_HEADERS}; the merchant's
     * `?token=` is read here and dropped. Any other method is an SSR read over HTTP: it keeps its
     * method, body and `content-type`, and gains {@link CALLER_HEADER} with the caller the gate
     * resolved. The cookie, `authorization` and any incoming `x-actor-*` header never reach
     * the actor, so a caller cannot name itself.
     */
    const forwardToActor = Effect.fn("Backend.forwardToActor")(function* (
      key: ShopKey,
      request: HttpServerRequest.HttpServerRequest,
    ) {
      const url = new URL(request.url, "http://backend");
      const upgrade = request.headers.upgrade?.toLowerCase() === "websocket";
      const bearer = decodeBearer(request.headers.authorization);
      const caller = yield* shopAccess
        .resolve({
          key,
          cookie: request.headers.cookie,
          sessionToken: upgrade
            ? Option.getOrUndefined(Option.fromNullishOr(url.searchParams.get("token")))
            : Option.getOrUndefined(bearer),
        })
        .pipe(Effect.result);
      if (caller._tag === "Failure")
        return HttpServerResponse.empty({ status: caller.failure.status });
      const headers = new Headers();
      if (upgrade) {
        for (const name of FORWARDED_HANDSHAKE_HEADERS) {
          const value = request.headers[name];
          if (value !== undefined) headers.set(name, value);
        }
      } else {
        const contentType = request.headers["content-type"];
        if (contentType !== undefined) headers.set("content-type", contentType);
        headers.set(CALLER_HEADER, encodeCallerHeader(caller.success));
      }
      const body = upgrade ? undefined : yield* request.arrayBuffer.pipe(Effect.orDie);
      const forwarded = HttpServerRequest.fromWeb(
        new Request(new URL(url.pathname, url.origin), {
          method: request.method,
          headers,
          body,
        }),
      );
      return yield* actors.fetch(key, forwarded);
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
      // Effect's HTTP RPC client posts to its URL with a trailing slash.
      if (pathname === "/api/test-control" || pathname === "/api/test-control/")
        return Option.isSome(testControl)
          ? yield* yield* testControl.value
          : HttpServerResponse.empty({ status: 404 });
      return yield* yield* rpc;
    });
    return { fetch };
  }).pipe(
    Effect.provide(ShopAccess.layer),
    Effect.provide(Auth.layer),
    Effect.provide(SystemActors.layer),
    Effect.provide(MagicLinkDelivery.layer),
    Effect.provide(
      Layer.mergeAll(
        Members.layer,
        Mailer.layer,
        signInLimiter,
        TestData.layer,
        Tickets.layer,
        Shopify.layer,
      ),
    ),
    Effect.provide(CloudflareD1(AuthDb)),
    Effect.provide(Cloudflare.Email.SendBinding),
    Effect.provide(Cloudflare.Workers.RateLimitBinding),
    Effect.provide(Cloudflare.D1.QueryDatabaseBinding),
  ),
) {}
