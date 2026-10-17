/**
 * Whether an actor upgrade comes from another site: its `Origin` is present and is not the
 * request's own. Browsers always send `Origin` on a WebSocket upgrade and a page cannot change it,
 * so refusing these stops another site from opening a socket with the visitor's cookie. A request
 * with no `Origin` is not a browser's cross-site one, and the Backend's gate still decides who it
 * is.
 */
export const isCrossSiteUpgrade = (request: Request): boolean => {
  const origin = request.headers.get("origin");
  return origin !== null && origin !== new URL(request.url).origin;
};
