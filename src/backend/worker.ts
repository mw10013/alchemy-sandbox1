import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { RpcSerialization, RpcServer } from "effect/rpc";
import { BackendRpcs } from "../api/backend.ts";
import { BackendHandlers } from "./handlers.ts";

// Private Effect Worker. The Website reaches it only through the `BACKEND`
// service binding, as Effect RPC over HTTP (ndjson).
export default class Backend extends Cloudflare.RpcWorker<Backend>()(
  "Backend",
  {
    main: import.meta.filename,
    schema: BackendRpcs,
    workersDev: false,
    compatibility: { date: "2026-07-01", flags: ["nodejs_compat"] },
  },
  Effect.sync(() =>
    RpcServer.toHttpEffect(BackendRpcs).pipe(
      Effect.provide(Layer.mergeAll(BackendHandlers, RpcSerialization.layerNdjson)),
    ),
  ),
) {}
