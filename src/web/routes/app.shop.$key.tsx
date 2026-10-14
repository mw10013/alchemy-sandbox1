import { createFileRoute } from "@tanstack/react-router";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ShopKey } from "../../contract/shop.ts";
import { BackLink } from "../components/screen/BackLink.tsx";
import ShopPage from "../components/ShopPage";
import { getShopSnapshot } from "../server/shop.ts";

/** A key that does not decode is no route at all, so it is 404 and never reaches the Backend. */
const decodeShopKey = Schema.decodeUnknownOption(ShopKey);

/** A member's shop page: the loader asks the Backend for the snapshot, or why not. */
export const Route = createFileRoute("/app/shop/$key")({
  params: {
    parse: ({ key }) =>
      Option.match(decodeShopKey(key), { onNone: () => false, onSome: (key) => ({ key }) }),
    stringify: ({ key }) => ({ key }),
  },
  loader: ({ params }) => getShopSnapshot({ data: { key: params.key } }),
  component: function MemberShopRoute() {
    const { key } = Route.useParams();
    return (
      <>
        <BackLink label="Member area" href="/app" />
        <ShopPage
          role="member"
          shop={key}
          merchantToken={Option.none()}
          data={Route.useLoaderData()}
        />
      </>
    );
  },
});
