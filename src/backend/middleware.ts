import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Me, Unauthorized } from "../api/backend.ts";
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
