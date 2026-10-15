import { redirect } from "@tanstack/react-router";
import { createMiddleware, createServerFn } from "@tanstack/react-start";
import { getRequest, getRequestHeader } from "@tanstack/react-start/server";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { InvalidSessionToken } from "../../contract/shop.ts";
import { backend, requestInfo, rescue } from "./backend.ts";
import { env } from "./env.server.ts";
import { sessionTokenBounce } from "./shopify-urls.ts";

/** `Authorization: Bearer <token>`, the header App Bridge adds to the embedded page's fetches. */
const Bearer = Schema.TemplateLiteralParser(["Bearer ", Schema.String]);
const decodeBearer = Schema.decodeUnknownOption(Bearer);
const decodeToken = Schema.decodeUnknownOption(Schema.NonEmptyString);

/** A server function's data carrying the document's `id_token`, as `authenticateApp` takes it. */
const IdTokenData = Schema.Struct({ idToken: Schema.NonEmptyString });
const decodeIdTokenData = Schema.decodeUnknownOption(IdTokenData);

/** The header App Bridge answers by retrying the request with a fresh session token. */
const RETRY_INVALID_SESSION_HEADER = "X-Shopify-Retry-Invalid-Session-Request";

/** A browser's server-function call, which TanStack Start's client marks; never authentication. */
const isServerFnCall = () => getRequestHeader("x-tsr-serverFn") === "true";

/**
 * What an embedded request gets when its session token is missing or refused: with a bearer,
 * `401` and {@link RETRY_INVALID_SESSION_HEADER}, so App Bridge retries with a fresh token; a
 * browser's server-function call without one, a bare `401` (Baton's guard: there is no document
 * to bounce); a document, the session-token bounce, which reloads the page with a new
 * `id_token`.
 */
const refuse = (bearer: boolean): never => {
  if (bearer)
    throw new Response(null, { status: 401, headers: { [RETRY_INVALID_SESSION_HEADER]: "1" } });
  if (isServerFnCall()) throw new Response(null, { status: 401 });
  const url = new URL(getRequest().url);
  throw redirect({ href: sessionTokenBounce(env.SHOPIFY_APP_URL, url.pathname, url.search) });
};

/**
 * Baton's `ShopifyServerFnMiddleware`: authenticates the embedded admin before a server function
 * runs and puts its shop in context. The session token is the bearer App Bridge adds to every
 * same-origin `fetch` from the embedded page, else the `idToken` in the function's data, which is
 * how the document's `id_token` arrives when `beforeLoad` calls the function in-process during
 * SSR. The Backend verifies and exchanges it; a refusal is {@link refuse}.
 */
export const shopifyAdmin = createMiddleware({ type: "function" }).server(
  async ({ next, data }) => {
    const bearer = Option.flatMap(decodeBearer(getRequestHeader("authorization")), ([, token]) =>
      decodeToken(token),
    );
    const sessionToken = Option.orElse(bearer, () =>
      Option.map(decodeIdTokenData(data), ({ idToken }) => idToken),
    );
    if (Option.isNone(sessionToken)) return refuse(Option.isSome(bearer));
    const session = await backend()
      .authenticateAdmin(requestInfo(), { sessionToken: sessionToken.value })
      .catch(rescue(InvalidSessionToken, () => refuse(Option.isSome(bearer))));
    return next({ context: { shop: session.shop, shopGid: session.shopGid } });
  },
);

/** `authenticateApp`'s input: the document's `id_token`, absent on a call App Bridge made. */
const AuthenticateAppInput = Schema.Struct({ idToken: Schema.optional(Schema.NonEmptyString) });

/** The App Home's authenticated admin: its shop, and the API key for App Bridge's meta tag. */
export const authenticateApp = createServerFn({ method: "GET" })
  .middleware([shopifyAdmin])
  .validator(Schema.toStandardSchemaV1(AuthenticateAppInput))
  .handler(({ context }) => ({ shop: context.shop, apiKey: env.SHOPIFY_API_KEY }));

/**
 * The app's API key and public URL, from the Website's bindings, for the App Home's guards that
 * run before any token is checked.
 */
export const getShopifyApp = createServerFn({ method: "GET" }).handler(() => ({
  apiKey: env.SHOPIFY_API_KEY,
  appUrl: env.SHOPIFY_APP_URL,
}));
