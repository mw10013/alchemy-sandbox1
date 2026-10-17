import { createFileRoute, Outlet } from "@tanstack/react-router";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ShopKey } from "../../contract/shop.ts";
import { ShopSocket } from "../components/ShopSocket.tsx";
import { getShopSnapshot } from "../server/shop.ts";

/** A key that does not decode is no route at all, so it is 404 and never reaches the Backend. */
const decodeShopKey = Schema.decodeUnknownOption(ShopKey);

/**
 * A member's shop: the layout of every page under `/shop/$key`. The loader asks the Backend for
 * the snapshot, or why not; with a snapshot the layout holds the member's socket
 * ({@link ShopSocket}) for the pages under it, and with a refusal it opens none, since the page
 * shows the refusal and nothing else.
 */
export const Route = createFileRoute("/shop/$key")({
  params: {
    parse: ({ key }) =>
      Option.match(decodeShopKey(key), { onNone: () => false, onSome: (key) => ({ key }) }),
    stringify: ({ key }) => ({ key }),
  },
  loader: ({ params }) => getShopSnapshot({ data: { key: params.key } }),
  component: function MemberShopLayout() {
    const { key } = Route.useParams();
    return Route.useLoaderData()._tag === "Snapshot" ? (
      <ShopSocket shop={key} merchantToken={Option.none()}>
        <Outlet />
      </ShopSocket>
    ) : (
      <Outlet />
    );
  },
});
