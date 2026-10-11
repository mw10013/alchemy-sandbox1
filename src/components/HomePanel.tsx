import { Layout, LayoutContent } from "@astryxdesign/core/Layout";
import { VStack } from "@astryxdesign/core/Stack";
import { Heading, Text } from "@astryxdesign/core/Text";

/** The landing panel of the admin and member sides, inside their `SideNavShell`. */
export default function HomePanel({ heading, email }: { heading: string; email: string }) {
  return (
    <Layout
      height="fill"
      contentWidth={768}
      content={
        <LayoutContent padding={6}>
          <VStack gap={2}>
            <Heading level={1}>{heading}</Heading>
            <Text as="p" type="supporting">
              Signed in as {email}
            </Text>
          </VStack>
        </LayoutContent>
      }
    />
  );
}
