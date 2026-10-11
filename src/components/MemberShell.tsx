import type { ReactNode } from "react";
import SideNavShell from "./SideNavShell";

const ITEMS = [{ label: "Home", href: "/app" }];

export default function MemberShell({ children }: { children: ReactNode }) {
  return (
    <SideNavShell heading="Alchemy-sandbox1" home="/app" items={ITEMS}>
      {children}
    </SideNavShell>
  );
}
