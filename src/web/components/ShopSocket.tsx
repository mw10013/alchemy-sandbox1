import { RegistryContext, useAtomMount } from "@effect/atom-react";
import { useHydrated } from "@tanstack/react-router";
import type * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { type ReactNode, useContext, useState } from "react";
import type { ShopKey } from "../../contract/shop.ts";
import { nameSocket, noticesAtom } from "../client/shop-actor-client.ts";
import { SocketBanner } from "./SocketBanner.tsx";

interface SocketProps {
  readonly shop: ShopKey;
  /** How the merchant's browser mints a session token per connect; None for a member. */
  readonly merchantToken: Option.Option<Effect.Effect<string>>;
}

/**
 * The holder once hydrated: names the socket once, keeps it open, shows its banner. Rendered
 * before the pages, its siblings, so the socket is named before any page reads an atom.
 */
function LiveShopSocket(props: SocketProps) {
  const registry = useContext(RegistryContext);
  useState(() => nameSocket(registry, props.shop, props.merchantToken));
  useAtomMount(noticesAtom);
  return <SocketBanner merchant={Option.isSome(props.merchantToken)} />;
}

/**
 * The shop socket's holder: one socket per tab, held by the layout, as legacy's
 * `ShopAgentSocketProvider` is: the `/app` layout for the merchant, the member shop layout for a
 * member. It names the socket once per shop and credential (`nameSocket`), and keeps
 * `noticesAtom` mounted for as long as the layout is, which keeps the client's runtime and so the
 * socket alive across the pages under it; a page seeds and reads the socket's atoms and never
 * names it. It renders {@link SocketBanner} above its children. Before hydration it renders its
 * children alone, so no socket is built on the server; the children keep their place in the tree
 * when it hydrates.
 *
 * Legacy's keepalive ping and stale-socket watchdog are absent on purpose: Effect's RPC client
 * pings every five seconds and drops and reconnects a socket that misses a pong, and Alchemy's
 * `RpcWebSocket` answers that ping at the edge with the WebSocket auto-response, without waking
 * the actor, and owns that auto-response.
 *
 * @see refs/effect/packages/effect/src/rpc/RpcClient.ts (`makePinger`)
 * @see refs/alchemy/packages/alchemy/src/Cloudflare/Workers/RpcWebSocket.ts (`make`)
 */
export function ShopSocket(props: SocketProps & { readonly children: ReactNode }) {
  const hydrated = useHydrated();
  return (
    <>
      {hydrated && (
        <LiveShopSocket key={props.shop} shop={props.shop} merchantToken={props.merchantToken} />
      )}
      {props.children}
    </>
  );
}
