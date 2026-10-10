import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import { Rpc, RpcGroup, RpcMiddleware } from "effect/rpc";

export class InvalidInput extends Schema.TaggedError<InvalidInput>()("InvalidInput", {
  message: Schema.String,
}) {}

export const Hello = Schema.Struct({ message: Schema.String, servedAt: Schema.String });
export const Shouted = Schema.Struct({ input: Schema.String, output: Schema.String });

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
  Rpc.make("Shout", {
    payload: { input: Schema.String },
    success: Shouted,
    error: InvalidInput,
  }),
);
