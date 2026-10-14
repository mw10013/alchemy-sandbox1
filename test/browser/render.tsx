import "../../src/styles.css";
import { RegistryContext } from "@effect/atom-react";
import type * as AtomRegistry from "effect/reactivity/AtomRegistry";
import type { ReactNode } from "react";
import { render, renderHook } from "vitest-browser-react";

/** The atom registry provider the router wraps every page in. Polaris comes from the setup file. */
const appWrapper =
  (registry: AtomRegistry.AtomRegistry) =>
  ({ children }: { children: ReactNode }) => (
    <RegistryContext.Provider value={registry}>{children}</RegistryContext.Provider>
  );

/** Renders `ui` as the app would, over `registry` (usually a `testRegistry`). */
export const renderInApp = (ui: ReactNode, registry: AtomRegistry.AtomRegistry) =>
  render(ui, { wrapper: appWrapper(registry) });

/** {@link renderInApp} for a hook. */
export const renderHookInApp = <Result,>(hook: () => Result, registry: AtomRegistry.AtomRegistry) =>
  renderHook(hook, { wrapper: appWrapper(registry) });
