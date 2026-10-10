import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import { Rpc, RpcGroup, RpcMiddleware } from "effect/rpc";

// The text Shout accepts: trimmed, 1 to 80 characters. A payload field's checks run on the
// client (the RPC client constructs the payload with the schema) and on the server, so a
// value of this type has already passed them. Decode raw input with ShoutTextFromInput first.
export const ShoutText = Schema.Trimmed.check(
  Schema.isBetweenLength(1, 80, { message: "Enter 1 to 80 characters." }),
).pipe(Schema.brand("ShoutText"));
export type ShoutText = typeof ShoutText.Type;

// Raw textbox value -> ShoutText. Trim is a decode step, so the length check sees the trimmed text.
export const ShoutTextFromInput = Schema.Trim.pipe(Schema.decodeTo(ShoutText));

export const Hello = Schema.Struct({ message: Schema.String, servedAt: Schema.String });
export const Shouted = Schema.Struct({ input: ShoutText, output: Schema.String });

// Auth is deferred (D14). These are declared so the API definition is ready for it.
// CurrentUserMiddleware is NOT attached to the group yet: an attached middleware
// needs a server implementation layer (research C9).
export class CurrentUser extends Context.Service<CurrentUser, { readonly id: string }>()(
  "CurrentUser",
) {}
export class CurrentUserMiddleware extends RpcMiddleware.Service<
  CurrentUserMiddleware,
  { provides: CurrentUser }
>()("CurrentUserMiddleware") {}

export const BackendRpcs = RpcGroup.make(
  Rpc.make("Hello", { success: Hello }),
  Rpc.make("Shout", { payload: { input: ShoutText }, success: Shouted }),
);
