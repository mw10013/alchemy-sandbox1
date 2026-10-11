// Adapted from Astryx's login page template.
import { useState, type CSSProperties } from "react";
import { useAtom } from "@effect/atom-react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Center } from "@astryxdesign/core/Center";
import { VStack } from "@astryxdesign/core/Layout";
import { Heading, Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import * as Cause from "effect/Cause";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type { RpcClientError } from "effect/rpc";
import { EmailFromInput, type ReturnPath, type TooManyRequests } from "../api/backend.ts";
import { requestMagicLinkAtom } from "../backend-client.ts";

// Standalone auth page paints its own body background (no host shell). The viewport height,
// not the template's 100%: html and body here do not stretch to the viewport.
const pageStyle: CSSProperties = {
  minHeight: "100dvh",
  backgroundColor: "var(--color-background-body)",
};
// Cap the column at 400px but let it shrink to fit narrow screens (Stack
// has no maxWidth prop, so it's set here).
const contentStyle: CSSProperties = {
  width: "100%",
  maxWidth: 400,
};

const decodeEmail = Schema.decodeUnknownResult(EmailFromInput);

const describeFailure = (cause: Cause.Cause<TooManyRequests | RpcClientError.RpcClientError>) =>
  Option.match(Cause.findErrorOption(cause), {
    onNone: () => "Something went wrong. Try again.",
    onSome: (error) =>
      Match.valueTags(error, {
        TooManyRequests: () => "Too many attempts. Try again in a minute.",
        RpcClientError: () => "Something went wrong. Try again.",
      }),
  });

export default function SignInPage({
  returnTo,
  error,
}: {
  returnTo: ReturnPath | undefined;
  error: string | undefined;
}) {
  const [email, setEmail] = useState("");
  const [validation, setValidation] = useState<string | undefined>(undefined);
  const [result, requestMagicLink] = useAtom(requestMagicLinkAtom);

  // The shared codec decides what an email address is; a failure is shown as the field's error.
  const submit = () =>
    Result.match(decodeEmail(email), {
      onFailure: () => setValidation("Enter an email address."),
      onSuccess: (address) => {
        setValidation(undefined);
        requestMagicLink({ payload: { email: address, returnTo } });
      },
    });

  const form = (failure: string | undefined) => (
    <VStack gap={4} hAlign="stretch">
      <VStack gap={1} hAlign="center">
        <Heading level={2}>Sign in</Heading>
        <Text type="body" color="secondary" size="sm">
          We'll email you a sign-in link.
        </Text>
      </VStack>
      {error !== undefined && (
        <Banner status="error" title="That link didn't work. Request a new one." container="card" />
      )}
      {failure !== undefined && <Banner status="error" title={failure} container="card" />}
      <TextInput
        label="Email"
        value={email}
        onChange={setEmail}
        placeholder="you@example.com"
        type="email"
        size="lg"
        status={validation === undefined ? undefined : { type: "error", message: validation }}
      />
      <Button
        label="Email me a sign-in link"
        variant="primary"
        size="lg"
        isLoading={result.waiting}
        onClick={submit}
      />
    </VStack>
  );

  return (
    <Center axis="both" padding={6} style={pageStyle}>
      <VStack gap={4} hAlign="center" style={contentStyle}>
        <Text type="body" weight="bold" size="lg">
          Alchemy-sandbox1
        </Text>
        <Card padding={8} width="100%">
          {AsyncResult.match(result, {
            onInitial: () => form(undefined),
            onFailure: ({ cause }) => form(describeFailure(cause)),
            onSuccess: ({ value }) => (
              <VStack gap={4} hAlign="stretch">
                <VStack gap={1} hAlign="center">
                  <Heading level={2}>Check your email</Heading>
                  <Text type="body" color="secondary" size="sm" role="status">
                    If that address can sign in, a link is on its way. It expires in 5 minutes.
                  </Text>
                </VStack>
                {Option.match(value.link, {
                  onNone: () => null,
                  // Dev inline delivery only. A plain anchor: the verify route is a server route.
                  onSome: (link) => (
                    <Button
                      label="Open your sign-in link"
                      variant="primary"
                      size="lg"
                      href={link}
                      as="a"
                    />
                  ),
                })}
              </VStack>
            ),
          })}
        </Card>
      </VStack>
    </Center>
  );
}
