import { createFileRoute } from "@tanstack/react-router";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ShopKey } from "../api/shop.ts";
import ShopPage from "../components/ShopPage";
import { loadQuery } from "../query.ts";
import { activationAtom, countAtom, loadTicket, whoAmIAtom } from "../shop-actor-client.ts";
import { merchantTokenAtom, shopKeyAtom } from "../ticket-client.ts";

/** A key that does not decode is no route at all, so it is 404 and never reaches the Backend. */
const decodeShopKey = Schema.decodeUnknownOption(ShopKey);

/**
 * A member's shop page. The ticket comes first: a member of another shop gets the page's "not a
 * member" copy and nothing else is read, because every actor read would be refused.
 */
export const Route = createFileRoute("/app/shop/$key")({
  params: {
    parse: ({ key }) =>
      Option.match(decodeShopKey(key), { onNone: () => false, onSome: (key) => ({ key }) }),
    stringify: ({ key }) => ({ key }),
  },
  loader: async ({ context, params }) => {
    context.registry.set(shopKeyAtom, params.key);
    context.registry.set(merchantTokenAtom, Option.none());
    const ticket = await loadTicket(context.registry);
    if (Exit.isFailure(ticket)) return;
    await Promise.all([
      loadQuery(context.registry, countAtom),
      loadQuery(context.registry, activationAtom),
      loadQuery(context.registry, whoAmIAtom),
    ]);
  },
  component: () => <ShopPage role="member" />,
});
