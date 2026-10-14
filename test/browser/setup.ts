import { POLARIS_URL } from "../../src/web/components/polaris.ts";

/**
 * Loads Polaris from the CDN URL the site uses before any browser test renders, so a component
 * test sees the same `s-*` elements a page does. The test page has no server-rendered document
 * to carry the head script, so this appends it and waits for the elements to be defined. It
 * needs network access to `cdn.shopify.com`.
 */
await new Promise<void>((resolve, reject) => {
  const script = document.createElement("script");
  script.src = POLARIS_URL;
  script.addEventListener("load", () => resolve());
  script.addEventListener("error", () =>
    reject(new Error(`Polaris failed to load: ${POLARIS_URL}`)),
  );
  document.head.appendChild(script);
});
await customElements.whenDefined("s-page");
