import { assert, describe, it } from "@effect/vitest";
import { RuntimeContext } from "alchemy";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import {
  EmailFromInput,
  MagicLinkRequested,
  type RequestInfo,
} from "../../../src/contract/auth.ts";
import { type Member } from "../../../src/contract/members.ts";
import { SANDBOX_SHOP, type ShopKey } from "../../../src/contract/shop.ts";
import type { ConnectionCaller } from "../../../src/contract/shop-actor.ts";
import { ShopActors } from "../../../src/backend/shop-actors.ts";
import { BackendApi, SignInLimiter } from "../../../src/backend/api.ts";
import { QuietLogs, testAuth } from "./layers.ts";
import { Auth } from "../../../src/backend/auth.ts";
import { SentMail } from "../../../src/backend/mailer.ts";
import { ShopAccess, ShopAccessDenied } from "../../../src/backend/shop-access.ts";

const email = Schema.decodeUnknownSync(EmailFromInput);
const decodeRequested = Schema.decodeSync(MagicLinkRequested);

const admin = email("a@a.com");
const member = email("m1@m.com");
const stranger = email("nobody@example.com");
const members: ReadonlyArray<Member> = [
  { id: "mem-1", shop: SANDBOX_SHOP, email: member, createdAt: 1 },
];
const merchant: ConnectionCaller = { role: "merchant" };
const snapshot = { count: { value: 3 }, activation: { id: "activation-1" } };

/** A request with only a cookie, as a server function forwards it. */
const withCookie = (cookie: string | undefined): RequestInfo => ({ cookie, ip: undefined });

/**
 * {@link BackendApi} over Better Auth on an in-memory database, fresh per test. `allow` is the
 * rate limiter's answer; `gate` is what {@link ShopAccess} answers every caller.
 */
const TestBackend = ({
  delivery = "inline",
  allow = true,
  gate = Effect.succeed(merchant),
}: {
  delivery?: "inline" | "mailed";
  allow?: boolean;
  gate?: Effect.Effect<ConnectionCaller, ShopAccessDenied>;
} = {}) =>
  BackendApi.layer.pipe(
    Layer.provideMerge(
      testAuth({
        members,
        actors: ShopActors.layerTest([], snapshot),
        delivery,
        extra: Layer.mergeAll(
          SignInLimiter.layerTest(allow),
          Layer.succeed(ShopAccess, { resolve: () => gate }),
        ),
      }),
    ),
    // A Worker method runs with Alchemy's runtime marker, which the bridge provides per call.
    Layer.provideMerge(RuntimeContext.phantom),
    Layer.provide(QuietLogs),
  );

/** Requests a link for `address` and follows it; returns the cookie header of the new session. */
const signIn = Effect.fn("signIn")(function* (address: typeof member) {
  const api = yield* BackendApi;
  const { auth } = yield* Auth;
  const { link } = decodeRequested(
    yield* api.requestMagicLink(withCookie(undefined), { email: address }),
  );
  const response = yield* auth.fetch.pipe(
    Effect.provideService(
      HttpServerRequest.HttpServerRequest,
      HttpServerRequest.fromWeb(new Request(Option.getOrThrow(link))),
    ),
    Effect.map(HttpServerResponse.toWeb),
  );
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
});

/** The operator's user row, as the seed inserts it; Better Auth's hooks refuse it otherwise. */
const seedOperator = Effect.gen(function* () {
  const { auth } = yield* Auth;
  const instance = yield* auth.auth;
  const context = yield* Effect.promise(() => instance.$context);
  const now = new Date();
  yield* Effect.promise(() =>
    context.adapter.create({
      model: "user",
      data: {
        name: "Admin",
        email: admin,
        emailVerified: true,
        role: "admin",
        banned: false,
        createdAt: now,
        updatedAt: now,
      },
    }),
  );
});

describe("BackendApi sessions", () => {
  it.live("me without a cookie is Unauthorized", () =>
    Effect.gen(function* () {
      const api = yield* BackendApi;
      const error = yield* api.me(withCookie(undefined)).pipe(Effect.flip);
      assert.strictEqual(error._tag, "Unauthorized");
    }).pipe(Effect.provide(TestBackend())),
  );

  it.live("listMembers is Forbidden to a user and answers an operator", () =>
    Effect.gen(function* () {
      const api = yield* BackendApi;
      const asMember = yield* signIn(member);
      const error = yield* api.listMembers(withCookie(asMember)).pipe(Effect.flip);
      assert.strictEqual(error._tag, "Forbidden");
      yield* seedOperator;
      const asAdmin = yield* signIn(admin);
      const list = yield* api.listMembers(withCookie(asAdmin));
      assert.deepStrictEqual(
        list.map((row) => row.email),
        [member],
      );
    }).pipe(Effect.provide(TestBackend())),
  );
});

describe("BackendApi.requestMagicLink", () => {
  it.live("rate-limited is TooManyRequests and sends nothing", () =>
    Effect.gen(function* () {
      const api = yield* BackendApi;
      const error = yield* api
        .requestMagicLink({ cookie: undefined, ip: "203.0.113.1" }, { email: member })
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "TooManyRequests");
      assert.deepStrictEqual(yield* Ref.get(yield* SentMail), []);
    }).pipe(Effect.provide(TestBackend({ delivery: "mailed", allow: false }))),
  );

  it.live("a non-member gets the same answer as a member, without a link", () =>
    Effect.gen(function* () {
      const api = yield* BackendApi;
      const answer = yield* api.requestMagicLink(withCookie(undefined), { email: stranger });
      assert.deepStrictEqual(answer, { link: null });
      assert.deepStrictEqual(yield* Ref.get(yield* SentMail), []);
    }).pipe(Effect.provide(TestBackend())),
  );
});

describe("BackendApi.shopSnapshot", () => {
  const key: ShopKey = SANDBOX_SHOP;

  it.live("answers the gate's caller and the actor's snapshot", () =>
    Effect.gen(function* () {
      const api = yield* BackendApi;
      const answer = yield* api.shopSnapshot(withCookie(undefined), { key, sessionToken: "t" });
      assert.deepStrictEqual(answer, { caller: merchant, snapshot });
    }).pipe(Effect.provide(TestBackend())),
  );

  it.live.each([
    { status: 401, tag: "Unauthorized" },
    { status: 403, tag: "Forbidden" },
    { status: 404, tag: "NotAShopMember" },
  ] as const)("the gate's $status is $tag", ({ status, tag }) =>
    Effect.gen(function* () {
      const api = yield* BackendApi;
      const error = yield* api.shopSnapshot(withCookie(undefined), { key }).pipe(Effect.flip);
      assert.strictEqual(error._tag, tag);
    }).pipe(Effect.provide(TestBackend({ gate: Effect.fail(new ShopAccessDenied({ status })) }))),
  );

  it.live("the gate's 503 is a defect", () =>
    Effect.gen(function* () {
      const api = yield* BackendApi;
      const exit = yield* api.shopSnapshot(withCookie(undefined), { key }).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(exit) && Cause.hasDies(exit.cause));
    }).pipe(
      Effect.provide(TestBackend({ gate: Effect.fail(new ShopAccessDenied({ status: 503 })) })),
    ),
  );
});
