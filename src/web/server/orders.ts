import { createServerFn } from "@tanstack/react-start";
import * as Schema from "effect/Schema";
import { OrdersCallFailure } from "../../contract/orders.ts";
import { OrdersListInput } from "../../contract/shop-actor.ts";
import { OrdersSyncResult, SyncOrderInput, SyncOrderResult } from "../../domain/orders.ts";
import { backend, requestInfo, rescue } from "./backend.ts";
import { embeddedSessionToken } from "./shopify.ts";

/**
 * A sync button's answer: the Backend's result, or why it could not act ({@link OrdersCallFailure}),
 * which the screen turns into a toast. A refused session token never gets here: it is App
 * Bridge's retry or the session-token bounce, as on every embedded call.
 */
export type OrdersCallAnswer<A> =
  | A
  | { readonly _tag: "Failed"; readonly reason: OrdersCallFailure["_tag"] };

const failed = (failure: OrdersCallFailure) => ({ _tag: "Failed", reason: failure._tag }) as const;

/** The document's `id_token`, for a call made in-process during SSR; see `embeddedSessionToken`. */
const idToken = { idToken: Schema.optional(Schema.NonEmptyString) };

/**
 * The orders screen's first page, for its loader. The token is only verified, never exchanged
 * (`BackendApi.listOrders`).
 */
export const listOrders = createServerFn({ method: "GET" })
  .middleware([embeddedSessionToken])
  .validator(Schema.toStandardSchemaV1(Schema.Struct({ ...idToken, ...OrdersListInput.fields })))
  .handler(({ data: { limit, cursor }, context: { sessionToken, rescueToken } }) =>
    backend().listOrders(requestInfo(), { sessionToken, limit, cursor }).catch(rescueToken),
  );

/** Sync open orders. */
export const syncOpenOrders = createServerFn({ method: "POST" })
  .middleware([embeddedSessionToken])
  .validator(Schema.toStandardSchemaV1(Schema.Struct(idToken)))
  .handler(
    ({ context: { sessionToken, rescueToken } }): Promise<OrdersCallAnswer<OrdersSyncResult>> =>
      backend()
        .syncOpenOrders(requestInfo(), { sessionToken })
        .catch(rescueToken)
        .catch(rescue(OrdersCallFailure, failed)),
  );

/** Sync from Shopify on one stored order. */
export const syncOrder = createServerFn({ method: "POST" })
  .middleware([embeddedSessionToken])
  .validator(Schema.toStandardSchemaV1(Schema.Struct({ ...idToken, ...SyncOrderInput.fields })))
  .handler(
    ({
      data: { orderId },
      context: { sessionToken, rescueToken },
    }): Promise<OrdersCallAnswer<SyncOrderResult>> =>
      backend()
        .syncOrder(requestInfo(), { sessionToken, orderId })
        .catch(rescueToken)
        .catch(rescue(OrdersCallFailure, failed)),
  );
