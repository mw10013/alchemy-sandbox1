import { createFileRoute } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { ShopKey } from "../../contract/shop.ts";
import { mintSessionToken } from "../client/app-bridge.ts";
import { ORDERS_PAGE_SIZE } from "../client/shop-actor-client.ts";
import OrdersPage, { type OrdersActions } from "../components/OrdersPage.tsx";
import { listOrders, syncOpenOrders, syncOrder } from "../server/orders.ts";
import { appSearch } from "./-app-search.ts";

/**
 * The screen's presses as the server functions; from the browser, App Bridge's bearer is the
 * session token.
 */
const actions: OrdersActions = {
  syncOpenOrders: () => syncOpenOrders({ data: {} }),
  syncOrder: (orderId) => syncOrder({ data: { orderId } }),
};

/**
 * The merchant's orders screen under the App Home, whose guards have already run. The loader
 * reads the first page; during SSR its session token is the document's `id_token`, in the
 * browser App Bridge's bearer.
 */
export const Route = createFileRoute("/app/orders")({
  loader: ({ location }) =>
    listOrders({
      data: {
        idToken: appSearch(location.searchStr).id_token,
        limit: ORDERS_PAGE_SIZE,
        cursor: null,
      },
    }),
  component: function OrdersRoute() {
    const { shop } = Route.useRouteContext();
    const key = Schema.decodeUnknownSync(ShopKey)(shop);
    return (
      <OrdersPage
        shop={key}
        page={Route.useLoaderData()}
        merchantToken={mintSessionToken}
        actions={actions}
      />
    );
  },
});
