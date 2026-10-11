import type { CSSProperties } from "react";
import { useAtom } from "@effect/atom-react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Center } from "@astryxdesign/core/Center";
import { VStack } from "@astryxdesign/core/Layout";
import { Heading, Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useForm } from "@tanstack/react-form";
import * as Cause from "effect/Cause";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Schema from "effect/Schema";
import type { RpcClientError } from "effect/rpc";
import { EmailFromInput, type ReturnPath, type TooManyRequests } from "../api/backend.ts";
import { requestMagicLinkAtom } from "../backend-client.ts";
import { fieldStatus, schemaForm } from "../form.ts";

/**
 * The page paints its own body background: no shell hosts it. The height is the viewport's,
 * not the template's `100%`, because html and body here do not stretch to the viewport.
 */
const pageStyle: CSSProperties = {
  minHeight: "100dvh",
  backgroundColor: "var(--color-background-body)",
};
/** Caps the column at 400px and lets it shrink on narrow screens; Stack has no `maxWidth` prop. */
const contentStyle: CSSProperties = {
  width: "100%",
  maxWidth: 400,
};

const SignInForm = schemaForm(Schema.Struct({ email: EmailFromInput }));

/** User-facing text for a failed request; it follows the copy rules on `RootDocument`. */
const describeFailure = (cause: Cause.Cause<TooManyRequests | RpcClientError.RpcClientError>) =>
  Option.match(Cause.findErrorOption(cause), {
    onNone: () => "Something went wrong. Try again.",
    onSome: (error) =>
      Match.valueTags(error, {
        TooManyRequests: () => "Too many attempts. Try again in a minute.",
        RpcClientError: () => "Something went wrong. Try again.",
      }),
  });

/**
 * Requests a magic link for an address. The reply is the same whether or not the address is a
 * member, so the page never says which.
 *
 * Adapted from Astryx's `login` page template.
 *
 * @see refs/astryx/packages/cli/assets/templates/pages/login/page.tsx
 */
export default function SignInPage({
  returnTo,
  error,
}: {
  returnTo: ReturnPath | undefined;
  error: string | undefined;
}) {
  const [result, requestMagicLink] = useAtom(requestMagicLinkAtom);

  const form = useForm({
    defaultValues: { email: "" },
    ...SignInForm.options,
    onSubmit: ({ value }) => {
      requestMagicLink({ payload: { email: SignInForm.decode(value).email, returnTo } });
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
              type="email"
              status={fieldStatus(field.state.meta.errors)}
            />
          )}
        </form.Field>
        <Button label="Send link" type="submit" variant="primary" isLoading={result.waiting} />
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
                    The link expires in 5 minutes.
                  </Text>
                </VStack>
                {Option.match(value.link, {
                  onNone: () => null,
                  // A plain anchor, not a router link: the verify route is a server route.
                  onSome: (link) => (
                    <Button label="Open link" variant="primary" href={link} as="a" />
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
