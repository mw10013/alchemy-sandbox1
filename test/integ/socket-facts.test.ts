import { assert } from "@effect/vitest";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Vitest";
import * as Effect from "effect/Effect";
import { RpcClient } from "effect/rpc";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { ShopKey } from "../../src/api/shop.ts";
import {
  CALLER_HEADER,
  CONNECTION_CLOSE_REVOKED,
  type MemberCaller,
} from "../../src/api/shop-actor.ts";
import {
  connect,
  control,
  email,
  httpActor,
  issueTicket,
  nextCloseCode,
  signIn,
  socketUrl,
} from "./actor-clients.ts";
import Stack from "./stack.ts";

/**
 * The three platform facts the actor's socket identity rests on, proved in workerd: the
 * actor's key in a socket's attachment survives Alchemy's own writes and a hibernation; a
 * socket closed from the actor's code with a custom code leaves Alchemy's transport clean;
 * and `HttpServerRequest` is in a call's context on the HTTP path and absent on the socket,
 * which is how the actor tells the Backend's calls from a browser's.
 */
const { test, beforeAll, deploy } = Test.make({
  providers: Cloudflare.providers(),
});

/** Never destroyed; see the same declaration in `auth.test.ts`. */
const stack = beforeAll(deploy(Stack));

/** A seeded shop of its own, where `m1@m.com` is `mem-3`, so no other file shares its actor. */
const key = Schema.decodeUnknownSync(ShopKey)("other-shop.myshopify.com");
const m1 = email("m1@m.com");

/** A member identity no sign-in produces, for test control's `IssueActorTicketAs`. */
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
  "0.1 a socket's identity survives Alchemy's writes and a hibernation with no ticket resent",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    const cookie = yield* signIn(backendUrl, m1);
    yield* Effect.gen(function* () {
      const a = yield* connect(socketUrl(backendUrl, key), { cookie });
      const ticket = yield* issueTicket(backendUrl, key, { cookie });
      const bound = yield* a.bind(ticket, a.client.MemberWhoAmI());
      assert.strictEqual(bound.role, "member");
      assert.deepStrictEqual(yield* a.client.MemberWhoAmI(), bound);
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
      assert.deepStrictEqual(yield* a.client.MemberWhoAmI(), bound);
    }).pipe(Effect.scoped);
  }),
  { timeout: 90_000 },
);

test(
  "0.2 a socket the actor closes with 3401 leaves the transport and the object clean",
  Effect.gen(function* () {
    const { backendUrl, e2eToken } = yield* stack;
    const url = socketUrl(backendUrl, key);
    // The upgrade still passes the gate as `m1`; the ticket alone decides who binds.
    const cookie = yield* signIn(backendUrl, m1);
    const ticketAs = (caller: MemberCaller) =>
      control(backendUrl, e2eToken, (c) => c.IssueActorTicketAs({ shop: key, caller })).pipe(
        Effect.map(({ ticket }) => ticket),
      );
    yield* Effect.gen(function* () {
      const a = yield* connect(url, { cookie });
      const b = yield* connect(url, { cookie });
      const live = memberAs("facts-b", Date.now() + 600_000);
      yield* b.bind(yield* ticketAs(live), b.client.MemberWhoAmI());
      const before = yield* b.client.MemberActivation();

      // An expired session is closed by the actor after the failure is written.
      const expired = yield* a
        .bind(yield* ticketAs(memberAs("facts-a", Date.now() - 1)), a.client.MemberWhoAmI())
        .pipe(Effect.flip);
      assert.strictEqual(expired._tag, "Unauthorized");
      assert.strictEqual(yield* nextCloseCode(a.closes), CONNECTION_CLOSE_REVOKED);

      const count = yield* b.client.MemberIncrement();
      assert.deepStrictEqual(yield* b.client.MemberGetCount(), count);
      // `a` reconnects on its retry policy, unbound, and binds again.
      const again = yield* ticketAs(memberAs("facts-a", Date.now() + 600_000));
      yield* a
        .bind(again, a.client.MemberWhoAmI())
        .pipe(Effect.retry(Schedule.spaced("200 millis")), Effect.timeout("5 seconds"));
      const c = yield* connect(url, { cookie });
      const third = memberAs("facts-c", Date.now() + 600_000);
      yield* c.bind(yield* ticketAs(third), c.client.MemberWhoAmI());
      assert.strictEqual((yield* c.client.MemberActivation()).id, before.id, "no reset");
    }).pipe(Effect.scoped);
  }),
);

test(
  "0.3 HttpServerRequest marks the HTTP path: a header names the caller there and nowhere else",
  Effect.gen(function* () {
    const { backendUrl, e2eToken } = yield* stack;
    const cookie = yield* signIn(backendUrl, m1);
    yield* Effect.gen(function* () {
      const socket = yield* connect(socketUrl(backendUrl, key), { cookie });
      const ticket = yield* issueTicket(backendUrl, key, { cookie });
      yield* socket.bind(ticket, socket.client.MemberWhoAmI());
      const system = RpcClient.withHeaders({
        [CALLER_HEADER]: JSON.stringify({ role: "system" }),
      });
      const onSocket = yield* socket.client.MemberWhoAmI().pipe(system);
      assert.strictEqual(onSocket.role, "member", "a header on the socket names no one");
      const revoke = yield* socket.client
        .SystemRevoke({ by: "member", id: "mem-3" })
        .pipe(system, Effect.flip);
      assert.strictEqual(revoke._tag, "Forbidden");

      // Forwarded by the Backend's gate, which sets the caller header itself.
      const http = yield* httpActor(backendUrl, key, { cookie });
      assert.deepStrictEqual(yield* http.MemberWhoAmI(), onSocket);

      // The Backend's stub: `RemoveMember` calls `SystemRevoke` as the system caller and dies
      // if the actor refuses it, so an answer at all proves the role arrived.
      const added = email("facts-stub@e2e.test");
      // A failed earlier run may have left the row; the stack is never reset between runs.
      yield* control(backendUrl, e2eToken, (c) =>
        c.AddMember({ shop: key, email: added }).pipe(Effect.ignore),
      );
      const removed = yield* control(backendUrl, e2eToken, (c) =>
        c.RemoveMember({ shop: key, email: added }),
      );
      assert.deepStrictEqual(removed, { removed: true, closed: 0 });
    }).pipe(Effect.scoped);
  }),
);
