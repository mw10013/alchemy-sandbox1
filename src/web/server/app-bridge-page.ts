/**
 * The App Bridge-only document the two auth routes serve. Its own module, apart from the
 * middleware and server functions: it reads the Website's bindings in plain code, which only a
 * server route may import; `app.tsx` renders on the client and imports only server functions,
 * whose bodies Start strips from the client build.
 *
 * @module
 */
import * as Option from "effect/Option";
import { APP_BRIDGE_URL, CDN_URL, POLARIS_URL } from "../components/polaris.ts";
import { env } from "./env.server.ts";
import { frameAncestors } from "./shopify-urls.ts";

/**
 * Baton's App Bridge-only document: App Bridge and nothing else, plus `script` when given. On
 * `/auth/session-token` App Bridge reads `shopify-reload` from the URL and reloads the app with a
 * fresh `id_token`; with neither, it re-embeds a page the admin lost. With a valid `shop` it
 * carries the frame CSP and Baton's preconnect and preload `Link` header.
 */
export const appBridgePage = (shop: unknown, script = ""): Response => {
  const headers = new Headers({ "content-type": "text/html;charset=utf-8" });
  const csp = frameAncestors(shop);
  if (Option.isSome(csp)) {
    headers.set("Content-Security-Policy", csp.value);
    headers.set(
      "Link",
      `<${CDN_URL}>; rel="preconnect", <${APP_BRIDGE_URL}>; rel="preload"; as="script", <${POLARIS_URL}>; rel="preload"; as="script"`,
    );
  }
  return new Response(
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="shopify-api-key" content="${env.SHOPIFY_API_KEY}"><script src="${APP_BRIDGE_URL}"></script>${script}</head><body></body></html>`,
    { headers },
  );
};
