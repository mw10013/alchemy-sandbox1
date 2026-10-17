import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Where the admin link extension's Open in Baton lands, with the order's `id` beside the
 * embedded handshake's parameters (`shop`, `host`, `embedded`, `id_token` and the rest). It
 * redirects to the orders list with every parameter but `id`, forwarded verbatim from the raw
 * search: App Bridge boots from them and the `/app` guards read them, and an allow-list would drop
 * whatever Shopify adds next. The `/app` guards have already run, since the route sits under
 * `app.tsx`.
 *
 * The list is the target until the order page arrives with runs; then `id` (a legacy id, or a
 * GID whose last segment is one) names the order page to open instead.
 */
export const Route = createFileRoute("/app/orders/from-shopify")({
  beforeLoad: ({ location }) => {
    const search = new URLSearchParams(location.searchStr);
    search.delete("id");
    const rest = search.toString();
    throw redirect({ href: rest === "" ? "/app/orders" : `/app/orders?${rest}` });
  },
});
