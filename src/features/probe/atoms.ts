import { Layer } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { AtomRpc } from "effect/reactivity";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { ProbeRpcs } from "./contracts";

export class ProbeClient extends AtomRpc.Service<ProbeClient>()("sandbox/ProbeClient", {
  group: ProbeRpcs,
  protocol: () =>
    RpcClient.layerProtocolHttp({
      url: "/api/rpc",
      transformClient: (client) =>
        HttpClient.mapRequest(client, HttpClientRequest.setUrl("/api/rpc")),
    }).pipe(Layer.provide([FetchHttpClient.layer, RpcSerialization.layerNdjson])),
}) {}
export const readAtom = ProbeClient.query("probe_read", undefined, {
  serializationKey: "home-snapshot",
  // Retain the seed across the render/subscription gap; this is not freshness or polling.
  timeToLive: Infinity,
});
export const transformAtom = ProbeClient.mutation("probe_transform");
