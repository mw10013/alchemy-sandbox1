import { createFileRoute } from "@tanstack/react-router";
import { Lines } from "../components/screen/Lines.tsx";
import { useNavigateOnClick } from "../components/navigate.ts";
import { listMyShops } from "../server/shop.ts";

/** The member's home: a link to each shop the member belongs to. */
export const Route = createFileRoute("/shop/")({
  loader: () => listMyShops(),
  component: function MemberHome() {
    const shops = Route.useLoaderData();
    const navigate = useNavigateOnClick();
    return (
      <s-page heading="Member area" inlineSize="small">
        <s-section heading="Shops">
          {shops.length === 0 ? (
            <s-paragraph color="subdued">You are not a member of any shop.</s-paragraph>
          ) : (
            <Lines>
              {shops.map((shop) => (
                <s-link key={shop} {...navigate(`/shop/${shop}`)}>
                  {shop}
                </s-link>
              ))}
            </Lines>
          )}
        </s-section>
      </s-page>
    );
  },
});
