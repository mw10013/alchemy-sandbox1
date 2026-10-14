import { useAtomValue } from "@effect/atom-react";
import * as Effect from "effect/Effect";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { describe, expect, it } from "vite-plus/test";
import { renderHookInApp, renderInApp } from "../../test/browser/render.tsx";
import { shopTestRegistry } from "../../test/browser/shop-actor.ts";
import { countQuery } from "../shop-actor-client.ts";

describe("browser tests", () => {
  it("render a Polaris element and click it", async () => {
    let clicks = 0;
    const screen = await renderInApp(
      <s-button variant="primary" onClick={() => clicks++}>
        Go
      </s-button>,
      shopTestRegistry({}),
    );
    const button = screen.getByRole("button", { name: "Go" });

    await expect.element(button).toBeVisible();
    await button.click();
    expect(clicks).toBe(1);
    // Polaris loaded: without it `s-button` is an unknown element with no shadow root.
    expect(customElements.get("s-button")).toBeDefined();
    expect(screen.container.querySelector("s-button")?.shadowRoot).not.toBeNull();
  });

  it("read an atom through a hook, backed by test handlers", async () => {
    const registry = shopTestRegistry({ MemberGetCount: () => Effect.succeed({ value: 7 }) });
    const { result } = await renderHookInApp(() => useAtomValue(countQuery), registry);

    await expect.poll(() => AsyncResult.isSuccess(result.current)).toBe(true);
    expect(AsyncResult.getOrThrow(result.current).value).toBe(7);
  });
});
