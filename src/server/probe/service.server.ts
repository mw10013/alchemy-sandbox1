import "@tanstack/react-start/server-only";
import { Context, DateTime, Effect, Layer, Schema } from "effect";
import {
  InvalidProbeInput,
  NormalizedInput,
  PROBE_MESSAGE,
  type ProbeSnapshot,
  type ProbeTransform,
} from "../../features/probe/contracts";

export class ProbeService extends Context.Service<
  ProbeService,
  {
    read: () => Effect.Effect<ProbeSnapshot>;
    transform: (payload: {
      readonly input: string;
    }) => Effect.Effect<ProbeTransform, InvalidProbeInput>;
  }
>()("sandbox/ProbeService") {
  static readonly layer = Layer.succeed(
    ProbeService,
    ProbeService.of({
      read: Effect.fn("ProbeService.read")(function* () {
        const now = yield* DateTime.now;
        return { message: PROBE_MESSAGE, observedAt: DateTime.formatIso(now) };
      }),
      transform: Effect.fn("ProbeService.transform")(function* ({ input }) {
        const normalized = yield* Schema.decodeUnknownEffect(NormalizedInput)(input.trim()).pipe(
          Effect.mapError(
            () =>
              new InvalidProbeInput({
                message: "Enter between 1 and 80 characters after trimming.",
              }),
          ),
        );
        return { input, output: normalized.toUpperCase() };
      }),
    }),
  );
}
