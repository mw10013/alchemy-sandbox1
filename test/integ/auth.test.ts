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
import { EmailFromInput } from "../../src/contract/auth.ts";
import { integ } from "./actor-clients.ts";
import { fileStage } from "./file-stage.ts";
import Stack from "./stack.ts";

/**
 * Deploys the Backend into workerd with the local D1 (migrations and the test seed) and drives
 * the magic-link flow over HTTP. `dev` is not set here: the `integ` Vitest project sets
 * `ALCHEMY_DEV=1`, which the harness reads; the stack binds inline link delivery itself.
 */
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  stage: fileStage("auth"),
});

/**
 * Each file deploys its own stage ({@link fileStage}) and destroys it when done: the seed is the only data a file
 * starts with, so nothing one run changes reaches the next. `NO_DESTROY=1` keeps the stage for
 * inspecting after a failure.
 */
const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

const member = Schema.decodeUnknownSync(EmailFromInput)("m1@m.com");

/** The part of Better Auth's `get-session` answer this test reads. */
const Session = Schema.Struct({
  user: Schema.Struct({ email: Schema.String, role: Schema.String }),
});

test(
  "a seeded member signs in with a magic link and the session names them",
  Effect.gen(function* () {
    const { backendUrl } = yield* stack;
    const { link } = yield* integ(backendUrl, (c) => c.IssueMagicLink({ email: member }));

    // The verify response is a redirect that sets the session cookie; do not follow it.
    const verify = yield* HttpClient.get(link).pipe(
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
