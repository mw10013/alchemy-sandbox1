import { BetterAuth } from "@alchemy.run/better-auth";
import * as Alchemy from "alchemy";
import { RuntimeContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import { admin, magicLink } from "better-auth/plugins";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Email, type Role } from "../api/backend.ts";
import { MemberRow } from "./members.ts";
import { AuthEmail, AuthDb } from "./resources.ts";

const MAGIC_LINK_TTL_SECONDS = 300;
/** A transactional sender on the Email Service sending domain; no mailbox is behind it. */
const MAGIC_LINK_FROM = "noreply@mail.mw10013.com";

const decodeEmail = Schema.decodeUnknownOption(Email);
const decodeRow = Schema.decodeUnknownEffect(Schema.NullOr(MemberRow));

/**
 * Builds {@link Auth}. This is the only Promise seam with Better Auth: its callbacks run
 * inside Better Auth's promise machinery, so they run Effects with a snapshot of the
 * construction context, and the D1 and email clients read the Worker env captured at
 * construction.
 */
export const makeAuth = Effect.gen(function* () {
  const dev = yield* Alchemy.ALCHEMY_DEV;
  // The Website's URL, bound onto this Worker by the stack. It is absent while the stack is
  // planned, which needs no origin; a running Worker without it is broken.
  const authOrigin = yield* Config.option(Config.String("AUTH_ORIGIN"));
  if (globalThis.__ALCHEMY_RUNTIME__ && Option.isNone(authOrigin))
    return yield* Effect.die(new Error("AUTH_ORIGIN is not bound to the Backend"));
  const inline = dev;
  const email = yield* Cloudflare.Email.Send(AuthEmail);
  const d1 = yield* Cloudflare.D1.QueryDatabase(AuthDb);
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  // sendMagicLink writes and RequestMagicLink reads within one request.
  const pendingLinks = new Map<string, string>();

  // The raw D1 client, not SQL.D1: that one is memoized on the per-request scope, which the
  // construction snapshot does not carry.
  const findRole = (address: unknown) =>
    Option.match(decodeEmail(address), {
      onNone: () => Effect.succeed(Option.none<Role>()),
      onSome: (address) =>
        d1
          .prepare("SELECT email, role, created_at FROM member WHERE email = ?")
          .bind(address)
          .first()
          .pipe(
            Effect.flatMap(decodeRow),
            Effect.map((row) => Option.fromNullOr(row).pipe(Option.map((row) => row.role))),
            Effect.orDie,
          ),
    }).pipe(Effect.provide(RuntimeContext.phantom));

  const deliver = Effect.fn("Auth.deliverMagicLink")(function* (to: string, url: string) {
    if (inline) {
      pendingLinks.set(to, url);
      return yield* Effect.logInfo("magic link (dev inline)", { to, url });
    }
    yield* email
      .send({
        from: MAGIC_LINK_FROM,
        to,
        subject: "Your sign-in link",
        text: `Sign in: ${url}\n\nThis link expires in 5 minutes. If you did not ask for it, ignore this email.`,
        html: `<p><a href="${url}">Sign in</a></p><p>This link expires in 5 minutes. If you did not ask for it, ignore this email.</p>`,
      })
      .pipe(Effect.orDie, Effect.provide(RuntimeContext.phantom));
  });

  const auth = yield* BetterAuth({
    basePath: "/api/auth",
    baseURL: Option.getOrUndefined(authOrigin),
    user: {
      // Runs before a user is created: a non-member's verify lands on ?error=not_invited.
      validateUserInfo: ({ user }) =>
        runPromise(
          findRole(user.email).pipe(
            Effect.map(
              Option.match({ onNone: () => ({ error: "not_invited" }), onSome: () => undefined }),
            ),
          ),
        ),
    },
    databaseHooks: {
      user: {
        create: {
          // Copies the member's role onto the new user; the admin plugin keeps an existing role.
          before: (user) =>
            runPromise(
              findRole(user.email).pipe(
                Effect.map((role) => ({
                  data: { ...user, role: Option.getOrElse(role, (): Role => "user") },
                })),
              ),
            ),
        },
      },
    },
    plugins: [
      magicLink({
        expiresIn: MAGIC_LINK_TTL_SECONDS,
        storeToken: "hashed",
        sendMagicLink: ({ email: to, url }) => runPromise(deliver(to, url)),
      }),
      admin(),
    ],
    advanced: { ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] } },
    // Sign-in requests are limited per IP by the SignInLimit binding instead.
    rateLimit: { enabled: false },
  });

  const takeInlineLink = (to: string) =>
    Effect.sync(() => {
      const url = Option.fromUndefinedOr(pendingLinks.get(to));
      pendingLinks.delete(to);
      return url;
    });

  return { auth, inline, takeInlineLink };
});

/**
 * Better Auth with magic links, invite-only: only an address in the `member` table can create
 * a user, and the new user takes the member's role.
 *
 * Under `alchemy dev` delivery is inline (`inline` is true): a magic link is logged instead of
 * emailed, and RequestMagicLink returns it through `takeInlineLink` so the sign-in page can
 * show it. A site that behaves differently under inline delivery reads `inline`.
 */
export class Auth extends Context.Service<Auth, Effect.Success<typeof makeAuth>>()("app/Auth") {
  static readonly layer = Layer.effect(Auth, makeAuth);
}
