import { createFileRoute } from "@tanstack/react-router";
import { SANDBOX_SHOP } from "../api/shop.ts";
import { useNavigateOnClick } from "../navigate.ts";

export const Route = createFileRoute("/app/")({
  component: function MemberHome() {
    const navigate = useNavigateOnClick();
    return (
      <s-page heading="Member area" inlineSize="small">
        <s-section heading="Shops">
          <s-link {...navigate(`/app/shop/${SANDBOX_SHOP}`)}>{SANDBOX_SHOP}</s-link>
        </s-section>
      </s-page>
    );
  },
});
