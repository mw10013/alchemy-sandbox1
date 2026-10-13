import { assert } from "@effect/vitest";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Vitest";
import * as Effect from "effect/Effect";
import * as Cookies from "effect/http/Cookies";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Schema from "effect/Schema";
import { EmailFromInput } from "../../src/api/backend.ts";
import { control } from "./actor-clients.ts";
import Stack from "./stack.ts";

/**
 * Deploys the Backend into workerd with the local D1 (migrations and the test seed) and drives
 * the magic-link flow over HTTP. `dev` is not set here: the `integ` Vitest project sets
 * `ALCHEMY_DEV=1`, which the harness reads; the stack binds inline link delivery itself.
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

/** The part of Better Auth's `get-session` answer this test reads. */
const Session = Schema.Struct({
  user: Schema.Struct({ email: Schema.String, role: Schema.String }),
});

test(
  "a seeded member signs in with a magic link and the session names them",
  Effect.gen(function* () {
    const { backendUrl, e2eToken } = yield* stack;
    const { link } = yield* control(backendUrl, e2eToken, (c) =>
      c.IssueMagicLink({ email: member }),
    );

    // The verify response is a redirect that sets the session cookie; do not follow it.
    const verify = yield* HttpClient.get(atBackend(link, backendUrl)).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
    );
    assert.strictEqual(verify.status, 302);
    const cookie = Cookies.toCookieHeader(verify.cookies);
    assert.isNotEmpty(cookie);

    const session = yield* HttpClient.execute(
      HttpClientRequest.get(`${backendUrl}/api/auth/get-session`).pipe(
        HttpClientRequest.setHeader("cookie", cookie),
      ),
    ).pipe(Effect.flatMap(HttpClientResponse.schemaBodyJson(Session)));
    assert.strictEqual(session.user.email, member);
    assert.strictEqual(session.user.role, "user");
  }).pipe(Effect.provide(FetchHttpClient.layer)),
);
