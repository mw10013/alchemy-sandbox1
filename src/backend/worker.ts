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
import { ShopKey } from "../api/shop-actor.ts";
import { TestControlRpcs } from "../api/test-control.ts";
import { Auth } from "./auth.ts";
import { BackendHandlers, SignInLimiter } from "./handlers.ts";
import { MagicLinkDelivery } from "./magic-link-delivery.ts";
import { Mailer } from "./mailer.ts";
import { Members } from "./members.ts";
import { CurrentUserLive, currentUserFromCookie, RequireAdminLive } from "./middleware.ts";
import { AuthDb } from "./resources.ts";
import ShopActor from "./shop-actor.ts";
import {
  TestControlAuthLive,
  TestControlHandlers,
  TestControlToken,
  TestData,
} from "./test-control.ts";

/**
 * The private Effect Worker. It has no public URL: the browser reaches it only through the
 * Website, which forwards over the `BACKEND` service binding (browser → Website → Backend).
 * The binding ignores the request's host, so a caller may use any absolute URL.
 *
 * It serves Better Auth's routes under `/api/auth`, `TestControlRpcs` on `/api/test-control`,
 * and Effect RPC over HTTP (ndjson) for everything else; `RpcServer` ignores the path.
 *
 * It also hosts {@link ShopActor} and forwards `/api/actor/:key` (see {@link actorKeyFromPath})
 * to the actor named by the key, after a session check: no session is 401, and a path under
 * `/api/actor/` that names no key is 404 (see {@link isActorPath}). The actor serves the
 * RPC itself, over HTTP for the SSR call and over a WebSocket for the browser. Any member may
 * open any key for now; which member may open which shop is a product decision not yet taken.
 *
 * The test-control server exists only with the `E2E_TOKEN` binding, which the stack sets off
 * production; without it `/api/test-control` is 404.
 */
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
    const services = yield* Effect.context<
      Auth | MagicLinkDelivery | Members | SignInLimiter | TestData
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
    const fetch = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const { pathname } = new URL(request.url, "http://backend");
      if (pathname === "/api/auth" || pathname.startsWith("/api/auth/")) return yield* auth.fetch;
      if (isActorPath(pathname))
        return yield* Option.match(actorKeyFromPath(pathname), {
          onNone: () => Effect.succeed(HttpServerResponse.empty({ status: 404 })),
          onSome: (key) =>
            currentUserFromCookie(request.headers.cookie).pipe(
              Effect.provideService(Auth, authService),
              Effect.matchEffect({
                onFailure: () => Effect.succeed(HttpServerResponse.empty({ status: 401 })),
                onSuccess: () => actors.fetch(key, request),
              }),
            ),
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
    Effect.provide(Auth.layer),
    Effect.provide(MagicLinkDelivery.layer),
    Effect.provide(Layer.mergeAll(Members.layer, Mailer.layer, signInLimiter, TestData.layer)),
    Effect.provide(CloudflareD1(AuthDb)),
    Effect.provide(Cloudflare.Email.SendBinding),
    Effect.provide(Cloudflare.Workers.RateLimitBinding),
    Effect.provide(Cloudflare.D1.QueryDatabaseBinding),
  ),
) {}
