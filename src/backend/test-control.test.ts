import { Memory } from "@alchemy.run/better-auth";
import { assert, describe, it } from "@effect/vitest";
import { RuntimeContext } from "alchemy";
import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as References from "effect/References";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcTest from "effect/rpc/RpcTest";
import * as Schema from "effect/Schema";
import { EmailFromInput, type Member } from "../api/backend.ts";
import { E2eEmail, TestControlRpcs } from "../api/test-control.ts";
import { Auth } from "./auth.ts";
import { MagicLinkDelivery } from "./magic-link-delivery.ts";
import { Mailer, SentMail } from "./mailer.ts";
import { Members } from "./members.ts";
import {
  TestControlAuthLive,
  TestControlHandlers,
  TestControlToken,
  TestData,
} from "./test-control.ts";

const ORIGIN = "http://test.local";
const TOKEN = "t";
const email = Schema.decodeUnknownSync(EmailFromInput);

const member = email("m1@m.com");
const stranger = email("nobody@example.com");
const members: ReadonlyArray<Member> = [{ email: member, role: "user", createdAt: 1 }];

/**
 * The test-control handlers and token middleware over Better Auth on an in-memory database,
 * fresh per test, under the given {@link MagicLinkDelivery}. `ResetData` needs D1, so
 * {@link TestData} dies.
 */
const TestBackend = (delivery: "inline" | "mailed" = "inline") =>
  Layer.mergeAll(TestControlHandlers, TestControlAuthLive).pipe(
    Layer.provideMerge(
      Auth.layerWith({ secret: "test-secret-test-secret-test-secret" }).pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            Members.layerTest(members),
            Layer.succeed(TestControlToken, TOKEN),
            Layer.succeed(TestData, { reset: () => Effect.die("TestData needs D1") }),
            (delivery === "inline"
              ? MagicLinkDelivery.layerInline
              : MagicLinkDelivery.layerMailed
            ).pipe(Layer.provideMerge(Mailer.layerTest)),
          ),
        ),
        Layer.provide(Memory()),
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ AUTH_ORIGIN: ORIGIN }))),
      ),
    ),
    Layer.provide(RuntimeContext.phantom),
    Layer.provide(Layer.succeed(References.MinimumLogLevel, "Warn")),
  );

const authorized = RpcClient.withHeaders({ "x-e2e-token": TOKEN });

describe("test control", () => {
  it.live.each([
    { name: "no token", headers: {} },
    { name: "a wrong token", headers: { "x-e2e-token": "wrong" } },
  ])("a call with $name is TestControlUnauthorized", ({ headers }) =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(TestControlRpcs);
      const error = yield* client
        .IssueMagicLink({ email: member })
        .pipe(RpcClient.withHeaders(headers), Effect.flip);
      assert.strictEqual(error._tag, "TestControlUnauthorized");
    }).pipe(Effect.provide(TestBackend())),
  );

  it.live("IssueMagicLink returns the link and mails nothing", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(TestControlRpcs);
      const { link } = yield* client.IssueMagicLink({ email: member }).pipe(authorized);
      assert.strictEqual(new URL(link).pathname, "/api/auth/magic-link/verify");
      assert.deepStrictEqual(yield* Ref.get(yield* SentMail), []);
    }).pipe(Effect.provide(TestBackend())),
  );

  it.live("IssueMagicLink dies on a stage that mails its links", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(TestControlRpcs);
      const exit = yield* client.IssueMagicLink({ email: member }).pipe(authorized, Effect.exit);
      assert.isTrue(Exit.isFailure(exit) && Cause.hasDies(exit.cause));
      const sent = yield* Ref.get(yield* SentMail);
      assert.deepStrictEqual(
        sent.map((mail) => mail.to),
        [member],
      );
    }).pipe(Effect.provide(TestBackend("mailed"))),
  );

  it.live("IssueMagicLink for a non-member dies", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(TestControlRpcs);
      const exit = yield* client.IssueMagicLink({ email: stranger }).pipe(authorized, Effect.exit);
      assert.isTrue(Exit.isFailure(exit) && Cause.hasDies(exit.cause));
    }).pipe(Effect.provide(TestBackend())),
  );

  it.live("CreateMember returns the member with the given role", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(TestControlRpcs);
      const address = Schema.decodeUnknownSync(E2eEmail)("new@e2e.test");
      const created = yield* client
        .CreateMember({ email: address, role: "admin" })
        .pipe(authorized);
      assert.strictEqual(created.email, address);
      assert.strictEqual(created.role, "admin");
    }).pipe(Effect.provide(TestBackend())),
  );

  it.todo("ResetData clears Better Auth rows and @e2e.test members (needs D1: the e2e stage)");
});
