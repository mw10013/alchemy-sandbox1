import { Memory } from "@alchemy.run/better-auth";
import { assert, describe, it } from "@effect/vitest";
import { RuntimeContext } from "alchemy";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as References from "effect/References";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcTest from "effect/rpc/RpcTest";
import * as Schema from "effect/Schema";
import { BackendRpcs, EmailFromInput, ReturnPath, type Member } from "../api/backend.ts";
import { SANDBOX_SHOP, type ShopKey } from "../api/shop.ts";
import { Auth } from "./auth.ts";
import { BackendHandlers, SignInLimiter } from "./handlers.ts";
import { MagicLinkDelivery } from "./magic-link-delivery.ts";
import { Mailer, SentMail } from "./mailer.ts";
import { SystemActors } from "./actor-client.ts";
import { Members } from "./members.ts";
import { ShopAccess } from "./shop-access.ts";
import { Tickets } from "./ticket.ts";
import { CurrentUserLive, RequireAdminLive } from "./middleware.ts";

const ORIGIN = "http://test.local";
const email = Schema.decodeUnknownSync(EmailFromInput);
const returnPath = Schema.decodeUnknownSync(ReturnPath);

const admin = email("a@a.com");
const member = email("m1@m.com");
const stranger = email("nobody@example.com");
const member2 = email("m2@m.com");
/** Baton's `Member` rows. The operator has none: it is a user row with the role `admin`. */
const members: ReadonlyArray<Member> = [
  { id: "mem-1", shop: SANDBOX_SHOP, email: member, createdAt: 1 },
  { id: "mem-2", shop: SANDBOX_SHOP, email: member2, createdAt: 2 },
];

/** What the Better Auth hooks asked the actors to revoke; cleared by the tests that read it. */
const revoked: Array<{ key: ShopKey; by: "member" | "session"; id: string }> = [];

/**
 * The Backend's RPC layers over Better Auth on an in-memory database, fresh per test.
 * `delivery` is the stage's {@link MagicLinkDelivery} choice; `allow` is the rate limiter's
 * answer. The test owns every effect of the Backend, the logger included: `Info` is dropped,
 * so only a warning or error reaches the test output.
 */
const TestBackend = ({
  delivery,
  allow = true,
}: {
  delivery: "inline" | "mailed";
  allow?: boolean;
}) =>
  Layer.mergeAll(BackendHandlers, CurrentUserLive, RequireAdminLive).pipe(
    Layer.provideMerge(
      Auth.layerWith({ secret: "test-secret-test-secret-test-secret" }).pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            Members.layerTest(members),
            SystemActors.layerTest(revoked),
            SignInLimiter.layerTest(allow),
            Layer.succeed(ShopAccess, { resolve: () => Effect.die("ShopAccess needs D1") }),
            Tickets.layerWith(Redacted.make("test-ticket-secret")),
            (delivery === "inline"
              ? MagicLinkDelivery.layerInline
              : MagicLinkDelivery.layerMailed
            ).pipe(Layer.provideMerge(Mailer.layerTest)),
          ),
        ),
        Layer.provide(Memory()),
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ AUTH_ORIGIN: ORIGIN }))),
      ),
    ),
    Layer.provide(RuntimeContext.phantom),
    Layer.provide(Layer.succeed(References.MinimumLogLevel, "Warn")),
  );

/** Serves one web `Request` through Better Auth's routes, as the Worker's `fetch` would. */
const serve = Effect.fn("serve")(function* (request: Request) {
  const { auth } = yield* Auth;
  const response = yield* auth.fetch.pipe(
    Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(request)),
    Effect.provide(RuntimeContext.phantom),
  );
  return HttpServerResponse.toWeb(response);
});

const toCookieHeader = (setCookies: ReadonlyArray<string>) =>
  setCookies.map((cookie) => cookie.split(";")[0]).join("; ");

/** Requests a link for `address` and follows it; returns the cookie header of the new session. */
const signIn = Effect.fn("signIn")(function* (address: typeof member, returnTo = "/app") {
  const client = yield* RpcTest.makeClient(BackendRpcs);
  const { link } = yield* client.RequestMagicLink({
    email: address,
    returnTo: returnPath(returnTo),
  });
  assert.isTrue(Option.isSome(link), "inline delivery returns the link");
  const response = yield* serve(new Request(Option.getOrThrow(link)));
  assert.strictEqual(response.status, 302);
  assert.strictEqual(new URL(response.headers.get("location") ?? "").pathname, returnTo);
  return toCookieHeader(response.headers.getSetCookie());
});

/**
 * Inserts the operator's user row, as the seed does on a deployed stage. Straight through the
 * adapter, because Better Auth's create hooks refuse an address with no `Member` row.
 */
const seedOperator = Effect.gen(function* () {
  const { auth } = yield* Auth;
  const instance = yield* auth.auth.pipe(Effect.provide(RuntimeContext.phantom));
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

describe("magic-link sign-in (inline delivery)", () => {
  it.live.each([
    { address: member, role: "user" },
    { address: admin, role: "admin" },
  ])(
    "a member signs in as a new user; the seeded operator keeps its role (%#)",
    ({ address, role }) =>
      Effect.gen(function* () {
        yield* seedOperator;
        const cookie = yield* signIn(address);
        const client = yield* RpcTest.makeClient(BackendRpcs);
        const me = yield* client.Me().pipe(RpcClient.withHeaders({ cookie }));
        assert.strictEqual(me.email, address);
        assert.strictEqual(me.role, role);
      }).pipe(Effect.provide(TestBackend({ delivery: "inline" }))),
  );

  it.live("a non-member gets no link and no mail", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(BackendRpcs);
      const { link } = yield* client.RequestMagicLink({ email: stranger });
      assert.isTrue(Option.isNone(link));
      assert.deepStrictEqual(yield* Ref.get(yield* SentMail), []);
    }).pipe(Effect.provide(TestBackend({ delivery: "inline" }))),
  );

  it.live("a non-member's link, obtained directly, is refused at verify", () =>
    Effect.gen(function* () {
      const { auth } = yield* Auth;
      const { take } = yield* MagicLinkDelivery;
      yield* auth.api
        .signInMagicLink({ body: { email: stranger, callbackURL: "/app" }, headers: new Headers() })
        .pipe(Effect.provide(RuntimeContext.phantom));
      const link = yield* take(stranger);
      const response = yield* serve(new Request(Option.getOrThrow(link)));
      assert.strictEqual(response.status, 302);
      const location = new URL(response.headers.get("location") ?? "");
      assert.strictEqual(location.searchParams.get("error"), "not_invited");
      assert.deepStrictEqual(response.headers.getSetCookie(), [], "no session was created");
    }).pipe(Effect.provide(TestBackend({ delivery: "inline" }))),
  );

  it.live("sign-out ends the session and revokes its sockets on the member's shops", () =>
    Effect.gen(function* () {
      const cookie = yield* signIn(member);
      revoked.length = 0;
      const client = yield* RpcTest.makeClient(BackendRpcs);
      const response = yield* serve(
        new Request(`${ORIGIN}/api/auth/sign-out`, {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: "{}",
        }),
      );
      assert.strictEqual(response.status, 200);
      const error = yield* client.Me().pipe(RpcClient.withHeaders({ cookie }), Effect.flip);
      assert.strictEqual(error._tag, "Unauthorized");
      assert.deepStrictEqual(
        revoked.map(({ key, by }) => ({ key, by })),
        [{ key: SANDBOX_SHOP, by: "session" }],
      );
    }).pipe(Effect.provide(TestBackend({ delivery: "inline" }))),
  );
});

describe("guards", () => {
  it.live("Me without a session is Unauthorized", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(BackendRpcs);
      const error = yield* client.Me().pipe(Effect.flip);
      assert.strictEqual(error._tag, "Unauthorized");
    }).pipe(Effect.provide(TestBackend({ delivery: "inline" }))),
  );

  it.live("ListMembers needs an admin", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(BackendRpcs);
      const asMember = yield* signIn(member);
      const error = yield* client
        .ListMembers()
        .pipe(RpcClient.withHeaders({ cookie: asMember }), Effect.flip);
      assert.strictEqual(error._tag, "Forbidden");
      yield* seedOperator;
      const asAdmin = yield* signIn(admin);
      const list = yield* client.ListMembers().pipe(RpcClient.withHeaders({ cookie: asAdmin }));
      assert.deepStrictEqual(
        list.map((row) => row.email),
        [member, member2],
      );
    }).pipe(Effect.provide(TestBackend({ delivery: "inline" }))),
  );
});

describe("magic-link sign-in (mail delivery)", () => {
  it.live("a member is mailed the link and gets none back", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(BackendRpcs);
      const { link } = yield* client.RequestMagicLink({ email: member });
      assert.isTrue(Option.isNone(link));
      const [mail, ...rest] = yield* Ref.get(yield* SentMail);
      assert.deepStrictEqual(rest, []);
      assert.strictEqual(mail?.to, member);
      assert.include(mail?.text, `${ORIGIN}/api/auth/magic-link/verify?token=`);
    }).pipe(Effect.provide(TestBackend({ delivery: "mailed" }))),
  );

  it.live("the rate limit refuses before anything is sent", () =>
    Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(BackendRpcs);
      const error = yield* client.RequestMagicLink({ email: member }).pipe(Effect.flip);
      assert.strictEqual(error._tag, "TooManyRequests");
      assert.deepStrictEqual(yield* Ref.get(yield* SentMail), []);
    }).pipe(Effect.provide(TestBackend({ delivery: "mailed", allow: false }))),
  );
});
