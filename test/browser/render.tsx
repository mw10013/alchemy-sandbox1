import "../../src/styles.css";
import { Theme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import { RegistryContext } from "@effect/atom-react";
import type * as AtomRegistry from "effect/reactivity/AtomRegistry";
import type { ReactNode } from "react";
import { render, renderHook } from "vitest-browser-react";

/**
 * The providers `RootDocument` gives every page, minus `LinkProvider`: `RouterLink` needs a
 * router, and without it Astryx renders plain anchors.
 */
const appWrapper =
  (registry: AtomRegistry.AtomRegistry) =>
  ({ children }: { children: ReactNode }) => (
    <RegistryContext.Provider value={registry}>
      <Theme theme={neutralTheme} mode="dark">
        {children}
      </Theme>
    </RegistryContext.Provider>
  );

/** Renders `ui` as the app would, over `registry` (usually a `testRegistry`). */
export const renderInApp = (ui: ReactNode, registry: AtomRegistry.AtomRegistry) =>
  render(ui, { wrapper: appWrapper(registry) });

/** {@link renderInApp} for a hook. */
export const renderHookInApp = <Result,>(hook: () => Result, registry: AtomRegistry.AtomRegistry) =>
  renderHook(hook, { wrapper: appWrapper(registry) });
