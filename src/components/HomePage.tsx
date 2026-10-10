// Adapted from Astryx's shell-top-nav page template.
import { useState } from "react";
import { useAtom, useAtomValue } from "@effect/atom-react";
import { AppShell } from "@astryxdesign/core/AppShell";
import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { TopNav, TopNavHeading } from "@astryxdesign/core/TopNav";
import { VStack } from "@astryxdesign/core/VStack";
import { TextInput } from "@astryxdesign/core/TextInput";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import type { RpcClientError } from "effect/rpc";
import type { InvalidInput } from "../api/backend.ts";
import { helloAtom, shoutAtom } from "../backend-client.ts";

// Typed failure → its `_tag`; anything else (a defect) → "Defect".
const failureTag = (cause: Cause.Cause<{ readonly _tag: string }>) =>
  Option.match(Cause.findErrorOption(cause), {
    onNone: () => "Defect",
    onSome: (error) => error._tag,
  });

const describeShoutFailure = (cause: Cause.Cause<InvalidInput | RpcClientError.RpcClientError>) =>
  Option.match(Cause.findErrorOption(cause), {
    onNone: () => `Defect: ${Cause.pretty(cause).split("\n")[0]}`,
    onSome: (error) =>
      error._tag === "InvalidInput"
        ? `InvalidInput: ${error.message}`
        : "Transport error: the request failed. Try again.",
  });

export default function HomePage() {
  const [input, setInput] = useState("");
  const hello = useAtomValue(helloAtom);
  const [shoutResult, shout] = useAtom(shoutAtom);

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
          {hello._tag === "Initial" && (
            <Text as="p" role="status">
              Loading…
            </Text>
          )}
          {hello._tag === "Success" && (
            <Text as="p" role="status">
              {hello.value.message} — {hello.value.servedAt}
              {hello.waiting ? " (refreshing…)" : ""}
            </Text>
          )}
          {hello._tag === "Failure" && (
            <Text as="p" role="alert">
              {failureTag(hello.cause)}
            </Text>
          )}
        </VStack>
        <VStack gap={4} hAlign="start">
          <Heading level={2}>Mutation</Heading>
          <TextInput
            label="Text to shout"
            value={input}
            onChange={setInput}
            description="1–80 characters after trimming. Submit blank text to see a typed failure."
          />
          <Button
            label="Shout"
            variant="primary"
            isLoading={shoutResult.waiting}
            onClick={() => shout({ payload: { input }, reactivityKeys: ["hello"] })}
          />
          {shoutResult._tag === "Success" && (
            <Text as="p" role="status" aria-live="polite">
              {shoutResult.value.input} → {shoutResult.value.output}
            </Text>
          )}
          {shoutResult._tag === "Failure" && (
            <Text as="p" role="alert">
              {describeShoutFailure(shoutResult.cause)}
            </Text>
          )}
        </VStack>
      </VStack>
    </AppShell>
  );
}
