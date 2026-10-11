// Adapted from Astryx's login page template.
import type { CSSProperties } from "react";
import { useAtom } from "@effect/atom-react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Center } from "@astryxdesign/core/Center";
import { VStack } from "@astryxdesign/core/Layout";
import { Heading, Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { revalidateLogic, useForm } from "@tanstack/react-form";
import * as Cause from "effect/Cause";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
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

// The shared codec decides what an email address is; its issue messages become the field's error.
const SignInForm = Schema.Struct({ email: EmailFromInput });
const signInFormValidator = Schema.toStandardSchemaV1(SignInForm);
// Validation passes only values that decode, and it keeps the raw text, so submit decodes again.
const decodeSignInForm = Schema.decodeSync(SignInForm);

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
  const [result, requestMagicLink] = useAtom(requestMagicLinkAtom);

  // Validate on submit, then on every change until the address is fixed.
  const form = useForm({
    defaultValues: { email: "" },
    validationLogic: revalidateLogic(),
    validators: { onDynamic: signInFormValidator },
    onSubmit: ({ value }) => {
      requestMagicLink({ payload: { email: decodeSignInForm(value).email, returnTo } });
    },
  });

  const signInForm = (failure: string | undefined) => (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void form.handleSubmit();
      }}
    >
      <VStack gap={4} hAlign="stretch">
        <VStack gap={1} hAlign="center">
          <Heading level={2}>Sign in</Heading>
          <Text type="body" color="secondary" size="sm">
            We'll email you a sign-in link.
          </Text>
        </VStack>
        {error !== undefined && (
          <Banner
            status="error"
            title="That link didn't work. Request a new one."
            container="card"
          />
        )}
        {failure !== undefined && <Banner status="error" title={failure} container="card" />}
        <form.Field name="email">
          {(field) => (
            <TextInput
              label="Email"
              htmlName={field.name}
              value={field.state.value}
              onChange={field.handleChange}
              onBlur={field.handleBlur}
              placeholder="you@example.com"
              type="email"
              size="lg"
              status={Option.match(Option.fromNullishOr(field.state.meta.errors[0]), {
                onNone: () => undefined,
                onSome: (issue) => ({ type: "error", message: issue.message }),
              })}
            />
          )}
        </form.Field>
        <Button
          label="Email me a sign-in link"
          type="submit"
          variant="primary"
          size="lg"
          isLoading={result.waiting}
        />
      </VStack>
    </form>
  );

  return (
    <Center axis="both" padding={6} style={pageStyle}>
      <VStack gap={4} hAlign="center" style={contentStyle}>
        <Text type="body" weight="bold" size="lg">
          Alchemy-sandbox1
        </Text>
        <Card padding={8} width="100%">
          {AsyncResult.match(result, {
            onInitial: () => signInForm(undefined),
            onFailure: ({ cause }) => signInForm(describeFailure(cause)),
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
