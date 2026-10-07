import "@tanstack/react-start/server-only";
import { Effect, Layer } from "effect";
import { HttpEffect, HttpServerResponse } from "effect/http";
import { RpcServer, RpcSerialization } from "effect/rpc";
import { ProbeRpcs } from "../../features/probe/contracts";
import { ProbeApplication } from "./composition.server";
import { ProbeService } from "./service.server";

const handlers = ProbeRpcs.toLayer(
  Effect.gen(function* () {
    const service = yield* ProbeService;
    return {
      probe_read: () => service.read(),
      probe_transform: (payload) => service.transform(payload),
    };
  }),
);

// Build handlers and start the protocol in the HTTP adapter's request scope, not a nested provide scope.
export const makeRpcEffect = (application: Layer.Layer<ProbeService> = ProbeApplication) =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const rpcLayer = Layer.merge(
      handlers.pipe(Layer.provide(application)),
      RpcSerialization.layerNdjson,
    );
    const context = yield* Layer.buildWithScope(rpcLayer, scope);
    const response = yield* Effect.gen(function* () {
      const handle = yield* RpcServer.toHttpEffect(ProbeRpcs);
      return yield* handle;
    }).pipe(Effect.provideContext(context));
    return HttpServerResponse.setHeader(response, "cache-control", "no-store");
  }).pipe(Effect.interruptible);
export const rpcEffect = makeRpcEffect();
export const handleProbeRpc = HttpEffect.toWebHandler(rpcEffect);
