import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { BackendRpcs, InvalidInput } from "../api/backend.ts";

export const BackendHandlers = BackendRpcs.toLayer({
  Hello: () =>
    Effect.gen(function* () {
      yield* Effect.log("Backend.Hello"); // used to count calls in the dev log
      const now = yield* DateTime.now;
      return { message: "Hello from the backend Worker.", servedAt: DateTime.formatIso(now) };
    }),
  Shout: ({ input }) =>
    Effect.gen(function* () {
      yield* Effect.log("Backend.Shout");
      const trimmed = input.trim();
      if (trimmed.length < 1 || trimmed.length > 80) {
        return yield* new InvalidInput({
          message: "Enter between 1 and 80 characters after trimming.",
        });
      }
      return { input: trimmed, output: trimmed.toUpperCase() };
    }),
});
