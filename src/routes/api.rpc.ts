import { createFileRoute } from "@tanstack/react-router";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { env } from "../env.server.ts";

// RPC payloads are small JSON; file uploads will not go through RPC.
const MAX_RPC_BODY_BYTES = 64 * 1024;

const NdjsonMediaType = Schema.String.check(Schema.isPattern(/^application\/ndjson\s*(?:;.*)?$/iu));
const BodyLength = Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThan(0));

// What the proxy forwards: an ndjson body whose declared length is positive and within the cap.
const RpcRequestHeaders = Schema.Struct({
  "content-type": NdjsonMediaType,
  "content-length": BodyLength.check(Schema.isLessThanOrEqualTo(MAX_RPC_BODY_BYTES)),
});
const OversizeBodyLength = BodyLength.check(Schema.isGreaterThan(MAX_RPC_BODY_BYTES));

const accepts =
  <S extends Schema.ConstraintDecoder<unknown>>(schema: S) =>
  (input: unknown) =>
    Option.isSome(Schema.decodeUnknownOption(schema)(input));

const text = (status: number, body: string, headers?: Record<string, string>) =>
  new Response(body, { status, headers: { "content-type": "text/plain", ...headers } });

// Rejects bad requests before they reach the Backend. content-length can lie and the Backend
// still reads the body: this stops honest oversize requests and garbage, not a hard memory limit.
const rejectRequest = (request: Request): Response | undefined => {
  const headers = Object.fromEntries(request.headers);
  if (accepts(RpcRequestHeaders)(headers)) return undefined;
  if (!accepts(NdjsonMediaType)(headers["content-type"]))
    return text(415, "Unsupported Media Type");
  if (accepts(OversizeBodyLength)(headers["content-length"])) return text(413, "Payload Too Large");
  return text(400, "Bad Request");
};

// Browser → Website → Backend. The binding ignores the host; RpcServer ignores the path.
export const Route = createFileRoute("/api/rpc")({
  server: {
    handlers: {
      POST: ({ request }) => rejectRequest(request) ?? env.BACKEND.fetch(request),
      // WebSocket upgrades are GETs too; they get 405 until the Durable Object phase.
      GET: () => text(405, "Method Not Allowed", { allow: "POST" }),
    },
  },
});
