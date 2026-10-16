import { redirect } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Forbidden, ReturnPath, Unauthorized } from "../../contract/auth.ts";
import { NotAShopMember, ShopSnapshotInput } from "../../contract/shop.ts";
import type { ConnectionCaller, ShopSnapshot } from "../../contract/shop-actor.ts";
import { homeFor } from "../client/session.ts";
import { backend, requestInfo, rescue } from "./backend.ts";

/**
 * What a shop page renders first: the actor's snapshot and who the socket will say this browser
 * is, or why the gate refused it. `NotAMember` covers every refusal that is about this shop (no
 * `Member` row, an admin, a token for another shop); `Expired` is a merchant whose Shopify
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

const decodeReturnPath = Schema.decodeUnknownOption(ReturnPath);

/**
 * The signed-in member's shops. The `/shop` guard has already sent everyone else away; one who
 * signed out since goes to sign-in and back, and an admin to its own home.
 */
export const listMyShops = createServerFn({ method: "GET" }).handler(() =>
  backend()
    .myShops(requestInfo())
    .catch(
      rescue(Schema.Union([Unauthorized, Forbidden]), (failure) =>
        Match.valueTags(failure, {
          Unauthorized: () => {
            throw redirect({
              to: "/sign-in",
              search: { redirect: Option.getOrUndefined(decodeReturnPath("/shop")) },
            });
          },
          Forbidden: () => {
            throw redirect({ to: homeFor("admin") });
          },
        }),
      ),
    ),
);

/**
 * A member who is no longer signed in goes to sign-in and back to this shop afterwards, as the
 * `/shop` guard would send them.
 */
export const getShopSnapshot = createServerFn({ method: "GET" })
  .validator(Schema.toStandardSchemaV1(ShopSnapshotInput))
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
                  redirect: Option.getOrUndefined(decodeReturnPath(`/shop/${data.key}`)),
                },
              });
            },
            Forbidden: (): ShopPageData => ({ _tag: "NotAMember" }),
            NotAShopMember: (): ShopPageData => ({ _tag: "NotAMember" }),
          }),
        ),
      ),
  );
