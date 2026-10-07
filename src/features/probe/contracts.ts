import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

export const PROBE_MESSAGE = "Hello from the stateless Effect service.";
export const ProbeSnapshot = Schema.Struct({
  message: Schema.Literal(PROBE_MESSAGE),
  observedAt: Schema.String.check(
    Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
  ),
});
export type ProbeSnapshot = typeof ProbeSnapshot.Type;
export const TransformPayload = Schema.Struct({ input: Schema.String });
export const NormalizedInput = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80));
export const ProbeTransform = Schema.Struct({ input: Schema.String, output: Schema.String });
export type ProbeTransform = typeof ProbeTransform.Type;
export class InvalidProbeInput extends Schema.TaggedError<InvalidProbeInput>()(
  "InvalidProbeInput",
  {
    message: Schema.String,
  },
) {}
export const ProbeRpcs = RpcGroup.make(
  Rpc.make("probe_read", { success: ProbeSnapshot, error: InvalidProbeInput }),
  Rpc.make("probe_transform", {
    payload: TransformPayload,
    success: ProbeTransform,
    error: InvalidProbeInput,
  }),
);
