import { BetterAuth } from "@alchemy.run/better-auth";
import * as Alchemy from "alchemy";
import { RuntimeContext } from "alchemy";
import { admin, magicLink } from "better-auth/plugins";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { Email, type Role } from "../api/backend.ts";
import { Mailer } from "./mailer.ts";
import { Members } from "./members.ts";

const MAGIC_LINK_TTL_SECONDS = 300;

const decodeEmail = Schema.decodeUnknownOption(Email);

export interface AuthOptions {
  /**
   * The Better Auth signing secret. Omitted, it is an `Alchemy.Random` resource held in state,
   * which needs a stack; a test passes a literal.
   */
  readonly secret?: string | Redacted.Redacted<string>;
}

/**
 * Builds {@link Auth}. This is the only Promise seam with Better Auth: its callbacks run
 * inside Better Auth's promise machinery, so they run Effects with a snapshot of the
 * construction context. The collaborators ({@link Members}, {@link Mailer}) are services, so
 * the same code runs in the Worker and in a test with no Cloudflare binding behind it.
 */
export const makeAuth = (options: AuthOptions = {}) =>
  Effect.gen(function* () {
    const dev = yield* Alchemy.ALCHEMY_DEV;
    // The Website's URL, bound onto this Worker by the stack. It is absent while the stack is
    // planned, which needs no origin; a running Worker without it is broken.
    const authOrigin = yield* Config.option(Config.String("AUTH_ORIGIN"));
    if (globalThis.__ALCHEMY_RUNTIME__ && Option.isNone(authOrigin))
      return yield* Effect.die(new Error("AUTH_ORIGIN is not bound to the Backend"));
    const inline = dev;
    const members = yield* Members;
    const mailer = yield* Mailer;
    const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
    // sendMagicLink writes and RequestMagicLink reads within one request.
    const pendingLinks = new Map<string, string>();

    // A callback runs outside any request, so `Effect.scoped` gives the query its own scope:
    // `SQL.D1` builds its client per scope and releases it with the scope.
    const findRole = (address: unknown) =>
      Option.match(decodeEmail(address), {
        onNone: () => Effect.succeed(Option.none<Role>()),
        onSome: (address) =>
          members
            .findByEmail(address)
            .pipe(Effect.map(Option.map((member) => member.role)), Effect.scoped),
      }).pipe(Effect.provide(RuntimeContext.phantom));

    const deliver = Effect.fn("Auth.deliverMagicLink")(function* (to: string, url: string) {
      if (inline) {
        pendingLinks.set(to, url);
        return yield* Effect.logInfo("magic link (dev inline)", { to, url });
      }
      yield* mailer.send({
        to,
        subject: "Your sign-in link",
        text: `Sign in: ${url}\n\nThis link expires in 5 minutes. If you did not ask for it, ignore this email.`,
        html: `<p><a href="${url}">Sign in</a></p><p>This link expires in 5 minutes. If you did not ask for it, ignore this email.</p>`,
      });
    });

    const auth = yield* BetterAuth({
      ...(options.secret === undefined ? {} : { secret: options.secret }),
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
export class Auth extends Context.Service<Auth, Effect.Success<ReturnType<typeof makeAuth>>>()(
  "app/Auth",
) {
  static readonly layerWith = (options: AuthOptions) => Layer.effect(Auth, makeAuth(options));
  static readonly layer = Auth.layerWith({});
}
