import type { ReactNode } from "react";
import { useLocation, useNavigate, useRouter } from "@tanstack/react-router";
import { AppShell } from "@astryxdesign/core/AppShell";
import { SideNav, SideNavHeading, SideNavItem, SideNavSection } from "@astryxdesign/core/SideNav";
import { signOut } from "../session.ts";

export type NavItem = { readonly label: string; readonly href: string };

/**
 * The frame the admin and member sides share; each passes its own items. The heading links back
 * to the public home page.
 *
 * Adapted from Astryx's `shell-side-nav` page template.
 *
 * @see refs/astryx/packages/cli/assets/templates/pages/shell-side-nav/page.tsx
 */
export default function SideNavShell({
  heading,
  items,
  children,
}: {
  heading: string;
  items: ReadonlyArray<NavItem>;
  children: ReactNode;
}) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const router = useRouter();

  // Leave the guarded side first: signing out on it would redirect to sign-in, then here to `/`.
  const onSignOut = async () => {
    await navigate({ to: "/" });
    await signOut(router);
  };

  return (
    <AppShell
      contentPadding={0}
      sideNav={
        <SideNav
          collapsible
          header={<SideNavHeading heading={heading} headingHref="/" />}
          footer={
            <SideNavSection title="Account" isHeaderHidden>
              <SideNavItem label="Sign out" onClick={() => void onSignOut()} />
            </SideNavSection>
          }
        >
          <SideNavSection title="Menu" isHeaderHidden>
            {items.map((item) => (
              <SideNavItem
                key={item.href}
                label={item.label}
                href={item.href}
                isSelected={pathname === item.href || pathname === `${item.href}/`}
              />
            ))}
          </SideNavSection>
        </SideNav>
      }
    >
      {children}
    </AppShell>
  );
}
