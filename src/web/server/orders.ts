import { createServerFn } from "@tanstack/react-start";
import * as Schema from "effect/Schema";
import { OrdersListInput } from "../../contract/shop-actor.ts";
import { backend, requestInfo } from "./backend.ts";
import { embeddedSessionToken } from "./shopify.ts";

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
