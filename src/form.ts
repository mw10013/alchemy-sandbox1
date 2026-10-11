import { revalidateLogic } from "@tanstack/react-form";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * TanStack Form validation from the shared codec: `schema` decides what each field accepts,
 * and its issue messages become the field's error ({@link fieldStatus}). A field validates on
 * submit, then on every change until it is fixed.
 *
 * Validation passes only values that decode, and the form keeps the raw text, so `onSubmit`
 * decodes again with `decode`.
 *
 * @example
 * const SignInForm = schemaForm(Schema.Struct({ email: EmailFromInput }));
 * const form = useForm({
 *   defaultValues: { email: "" },
 *   ...SignInForm.options,
 *   onSubmit: ({ value }) => requestMagicLink(SignInForm.decode(value).email),
 * });
 */
export const schemaForm = <S extends Schema.Codec<any, any>>(schema: S) => ({
  options: {
    validationLogic: revalidateLogic(),
    validators: { onDynamic: Schema.toStandardSchemaV1(schema) },
  },
  decode: Schema.decodeSync(schema),
});

/** A field's `status` prop: its first issue as an error, or none while it is valid. */
export const fieldStatus = (errors: ReadonlyArray<{ readonly message: string } | undefined>) =>
  Option.match(Option.fromNullishOr(errors[0]), {
    onNone: () => undefined,
    onSome: (issue) => ({ type: "error" as const, message: issue.message }),
  });
