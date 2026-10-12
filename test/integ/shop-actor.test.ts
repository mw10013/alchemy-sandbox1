import { assert } from "@effect/vitest";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Vitest";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import { RpcClient } from "effect/rpc";
import * as Schema from "effect/Schema";
import { SANDBOX_SHOP, ShopKey } from "../../src/api/shop.ts";
import {
  CONNECTION_CLOSE_DISPLACED,
  CONNECTION_CLOSE_REVOKED,
  COUNT_KEY,
  TICKET_HEADER,
} from "../../src/api/shop-actor.ts";
import {
  authOrigin,
  type Credential,
  connect,
  control,
  email,
  httpActor,
  issueTicket,
  nextCloseCode,
  signIn,
  socketUrl,
  upgradeStatus,
} from "./actor-clients.ts";
import Stack from "./stack.ts";

/**
 * Deploys the Backend with `ShopActor` into workerd and drives the actor as browsers do,
 * straight at the Backend (no Website or Vite in front): sockets that bind with a ticket on
 * their first call, the gate on the upgrade and on `IssueActorTicket`, the role split, and
 * revocation and displacement closing the right sockets.
 */
const { test, beforeAll, deploy } = Test.make({
  providers: Cloudflare.providers(),
});

/** Never destroyed; see the same declaration in `auth.test.ts`. */
const stack = beforeAll(deploy(Stack));

const key = SANDBOX_SHOP;
const otherShop = Schema.decodeUnknownSync(ShopKey)("other-shop.myshopify.com");
const m1 = email("m1@m.com");
const m2 = email("m2@m.com");

/**
 * A browser's connect: a ticket from `IssueActorTicket` with the browser's credential, a
 * socket through the gate, and a first call that carries the ticket and binds the socket.
 */
const open = (backendUrl: string, credential: Credential) =>
  Effect.gen(function* () {
    const ticket = yield* issueTicket(backendUrl, key, credential);
    const socket = yield* connect(socketUrl(backendUrl, key, credential), credential);
    yield* "cookie" in credential
      ? socket.bind(ticket, socket.client.MemberWhoAmI())
      : socket.bind(ticket, socket.client.MerchantWhoAmI());
    return socket;
  });

/** A merchant's Shopify session token for a shop, minted as Shopify would. */
const merchantToken = (backendUrl: string, e2eToken: string, shop: ShopKey = key) =>
  control(backendUrl, e2eToken, (c) => c.IssueMerchantSessionToken({ shop })).pipe(
    Effect.map(({ token }) => token),
  );

/** No close arrives within a moment. */
const assertOpen = (closes: Queue.Dequeue<unknown>) =>
  Effect.gen(function* () {
    yield* Effect.sleep("500 millis");
    assert.isTrue(Option.isNone(yield* Queue.poll(closes)), "the socket stayed open");
  });

test(
  "two sockets share one actor: a write on one notifies both",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    const cookie = yield* signIn(backendUrl, m1);
    yield* Effect.gen(function* () {
      const a = yield* open(backendUrl, { cookie });
      const b = yield* open(backendUrl, { cookie });
      const before = yield* a.client.MemberGetCount();
      const after = yield* a.client.MemberIncrement();
      assert.strictEqual(after.value, before.value + 1);

      const notice = yield* PubSub.take(b.received).pipe(Effect.timeout("5 seconds"));
      assert.deepStrictEqual(notice, { _tag: "ShopActorNotice", invalidated: [COUNT_KEY] });
      assert.deepStrictEqual(yield* b.client.MemberGetCount(), after);
    }).pipe(Effect.scoped);
  }),
);

test(
  "roles: a merchant resets and a member may not; a member increments and a merchant may not",
  Effect.gen(function* () {
    const { backendUrl, e2eToken } = yield* stack;
    const cookie = yield* signIn(backendUrl, m1);
    const token = yield* merchantToken(backendUrl, e2eToken);
    yield* Effect.gen(function* () {
      const merchant = yield* open(backendUrl, { token });
      const member = yield* open(backendUrl, { cookie });
      assert.deepStrictEqual(yield* merchant.client.MerchantWhoAmI(), { role: "merchant" });
      assert.deepStrictEqual(yield* merchant.client.MerchantResetCount(), { value: 0 });
      for (const error of [
        yield* member.client.MerchantResetCount().pipe(Effect.flip),
        yield* member.client.MerchantGetCount().pipe(Effect.flip),
        yield* merchant.client.MemberIncrement().pipe(Effect.flip),
      ])
        assert.strictEqual(error._tag, "Forbidden");

      // The same split over HTTP through the Backend, as server rendering reads it.
      const asMerchant = yield* httpActor(backendUrl, key, { token });
      const asMember = yield* httpActor(backendUrl, key, { cookie });
      assert.deepStrictEqual(yield* asMerchant.MerchantResetCount(), { value: 0 });
      for (const error of [
        yield* asMember.MerchantResetCount().pipe(Effect.flip),
        yield* asMember.MerchantGetCount().pipe(Effect.flip),
        yield* asMerchant.MemberIncrement().pipe(Effect.flip),
      ])
        assert.strictEqual(error._tag, "Forbidden");
    }).pipe(Effect.scoped);
  }),
);

test(
  "binding: no ticket and a tampered ticket fail Unauthorized and leave the socket open",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    const cookie = yield* signIn(backendUrl, m1);
    yield* Effect.gen(function* () {
      const socket = yield* connect(socketUrl(backendUrl, key), { cookie });
      const none = yield* socket.client.MemberWhoAmI().pipe(Effect.flip);
      assert.strictEqual(none._tag, "Unauthorized");
      const ticket = yield* issueTicket(backendUrl, key, { cookie });
      const tampered = yield* socket.client
        .MemberWhoAmI()
        .pipe(RpcClient.withHeaders({ [TICKET_HEADER]: `${ticket}x` }), Effect.flip);
      assert.strictEqual(tampered._tag, "Unauthorized");
      yield* assertOpen(socket.closes);
      const bound = yield* socket.bind(ticket, socket.client.MemberWhoAmI());
      assert.strictEqual(bound.role, "member");
    }).pipe(Effect.scoped);
  }),
);

test(
  "sign-out closes only that session's sockets with 3401",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    const first = yield* signIn(backendUrl, m1);
    const second = yield* signIn(backendUrl, m1);
    yield* Effect.gen(function* () {
      const a = yield* open(backendUrl, { cookie: first });
      const b = yield* open(backendUrl, { cookie: second });
      const origin = yield* authOrigin(backendUrl, m1);
      const signOut = yield* HttpClient.execute(
        HttpClientRequest.post(`${backendUrl}/api/auth/sign-out`).pipe(
          HttpClientRequest.setHeaders({ cookie: first, origin }),
          HttpClientRequest.bodyJsonUnsafe({}),
        ),
      ).pipe(Effect.provide(FetchHttpClient.layer));
      assert.strictEqual(signOut.status, 200);
      assert.strictEqual(yield* nextCloseCode(a.closes), CONNECTION_CLOSE_REVOKED);
      assert.strictEqual((yield* b.client.MemberWhoAmI()).role, "member");
      yield* assertOpen(b.closes);
    }).pipe(Effect.scoped);
  }),
);

test(
  "RemoveMember closes the member's sockets with 3401 and the gate then refuses it",
  Effect.gen(function* () {
    const { backendUrl, e2eToken } = yield* stack;
    const removed = email("integ-removed@e2e.test");
    yield* control(backendUrl, e2eToken, (c) =>
      c.AddMember({ shop: key, email: removed }).pipe(Effect.ignore),
    );
    const cookie = yield* signIn(backendUrl, removed);
    const other = yield* signIn(backendUrl, m2);
    yield* Effect.gen(function* () {
      const a = yield* open(backendUrl, { cookie });
      const b = yield* open(backendUrl, { cookie: other });
      const result = yield* control(backendUrl, e2eToken, (c) =>
        c.RemoveMember({ shop: key, email: removed }),
      );
      assert.deepStrictEqual(result, { removed: true, closed: 1 });
      assert.strictEqual(yield* nextCloseCode(a.closes), CONNECTION_CLOSE_REVOKED);
      assert.strictEqual((yield* b.client.MemberWhoAmI()).role, "member");
      const refused = yield* issueTicket(backendUrl, key, { cookie }).pipe(Effect.flip);
      assert.strictEqual(refused._tag, "NotAShopMember");

      yield* control(backendUrl, e2eToken, (c) => c.AddMember({ shop: key, email: removed }));
      yield* issueTicket(backendUrl, key, { cookie });
    }).pipe(Effect.scoped);
  }),
);

test(
  "a member's third socket displaces the oldest with 4409; merchants are not capped",
  Effect.gen(function* () {
    const { backendUrl, e2eToken } = yield* stack;
    const cookie = yield* signIn(backendUrl, m1);
    const token = yield* merchantToken(backendUrl, e2eToken);
    yield* Effect.gen(function* () {
      const a = yield* open(backendUrl, { cookie });
      const b = yield* open(backendUrl, { cookie });
      const c = yield* open(backendUrl, { cookie });
      assert.strictEqual(yield* nextCloseCode(a.closes), CONNECTION_CLOSE_DISPLACED);
      assert.strictEqual((yield* b.client.MemberWhoAmI()).role, "member");
      assert.strictEqual((yield* c.client.MemberWhoAmI()).role, "member");
      yield* assertOpen(b.closes);

      const merchants = [
        yield* open(backendUrl, { token }),
        yield* open(backendUrl, { token }),
        yield* open(backendUrl, { token }),
      ];
      for (const merchant of merchants) {
        assert.deepStrictEqual(yield* merchant.client.MerchantWhoAmI(), { role: "merchant" });
        yield* assertOpen(merchant.closes);
      }
    }).pipe(Effect.scoped);
  }),
);

test(
  "a socket whose session has expired fails Unauthorized and closes with 3401",
  Effect.gen(function* () {
    const { backendUrl, e2eToken } = yield* stack;
    const cookie = yield* signIn(backendUrl, m1);
    yield* Effect.gen(function* () {
      const { ticket } = yield* control(backendUrl, e2eToken, (c) =>
        c.IssueActorTicketAs({
          shop: key,
          caller: {
            role: "member",
            memberId: "mem-1",
            memberEmail: m1,
            teamIds: [],
            userId: "user-expired",
            sessionId: "session-expired",
            sessionExpiresAt: Date.now() - 1,
          },
        }),
      );
      const socket = yield* connect(socketUrl(backendUrl, key), { cookie });
      const error = yield* socket.bind(ticket, socket.client.MemberWhoAmI()).pipe(Effect.flip);
      assert.strictEqual(error._tag, "Unauthorized");
      assert.strictEqual(yield* nextCloseCode(socket.closes), CONNECTION_CLOSE_REVOKED);
    }).pipe(Effect.scoped);
  }),
);

test(
  "the gate: 401, 403, 404 on the upgrade, and the same answers from IssueActorTicket",
  Effect.gen(function* () {
    const { backendUrl, e2eToken } = yield* stack;
    // The operator's user row comes from ResetData; see `TestData`.
    yield* control(backendUrl, e2eToken, (c) => c.ResetData());
    const operator = yield* signIn(backendUrl, email("a@a.com"));
    const member2 = yield* signIn(backendUrl, m2);
    const otherShopToken = yield* merchantToken(backendUrl, e2eToken, otherShop);
    const at = (shop: ShopKey, query = "") => `${backendUrl}/api/actor/${shop}${query}`;

    assert.strictEqual(yield* upgradeStatus(at(key)), 401, "no session");
    assert.strictEqual(yield* upgradeStatus(at(key), { cookie: operator }), 403, "operator");
    assert.strictEqual(
      yield* upgradeStatus(at(otherShop), { cookie: member2 }),
      404,
      "not a member of that shop",
    );
    assert.strictEqual(
      yield* upgradeStatus(at(key, `?token=${otherShopToken}`)),
      403,
      "a token for another shop",
    );
    assert.strictEqual(yield* upgradeStatus(at(key, "?token=bad")), 401, "a bad token");

    const ticketError = (shop: ShopKey, credential: Credential | { readonly none: true }) =>
      ("none" in credential
        ? issueTicket(backendUrl, shop, { cookie: "" })
        : issueTicket(backendUrl, shop, credential)
      ).pipe(
        Effect.flip,
        Effect.map((error) => error._tag),
      );
    assert.strictEqual(yield* ticketError(key, { none: true }), "Unauthorized");
    assert.strictEqual(yield* ticketError(key, { cookie: operator }), "NotAShopMember");
    assert.strictEqual(yield* ticketError(otherShop, { cookie: member2 }), "NotAShopMember");
    assert.strictEqual(yield* ticketError(key, { token: otherShopToken }), "NotAShopMember");
    assert.strictEqual(yield* ticketError(key, { token: "bad" }), "Unauthorized");
  }),
);

test(
  "a path under /api/actor/ that names no key is 404",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    const response = yield* HttpClient.get(`${backendUrl}/api/actor/NOT-A-KEY`);
    assert.strictEqual(response.status, 404);
  }).pipe(Effect.provide(FetchHttpClient.layer)),
);
