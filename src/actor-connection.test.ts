import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import * as Schedule from "effect/Schedule";
import * as Socket from "effect/socket/Socket";
import {
  applyCloseOutcome,
  closeOutcome,
  connectionStateAtom,
  merchantExpiredAtom,
  notAMemberAtom,
  retryPolicy,
} from "./actor-connection.ts";
import {
  CONNECTION_CLOSE_DISPLACED,
  CONNECTION_CLOSE_FORBIDDEN,
  CONNECTION_CLOSE_NOT_A_MEMBER,
  CONNECTION_CLOSE_REVOKED,
  CONNECTION_CLOSE_TRY_AGAIN,
  CONNECTION_CLOSE_UNAUTHENTICATED,
} from "./api/shop-actor.ts";

const closed = (code: number) =>
  new Socket.SocketError({ reason: new Socket.SocketCloseError({ code }) });

/** Whether the policy continues after one input, stepped directly (no time passes). */
const continuesAfter = (error: Socket.SocketError) =>
  Effect.gen(function* () {
    const step = yield* Schedule.toStep(retryPolicy(() => Effect.void));
    const exit = yield* Effect.exit(step(0, error));
    return Exit.isSuccess(exit);
  });

describe("retry policy", () => {
  it.effect.each([
    { code: CONNECTION_CLOSE_UNAUTHENTICATED, continues: false },
    { code: CONNECTION_CLOSE_FORBIDDEN, continues: false },
    { code: CONNECTION_CLOSE_NOT_A_MEMBER, continues: false },
    { code: CONNECTION_CLOSE_DISPLACED, continues: false },
    { code: CONNECTION_CLOSE_REVOKED, continues: true },
    { code: 1006, continues: true },
    { code: CONNECTION_CLOSE_TRY_AGAIN, continues: true },
  ])("after $code it continues: $continues", ({ code, continues }) =>
    Effect.gen(function* () {
      assert.strictEqual(yield* continuesAfter(closed(code)), continues);
    }),
  );
});

describe("close outcome", () => {
  it.each([
    { code: CONNECTION_CLOSE_UNAUTHENTICATED, merchant: false, outcome: "sign-in" },
    { code: CONNECTION_CLOSE_UNAUTHENTICATED, merchant: true, outcome: "expired" },
    { code: CONNECTION_CLOSE_FORBIDDEN, merchant: false, outcome: "forbidden" },
    { code: CONNECTION_CLOSE_NOT_A_MEMBER, merchant: false, outcome: "not-a-member" },
    { code: CONNECTION_CLOSE_DISPLACED, merchant: false, outcome: "displaced" },
    { code: CONNECTION_CLOSE_REVOKED, merchant: false, outcome: "lost" },
    { code: CONNECTION_CLOSE_TRY_AGAIN, merchant: true, outcome: "lost" },
  ] as const)("$code for a merchant: $merchant is $outcome", ({ code, merchant, outcome }) => {
    assert.strictEqual(closeOutcome(closed(code), merchant), outcome);
  });

  it.effect.each([
    { outcome: "expired", state: "forbidden", notAMember: false, expired: true },
    { outcome: "not-a-member", state: "forbidden", notAMember: true, expired: false },
    { outcome: "displaced", state: "displaced", notAMember: false, expired: false },
    { outcome: "forbidden", state: "forbidden", notAMember: false, expired: false },
    { outcome: "lost", state: "lost", notAMember: false, expired: false },
  ] as const)("$outcome leaves the page $state", ({ outcome, state, notAMember, expired }) =>
    Effect.gen(function* () {
      const registry = AtomRegistry.make();
      yield* applyCloseOutcome(registry, outcome);
      assert.strictEqual(registry.get(connectionStateAtom), state);
      assert.strictEqual(registry.get(notAMemberAtom), notAMember);
      assert.strictEqual(registry.get(merchantExpiredAtom), expired);
      registry.dispose();
    }),
  );
});
