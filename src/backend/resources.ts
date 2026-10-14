import * as Cloudflare from "alchemy/Cloudflare";

/**
 * Baton's shop tables (`ShopSession`, `Member`, `Team`, `TeamMember`) and Better Auth's tables.
 * It applies migrations only; seeding is the `Seed` Action's job, because Better Auth creates its
 * tables after this resource on a fresh stage.
 */
export const AuthDb = Cloudflare.D1.Database("AuthDb", {
  migrations: "./migrations",
  readReplication: { mode: "disabled" },
});

export const AuthEmail = Cloudflare.Email.SendEmail("AuthEmail");

/** Limits sign-in requests per client IP. */
export const SignInLimit = Cloudflare.RateLimit("SignInLimit", {
  namespaceId: 1001, // any stable integer, unique per limiter in the account
  simple: { limit: 5, period: 60 },
});
