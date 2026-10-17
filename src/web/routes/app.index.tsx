import { createFileRoute, useLocation } from "@tanstack/react-router";
import { useNavigateOnClick } from "../components/navigate.ts";

/**
 * The App Home's landing page: the shop, and the way to Orders. The link keeps the raw search
 * Shopify sent, because the `/app` guards read it on every navigation (`appSearch`).
 */
export const Route = createFileRoute("/app/")({
  component: function AppHome() {
    const { shop } = Route.useRouteContext();
    const searchStr = useLocation({ select: (location) => location.searchStr });
    const navigate = useNavigateOnClick();
    return (
      <s-page heading="Baton">
        <s-section heading={shop}>
          <s-link {...navigate(`/app/orders${searchStr}`)}>Orders</s-link>
        </s-section>
      </s-page>
    );
  },
});
