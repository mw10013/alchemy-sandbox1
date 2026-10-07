import { expect, it, vi } from "vite-plus/test";
import { createElement, Suspense, use } from "react";
import { createMemoryHistory, createRootRoute, createRouter } from "@tanstack/react-router";
import {
  attachRouterServerSsrUtils,
  renderRouterToStream,
} from "@tanstack/react-router/ssr/server";
import { RegistryContext, HydrationBoundary, useAtomValue } from "@effect/atom-react";
import { Exit } from "effect";
import { AsyncResult, AtomRegistry } from "effect/reactivity";
import { readAtom } from "../../features/probe/atoms";
import { PROBE_MESSAGE } from "../../features/probe/contracts";
import { dehydrateProbe } from "./hydration.server";

it.each(["completion", "cancellation"])(
  "owns the SSR registry until Start stream %s (Node)",
  async (mode) => {
    const registry = AtomRegistry.make();
    const dispose = vi.spyOn(registry, "dispose");
    const router = createRouter({
      routeTree: createRootRoute(),
      isServer: true,
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    attachRouterServerSsrUtils({ router, manifest: undefined });
    router.serverSsr!.onCleanup(() => registry.dispose());
    await router.serverSsr!.dehydrate();
    let release!: (value: string) => void;
    const gate = new Promise<string>((resolve) => {
      release = resolve;
    });
    function Pending() {
      return createElement("p", null, use(gate));
    }
    function Snapshot() {
      const value = useAtomValue(readAtom);
      return createElement(
        "p",
        null,
        AsyncResult.isSuccess(value) ? value.value.message : "not seeded",
      );
    }
    const state = dehydrateProbe(
      Exit.succeed({ message: PROBE_MESSAGE, observedAt: "2026-10-07T00:00:00.000Z" }),
    );
    try {
      const result = await renderRouterToStream({
        router,
        request: new Request("http://probe.test/"),
        responseHeaders: new Headers(),
        children: createElement(
          "html",
          null,
          createElement(
            "body",
            null,
            createElement(
              RegistryContext.Provider,
              { value: registry },
              createElement(
                HydrationBoundary,
                { state },
                createElement(Snapshot),
                createElement(
                  Suspense,
                  { fallback: createElement("p", null, "pending") },
                  createElement(Pending),
                ),
              ),
            ),
          ),
        ),
      });
      expect(dispose).not.toHaveBeenCalled();
      if (mode === "completion") {
        release("done");
        expect(await result.response.text()).toContain(PROBE_MESSAGE);
      } else {
        const reader = result.response.body!.getReader();
        expect((await reader.read()).done).toBe(false);
        await reader.cancel();
      }
      expect(dispose).toHaveBeenCalledTimes(1);
    } finally {
      release("cleanup");
      router.serverSsr?.cleanup();
      registry.dispose();
      dispose.mockRestore();
    }
  },
);
