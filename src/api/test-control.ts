import * as Schema from "effect/Schema";
import { Rpc, RpcGroup, RpcMiddleware } from "effect/rpc";
import { Email, Member, MemberExists, ReturnPath, Ticket } from "./backend.ts";
import { ConnectionCaller } from "./shop-actor.ts";
import { ShopKey } from "./shop.ts";

/** An address a test adds. {@link TestControlRpcs} `ResetData` removes every such address. */
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
 * - `ResetData` removes every session, account and verification row, every `@e2e.test` user
 *   and `Member` row, and puts back the operator, so a stage is back to its seeded state.
 * - `AddMember` and `RemoveMember` edit a shop's `Member` rows, as an admin UI would;
 *   `RemoveMember` then revokes the member's sockets on that shop's actor and answers how
 *   many it closed.
 * - `IssueMerchantSessionToken` signs a Shopify session token for a shop with the fake app's
 *   secret, as Shopify would; it is how a merchant window exists in dev and e2e.
 * - `IssueActorTicketAs` mints a ticket for any caller with no gate, so a test can bind a
 *   socket with an identity no sign-in produces, such as an expired session.
 * - `IssueMagicLink` is `RequestMagicLink` without the rate limit or the non-member silence; an
 *   address that could not sign in, or a stage that mails its links instead of handing them
 *   back, is a defect.
 */
export const TestControlRpcs = RpcGroup.make(
  Rpc.make("ResetData", { success: Schema.Void }),
  Rpc.make("AddMember", {
    payload: { shop: ShopKey, email: E2eEmail },
    success: Member,
    error: MemberExists,
  }),
  Rpc.make("RemoveMember", {
    payload: { shop: ShopKey, email: Email },
    success: Schema.Struct({ removed: Schema.Boolean, closed: Schema.Int }),
  }),
  Rpc.make("IssueMerchantSessionToken", {
    payload: { shop: ShopKey, expiresInSeconds: Schema.optional(Schema.Int) },
    success: Schema.Struct({ token: Schema.String }),
  }),
  Rpc.make("IssueActorTicketAs", {
    payload: { shop: ShopKey, caller: ConnectionCaller },
    success: Schema.Struct({ ticket: Ticket }),
  }),
  Rpc.make("IssueMagicLink", {
    payload: { email: Email, returnTo: Schema.optional(ReturnPath) },
    success: Schema.Struct({ link: Schema.String }),
  }),
).middleware(TestControlAuth);
