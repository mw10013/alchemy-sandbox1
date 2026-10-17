/**
 * The merchant's order calls from the embedded app, shared by both sides of the binding: the
 * orders screen's first page and its two sync buttons. Each carries the session token App Bridge
 * issued, which names the shop, as `AuthenticateAdminInput` does.
 *
 * @module
 */
import * as Schema from "effect/Schema";
import { SyncOrderInput } from "../domain/orders.ts";
import { OrdersListInput } from "./shop-actor.ts";

const sessionToken = Schema.NonEmptyString;

/** `BackendApi.listOrders`' input: one page of the shop's orders. */
export const ListOrdersRequest = Schema.Struct({ sessionToken, ...OrdersListInput.fields });
export type ListOrdersRequest = typeof ListOrdersRequest.Type;

/** `BackendApi.syncOpenOrders`' input: Sync open orders. */
export const SyncOpenOrdersRequest = Schema.Struct({ sessionToken });
export type SyncOpenOrdersRequest = typeof SyncOpenOrdersRequest.Type;

/** `BackendApi.syncOrder`' input: Sync from Shopify on one stored order, by its GID. */
export const SyncOrderRequest = Schema.Struct({ sessionToken, ...SyncOrderInput.fields });
export type SyncOrderRequest = typeof SyncOrderRequest.Type;

/**
 * Why an order call could not act for a shop whose token verified, as the tag of the typed
 * failure that crossed the binding: the shop has no `ShopSession` (`ShopNotInstalled`, or
 * `OfflineSessionMissing` when the row went between two reads), only the merchant reopening the
 * app can restore access (`ReauthorizationRequired`), or Shopify could not be reached
 * (`ShopifyUnavailable`). The Website decodes the tag alone: the classes behind the last three are
 * the Backend's.
 */
export const OrdersCallFailure = Schema.Struct({
  _tag: Schema.Literals([
    "ShopNotInstalled",
    "OfflineSessionMissing",
    "ReauthorizationRequired",
    "ShopifyUnavailable",
  ]),
});
export type OrdersCallFailure = typeof OrdersCallFailure.Type;

/**
 * How far back the open-orders sync reaches. Shopify grants the last 60 days of orders
 * without `read_all_orders`, which is a Partner Dashboard access request; 30
 * leaves headroom for a clock skew or a long-running bulk operation without
 * ever touching that boundary. The number is in the button's help text, so it
 * is a promise to the merchant as well as a query term.
 */
export const ORDER_SYNC_WINDOW_DAYS = 30;
