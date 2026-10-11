import { Button } from "@astryxdesign/core/Button";
import { useAtomValue } from "@effect/atom-react";
import * as Effect from "effect/Effect";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { describe, expect, it } from "vite-plus/test";
import { testRegistry } from "../../test/browser/backend.ts";
import { renderHookInApp, renderInApp } from "../../test/browser/render.tsx";
import { helloAtom } from "../backend-client.ts";

describe("browser tests", () => {
  it("render a themed Astryx component and click it", async () => {
    let clicks = 0;
    const screen = await renderInApp(
      <Button label="Go" variant="primary" onClick={() => clicks++} />,
      testRegistry({}),
    );
    const button = screen.getByRole("button", { name: "Go" });

    await expect.element(button).toBeVisible();
    await button.click();
    expect(clicks).toBe(1);
    // Astryx's CSS loaded: without it the button falls back to the browser's default font.
    expect(getComputedStyle(button.element()).fontFamily).toContain("Figtree");
  });

  it("read an atom through a hook, backed by test handlers", async () => {
    const registry = testRegistry({
      Hello: () => Effect.succeed({ message: "Hello", servedAt: "now" }),
    });
    const { result } = await renderHookInApp(() => useAtomValue(helloAtom), registry);

    await expect.poll(() => AsyncResult.isSuccess(result.current)).toBe(true);
    expect(AsyncResult.getOrThrow(result.current).message).toBe("Hello");
  });
});
