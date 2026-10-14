import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const isDevStage = Schema.is(Schema.TemplateLiteral(["dev_", Schema.String]));

/** The SQL files a stage is seeded with. */
export interface Seeds {
  /** Run by `importFiles` on {@link AuthDb}, before Better Auth's tables exist. */
  readonly data: string;
  /** Run by `AuthSeed`, after them. None on a stage that has no operator seed. */
  readonly auth: Option.Option<string>;
}

/**
 * The seeds for a stage. `dev` and every `dev_*` stage (one per checkout) share the dev seeds;
 * `staging` and `production` have their own; any other stage is a test stage (`test_<user>`,
 * `e2e_<user>`) and gets the test seeds. Production has no auth seed, and no data seed file yet.
 */
export const seedsFor = Match.type<string>().pipe(
  Match.whenOr(Match.is("dev"), isDevStage, (): Seeds => ({
    data: "./seed/dev.sql",
    auth: Option.some("./seed/dev-auth.sql"),
  })),
  Match.when(Match.is("staging"), (): Seeds => ({
    data: "./seed/staging.sql",
    auth: Option.some("./seed/staging-auth.sql"),
  })),
  Match.when(Match.is("production"), (): Seeds => ({
    data: "./seed/production.sql",
    auth: Option.none(),
  })),
  Match.orElse((): Seeds => ({
    data: "./seed/test.sql",
    auth: Option.some("./seed/test-auth.sql"),
  })),
);

/**
 * Baton's shop tables (`ShopSession`, `Member`, `Team`, `TeamMember`) and Better Auth's tables.
 * `importFiles` runs after migrations, hashed, and re-runs only when the file changes. It runs
 * before `@alchemy.run/better-auth` creates its tables on a fresh stage, so a seed listed here
 * cannot touch them; `AuthSeed` does that. The stage is known only while the stack is
 * planned; at runtime the props are not used, so no seed is listed there.
 */
export const AuthDb = Cloudflare.D1.Database(
  "AuthDb",
  Effect.serviceOption(Alchemy.Stage).pipe(
    Effect.map((stage) => ({
      migrations: "./migrations",
      readReplication: { mode: "disabled" as const },
      importFiles: Option.match(stage, {
        onNone: () => [],
        onSome: (stage) => [seedsFor(stage).data],
      }),
    })),
  ),
);

export const AuthEmail = Cloudflare.Email.SendEmail("AuthEmail");

/** Limits sign-in requests per client IP. */
export const SignInLimit = Cloudflare.RateLimit("SignInLimit", {
  namespaceId: 1001, // any stable integer, unique per limiter in the account
  simple: { limit: 5, period: 60 },
});
