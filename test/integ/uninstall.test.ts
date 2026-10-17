import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { assert } from "@effect/vitest";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Vitest";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { CONNECTION_CLOSE_UNINSTALLED } from "../../src/contract/shop-actor.ts";
import { SEED_SHOP } from "../seed-shops.ts";
import { signWebhook } from "../shopify-webhook.ts";
import { dev, email, integ, nextCloseCode, openAs, storeByWebhook } from "./actor-clients.ts";
import { fileStage } from "./file-stage.ts";
import Stack from "./stack.ts";

/**
 * `app/uninstalled` against the real Backend, D1 and actor, on a stage of its own so the shop it
 * tears down is no other file's: the session and its cascade go, the actor's sockets close
 * terminally, its storage goes, and a later delivery does not bring the actor back. Local
 * workerd writes storage synchronously, so this cannot show a delete lost to a reset before
 * `storage.sync()`; only staging can.
 */
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  stage: fileStage("uninstall"),
});

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

/** POSTs a signed `topic` delivery of `payload` for {@link SEED_SHOP}; the status. */
const deliver = (backendUrl: string, path: string, topic: string, payload: unknown) =>
  Effect.gen(function* () {
    const body = JSON.stringify(payload);
    const response = yield* HttpClient.execute(
      HttpClientRequest.post(`${backendUrl}${path}`).pipe(
        HttpClientRequest.setHeaders(yield* signWebhook(topic, SEED_SHOP, body)),
        HttpClientRequest.bodyText(body, "application/json"),
      ),
    );
    return response.status;
  }).pipe(Effect.provide(FetchHttpClient.layer));

/**
 * Every file of the actors' local storage on this file's stage, by name, with its size and
 * modification time: one SQLite database per actor beside `metadata.sqlite`, under the directory
 * Alchemy names after the script and the class. An actor's file is named after the actor, so a
 * recreated actor reuses it; what shows a recreation is the write its migration makes.
 */
const actorStorage = (backendName: string) => {
  const directory = join(".alchemy", "local", `${backendName}-ShopActor`);
  return Object.fromEntries(
    readdirSync(directory).map((file) => {
      const { size, mtimeMs } = statSync(join(directory, file));
      return [file, `${String(size)}@${String(mtimeMs)}`];
    }),
  );
};

const ORDER_ID = "gid://shopify/Order/1";

/**
 * `GetOrder` goes last: it reaches the actor by name, which creates it again, so it shows only
 * that the storage went (the recreated actor is empty). Before it, the late `orders/create`
 * leaves the storage files untouched and calls no Shopify, so it created nothing; that
 * `GetOrder` then does change them is the control that the files would show a recreation.
 */
test(
  "uninstall deletes the shop row, its members and teams, and destroys the object",
  Effect.gen(function* () {
    const { backendUrl, backendName } = yield* stack;
    yield* storeByWebhook(
      backendUrl,
      SEED_SHOP,
      {
        id: ORDER_ID,
        legacyResourceId: "1",
        name: "#1001",
        processedAt: Date.now() - 60_000,
        updatedAt: Date.now() - 60_000,
        cancelledAt: null,
        displayFulfillmentStatus: "UNFULFILLED",
        fullyPaid: true,
        note: null,
      },
      [],
    );
    assert.isNotNull(
      yield* integ(backendUrl, (c) => c.GetOrder({ shop: SEED_SHOP, orderId: ORDER_ID })),
    );
    const before = yield* integ(backendUrl, (c) => c.ShopIdentityNames({ shop: SEED_SHOP }));
    assert.isNotEmpty(before.emails);
    assert.isNotEmpty(before.teams);

    yield* Effect.gen(function* () {
      const socket = yield* openAs(backendUrl, SEED_SHOP, {
        role: "member",
        memberId: "mem-1",
        memberEmail: email("m1@m.com"),
        teamIds: [],
        userId: "user-1",
        sessionId: "session-1",
        sessionExpiresAt: Date.now() + 60_000,
      });
      yield* socket.client.MemberWhoAmI();
      assert.strictEqual(
        yield* deliver(backendUrl, "/webhooks/app/uninstalled", "app/uninstalled", {
          id: 1,
          domain: SEED_SHOP,
        }),
        200,
      );
      assert.strictEqual(yield* nextCloseCode(socket.closes), CONNECTION_CLOSE_UNINSTALLED);
    }).pipe(Effect.scoped);

    assert.isNull(yield* dev(backendUrl, (c) => c.GetShopSession({ shop: SEED_SHOP })));
    assert.deepStrictEqual(
      yield* integ(backendUrl, (c) => c.ShopIdentityNames({ shop: SEED_SHOP })),
      { emails: [], teams: [] },
    );
    const afterUninstall = actorStorage(backendName);

    yield* integ(backendUrl, (c) => c.ScriptShopify({ replies: [] }));
    assert.strictEqual(
      yield* deliver(backendUrl, "/webhooks/orders", "orders/create", {
        id: 2,
        admin_graphql_api_id: "gid://shopify/Order/2",
        updated_at: new Date().toISOString(),
      }),
      200,
    );
    assert.deepStrictEqual(yield* integ(backendUrl, (c) => c.ShopifyCalls({})), []);
    assert.deepStrictEqual(actorStorage(backendName), afterUninstall);

    assert.isNull(
      yield* integ(backendUrl, (c) => c.GetOrder({ shop: SEED_SHOP, orderId: ORDER_ID })),
    );
    assert.notDeepEqual(actorStorage(backendName), afterUninstall);
  }),
);
