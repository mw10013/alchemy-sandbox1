import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Atom from "effect/reactivity/Atom";
import * as AtomRpc from "effect/reactivity/AtomRpc";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { BackendRpcs } from "./api/backend.ts";
import { env } from "./env.server.ts";

// Browser: same-origin proxy route. SSR: any absolute URL; the service binding ignores the host.
const rpcUrl = createIsomorphicFn()
  .client(() => `${window.location.origin}/api/rpc`)
  .server(() => "https://backend/rpc");

// SSR goes through the service binding in-process and forwards the visitor's cookie (Q4).
const serverFetch: typeof fetch = (input, init) => {
  const headers = new Headers(init?.headers);
  const cookie = getRequestHeader("cookie");
  if (cookie) headers.set("cookie", cookie);
  return env.BACKEND.fetch(input, { ...init, headers });
};

const transport = createIsomorphicFn()
  .client(() => FetchHttpClient.layer)
  .server(() =>
    FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch)(serverFetch))),
  );

export class BackendClient extends AtomRpc.Service<BackendClient>()("BackendClient", {
  group: BackendRpcs,
  protocol: RpcClient.layerProtocolHttp({ url: rpcUrl() }).pipe(
    Layer.provide(RpcSerialization.layerNdjson),
    Layer.provide(transport()),
  ),
}) {}

// Query atom. The serializable query is the inner atom: it is dehydrated by key and,
// on hydration, set as valid, so the browser does not refetch it (research C2).
// timeToLive keeps the primed value alive between the loader and dehydrate (C12).
// The reactivity wrapper sits outside so that Shout can still invalidate it by key.
export const helloAtom = BackendClient.query("Hello", undefined, {
  serializationKey: "hello",
  timeToLive: "1 minute",
}).pipe(Atom.withReactivity(["hello"]));

export const shoutAtom = BackendClient.mutation("Shout");
