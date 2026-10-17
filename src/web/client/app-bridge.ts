import * as Effect from "effect/Effect";

/**
 * The part of App Bridge's `shopify` global the embedded pages call. App Bridge defines it in
 * the embedded App Home only (its script is the `/app` document's first), and in the browser
 * only, so nothing reads it during SSR.
 *
 * @see https://shopify.dev/docs/api/app-home/apis
 */
export interface AppBridge {
  /** A fresh session token for this shop, valid for about a minute. */
  readonly idToken: () => Promise<string>;
  readonly toast: {
    readonly show: (
      message: string,
      options?: { readonly isError?: boolean; readonly duration?: number },
    ) => void;
  };
}

declare global {
  var shopify: AppBridge;
}

/**
 * A session token minted for each use: the merchant socket's credential on every connect, since a
 * browser cannot set a header on a WebSocket upgrade and a token outlives no reconnect after a
 * minute.
 */
export const mintSessionToken: Effect.Effect<string> = Effect.promise(() =>
  globalThis.shopify.idToken(),
);

/** A toast in the Shopify admin's chrome; `isError` for a press that failed. */
export const toast = (message: string, options?: { readonly isError?: boolean }) =>
  globalThis.shopify.toast.show(message, options);
