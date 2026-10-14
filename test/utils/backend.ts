import { Memory } from "@alchemy.run/better-auth";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Layer from "effect/Layer";
import * as References from "effect/References";
import type { Member } from "../../src/api/backend.ts";
import { ShopActors } from "../../src/backend/actor-client.ts";
import { Auth } from "../../src/backend/auth.ts";
import { MagicLinkDelivery } from "../../src/backend/magic-link-delivery.ts";
import { Mailer } from "../../src/backend/mailer.ts";
import { Members } from "../../src/backend/members.ts";

/** The `AUTH_ORIGIN` the test Backend's Better Auth runs under, so links resolve against it. */
export const TEST_ORIGIN = "http://test.local";

/** Drops `Info` and below, so only a warning or error reaches the test output. */
export const QuietLogs = Layer.succeed(References.MinimumLogLevel, "Warn");

/**
 * {@link Auth} over Better Auth on an in-memory database, fresh per test, with the services
 * every Backend test needs: {@link Members}, the given {@link ShopActors} fake, and the stage's
 * {@link MagicLinkDelivery} over {@link Mailer.layerTest}. `extra` adds what only one test
 * needs, such as `ShopAccess`. Alchemy's runtime marker is left to the caller: a test that calls
 * Worker methods directly needs it in its context (`provideMerge`), the others only feed it.
 */
export const testAuth = <A, E, R>({
  members,
  actors,
  delivery,
  extra,
}: {
  members: ReadonlyArray<Member>;
  actors: Layer.Layer<ShopActors>;
  delivery: "inline" | "mailed";
  extra: Layer.Layer<A, E, R>;
}) =>
  Auth.layerWith({ secret: "test-secret-test-secret-test-secret" }).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Members.layerTest(members),
        actors,
        extra,
        (delivery === "inline"
          ? MagicLinkDelivery.layerInline
          : MagicLinkDelivery.layerMailed
        ).pipe(Layer.provideMerge(Mailer.layerTest)),
      ),
    ),
    Layer.provide(Memory()),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ AUTH_ORIGIN: TEST_ORIGIN }))),
  );
