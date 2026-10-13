import { redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Forbidden, NotAShopMember, ReturnPath, Unauthorized } from "../api/backend.ts";
import { ShopKey } from "../api/shop.ts";
import type { ConnectionCaller, ShopSnapshot } from "../api/shop-actor.ts";
import { backend, requestInfo, rescue } from "./backend.ts";

/**
 * What a shop page renders first: the actor's snapshot and who the socket will say this browser
 * is, or why the gate refused it. `NotAMember` covers every refusal that is about this shop (no
 * `Member` row, an operator, a token for another shop); `Expired` is a merchant whose Shopify
 * token the gate no longer accepts.
 */
export type ShopPageData =
  | {
      readonly _tag: "Snapshot";
      readonly caller: ConnectionCaller;
      readonly snapshot: ShopSnapshot;
    }
  | { readonly _tag: "NotAMember" }
  | { readonly _tag: "Expired" };

const ShopInput = Schema.Struct({ key: ShopKey, sessionToken: Schema.optional(Schema.String) });
const decodeReturnPath = Schema.decodeUnknownOption(ReturnPath);

/**
 * A member who is no longer signed in goes to sign-in and back to this shop afterwards, as the
 * `/app` guard would send them.
 */
export const getShopSnapshot = createServerFn({ method: "GET" })
  .validator(Schema.toStandardSchemaV1(ShopInput))
  .handler(({ data }): Promise<ShopPageData> =>
    backend()
      .shopSnapshot(requestInfo(), data)
      .then(({ caller, snapshot }): ShopPageData => ({ _tag: "Snapshot", caller, snapshot }))
      .catch(
        rescue(Schema.Union([Unauthorized, Forbidden, NotAShopMember]), (failure): ShopPageData =>
          Match.valueTags(failure, {
            Unauthorized: (): ShopPageData => {
              if (data.sessionToken !== undefined) return { _tag: "Expired" };
              throw redirect({
                to: "/sign-in",
                search: {
                  redirect: Option.getOrUndefined(decodeReturnPath(`/app/shop/${data.key}`)),
                },
              });
            },
            Forbidden: (): ShopPageData => ({ _tag: "NotAMember" }),
            NotAShopMember: (): ShopPageData => ({ _tag: "NotAMember" }),
          }),
        ),
      ),
  );
