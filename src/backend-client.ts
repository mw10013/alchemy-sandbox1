import { createIsomorphicFn } from "@tanstack/react-start";
import * as Layer from "effect/Layer";
import * as Atom from "effect/reactivity/Atom";
import * as AtomRpc from "effect/reactivity/AtomRpc";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { BackendRpcs } from "./api/backend.ts";
import { backendTransport } from "./backend-transport.ts";
import { refreshOnFocus } from "./query.ts";

/** Browser: the same-origin proxy route. SSR: any absolute URL; see `Backend`. */
const rpcUrl = createIsomorphicFn()
  .client(() => `${window.location.origin}/api/rpc`)
  .server(() => "https://backend/rpc");

/** The Backend's RPC protocol over HTTP; {@link BackendClient} and one-off calls share it. */
export const backendProtocol = RpcClient.layerProtocolHttp({ url: rpcUrl() }).pipe(
  Layer.provide(RpcSerialization.layerNdjson),
  Layer.provide(backendTransport()),
);

export class BackendClient extends AtomRpc.Service<BackendClient>()("BackendClient", {
  group: BackendRpcs,
  protocol: backendProtocol,
}) {}

/** The reference page query; see `loadQuery`. */
export const helloAtom = BackendClient.query("Hello", undefined, {
  serializationKey: "hello",
  timeToLive: "5 minutes",
}).pipe(Atom.withReactivity(["hello"]), refreshOnFocus);

export const shoutAtom = BackendClient.mutation("Shout");

/**
 * The signed-in member. Route guards read it and nothing renders it, so its idle TTL is what
 * notices a session that expired server-side: after 5 idle minutes the next guard refetches.
 * Sign-out invalidates it through the `"me"` reactivity key; sign-in is a full page load.
 */
export const meAtom = BackendClient.query("Me", undefined, {
  serializationKey: "me",
  timeToLive: "5 minutes",
}).pipe(Atom.withReactivity(["me"]));

export const requestMagicLinkAtom = BackendClient.mutation("RequestMagicLink");

export const membersAtom = BackendClient.query("ListMembers", undefined, {
  serializationKey: "members",
  timeToLive: "5 minutes",
}).pipe(Atom.withReactivity(["members"]), refreshOnFocus);
