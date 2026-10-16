import { abstractFetch, setAbstractFetchFunc } from "@shopify/shopify-api/runtime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** One HTTP call the library made, as the stub saw it. */
export interface StubbedCall {
  readonly path: string;
  /** The OAuth `grant_type`, when the call is to the token endpoint. */
  readonly grantType: string | undefined;
  /** The presented refresh token, when the grant is `refresh_token`. */
  readonly refreshToken: string | undefined;
}

/** What a test says in reply: a `Response`, possibly after side effects of its own. */
export type StubReply = (call: StubbedCall, attempt: number) => Response | Promise<Response>;

/** The fields of a token endpoint request the stub reads. */
const TokenRequest = Schema.fromJsonString(
  Schema.Struct({
    grant_type: Schema.optional(Schema.String),
    refresh_token: Schema.optional(Schema.String),
  }),
);
const decodeTokenRequest = Schema.decodeUnknownSync(TokenRequest);

const TOKEN_PATH = "/admin/oauth/access_token";
const REFRESH_GRANT = "refresh_token";

/** A token endpoint success body. */
export const accessTokenBody = (over?: Record<string, unknown>) => ({
  access_token: "shpat_new",
  expires_in: 3600,
  refresh_token: "shprt_new",
  refresh_token_expires_in: 7_776_000,
  scope: "read_products",
  ...over,
});

export const jsonResponse = (status: number, body: unknown) => Response.json(body, { status });

/**
 * Runs `effect` with the library's HTTP replaced by `reply`, then restores it. The library has
 * one module-global fetch, so a test file that stubs it must run its stubbing tests in series,
 * which Vitest does within a file. Every call is recorded in `calls`.
 */
export const withShopifyStub = <A, E, R>(
  reply: StubReply,
  use: (calls: Array<StubbedCall>) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const original = abstractFetch;
      const calls: Array<StubbedCall> = [];
      setAbstractFetchFunc(((url: string, options?: RequestInit) => {
        const path = new URL(url).pathname;
        const body: typeof TokenRequest.Type =
          typeof options?.body === "string" && path === TOKEN_PATH
            ? decodeTokenRequest(options.body)
            : {};
        const call: StubbedCall = {
          path,
          grantType: body.grant_type,
          refreshToken: body.grant_type === REFRESH_GRANT ? body.refresh_token : undefined,
        };
        const attempt = calls.length;
        calls.push(call);
        return Promise.resolve(reply(call, attempt));
      }) as typeof abstractFetch);
      return { original, calls };
    }),
    ({ calls }) => use(calls),
    ({ original }) =>
      Effect.sync(() => {
        setAbstractFetchFunc(original);
      }),
  );
