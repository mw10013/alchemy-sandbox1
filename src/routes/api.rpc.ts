import { createFileRoute } from "@tanstack/react-router";
import { env } from "../env.server.ts";

// RPC payloads are small JSON; file uploads will not go through RPC.
const MAX_RPC_BODY_BYTES = 64 * 1024;

const text = (status: number, body: string, headers?: Record<string, string>) =>
  new Response(body, { status, headers: { "content-type": "text/plain", ...headers } });

// Rejects bad requests before they reach the Backend. content-length can lie and the Backend
// still reads the body: this stops honest oversize requests and garbage, not a hard memory limit.
const rejectRequest = (request: Request): Response | undefined => {
  const mediaType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (mediaType !== "application/ndjson") return text(415, "Unsupported Media Type");
  const contentLength = request.headers.get("content-length");
  if (contentLength === null) return text(411, "Length Required");
  if (!/^\d+$/.test(contentLength) || Number(contentLength) === 0) return text(400, "Bad Request");
  if (Number(contentLength) > MAX_RPC_BODY_BYTES) return text(413, "Payload Too Large");
  return undefined;
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
