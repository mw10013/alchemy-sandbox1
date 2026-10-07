// Adapted from Astryx's shell-top-nav page template.
import { useState } from "react";
import { AppShell } from "@astryxdesign/core/AppShell";
import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { TopNav, TopNavHeading } from "@astryxdesign/core/TopNav";
import { VStack } from "@astryxdesign/core/VStack";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useAtom, useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { Cause, Option } from "effect";
import { readAtom, transformAtom } from "../features/probe/atoms";

export default function HomePage() {
  const [input, setInput] = useState("");
  const snapshot = useAtomValue(readAtom);
  const refresh = useAtomRefresh(readAtom);
  const [transform, submit] = useAtom(transformAtom);
  const lastSnapshot = AsyncResult.value(snapshot);
  const transformError = AsyncResult.isFailure(transform)
    ? Cause.findErrorOption(transform.cause)
    : Option.none();
  const errorMessage =
    Option.isSome(transformError) && transformError.value._tag === "InvalidProbeInput"
      ? `InvalidProbeInput: ${transformError.value.message}`
      : AsyncResult.isFailure(transform)
        ? "Transport error: the RPC request failed. Try again."
        : undefined;

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
          <Heading level={2}>Server snapshot</Heading>
          <Button label="Refresh" isLoading={snapshot.waiting} onClick={refresh} />
          <Text as="p" role="status" aria-live="polite">
            {Option.isSome(lastSnapshot)
              ? `${lastSnapshot.value.message} — ${lastSnapshot.value.observedAt}`
              : "Loading snapshot…"}
          </Text>
          {snapshot.waiting && (
            <Text as="p" role="status">
              Refreshing; retaining the last snapshot.
            </Text>
          )}
          {AsyncResult.isFailure(snapshot) && (
            <Text as="p" role="alert">
              Transport error: snapshot refresh failed. Try again.
            </Text>
          )}
        </VStack>
        <VStack gap={4} hAlign="start">
          <Heading level={2}>Stateless transform</Heading>
          <TextInput
            label="Text to transform"
            value={input}
            onChange={setInput}
            description="1–80 characters after trimming. Submit blank text to see a typed failure."
          />
          <Button
            label="Transform"
            variant="primary"
            isLoading={transform.waiting}
            onClick={() => submit({ payload: { input } })}
          />
          <Text as="p" type="supporting">
            The result is temporary browser state. Transforming does not change or refresh the
            snapshot.
          </Text>
          {AsyncResult.isSuccess(transform) && (
            <Text as="p" role="status" aria-live="polite">
              {transform.value.input} → {transform.value.output}
            </Text>
          )}
          {errorMessage && (
            <Text as="p" role="alert">
              {errorMessage}
            </Text>
          )}
        </VStack>
      </VStack>
    </AppShell>
  );
}
