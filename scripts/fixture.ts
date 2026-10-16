#!/usr/bin/env node
/**
 * `vp run fixture`: puts this checkout's dev store into the dev fixture (`fixture.ts`). Two
 * halves run in parallel, because they write different systems and neither reads the other:
 *
 * - the store half, {@link applyStoreFixture}: the fixture's products and three real orders,
 *   written into `SHOPIFY_DEV_STORE` through Shopify CLI;
 * - the D1 and actor half: `LoadFixture` on this checkout's dev server
 *   (`http://localhost:$WEBSITE_PORT/api/dev/fixture`), which replaces the shop's members, teams,
 *   workflows and orders.
 *
 * The dev server must be running (`vp run dev`), and the app must have been opened in the store
 * once, which is what installs it on this stage. Run it again to put the shop back. Each half
 * prints one summary line, the other half's included when one fails, and either failing fails
 * the command.
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { RpcClient, RpcSerialization } from "effect/rpc";

import { fixture } from "../fixture.ts";
import { FixtureRpcs, ShopFixtureData } from "../src/contract/fixture.ts";
import { ShopKey } from "../src/contract/shop.ts";
import { applyStoreFixture, domainOf, requireFixtureStore } from "./lib/stores.ts";
import { storeNameOf } from "./lib/worktree.ts";

class FixtureError extends Schema.TaggedError<FixtureError>()("FixtureError", {
  message: Schema.String,
}) {}

const decodeShopKey = Schema.decodeUnknownEffect(ShopKey);

/** `LoadFixture` with the fixture's D1 and actor half, for `shop`, on the dev server at `url`. */
const loadData = (url: string, shop: ShopKey, store: string) =>
  Effect.gen(function* () {
    const client = yield* RpcClient.make(FixtureRpcs);
    const data: ShopFixtureData = {
      members: fixture.members,
      teams: fixture.teams,
      workflows: fixture.workflows,
      orders: fixture.orders,
    };
    return yield* client.LoadFixture({ shop, fixture: data });
  }).pipe(
    Effect.scoped,
    Effect.provide(
      RpcClient.layerProtocolHttp({ url }).pipe(
        Layer.provide(RpcSerialization.layerNdjson),
        Layer.provide(FetchHttpClient.layer),
      ),
    ),
    Effect.mapError((error) =>
      Match.value(error).pipe(
        Match.tagsExhaustive({
          ShopNotInstalled: () =>
            new FixtureError({
              message: `${shop} is not installed on this stage: open the app in ${store} first (vp run dev prints the admin URL), then run vp run fixture again`,
            }),
          RpcClientError: (error) =>
            new FixtureError({
              message: `${url} did not answer (${error.message}); is vp run dev running?`,
            }),
        }),
      ),
    ),
  );

const program = Effect.gen(function* () {
  const store = yield* Config.NonEmptyString("SHOPIFY_DEV_STORE").pipe(
    Effect.mapError(
      () => new FixtureError({ message: "SHOPIFY_DEV_STORE is not set: add it to .env" }),
    ),
  );
  const port = yield* Config.Port("WEBSITE_PORT").pipe(
    Effect.mapError(() => new FixtureError({ message: "WEBSITE_PORT is not set: add it to .env" })),
  );
  const { environment, index } = yield* requireFixtureStore(store);
  const shop = yield* decodeShopKey(domainOf(storeNameOf(environment, index))).pipe(
    Effect.mapError((error) => new FixtureError({ message: error.message })),
  );
  const url = `http://localhost:${port}/api/dev/fixture`;

  const [storeHalf, dataHalf] = yield* Effect.all(
    [applyStoreFixture(store).pipe(Effect.result), loadData(url, shop, store).pipe(Effect.result)],
    { concurrency: "unbounded" },
  );
  yield* Console.log(
    Result.match(storeHalf, {
      onSuccess: () =>
        `store  ok: ${shop} has the fixture's ${fixture.products.length} products and ${fixture.storeOrders.length} orders`,
      onFailure: (error) => `store  failed: ${error.message}`,
    }),
  );
  yield* Console.log(
    Result.match(dataHalf, {
      onSuccess: (counts) =>
        `shop   ok: ${shop} has ${counts.members} members, ${counts.teams} teams, ${counts.workflows} workflows, ${counts.orders} orders, ${counts.lineItems} line items`,
      onFailure: (error) => `shop   failed: ${error.message}`,
    }),
  );
  if (Result.isFailure(storeHalf) || Result.isFailure(dataHalf))
    return yield* new FixtureError({ message: "vp run fixture failed; see above" });
});

program.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
