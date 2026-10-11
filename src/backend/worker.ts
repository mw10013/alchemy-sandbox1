import { CloudflareD1 } from "@alchemy.run/better-auth/CloudflareD1";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as Layer from "effect/Layer";
import { RpcSerialization, RpcServer } from "effect/rpc";
import { BackendRpcs } from "../api/backend.ts";
import { Auth } from "./auth.ts";
import { BackendHandlers, SignInLimiter } from "./handlers.ts";
import { Members } from "./members.ts";
import { CurrentUserLive, RequireAdminLive } from "./middleware.ts";
import { AuthDb } from "./resources.ts";

// Private Effect Worker. The Website reaches it only through the `BACKEND` service binding:
// Better Auth's routes under /api/auth, and Effect RPC over HTTP (ndjson) for everything else.
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
    const { auth } = yield* Auth;
    const services = yield* Effect.context<Auth | Members | SignInLimiter>();
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
    const fetch = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const { pathname } = new URL(request.url, "http://backend");
      if (pathname === "/api/auth" || pathname.startsWith("/api/auth/")) return yield* auth.fetch;
      return yield* yield* rpc;
    });
    return { fetch };
  }).pipe(
    Effect.provide(Layer.mergeAll(Auth.layer, Members.layer, SignInLimiter.layer)),
    Effect.provide(CloudflareD1(AuthDb)),
    Effect.provide(Cloudflare.Email.SendBinding),
    Effect.provide(Cloudflare.Workers.RateLimitBinding),
    Effect.provide(Cloudflare.D1.QueryDatabaseBinding),
  ),
) {}
