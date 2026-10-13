import { type CSSProperties, useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Center } from "@astryxdesign/core/Center";
import { VStack } from "@astryxdesign/core/Layout";
import { Heading, Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useForm } from "@tanstack/react-form";
import * as Match from "effect/Match";
import * as Schema from "effect/Schema";
import { type Email, EmailFromInput, type ReturnPath } from "../api/backend.ts";
import { fieldStatus, schemaForm } from "../form.ts";
import type { MagicLinkResult } from "../server/sign-in.ts";

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

/** Copy for a request that did not go through; follows the copy rules on `RootDocument`. */
const SOMETHING_WENT_WRONG = "Something went wrong. Try again.";
const TOO_MANY_ATTEMPTS = "Too many attempts. Try again in a minute.";

/** The page's state after a submit: the answer, or the copy for a request that failed. */
type Outcome =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Sending" }
  | { readonly _tag: "Sent"; readonly link: string | undefined }
  | { readonly _tag: "Failed"; readonly message: string };

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
  requestMagicLink,
}: {
  returnTo: ReturnPath | undefined;
  error: string | undefined;
  requestMagicLink: (input: {
    readonly email: Email;
    readonly returnTo: ReturnPath | undefined;
  }) => Promise<MagicLinkResult>;
}) {
  const [outcome, setOutcome] = useState<Outcome>({ _tag: "Idle" });

  const form = useForm({
    defaultValues: { email: "" },
    ...SignInForm.options,
    onSubmit: async ({ value }) => {
      setOutcome({ _tag: "Sending" });
      const next = await requestMagicLink({ email: SignInForm.decode(value).email, returnTo }).then(
        (result): Outcome =>
          Match.valueTags(result, {
            Sent: ({ link }): Outcome => ({ _tag: "Sent", link }),
            TooManyRequests: (): Outcome => ({ _tag: "Failed", message: TOO_MANY_ATTEMPTS }),
          }),
        (): Outcome => ({ _tag: "Failed", message: SOMETHING_WENT_WRONG }),
      );
      setOutcome(next);
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
        <Button
          label="Send link"
          type="submit"
          variant="primary"
          isLoading={outcome._tag === "Sending"}
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
          {Match.valueTags(outcome, {
            Idle: () => signInForm(undefined),
            Sending: () => signInForm(undefined),
            Failed: ({ message }) => signInForm(message),
            Sent: ({ link }) => (
              <VStack gap={4} hAlign="stretch">
                <VStack gap={1} hAlign="center">
                  <Heading level={2}>Check your email</Heading>
                  <Text type="body" color="secondary" size="sm" role="status">
                    The link expires in 5 minutes.
                  </Text>
                </VStack>
                {link !== undefined && (
                  // A plain anchor, not a router link: the verify route is a server route.
                  <Button label="Open link" variant="primary" href={link} as="a" />
                )}
              </VStack>
            ),
          })}
        </Card>
      </VStack>
    </Center>
  );
}
