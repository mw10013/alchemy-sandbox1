import { createFileRoute } from "@tanstack/react-router";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ShopKey } from "../api/shop-actor.ts";
import ShopPage from "../components/ShopPage";
import { loadQuery } from "../query.ts";
import { activationAtom, countAtom, shopKeyAtom } from "../shop-actor-client.ts";

/** A key that does not decode is no route at all, so it is 404 and never reaches the Backend. */
const decodeShopKey = Schema.decodeUnknownOption(ShopKey);

export const Route = createFileRoute("/app/shop/$key")({
  params: {
    parse: ({ key }) =>
      Option.match(decodeShopKey(key), { onNone: () => false, onSome: (key) => ({ key }) }),
    stringify: ({ key }) => ({ key }),
  },
  loader: async ({ context, params }) => {
    context.registry.set(shopKeyAtom, params.key);
    await Promise.all([
      loadQuery(context.registry, countAtom),
      loadQuery(context.registry, activationAtom),
    ]);
  },
  component: ShopPage,
});
