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
 * Resolves the Better Auth session from a `cookie` header value into the signed-in member, or
 * fails {@link Unauthorized}. {@link CurrentUserLive} uses it for RPC; the Backend uses it to
 * gate actor traffic before forwarding.
 */
export const currentUserFromCookie = Effect.fn("currentUserFromCookie")(function* (
  cookie: string | undefined,
) {
  const { auth } = yield* Auth;
  const session = yield* auth.getSession(new Headers({ cookie: cookie ?? "" })).pipe(
    Effect.mapError(() => new Unauthorized()),
    Effect.catchDefect(() => Effect.fail(new Unauthorized())),
  );
  if (session === null) return yield* new Unauthorized();
  return yield* decodeMe({
    id: session.user.id,
    email: session.user.email,
    role: session.user.role,
  }).pipe(Effect.mapError(() => new Unauthorized()));
});

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
