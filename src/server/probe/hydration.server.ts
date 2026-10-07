import "@tanstack/react-start/server-only";
import { Exit, Schema } from "effect";
import { AsyncResult, Atom, AtomRegistry, Hydration } from "effect/reactivity";
import { readAtom } from "../../features/probe/atoms";
import type { InvalidProbeInput, ProbeSnapshot } from "../../features/probe/contracts";
import { readProbeExit } from "./composition.server";

export function dehydrateProbe(exit: Exit.Exit<ProbeSnapshot, InvalidProbeInput>) {
  const result = AsyncResult.fromExit(exit);
  const registry = AtomRegistry.make({ initialValues: [[readAtom, result]] });
  try {
    if (!Atom.isSerializable(readAtom)) throw new Error("Probe read atom must be serializable");
    const serializable = readAtom[Atom.SerializableTypeId];
    // initialValues preserves the value but otherwise still builds the query lifetime.
    // Commit the public serializable preload before dehydration reads any nodes.
    registry.setSerializable(serializable.key, serializable.encode(result));
    registry.get(readAtom);
    const state = Hydration.toValues(Hydration.dehydrate(registry));
    const entry = state.find((entry) => entry.key === serializable.key);
    if (!entry || entry.resultPromise) throw new Error("Missing completed probe hydration entry");
    serializable.decode(entry.value);
    return state.map(({ key, value, dehydratedAt }) => ({
      "~effect/reactivity/Hydration/DehydratedAtom": true as const,
      key,
      value: Schema.decodeUnknownSync(Schema.Json)(value),
      dehydratedAt,
    }));
  } finally {
    registry.dispose();
  }
}
export async function loadProbeHydration() {
  return dehydrateProbe(await readProbeExit());
}
