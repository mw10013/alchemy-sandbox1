// Adapted from Astryx's shell-top-nav page template.
import { useState } from "react";
import { AppShell } from "@astryxdesign/core/AppShell";
import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { TopNav, TopNavHeading } from "@astryxdesign/core/TopNav";
import { VStack } from "@astryxdesign/core/VStack";
import type { Health } from "../server/health";

export default function HomePage() {
  const [message, setMessage] = useState("Ready to test the backend.");

  async function testBackend() {
    try {
      const response = await fetch("/api/health");
      if (!response.ok) throw new Error(`API returned ${response.status}`);
      const health: Health = await response.json();
      setMessage(`${health.message} — ${health.timestamp}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Backend request failed.");
    }
  }

  return (
    <AppShell
      variant="surface"
      contentPadding={6}
      topNav={
        <TopNav
          label="Alchemy sandbox navigation"
          heading={<TopNavHeading heading="Alchemy-sandbox1" headingHref="/" />}
        />
      }
    >
      <VStack gap={10}>
        <VStack gap={4}>
          <Heading level={1}>Hello, Alchemy.</Heading>
          <Text as="p">TanStack Start + Effect + Astryx, ready for Cloudflare Workers.</Text>
          <Text as="p" type="supporting">
            This page uses Astryx’s default neutral theme. The frontend and API share one Worker.
          </Text>
        </VStack>
        <VStack gap={4} hAlign="start">
          <Heading level={2}>Backend smoke test</Heading>
          <Button label="Test backend" variant="primary" clickAction={testBackend} />
          <Text as="p" role="status" aria-live="polite">
            {message}
          </Text>
        </VStack>
      </VStack>
    </AppShell>
  );
}
