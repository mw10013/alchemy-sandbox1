import * as Schema from "effect/Schema";
import { Rpc, RpcGroup, RpcMiddleware } from "effect/rpc";
import { Email, ReturnPath } from "./auth.ts";
import { Member, MemberExists } from "./members.ts";
import { ShopKey } from "./shop.ts";

/** An address a test adds, so it never collides with a seeded member. */
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
 * The part of a stored Shopify session a test may read. It has no field for the access or the
 * refresh token, so no handler can return one.
 */
export const ShopSessionView = Schema.Struct({
  shopGid: Schema.String,
  scope: Schema.NullOr(Schema.String),
  accessTokenExpiresAt: Schema.NullOr(Schema.Number),
});
export type ShopSessionView = typeof ShopSessionView.Type;

/**
 * Procedures for a test runner. The Backend serves them only when it has the `E2E_TOKEN`
 * binding, which the stack sets only when the test runner supplies the token.
 *
 * - `AddMember` and `RemoveMember` edit a shop's `Member` rows, as an admin UI would;
 *   `RemoveMember` then revokes the member's sockets on that shop's actor and answers how
 *   many it closed.
 * - `IssueMerchantSessionToken` signs a Shopify session token for a shop with the fake app's
 *   secret, as Shopify would; it is how a merchant window exists in dev and e2e.
 * - `GetShopSession` reads a shop's stored session as {@link ShopSessionView}, or null when the
 *   shop has none; it is how a test sees what a real token exchange stored.
 * - `IssueMagicLink` is `BackendApi.requestMagicLink` without the rate limit or the non-member
 *   silence; an address that could not sign in, or a stage that mails its links instead of
 *   handing them back, is a defect.
 *
 * Beside the procedures, the Backend serves a test-only upgrade route on the same binding; see
 * `testControlCaller` in the Backend.
 */
export const TestControlRpcs = RpcGroup.make(
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
  Rpc.make("GetShopSession", {
    payload: { shop: ShopKey },
    success: Schema.NullOr(ShopSessionView),
  }),
  Rpc.make("IssueMagicLink", {
    payload: { email: Email, returnTo: Schema.optional(ReturnPath) },
    success: Schema.Struct({ link: Schema.String }),
  }),
).middleware(TestControlAuth);
