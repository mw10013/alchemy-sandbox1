/**
 * The Polaris web components bundle every page loads, and the only place its URL is written.
 *
 * Pinned to the 2.0 release candidate, with `@shopify/polaris-types` pinned to the matching
 * `2.0.0-rc.*` exactly: Shopify publishes the stable release at a new URL rather than updating
 * this one, so moving to stable 2.x changes this constant and the types package together. No
 * App Bridge loads beside it, so Polaris renders its standalone "Admin Next" look, light only.
 * The `polaris` ref snapshots the bundle from this same URL.
 *
 * @see https://shopify.dev/docs/api/app-home/v2.0-rc/web-components
 */
export const POLARIS_URL = "https://cdn.shopify.com/shopifycloud/polaris-2.0-rc.js";
