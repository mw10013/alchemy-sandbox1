// @vitest-environment jsdom
import { afterAll, expect, it, vi } from "vite-plus/test";
import { act, createElement } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { HydrationBoundary, RegistryContext, useAtom, useAtomValue } from "@effect/atom-react";
import { Exit } from "effect";
import { AsyncResult, AtomRegistry } from "effect/reactivity";
import { readAtom, transformAtom } from "./atoms";
import { PROBE_MESSAGE } from "./contracts";
import { dehydrateProbe } from "../../server/probe/hydration.server";
import { ProbeHydration } from "./ProbeHydration";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
afterAll(() => vi.unstubAllGlobals());

it("applies a new loader generation to an existing browser subtree without refetching", async () => {
  const { createRoot } = await import("react-dom/client");
  const container = document.createElement("main");
  document.body.append(container);
  const root = createRoot(container);
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  function Snapshot() {
    const result = useAtomValue(readAtom);
    return createElement(
      "p",
      null,
      AsyncResult.isSuccess(result) ? result.value.observedAt : "not seeded",
    );
  }
  const tree = (observedAt: string) =>
    createElement(ProbeHydration, {
      serverOwned: false,
      state: dehydrateProbe(Exit.succeed({ message: PROBE_MESSAGE, observedAt })),
      children: createElement(Snapshot),
    });
  try {
    await act(async () => root.render(tree("2026-10-07T00:00:00.000Z")));
    expect(container.textContent).toBe("2026-10-07T00:00:00.000Z");
    await act(async () => root.render(tree("2026-10-07T00:01:00.000Z")));
    expect(container.textContent).toBe("2026-10-07T00:01:00.000Z");
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    fetchSpy.mockRestore();
  }
});

it("client hydrates the completed seed with mounted query and mutation without transport", async () => {
  const state = dehydrateProbe(
    Exit.succeed({ message: PROBE_MESSAGE, observedAt: "2026-10-07T00:00:00.000Z" }),
  );
  const server = AtomRegistry.make();
  const client = AtomRegistry.make();
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  function Probe() {
    const value = useAtomValue(readAtom);
    const [action] = useAtom(transformAtom);
    return createElement(
      "p",
      null,
      `${AsyncResult.isSuccess(value) ? value.value.observedAt : "not seeded"} / ${action._tag}`,
    );
  }
  const tree = (registry: AtomRegistry.AtomRegistry) =>
    createElement(
      RegistryContext.Provider,
      { value: registry },
      createElement(HydrationBoundary, { state }, createElement(Probe)),
    );
  const container = document.createElement("main");
  document.body.append(container);
  container.innerHTML = renderToString(tree(server));
  let root: ReturnType<typeof hydrateRoot> | undefined;
  try {
    await act(async () => {
      root = hydrateRoot(container, tree(client));
    });
    expect(container.textContent).toBe("2026-10-07T00:00:00.000Z / Initial");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(
      consoleSpy.mock.calls.filter(([message]) =>
        String(message).match(/hydration|didn't match|does not match/i),
      ),
    ).toEqual([]);
  } finally {
    await act(async () => root?.unmount());
    container.remove();
    client.dispose();
    server.dispose();
    fetchSpy.mockRestore();
    consoleSpy.mockRestore();
  }
});
