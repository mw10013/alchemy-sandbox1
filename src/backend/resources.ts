import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

/**
 * The `member` table and Better Auth's tables. `importFiles` runs after migrations, hashed,
 * and re-runs only when the file changes. The stage is known only while the stack is planned;
 * at runtime the props are not used, so no seed is listed there.
 */
export const AuthDb = Cloudflare.D1.Database(
  "AuthDb",
  Effect.serviceOption(Alchemy.Stage).pipe(
    Effect.map((stage) => ({
      migrations: "./migrations",
      readReplication: { mode: "disabled" as const },
      importFiles: Option.match(stage, {
        onNone: () => [],
        onSome: (stage) => [`./seed/${stage}.sql`],
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
