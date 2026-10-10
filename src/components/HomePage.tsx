// Adapted from Astryx's shell-top-nav page template.
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { AppShell } from "@astryxdesign/core/AppShell";
import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { TopNav, TopNavHeading } from "@astryxdesign/core/TopNav";
import { VStack } from "@astryxdesign/core/VStack";
import { TextInput } from "@astryxdesign/core/TextInput";
import { shout } from "../backend/functions";

type ShoutResult = Awaited<ReturnType<typeof shout>>;

export default function HomePage({
  hello,
}: {
  hello: { readonly message: string; readonly servedAt: string };
}) {
  const [input, setInput] = useState("");
  const [result, setResult] = useState<ShoutResult>();
  const [pending, setPending] = useState(false);
  const [transportError, setTransportError] = useState(false);
  const callShout = useServerFn(shout);

  const submit = async () => {
    setPending(true);
    setTransportError(false);
    try {
      setResult(await callShout({ data: { input } }));
    } catch {
      setResult(undefined);
      setTransportError(true);
    } finally {
      setPending(false);
    }
  };

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
          <Text as="p">TanStack Start + Effect + Astryx on Cloudflare Workers.</Text>
          <Text as="p" type="supporting">
            Start renders this page in the Website Worker. Data comes from a private Effect Worker
            over a service binding.
          </Text>
        </VStack>
        <VStack gap={4} hAlign="start">
          <Heading level={2}>Loader data</Heading>
          <Text as="p" role="status">
            {hello.message} — {hello.servedAt}
          </Text>
        </VStack>
        <VStack gap={4} hAlign="start">
          <Heading level={2}>Mutation</Heading>
          <TextInput
            label="Text to shout"
            value={input}
            onChange={setInput}
            description="1–80 characters after trimming. Submit blank text to see a typed failure."
          />
          <Button label="Shout" variant="primary" isLoading={pending} onClick={submit} />
          {result?.ok && (
            <Text as="p" role="status" aria-live="polite">
              {result.input} → {result.output}
            </Text>
          )}
          {result?.ok === false && (
            <Text as="p" role="alert">
              InvalidInput: {result.message}
            </Text>
          )}
          {transportError && (
            <Text as="p" role="alert">
              Transport error: the request failed. Try again.
            </Text>
          )}
        </VStack>
      </VStack>
    </AppShell>
  );
}
