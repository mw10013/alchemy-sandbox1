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
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { RpcClientError } from "effect/rpc";
import { ShoutTextFromInput } from "../api/backend.ts";
import { helloAtom, shoutAtom } from "../backend-client.ts";

// Typed failure → its `_tag`; anything else (a defect) → "Defect".
const failureTag = (cause: Cause.Cause<{ readonly _tag: string }>) =>
  Option.match(Cause.findErrorOption(cause), {
    onNone: () => "Defect",
    onSome: (error) => error._tag,
  });

// Shout's only typed failure is the transport; a payload the server rejects is a defect.
const describeShoutFailure = (cause: Cause.Cause<RpcClientError.RpcClientError>) =>
  Option.match(Cause.findErrorOption(cause), {
    onNone: () => `Defect: ${String(Cause.squash(cause))}`,
    onSome: (error) =>
      Match.valueTags(error, {
        RpcClientError: () => "Transport error: the request failed. Try again.",
      }),
  });

const decodeShoutText = Schema.decodeUnknownResult(ShoutTextFromInput);

export default function HomePage() {
  const [input, setInput] = useState("");
  const [validation, setValidation] = useState<string | undefined>(undefined);
  const hello = useAtomValue(helloAtom);
  const [shoutResult, shout] = useAtom(shoutAtom);

  // The shared codec decides what Shout accepts; a failure is shown as the field's error.
  const submit = () =>
    Result.match(decodeShoutText(input), {
      onFailure: (error) => setValidation(error.message),
      onSuccess: (text) => {
        setValidation(undefined);
        shout({ payload: { input: text }, reactivityKeys: ["hello"] });
      },
    });

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
          {AsyncResult.match(hello, {
            onInitial: () => (
              <Text as="p" role="status">
                Loading…
              </Text>
            ),
            onSuccess: ({ value, waiting }) => (
              <Text as="p" role="status">
                {value.message} — {value.servedAt}
                {waiting ? " (refreshing…)" : ""}
              </Text>
            ),
            onFailure: ({ cause }) => (
              <Text as="p" role="alert">
                {failureTag(cause)}
              </Text>
            ),
          })}
        </VStack>
        <VStack gap={4} hAlign="start">
          <Heading level={2}>Mutation</Heading>
          <TextInput
            label="Text to shout"
            value={input}
            onChange={setInput}
            description="1–80 characters after trimming. Submit blank text to see the validation message."
            status={validation === undefined ? undefined : { type: "error", message: validation }}
          />
          <Button
            label="Shout"
            variant="primary"
            isLoading={shoutResult.waiting}
            onClick={submit}
          />
          {AsyncResult.match(shoutResult, {
            onInitial: () => null,
            onSuccess: ({ value }) => (
              <Text as="p" role="status" aria-live="polite">
                {value.input} → {value.output}
              </Text>
            ),
            onFailure: ({ cause }) => (
              <Text as="p" role="alert">
                {describeShoutFailure(cause)}
              </Text>
            ),
          })}
        </VStack>
      </VStack>
    </AppShell>
  );
}
