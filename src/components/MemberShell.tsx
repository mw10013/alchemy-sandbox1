import type { ReactNode } from "react";
import { SANDBOX_SHOP } from "../api/shop-actor.ts";
import SideNavShell from "./SideNavShell";

const ITEMS = [
  { label: "Home", href: "/app" },
  { label: "Shop", href: `/app/shop/${SANDBOX_SHOP}` },
];

export default function MemberShell({ children }: { children: ReactNode }) {
  return (
    <SideNavShell heading="Alchemy-sandbox1" items={ITEMS}>
      {children}
    </SideNavShell>
  );
}
