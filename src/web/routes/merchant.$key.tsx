import { createFileRoute } from "@tanstack/react-router";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ShopKey } from "../../contract/shop.ts";
import ShopPage from "../components/ShopPage";
import { getShopSnapshot } from "../server/shop.ts";

const decodeShopKey = Schema.decodeUnknownOption(ShopKey);

/** The Shopify session token, as Shopify would hand it to an embedded app's page. */
const MerchantSearch = Schema.Struct({ token: Schema.optional(Schema.NonEmptyString) });
const decodeSearch = Schema.decodeUnknownOption(MerchantSearch);

/**
 * A merchant's shop page, without App Bridge: the Shopify session token arrives in the
 * `token` search param (test control mints one) and goes to the Backend with the loader's
 * snapshot request and on the socket URL. No Better Auth session is involved, so this route
 * sits outside `/shop`.
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
  loader: ({ params, deps }) =>
    getShopSnapshot({ data: { key: params.key, sessionToken: deps.token } }),
  component: function MerchantShopRoute() {
    const { key } = Route.useParams();
    const { token } = Route.useSearch();
    return (
      <ShopPage
        role="merchant"
        shop={key}
        merchantToken={Option.fromUndefinedOr(token)}
        data={Route.useLoaderData()}
      />
    );
  },
});
