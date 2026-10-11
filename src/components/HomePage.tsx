// Adapted from Astryx's shell-top-nav page template.
import { useAtom, useAtomValue } from "@effect/atom-react";
import { AppShell } from "@astryxdesign/core/AppShell";
import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { TopNav, TopNavHeading, TopNavItem } from "@astryxdesign/core/TopNav";
import { VStack } from "@astryxdesign/core/VStack";
import { TextInput } from "@astryxdesign/core/TextInput";
import { revalidateLogic, useForm } from "@tanstack/react-form";
import * as Cause from "effect/Cause";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
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

// The shared codec decides what Shout accepts; its issue messages become the field's error.
const ShoutForm = Schema.Struct({ text: ShoutTextFromInput });
const shoutFormValidator = Schema.toStandardSchemaV1(ShoutForm);
// Validation passes only values that decode, and it keeps the raw text, so submit decodes again.
const decodeShoutForm = Schema.decodeSync(ShoutForm);

export default function HomePage() {
  const hello = useAtomValue(helloAtom);
  const [shoutResult, shout] = useAtom(shoutAtom);

  // Validate on submit, then on every change until the text is fixed.
  const form = useForm({
    defaultValues: { text: "" },
    validationLogic: revalidateLogic(),
    validators: { onDynamic: shoutFormValidator },
    onSubmit: ({ value }) => {
      shout({ payload: { input: decodeShoutForm(value).text }, reactivityKeys: ["hello"] });
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
          endContent={<TopNavItem label="Sign in" href="/sign-in" />}
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
          <form
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void form.handleSubmit();
            }}
          >
            <VStack gap={4} hAlign="start">
              <form.Field name="text">
                {(field) => (
                  <TextInput
                    label="Text to shout"
                    htmlName={field.name}
                    value={field.state.value}
                    onChange={field.handleChange}
                    onBlur={field.handleBlur}
                    description="1–80 characters after trimming. Submit blank text to see the validation message."
                    status={Option.match(Option.fromNullishOr(field.state.meta.errors[0]), {
                      onNone: () => undefined,
                      onSome: (issue) => ({ type: "error", message: issue.message }),
                    })}
                  />
                )}
              </form.Field>
              <Button
                label="Shout"
                type="submit"
                variant="primary"
                isLoading={shoutResult.waiting}
              />
            </VStack>
          </form>
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
