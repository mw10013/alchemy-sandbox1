import { RuntimeContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as SQL from "alchemy/SQL/D1";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { TestControlAuth, TestControlRpcs, TestControlUnauthorized } from "../api/test-control.ts";
import { TICKET_TTL_MILLIS } from "../api/shop-actor.ts";
import { SystemActors } from "./actor-client.ts";
import { Auth } from "./auth.ts";
import { MagicLinkDelivery } from "./magic-link-delivery.ts";
import { Members } from "./members.ts";
import { AuthDb } from "./resources.ts";
import { Shopify } from "./shopify.ts";
import { Tickets } from "./ticket.ts";

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
 * The operator every test stage signs in as. The seed cannot insert it: `importFiles` runs
 * before `@alchemy.run/better-auth` has created the `user` table on a fresh stage, so
 * {@link TestData} puts it back on every reset instead. Dates are ISO text and booleans 0/1, as
 * Better Auth stores them.
 */
const OPERATOR = { id: "user-admin", name: "Admin", email: "a@a.com" } as const;

/**
 * Wipes what tests leave behind in `AuthDb`. Sessions, accounts and verifications all go;
 * users and `Member` rows go only for `@e2e.test` addresses (their `TeamMember` edges cascade),
 * so the seeded members and their users stay. The operator's user row is inserted if missing.
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
          yield* sql`DELETE FROM "user" WHERE email LIKE '%@e2e.test'`;
          yield* sql`DELETE FROM Member WHERE email LIKE '%@e2e.test'`;
          const now = new Date().toISOString();
          yield* sql`INSERT OR IGNORE INTO "user"
            (id, name, email, emailVerified, role, banned, createdAt, updatedAt)
            VALUES (${OPERATOR.id}, ${OPERATOR.name}, ${OPERATOR.email}, 1, 'admin', 0, ${now}, ${now})`;
        }, Effect.orDie),
      });
    }),
  );
}

export const TestControlHandlers = TestControlRpcs.toLayer(
  Effect.gen(function* () {
    const { auth, maySignIn } = yield* Auth;
    const delivery = yield* MagicLinkDelivery;
    const members = yield* Members;
    const testData = yield* TestData;
    const actors = yield* SystemActors;
    const shopify = yield* Shopify;
    const tickets = yield* Tickets;

    return TestControlRpcs.of({
      ResetData: () => testData.reset(),
      AddMember: ({ shop, email }) => members.add(shop, email),
      RemoveMember: ({ shop, email }) =>
        Effect.gen(function* () {
          const removed = yield* members.remove(shop, email);
          if (Option.isNone(removed)) return { removed: false, closed: 0 };
          // Baton's rule on `Members`: the edit is followed by a revoke on the shop's actor.
          // Unlike the Better Auth hooks, a failed revoke is a defect here, so a test sees it.
          const { closed } = yield* actors
            .call(shop, (client) => client.SystemRevoke({ by: "member", id: removed.value }))
            .pipe(Effect.orDie);
          return { removed: true, closed };
        }),
      IssueMerchantSessionToken: ({ shop, expiresInSeconds }) =>
        shopify
          .signSessionToken({ shop, expiresIn: expiresInSeconds })
          .pipe(Effect.map((token) => ({ token }))),
      IssueActorTicketAs: ({ shop, caller }) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const ticket = yield* tickets.mint({ shop, caller, expiresAt: now + TICKET_TTL_MILLIS });
          return { ticket };
        }),
      IssueMagicLink: ({ email, returnTo }, { headers }) =>
        Effect.gen(function* () {
          if (!(yield* maySignIn(email)))
            return yield* Effect.die(new Error(`${email} is neither a user nor a member`));
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
