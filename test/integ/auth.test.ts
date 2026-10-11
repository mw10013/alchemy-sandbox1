import { assert } from "@effect/vitest";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Vitest";
import * as Effect from "effect/Effect";
import * as Cookies from "effect/http/Cookies";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Option from "effect/Option";
import * as RpcClient from "effect/rpc/RpcClient";
import * as Schema from "effect/Schema";
import { BackendRpcs, EmailFromInput } from "../../src/api/backend.ts";
import Stack from "./stack.ts";

/**
 * Deploys the Backend into workerd with the local D1 (migrations and the test seed) and drives
 * the magic-link flow over HTTP. `dev` is not set here: the `integ` Vitest project sets
 * `ALCHEMY_DEV=1`, which the harness reads, and which the Worker's init reads at plan to choose
 * inline link delivery.
 */
const { test, beforeAll, deploy } = Test.make({
  providers: Cloudflare.providers(),
});

/**
 * Never destroyed. The stack is local and lives under this checkout's `.alchemy/`, so a reused
 * stack makes a re-run a no-op deploy, and `destroy` of a dev-mode stack hangs past the hook
 * timeout on Alchemy 2.0.0-beta.81.
 */
const stack = beforeAll(deploy(Stack));

/**
 * The link against the Backend that is running now. The Backend takes a free port per start,
 * and a redeploy resolves the AuthOrigin binding from the previous run's URL, so a link from a
 * reused stack names a dead port; only its path and query carry the token.
 */
const atBackend = (link: string, backendUrl: string) => {
  const url = new URL(link);
  assert.strictEqual(url.pathname, "/api/auth/magic-link/verify");
  return new URL(url.pathname + url.search, backendUrl).toString();
};

const member = Schema.decodeUnknownSync(EmailFromInput)("m1@m.com");

test(
  "a seeded member signs in with a magic link and is the current user",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    yield* Effect.gen(function* () {
      const client = yield* RpcClient.make(BackendRpcs);
      const { link } = yield* client.RequestMagicLink({ email: member });
      assert.isTrue(Option.isSome(link), "inline delivery returns the link");

      // The verify response is a redirect that sets the session cookie; do not follow it.
      const verify = yield* HttpClient.get(atBackend(Option.getOrThrow(link), backendUrl)).pipe(
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
      );
      assert.strictEqual(verify.status, 302);
      const cookie = Cookies.toCookieHeader(verify.cookies);
      assert.isNotEmpty(cookie);

      const me = yield* client.Me().pipe(RpcClient.withHeaders({ cookie }));
      assert.strictEqual(me.email, member);
      assert.strictEqual(me.role, "user");
    }).pipe(Effect.provide(Test.rpcClientLayer(`${backendUrl}/rpc`)));
  }),
);

test(
  "Me without a session is Unauthorized",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    const error = yield* Effect.gen(function* () {
      const client = yield* RpcClient.make(BackendRpcs);
      return yield* client.Me();
    }).pipe(Effect.provide(Test.rpcClientLayer(`${backendUrl}/rpc`)), Effect.flip);
    assert.strictEqual(error._tag, "Unauthorized");
  }),
);
