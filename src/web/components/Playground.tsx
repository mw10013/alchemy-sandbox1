import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { useForm } from "@tanstack/react-form";
import * as Match from "effect/Match";
import * as Schema from "effect/Schema";
import {
  type Hello,
  type Shouted,
  type ShoutText,
  ShoutTextFromInput,
} from "../../contract/playground.ts";
import { fieldError, schemaForm } from "./form.ts";
import { Inline } from "./screen/Inline.tsx";
import { Things } from "./screen/Things.tsx";

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
 * function), one section each. After a successful shout the router reloads, which reruns the
 * loader and shows a fresh `hello`. A result is an `<output>`, whose implicit `status` role
 * announces it; Polaris text elements take no role.
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
    <>
      <s-section heading="Loader data">
        <output>
          <s-paragraph>
            {hello.message} — {hello.servedAt}
          </s-paragraph>
        </output>
      </s-section>
      <s-section heading="Mutation">
        <Things>
          <form
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void form.handleSubmit();
            }}
          >
            <Things>
              <form.Field name="text">
                {(field) => (
                  <s-text-field
                    label="Text"
                    name={field.name}
                    value={field.state.value}
                    details="Up to 80 characters."
                    error={fieldError(field.state.meta.errors)}
                    onInput={(event) => field.handleChange(event.currentTarget.value)}
                    onBlur={field.handleBlur}
                  />
                )}
              </form.Field>
              <Inline>
                <s-button
                  type="submit"
                  variant="primary"
                  {...(shoutState._tag === "Sending" ? { loading: true } : {})}
                >
                  Shout
                </s-button>
              </Inline>
            </Things>
          </form>
          {Match.valueTags(shoutState, {
            Idle: () => null,
            Sending: () => null,
            Shouted: ({ value }) => (
              <output>
                <s-paragraph>
                  {value.input} → {value.output}
                </s-paragraph>
              </output>
            ),
            Failed: () => <s-banner tone="critical" heading={SHOUT_FAILED} />,
          })}
        </Things>
      </s-section>
    </>
  );
}
