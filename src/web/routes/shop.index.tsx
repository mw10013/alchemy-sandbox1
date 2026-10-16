import { createFileRoute } from "@tanstack/react-router";
import { SEED_SHOP } from "../../contract/shop.ts";
import { useNavigateOnClick } from "../components/navigate.ts";

export const Route = createFileRoute("/shop/")({
  component: function MemberHome() {
    const navigate = useNavigateOnClick();
    return (
      <s-page heading="Member area" inlineSize="small">
        <s-section heading="Shops">
          <s-link {...navigate(`/shop/${SEED_SHOP}`)}>{SEED_SHOP}</s-link>
        </s-section>
      </s-page>
    );
  },
});
