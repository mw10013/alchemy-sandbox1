import type { ShopKey } from "../../contract/shop.ts";
import { useNavigateOnClick } from "./navigate.ts";
import { Lines } from "./screen/Lines.tsx";

/** The member's home: a link to each shop the member belongs to, in the order given. */
export default function MemberHomePage({ shops }: { shops: ReadonlyArray<ShopKey> }) {
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
}
