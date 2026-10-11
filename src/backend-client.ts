import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Atom from "effect/reactivity/Atom";
import * as AtomRpc from "effect/reactivity/AtomRpc";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { BackendRpcs } from "./api/backend.ts";
import { env } from "./env.server.ts";
import { refreshOnFocus } from "./query.ts";

// Browser: same-origin proxy route. SSR: any absolute URL; the service binding ignores the host.
const rpcUrl = createIsomorphicFn()
  .client(() => `${window.location.origin}/api/rpc`)
  .server(() => "https://backend/rpc");

// SSR goes through the service binding in-process and forwards the visitor's cookie.
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

// The reference page query. The pattern is documented in ./query.ts.
export const helloAtom = BackendClient.query("Hello", undefined, {
  serializationKey: "hello",
  timeToLive: "5 minutes",
}).pipe(Atom.withReactivity(["hello"]), refreshOnFocus);

export const shoutAtom = BackendClient.mutation("Shout");

// The signed-in member. Read by route guards, never rendered, so the idle TTL is what makes
// an expired session noticed: after 5 idle minutes the next guard refetches. Invalidated
// through the "me" reactivity key on sign-out. Sign-in is a full page load.
export const meAtom = BackendClient.query("Me", undefined, {
  serializationKey: "me",
  timeToLive: "5 minutes",
}).pipe(Atom.withReactivity(["me"]));

export const requestMagicLinkAtom = BackendClient.mutation("RequestMagicLink");

export const membersAtom = BackendClient.query("ListMembers", undefined, {
  serializationKey: "members",
  timeToLive: "5 minutes",
}).pipe(Atom.withReactivity(["members"]), refreshOnFocus);
