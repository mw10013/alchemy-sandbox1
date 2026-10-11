import { RuntimeContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as SQL from "alchemy/SQL/D1";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { TestControlAuth, TestControlRpcs, TestControlUnauthorized } from "../api/test-control.ts";
import { Auth } from "./auth.ts";
import { MagicLinkDelivery } from "./magic-link-delivery.ts";
import { Members } from "./members.ts";
import { AuthDb } from "./resources.ts";

/** The stage's `E2E_TOKEN`, read once by the Worker, which serves test control only when it has one. */
export class TestControlToken extends Context.Service<TestControlToken, string>()(
  "app/TestControlToken",
) {}

/** Admits a call whose `x-e2e-token` header is {@link TestControlToken}; RPC headers are lowercased. */
export const TestControlAuthLive = Layer.effect(
  TestControlAuth,
  Effect.gen(function* () {
    const token = yield* TestControlToken;
    return TestControlAuth.of((effect, { headers }) =>
      headers["x-e2e-token"] === token ? effect : Effect.fail(new TestControlUnauthorized()),
    );
  }),
);

/**
 * Wipes what tests leave behind in `AuthDb`. The Better Auth tables are `session`, `account`,
 * `verification` and `user`; sessions and accounts go first because they reference users.
 * Seed members stay, so a stage is back to its seeded state.
 */
export class TestData extends Context.Service<
  TestData,
  { readonly reset: () => Effect.Effect<void> }
>()("app/TestData") {
  static readonly layer = Layer.effect(
    TestData,
    Effect.gen(function* () {
      const d1 = yield* Cloudflare.D1.QueryDatabase(AuthDb);
      const sql = yield* SQL.D1(d1);
      return TestData.of({
        reset: Effect.fn("TestData.reset")(function* () {
          yield* sql`DELETE FROM session`;
          yield* sql`DELETE FROM account`;
          yield* sql`DELETE FROM verification`;
          yield* sql`DELETE FROM "user"`;
          yield* sql`DELETE FROM member WHERE email LIKE '%@e2e.test'`;
        }, Effect.orDie),
      });
    }),
  );
}

export const TestControlHandlers = TestControlRpcs.toLayer(
  Effect.gen(function* () {
    const { auth } = yield* Auth;
    const delivery = yield* MagicLinkDelivery;
    const members = yield* Members;
    const testData = yield* TestData;

    return TestControlRpcs.of({
      ResetData: () => testData.reset(),
      CreateMember: ({ email, role }) => members.create(email, role),
      IssueMagicLink: ({ email, returnTo }, { headers }) =>
        Effect.gen(function* () {
          if (Option.isNone(yield* members.findByEmail(email)))
            return yield* Effect.die(new Error(`${email} is not a member`));
          yield* auth.api
            .signInMagicLink({
              body: { email, callbackURL: returnTo ?? "/app", errorCallbackURL: "/sign-in" },
              headers: new Headers(headers),
            })
            .pipe(Effect.orDie);
          const link = yield* delivery.take(email);
          if (Option.isNone(link))
            return yield* Effect.die(new Error(`no link for ${email}: the stage mails its links`));
          return { link: link.value };
        }).pipe(Effect.provide(RuntimeContext.phantom)),
    });
  }),
);
