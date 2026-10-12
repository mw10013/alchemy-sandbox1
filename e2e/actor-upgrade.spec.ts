import http from "node:http";
import { SANDBOX_SHOP } from "../src/api/shop.ts";
import { expect, test } from "./fixtures.ts";

test.use({ storageState: "playwright/.auth/member.json" });

/**
 * Whether a WebSocket upgrade with the given headers opens. A browser cannot set `Origin`, and
 * Node's fetch refuses an `upgrade` header, so the handshake goes through node:http. Under
 * `alchemy dev` a refused upgrade reaches the client as a dropped connection, not as its status
 * (the 403 does not survive the dev server), so only open or not is observable.
 */
const upgradeOpens = (url: string, headers: Record<string, string>) =>
  new Promise<boolean>((resolve) => {
    const request = http.get(url, {
      headers: {
        ...headers,
        upgrade: "websocket",
        connection: "Upgrade",
        "sec-websocket-version": "13",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      },
    });
    request.on("response", (response) => {
      response.resume();
      resolve(false);
    });
    request.on("upgrade", (_, socket) => {
      socket.destroy();
      resolve(true);
    });
    request.on("error", () => resolve(false));
  });

test("an upgrade from another site is refused, and the same one from this site opens", async ({
  baseURL,
  context,
}) => {
  if (baseURL === undefined) throw new Error("use.baseURL is not set");
  const url = new URL(`/api/actor/${SANDBOX_SHOP}`, baseURL);
  const cookie = (await context.cookies(url.toString()))
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");

  expect(await upgradeOpens(url.toString(), { cookie, origin: "https://evil.example" })).toBe(
    false,
  );
  expect(await upgradeOpens(url.toString(), { cookie, origin: url.origin })).toBe(true);
});
