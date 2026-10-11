import { RuntimeContext } from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { BackendRpcs, CurrentUser, TooManyRequests } from "../api/backend.ts";
import { Auth } from "./auth.ts";
import { MagicLinkDelivery } from "./magic-link-delivery.ts";
import { Members } from "./members.ts";
import { SignInLimit } from "./resources.ts";

/**
 * The {@link SignInLimit} client. Yielding the binding attaches it to the Worker, so the layer
 * is built in the Worker's init.
 */
export class SignInLimiter extends Context.Service<SignInLimiter, Cloudflare.RateLimitClient>()(
  "app/SignInLimiter",
) {
  static readonly layer = Layer.effect(
    SignInLimiter,
    Effect.gen(function* () {
      return yield* SignInLimit;
    }),
  );

  /** A limiter that always answers `success`, for tests. */
  static readonly layerTest = (success: boolean) =>
    Layer.succeed(SignInLimiter, {
      raw: Effect.die("SignInLimiter has no raw binding off the Worker"),
      limit: () => Effect.succeed({ success }),
    });

  /**
   * A limiter that admits everyone. Under `alchemy dev` no client IP arrives, so every request
   * would share one key and a few sign-ins would lock everyone out.
   */
  static readonly layerOpen = SignInLimiter.layerTest(true);
}

export const BackendHandlers = BackendRpcs.toLayer(
  Effect.gen(function* () {
    const { auth } = yield* Auth;
    const delivery = yield* MagicLinkDelivery;
    const members = yield* Members;
    const limiter = yield* SignInLimiter;

    return BackendRpcs.of({
      Hello: () =>
        Effect.gen(function* () {
          yield* Effect.log("Backend.Hello"); // used to count calls in the dev log
          const now = yield* DateTime.now;
          return { message: "Hello from the backend Worker.", servedAt: DateTime.formatIso(now) };
        }),
      Shout: ({ input }) =>
        Effect.gen(function* () {
          yield* Effect.log("Backend.Shout");
          return { input, output: input.toUpperCase() };
        }),
      // A non-member gets the same reply as a member, minus the link: the caller must not learn
      // who is invited. A Better Auth failure stays a defect for the same reason.
      RequestMagicLink: ({ email, returnTo }, { headers }) =>
        Effect.gen(function* () {
          const ip = headers["cf-connecting-ip"] ?? "unknown";
          const { success } = yield* limiter.limit({ key: ip }).pipe(Effect.orDie);
          if (!success) return yield* new TooManyRequests();
          const member = yield* members.findByEmail(email);
          if (Option.isNone(member)) {
            yield* Effect.logInfo("sign-in requested for a non-member");
            return { link: Option.none() };
          }
          yield* auth.api
            .signInMagicLink({
              body: { email, callbackURL: returnTo ?? "/app", errorCallbackURL: "/sign-in" },
              headers: new Headers(headers),
            })
            .pipe(Effect.orDie);
          return { link: yield* delivery.take(email) };
        }).pipe(Effect.provide(RuntimeContext.phantom)),
      Me: () =>
        Effect.gen(function* () {
          return yield* CurrentUser;
        }),
      ListMembers: () => members.list(),
    });
  }),
);
