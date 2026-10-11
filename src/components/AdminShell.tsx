import type { ReactNode } from "react";
import SideNavShell from "./SideNavShell";

const ITEMS = [
  { label: "Home", href: "/admin" },
  { label: "Members", href: "/admin/members" },
];

export default function AdminShell({ children }: { children: ReactNode }) {
  return (
    <SideNavShell heading="Alchemy-sandbox1 Admin" items={ITEMS}>
      {children}
    </SideNavShell>
  );
}
