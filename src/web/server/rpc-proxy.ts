import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** RPC payloads are small JSON; file uploads will not go through RPC. */
const MAX_RPC_BODY_BYTES = 64 * 1024;

const NdjsonMediaType = Schema.String.check(Schema.isPattern(/^application\/ndjson\s*(?:;.*)?$/iu));
const BodyLength = Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThan(0));

/**
 * What the proxy forwards: an ndjson body whose declared length is positive and within
 * {@link MAX_RPC_BODY_BYTES}.
 */
const RpcRequestHeaders = Schema.Struct({
  "content-type": NdjsonMediaType,
  "content-length": BodyLength.check(Schema.isLessThanOrEqualTo(MAX_RPC_BODY_BYTES)),
});
const OversizeBodyLength = BodyLength.check(Schema.isGreaterThan(MAX_RPC_BODY_BYTES));

const accepts =
  <S extends Schema.ConstraintDecoder<unknown>>(schema: S) =>
  (input: unknown) =>
    Option.isSome(Schema.decodeUnknownOption(schema)(input));

export const text = (status: number, body: string, headers?: Record<string, string>) =>
  new Response(body, { status, headers: { "content-type": "text/plain", ...headers } });

/**
 * Rejects bad requests before the test-control route forwards them to the Backend, the only
 * Effect RPC left on the Website. `content-length` can lie and the Backend still reads the
 * body, so this stops honest oversize requests and garbage; it is not a hard memory limit.
 */
export const rejectRequest = (request: Request): Response | undefined => {
  const headers = Object.fromEntries(request.headers);
  if (accepts(RpcRequestHeaders)(headers)) return undefined;
  if (!accepts(NdjsonMediaType)(headers["content-type"]))
    return text(415, "Unsupported Media Type");
  if (accepts(OversizeBodyLength)(headers["content-length"])) return text(413, "Payload Too Large");
  return text(400, "Bad Request");
};
