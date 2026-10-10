import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { BackendRpcs } from "../api/backend.ts";

export const BackendHandlers = BackendRpcs.toLayer({
  Hello: () =>
    Effect.gen(function* () {
      yield* Effect.log("Backend.Hello"); // used to count calls in the dev log
      const now = yield* DateTime.now;
      return { message: "Hello from the backend Worker.", servedAt: DateTime.formatIso(now) };
    }),
  // `input` is a ShoutText: the payload schema validated it, so there is nothing to check here.
  Shout: ({ input }) =>
    Effect.gen(function* () {
      yield* Effect.log("Backend.Shout");
      return { input, output: input.toUpperCase() };
    }),
});
