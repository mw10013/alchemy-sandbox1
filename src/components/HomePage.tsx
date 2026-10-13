import { useRouter } from "@tanstack/react-router";
import { AppShell } from "@astryxdesign/core/AppShell";
import { Button } from "@astryxdesign/core/Button";
import { HStack, Layout, LayoutContent, VStack } from "@astryxdesign/core/Layout";
import { Heading, Text } from "@astryxdesign/core/Text";
import { TopNav, TopNavHeading, TopNavItem } from "@astryxdesign/core/TopNav";
import type { Hello, Me, Shouted, ShoutText } from "../api/backend.ts";
import { homeFor } from "../routes/-guards.ts";
import { signOut } from "../session.ts";
import Playground from "./Playground";

/**
 * The public landing page. The top nav and hero follow the session: a signed-out visitor is
 * offered sign-in, a member their {@link homeFor} dashboard and sign-out.
 *
 * Adapted from Astryx's `shell-top-nav` and `centered-hero` page templates.
 *
 * @see refs/astryx/packages/cli/assets/templates/pages/shell-top-nav/page.tsx
 * @see refs/astryx/packages/cli/assets/templates/pages/centered-hero/page.tsx
 */
export default function HomePage({
  me,
  hello,
  shout,
}: {
  me: Me | undefined;
  hello: typeof Hello.Type;
  shout: (input: ShoutText) => Promise<typeof Shouted.Type>;
}) {
  const router = useRouter();

  const dashboard = me && homeFor(me.role);

  return (
    <AppShell
      variant="surface"
      contentPadding={0}
      topNav={
        <TopNav
          label="Site navigation"
          heading={<TopNavHeading heading="Alchemy-sandbox1" headingHref="/" />}
          endContent={
            dashboard ? (
              <HStack gap={2} vAlign="center">
                <TopNavItem label="Dashboard" href={dashboard} />
                <Button
                  label="Sign out"
                  variant="secondary"
                  size="sm"
                  onClick={() => void signOut(router)}
                />
              </HStack>
            ) : (
              <TopNavItem label="Sign in" href="/sign-in" />
            )
          }
        />
      }
    >
      <Layout
        height="auto"
        contentWidth={960}
        content={
          <LayoutContent padding={6}>
            <VStack gap={10}>
              <VStack gap={6} hAlign="center">
                <VStack gap={3} hAlign="center">
                  <Heading level={1} type="display-2" justify="center" textWrap="balance">
                    Build on the edge with Effect
                  </Heading>
                  <Text type="body" color="secondary" justify="center" textWrap="balance">
                    TanStack Start, Effect and Astryx on Cloudflare Workers.
                  </Text>
                </VStack>
                {dashboard ? (
                  <Button label="Open dashboard" variant="primary" href={dashboard} />
                ) : (
                  <Button label="Get started" variant="primary" href="/sign-in" />
                )}
              </VStack>
              <Playground hello={hello} shout={shout} />
            </VStack>
          </LayoutContent>
        }
      />
    </AppShell>
  );
}
