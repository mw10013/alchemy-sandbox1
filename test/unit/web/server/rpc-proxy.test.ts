import { assert, describe, it } from "@effect/vitest";
import { rejectRequest } from "../../../../src/web/server/rpc-proxy.ts";

/** A POST to the dev route with the given headers; the body itself is never read. */
const post = (headers: Record<string, string>) =>
  new Request("https://baton.example/api/dev", { method: "POST", headers });

const statusOf = (headers: Record<string, string>) => rejectRequest(post(headers))?.status;

describe("rejectRequest", () => {
  it.each([
    { "content-type": "application/ndjson", "content-length": "120" },
    { "content-type": "application/ndjson; charset=utf-8", "content-length": "65536" },
  ])("accepts an ndjson body of a declared length within the limit: %o", (headers) => {
    assert.isUndefined(rejectRequest(post(headers)));
  });

  it.each<Record<string, string>>([
    { "content-length": "120" },
    { "content-type": "application/json", "content-length": "120" },
    { "content-type": "text/plain", "content-length": "65537" },
  ])("refuses another media type with 415: %o", (headers) => {
    assert.strictEqual(statusOf(headers), 415);
  });

  it("refuses an ndjson body declared over the limit with 413", () => {
    assert.strictEqual(
      statusOf({ "content-type": "application/ndjson", "content-length": "65537" }),
      413,
    );
  });

  it.each<Record<string, string>>([
    { "content-type": "application/ndjson" },
    { "content-type": "application/ndjson", "content-length": "0" },
    { "content-type": "application/ndjson", "content-length": "1.5" },
    { "content-type": "application/ndjson", "content-length": "lots" },
  ])("refuses an ndjson body with no usable length with 400: %o", (headers) => {
    assert.strictEqual(statusOf(headers), 400);
  });
});
