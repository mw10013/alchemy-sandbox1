import { useAtom, useAtomValue } from "@effect/atom-react";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Grid } from "@astryxdesign/core/Grid";
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
import { ShoutTextFromInput } from "../api/backend.ts";
import { helloAtom, shoutAtom } from "../backend-client.ts";
import { fieldStatus, schemaForm } from "../form.ts";

/**
 * Shout's only typed failure is the transport; a payload the server rejects is a defect. The
 * text follows the copy rules on `RootDocument`.
 */
const describeShoutFailure = (cause: Cause.Cause<RpcClientError.RpcClientError>) =>
  Option.match(Cause.findErrorOption(cause), {
    onNone: () => "Something went wrong. Try again.",
    onSome: (error) =>
      Match.valueTags(error, {
        RpcClientError: () => "Couldn't reach the server. Try again.",
      }),
  });

const ShoutForm = schemaForm(Schema.Struct({ text: ShoutTextFromInput }));

/**
 * The reference page query ({@link helloAtom}) and mutation ({@link shoutAtom}). The query
 * must be loaded by the route that renders this; see `loadQuery`.
 */
export default function Playground() {
  const hello = useAtomValue(helloAtom);
  const [shoutResult, shout] = useAtom(shoutAtom);

  const form = useForm({
    defaultValues: { text: "" },
    ...ShoutForm.options,
    onSubmit: ({ value }) => {
      shout({ payload: { input: ShoutForm.decode(value).text }, reactivityKeys: ["hello"] });
    },
  });

  return (
    <VStack gap={4}>
      <Heading level={2}>Playground</Heading>
      <Grid columns={{ minWidth: 320, repeat: "fit" }} gap={4}>
        <Card>
          <VStack gap={3} hAlign="start">
            <Heading level={3}>Loader data</Heading>
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
              onFailure: () => (
                <Text as="p" role="alert">
                  Couldn't load.
                </Text>
              ),
            })}
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
        </Card>
      </Grid>
    </VStack>
  );
}
