import * as Cloudflare from "alchemy/Cloudflare";
import { DateTime, Effect, Schema } from "effect";

export class InvalidInput extends Schema.TaggedError<InvalidInput>()("InvalidInput", {
  message: Schema.String,
}) {}

// Private Effect Worker. Start reaches it only through the `BACKEND` service
// binding, calling these methods with `toRpcAsync` from `alchemy/Cloudflare/Bridge`.
export default class Backend extends Cloudflare.Worker<Backend>()(
  "Backend",
  {
    main: import.meta.filename,
    workersDev: false,
    compatibility: { date: "2026-07-01", flags: ["nodejs_compat"] },
  },
  Effect.succeed({
    hello: Effect.fn("Backend.hello")(function* () {
      const now = yield* DateTime.now;
      return {
        message: "Hello from the backend Worker.",
        servedAt: DateTime.formatIso(now),
      };
    }),
    shout: Effect.fn("Backend.shout")(function* (input: string) {
      const trimmed = input.trim();
      if (trimmed.length < 1 || trimmed.length > 80) {
        return yield* new InvalidInput({
          message: "Enter between 1 and 80 characters after trimming.",
        });
      }
      return { input: trimmed, output: trimmed.toUpperCase() };
    }),
  }),
) {}
