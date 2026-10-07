import type { ReactNode } from "react";
import { HydrationBoundary, RegistryProvider } from "@effect/atom-react";
import type { Hydration } from "effect/reactivity";

export function ProbeHydration({
  state,
  serverOwned,
  children,
}: {
  state: ReadonlyArray<Hydration.DehydratedAtomValue>;
  serverOwned: boolean;
  children: ReactNode;
}) {
  const content = <HydrationBoundary state={state}>{children}</HydrationBoundary>;
  // Fresh completed loader generations get isolated browser presentation state.
  // SSR keeps the root registry owned by Start's response stream.
  return serverOwned ? (
    content
  ) : (
    <RegistryProvider key={JSON.stringify(state)}>{content}</RegistryProvider>
  );
}
