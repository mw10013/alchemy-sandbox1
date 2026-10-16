/**
 * Putting this checkout's dev store into the dev fixture (`fixture.ts`), for `vp run fixture` and
 * `vp run db:reset`. Two halves run in parallel, because they write different systems and neither
 * reads the other:
 *
 * - the store half, {@link applyStoreFixture}: the fixture's products and three real orders,
 *   written into `SHOPIFY_DEV_STORE` through Shopify CLI;
 * - the D1 and actor half: `LoadFixture` on this checkout's dev server
 *   (`http://localhost:$WEBSITE_PORT/api/dev/fixture`), which replaces the shop's members, teams,
 *   workflows and orders.
 *
 * @module
 */
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { RpcClient, RpcSerialization } from "effect/rpc";

import { fixture } from "../../fixture.ts";
import { FixtureRpcs, ShopFixtureData } from "../../src/contract/fixture.ts";
import { ShopKey } from "../../src/contract/shop.ts";
import { applyStoreFixture, domainOf, requireFixtureStore } from "./stores.ts";
import { storeNameOf } from "./worktree.ts";

export class FixtureError extends Schema.TaggedError<FixtureError>()("FixtureError", {
  message: Schema.String,
}) {}

const decodeShopKey = Schema.decodeUnknownEffect(ShopKey);

/**
 * How long {@link applyFixture} waits for the shop to be installed when asked to: long enough for
 * Shopify CLI to point the app at its tunnel and for a browser to load the app once.
 */
const INSTALL_WAIT = Duration.minutes(3);

/** `LoadFixture` with the fixture's D1 and actor half, for `shop`, on the dev server at `url`. */
const loadData = (url: string, shop: ShopKey) =>
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
  );

/**
 * Applies the dev fixture to `SHOPIFY_DEV_STORE` and prints one summary line per half; either half
 * failing fails it, after both lines are printed.
 *
 * The shop half needs the shop's `ShopSession`, which only an embedded load writes. With
 * `waitForInstall`, a shop that is not installed yet is asked again every two seconds, up to
 * {@link INSTALL_WAIT}, for a caller that has just opened the app in a browser; without it, it
 * fails at once with what to do.
 */
export const applyFixture = Effect.fn("applyFixture")(function* (options: {
  readonly waitForInstall: boolean;
}) {
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

  const shopHalf = loadData(url, shop).pipe(
    options.waitForInstall
      ? Effect.retry({
          while: (error) => error._tag === "ShopNotInstalled",
          schedule: Schedule.spaced("2 seconds").pipe(
            Schedule.upTo({ duration: INSTALL_WAIT }),
            Schedule.tap(({ attempt }) =>
              attempt === 1
                ? Console.log(`wait  ${shop} is not installed yet: waiting for the app to load`)
                : Effect.void,
            ),
          ),
        })
      : (effect) => effect,
    Effect.mapError((error) =>
      Match.value(error).pipe(
        Match.tagsExhaustive({
          ShopNotInstalled: () =>
            new FixtureError({
              message: `${shop} is not installed on this stage: open the app in ${store} first (vp run dev:status prints its URL), then run vp run fixture`,
            }),
          RpcClientError: (error) =>
            new FixtureError({
              message: `${url} did not answer (${error.message}); is vp run dev running?`,
            }),
        }),
      ),
    ),
  );

  const [storeHalf, dataHalf] = yield* Effect.all(
    [applyStoreFixture(store).pipe(Effect.result), shopHalf.pipe(Effect.result)],
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
    return yield* new FixtureError({ message: "the fixture failed; see above" });
});
