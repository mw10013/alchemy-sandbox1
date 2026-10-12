import { RuntimeContext } from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Schema from "effect/Schema";
import {
  CurrentUser,
  CurrentUserMiddleware,
  Forbidden,
  Me,
  RequireAdmin,
  Unauthorized,
} from "../api/backend.ts";
import { Auth } from "./auth.ts";

const decodeMe = Schema.decodeUnknownEffect(Me);

/**
 * Resolves the Better Auth session from a `cookie` header value: the signed-in user as
 * {@link Me}, the session's id, and its expiry in epoch ms. No session, or one that does not
 * decode, is {@link Unauthorized}. The actor gate needs the session itself, to scope a revoke to
 * it and to stop serving a socket past its expiry.
 */
export const sessionFromCookie = Effect.fn("sessionFromCookie")(function* (
  cookie: string | undefined,
) {
  const { auth } = yield* Auth;
  const session = yield* auth.getSession(new Headers({ cookie: cookie ?? "" })).pipe(
    Effect.mapError(() => new Unauthorized()),
    Effect.catchDefect(() => Effect.fail(new Unauthorized())),
  );
  if (session === null) return yield* new Unauthorized();
  const me = yield* decodeMe({
    id: session.user.id,
    email: session.user.email,
    role: session.user.role,
  }).pipe(Effect.mapError(() => new Unauthorized()));
  return {
    me,
    sessionId: session.session.id,
    sessionExpiresAt: session.session.expiresAt.getTime(),
  };
});

/**
 * The signed-in user from a `cookie` header value, through {@link sessionFromCookie}.
 * {@link CurrentUserLive} uses it for RPC.
 */
export const currentUserFromCookie = (cookie: string | undefined) =>
  sessionFromCookie(cookie).pipe(Effect.map(({ me }) => me));

/**
 * Provides {@link CurrentUser} from the request cookie through {@link currentUserFromCookie}.
 * RPC headers are lowercased and carry the cookie for browser calls, through the Website's
 * proxy, and for SSR calls, which forward the visitor's cookie.
 */
export const CurrentUserLive = Layer.effect(
  CurrentUserMiddleware,
  Effect.gen(function* () {
    const auth = yield* Auth;
    return CurrentUserMiddleware.of((effect, { headers }) =>
      currentUserFromCookie(headers.cookie).pipe(
        Effect.flatMap((me) => Effect.provideService(effect, CurrentUser, me)),
        Effect.provideService(Auth, auth),
        // RPC does not carry Alchemy's runtime marker; the Worker owns the request scope.
        Effect.provide(RuntimeContext.phantom),
      ),
    );
  }),
);

export const RequireAdminLive = Layer.succeed(RequireAdmin)(
  RequireAdmin.of((effect) =>
    Effect.gen(function* () {
      const user = yield* CurrentUser;
      return yield* Match.value(user.role).pipe(
        Match.when("admin", () => effect),
        Match.orElse(() => Effect.fail(new Forbidden())),
      );
    }),
  ),
);
