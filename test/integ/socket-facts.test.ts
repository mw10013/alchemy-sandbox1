import { assert } from "@effect/vitest";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Vitest";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { ShopKey } from "../../src/contract/shop.ts";
import { CONNECTION_CLOSE_REVOKED, type MemberCaller } from "../../src/contract/shop-actor.ts";
import { control, email, nextCloseCode, openAs } from "./actor-clients.ts";
import Stack from "./stack.ts";

/**
 * The platform facts the actor's socket identity rests on, proved in workerd: the identity and
 * tags a socket is accepted with survive Alchemy's own attachment writes and a hibernation, the
 * identity reaches the RPC middleware on every message, and a socket closed before its message
 * is dispatched leaves Alchemy's transport and the object clean.
 */
const { test, beforeAll, deploy } = Test.make({
  providers: Cloudflare.providers(),
});

/** Never destroyed; see the same declaration in `auth.test.ts`. */
const stack = beforeAll(deploy(Stack));

/** A seeded shop of its own, so no other file shares its actor. */
const key = Schema.decodeUnknownSync(ShopKey)("other-shop.myshopify.com");

/** A member identity no sign-in produces, for test control's upgrade route. */
const memberAs = (memberId: string, sessionExpiresAt: number): MemberCaller => ({
  role: "member",
  memberId,
  memberEmail: email(`${memberId}@e2e.test`),
  teamIds: [],
  userId: `user-${memberId}`,
  sessionId: `session-${memberId}`,
  sessionExpiresAt,
});

test(
  "a socket's identity and tags survive Alchemy's writes and a hibernation",
  Effect.gen(function* () {
    const { backendUrl, e2eToken } = yield* stack;
    const address = email("facts-hibernate@e2e.test");
    // A failed earlier run may have left the row; the stack is never reset between runs.
    yield* control(backendUrl, e2eToken, (c) =>
      c.RemoveMember({ shop: key, email: address }).pipe(Effect.ignore),
    );
    const added = yield* control(backendUrl, e2eToken, (c) =>
      c.AddMember({ shop: key, email: address }),
    );
    yield* Effect.gen(function* () {
      const caller = { ...memberAs(added.id, Date.now() + 600_000), memberEmail: address };
      const a = yield* openAs(backendUrl, e2eToken, key, caller);
      // Every call goes through the middleware that dies without the socket's identity.
      assert.deepStrictEqual(yield* a.client.MemberWhoAmI(), caller);
      const first = yield* a.client.MemberActivation();
      // Each call is an event that keeps the object awake, and local workerd evicts an idle
      // one after about 10 s, so the polls are spaced wider than that. The clients' pings are
      // answered by the auto-response and do not wake it.
      const later = yield* a.client.MemberActivation().pipe(
        Effect.repeat({
          schedule: Schedule.spaced("12 seconds"),
          until: (activation) => activation.id !== first.id,
          times: 5,
        }),
      );
      assert.notStrictEqual(later.id, first.id, "the actor hibernated");
      assert.deepStrictEqual(yield* a.client.MemberWhoAmI(), caller, "the attachment survived");
      // A revoke selects sockets by the `member:<id>` tag, so a close proves the tag survived.
      const removed = yield* control(backendUrl, e2eToken, (c) =>
        c.RemoveMember({ shop: key, email: address }),
      );
      assert.deepStrictEqual(removed, { removed: true, closed: 1 });
      assert.strictEqual(yield* nextCloseCode(a.closes), CONNECTION_CLOSE_REVOKED);
    }).pipe(Effect.scoped);
  }),
  { timeout: 90_000 },
);

test(
  "a socket closed before its message is dispatched leaves the transport and the object clean",
  Effect.gen(function* () {
    const { backendUrl, e2eToken } = yield* stack;
    yield* Effect.gen(function* () {
      const b = yield* openAs(backendUrl, e2eToken, key, memberAs("facts-b", Date.now() + 600_000));
      const before = yield* b.client.MemberActivation();

      const a = yield* openAs(backendUrl, e2eToken, key, memberAs("facts-a", Date.now() - 1));
      // The message is never dispatched, so the call has no answer; only the close arrives.
      yield* a.client.MemberWhoAmI().pipe(Effect.forkScoped);
      assert.strictEqual(yield* nextCloseCode(a.closes), CONNECTION_CLOSE_REVOKED);

      const count = yield* b.client.MemberIncrement();
      assert.deepStrictEqual(yield* b.client.MemberGetCount(), count);
      assert.strictEqual((yield* b.client.MemberActivation()).id, before.id, "no reset");
      const c = yield* openAs(backendUrl, e2eToken, key, memberAs("facts-c", Date.now() + 600_000));
      assert.strictEqual(
        (yield* c.client.MemberActivation()).id,
        before.id,
        "a new socket is served",
      );
    }).pipe(Effect.scoped);
  }),
);
