import { toRpcAsync } from "alchemy/Cloudflare/Bridge";
import { getRequestHeader } from "@tanstack/react-start/server";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { RequestInfo } from "../api/backend.ts";
import type Backend from "../backend/worker.ts";
import { env } from "../env.server.ts";

/** The Backend through the service binding, read at call time; see `env`. */
export const backend = () => toRpcAsync<Backend>(env.BACKEND);

/** The fields of the visitor's request the Backend may see. */
export const requestInfo = (): RequestInfo => ({
  cookie: getRequestHeader("cookie"),
  ip: getRequestHeader("cf-connecting-ip"),
});

/**
 * A Backend call's typed failure, back as its class: the binding rethrows a failure as the
 * plain `{ _tag, ...fields }` object, which `failures` (a union of the error classes the
 * method declares) decodes. Anything that does not decode, a defect included, is rethrown, and
 * the route error boundary shows it.
 *
 * @example
 * const me = await backend().me(requestInfo()).catch(rescue(Unauthorized, () => null));
 */
export const rescue =
  <S extends Schema.Top & { readonly DecodingServices: never }, A>(
    failures: S,
    onFailure: (failure: S["Type"]) => A,
  ) =>
  (error: unknown): A =>
    Option.match(Schema.decodeUnknownOption(failures)(error), {
      onNone: () => {
        throw error;
      },
      onSome: onFailure,
    });
