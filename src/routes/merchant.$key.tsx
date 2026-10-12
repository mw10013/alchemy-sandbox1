import { createFileRoute } from "@tanstack/react-router";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ShopKey } from "../api/shop.ts";
import ShopPage from "../components/ShopPage";
import { loadQuery } from "../query.ts";
import { loadTicket, merchantCountAtom, merchantWhoAmIAtom } from "../shop-actor-client.ts";
import { merchantTokenAtom, shopKeyAtom } from "../ticket-client.ts";

const decodeShopKey = Schema.decodeUnknownOption(ShopKey);

/** The Shopify session token, as Shopify would hand it to an embedded app's page. */
const MerchantSearch = Schema.Struct({ token: Schema.optional(Schema.NonEmptyString) });
const decodeSearch = Schema.decodeUnknownOption(MerchantSearch);

/**
 * A merchant's shop page, without App Bridge: the Shopify session token arrives in the
 * `token` search param (test control mints one) and goes to the Backend on every ticket
 * request, on the socket URL and on server rendering's reads. No Better Auth session is
 * involved, so this route sits outside `/app`.
 */
export const Route = createFileRoute("/merchant/$key")({
  params: {
    parse: ({ key }) =>
      Option.match(decodeShopKey(key), { onNone: () => false, onSome: (key) => ({ key }) }),
    stringify: ({ key }) => ({ key }),
  },
  validateSearch: (search): typeof MerchantSearch.Type =>
    Option.getOrElse(decodeSearch(search), () => ({})),
  loaderDeps: ({ search }) => ({ token: search.token }),
  loader: async ({ context, params, deps }) => {
    context.registry.set(shopKeyAtom, params.key);
    context.registry.set(merchantTokenAtom, Option.fromUndefinedOr(deps.token));
    const ticket = await loadTicket(context.registry);
    if (Exit.isFailure(ticket)) return;
    await Promise.all([
      loadQuery(context.registry, merchantCountAtom),
      loadQuery(context.registry, merchantWhoAmIAtom),
    ]);
  },
  component: () => <ShopPage role="merchant" />,
});
