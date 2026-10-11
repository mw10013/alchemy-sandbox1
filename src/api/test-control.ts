import * as Schema from "effect/Schema";
import { Rpc, RpcGroup, RpcMiddleware } from "effect/rpc";
import { Email, Member, ReturnPath, Role } from "./backend.ts";

/** A member a test creates. {@link TestControlRpcs} `ResetData` removes every such address. */
export const E2eEmail = Email.check(
  Schema.isPattern(/@e2e\.test$/u, { message: "Test members use an @e2e.test address." }),
);

export class TestControlUnauthorized extends Schema.TaggedError<TestControlUnauthorized>()(
  "TestControlUnauthorized",
  {},
) {}

/** Admits a call whose `x-e2e-token` header is the stage's `E2E_TOKEN`. */
export class TestControlAuth extends RpcMiddleware.Service<TestControlAuth>()("TestControlAuth", {
  error: TestControlUnauthorized,
}) {}

/**
 * Procedures for a test runner. The Backend serves them only when it has the `E2E_TOKEN`
 * binding, which the stack never sets on production.
 *
 * - `ResetData` removes every Better Auth row and every `@e2e.test` member, and leaves the seed
 *   members.
 * - `IssueMagicLink` is `RequestMagicLink` without the rate limit or the non-member silence; a
 *   non-member, or a stage that mails its links instead of handing them back, is a defect.
 */
export const TestControlRpcs = RpcGroup.make(
  Rpc.make("ResetData", { success: Schema.Void }),
  Rpc.make("CreateMember", { payload: { email: E2eEmail, role: Role }, success: Member }),
  Rpc.make("IssueMagicLink", {
    payload: { email: Email, returnTo: Schema.optional(ReturnPath) },
    success: Schema.Struct({ link: Schema.String }),
  }),
).middleware(TestControlAuth);
