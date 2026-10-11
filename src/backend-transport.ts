import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequestHeader } from "@tanstack/react-start/server";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import { env } from "./env.server.ts";

/** SSR goes through the service binding in-process and forwards the visitor's cookie. */
const serverFetch: typeof fetch = (input, init) => {
  const headers = new Headers(init?.headers);
  const cookie = getRequestHeader("cookie");
  if (cookie) headers.set("cookie", cookie);
  return env.BACKEND.fetch(input, { ...init, headers });
};

/**
 * The HTTP client an RPC client posts with: the browser's `fetch` on the client, the `BACKEND`
 * binding with the visitor's cookie on the server. The binding ignores the request's host, so
 * an SSR caller may use any absolute URL; see `Backend`.
 */
export const backendTransport = createIsomorphicFn()
  .client(() => FetchHttpClient.layer)
  .server(() =>
    FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch)(serverFetch))),
  );
