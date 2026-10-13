import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Grid } from "@astryxdesign/core/Grid";
import { VStack } from "@astryxdesign/core/Layout";
import { Heading, Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useForm } from "@tanstack/react-form";
import * as Match from "effect/Match";
import * as Schema from "effect/Schema";
import { type Hello, type Shouted, type ShoutText, ShoutTextFromInput } from "../api/backend.ts";
import { fieldStatus, schemaForm } from "../form.ts";

/**
 * Shout has no typed failure: a payload the server rejects is a defect, and so is a server it
 * cannot reach. The text follows the copy rules on `RootDocument`.
 */
const SHOUT_FAILED = "Couldn't reach the server. Try again.";

/** The mutation's state after a submit. */
type ShoutState =
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Sending" }
  | { readonly _tag: "Shouted"; readonly value: typeof Shouted.Type }
  | { readonly _tag: "Failed" };

const ShoutForm = schemaForm(Schema.Struct({ text: ShoutTextFromInput }));

/**
 * The reference page read (`hello`, the route's loader data) and write (`shout`, a server
 * function). After a successful shout the router reloads, which reruns the loader and shows a
 * fresh `hello`.
 */
export default function Playground({
  hello,
  shout,
}: {
  hello: typeof Hello.Type;
  shout: (input: ShoutText) => Promise<typeof Shouted.Type>;
}) {
  const router = useRouter();
  const [shoutState, setShoutState] = useState<ShoutState>({ _tag: "Idle" });

  const form = useForm({
    defaultValues: { text: "" },
    ...ShoutForm.options,
    onSubmit: async ({ value }) => {
      setShoutState({ _tag: "Sending" });
      const next = await shout(ShoutForm.decode(value).text).then(
        (shouted): ShoutState => ({ _tag: "Shouted", value: shouted }),
        (): ShoutState => ({ _tag: "Failed" }),
      );
      setShoutState(next);
      if (next._tag === "Shouted") await router.invalidate();
    },
  });

  return (
    <VStack gap={4}>
      <Heading level={2}>Playground</Heading>
      <Grid columns={{ minWidth: 320, repeat: "fit" }} gap={4}>
        <Card>
          <VStack gap={3} hAlign="start">
            <Heading level={3}>Loader data</Heading>
            <Text as="p" role="status">
              {hello.message} — {hello.servedAt}
            </Text>
          </VStack>
        </Card>
        <Card>
          <VStack gap={3} hAlign="stretch">
            <Heading level={3}>Mutation</Heading>
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
                      label="Text"
                      htmlName={field.name}
                      value={field.state.value}
                      onChange={field.handleChange}
                      onBlur={field.handleBlur}
                      description="Up to 80 characters."
                      status={fieldStatus(field.state.meta.errors)}
                    />
                  )}
                </form.Field>
                <Button
                  label="Shout"
                  type="submit"
                  variant="primary"
                  isLoading={shoutState._tag === "Sending"}
                />
              </VStack>
            </form>
            {Match.valueTags(shoutState, {
              Idle: () => null,
              Sending: () => null,
              Shouted: ({ value }) => (
                <Text as="p" role="status" aria-live="polite">
                  {value.input} → {value.output}
                </Text>
              ),
              Failed: () => (
                <Text as="p" role="alert">
                  {SHOUT_FAILED}
                </Text>
              ),
            })}
          </VStack>
        </Card>
      </Grid>
    </VStack>
  );
}
