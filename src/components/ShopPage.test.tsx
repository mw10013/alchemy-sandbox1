import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import { describe, expect, it } from "vite-plus/test";
import { shopTestRegistry } from "../../test/browser/shop-actor.ts";
import { renderInApp } from "../../test/browser/render.tsx";
import { COUNT_KEY } from "../api/shop-actor.ts";
import { notices } from "../shop-actor-client.ts";
import ShopPage from "./ShopPage.tsx";

const activation = () => Effect.succeed({ id: "activation-1" });

describe("ShopPage", () => {
  it("shows the count and the activation", async () => {
    const registry = shopTestRegistry({
      GetCount: () => Effect.succeed({ value: 7 }),
      Activation: activation,
    });
    const screen = await renderInApp(<ShopPage />, registry);

    await expect.element(screen.getByRole("status", { name: "Count" })).toHaveTextContent("7");
    await expect.element(screen.getByText("Activation activation-1")).toBeVisible();
  });

  it("increments through the actor and shows the new value", async () => {
    let value = 0;
    const registry = shopTestRegistry({
      GetCount: () => Effect.sync(() => ({ value })),
      Increment: () => Effect.sync(() => ({ value: ++value })),
      Activation: activation,
    });
    const screen = await renderInApp(<ShopPage />, registry);
    await expect.element(screen.getByRole("status", { name: "Count" })).toHaveTextContent("0");

    await screen.getByRole("button", { name: "Increment" }).click();
    // The page refetches on the actor's notice, not on the mutation's result.
    await PubSub.publish(notices, { _tag: "ShopActorNotice", invalidated: [COUNT_KEY] }).pipe(
      Effect.runPromise,
    );

    await expect.element(screen.getByRole("status", { name: "Count" })).toHaveTextContent("1");
    expect(value).toBe(1);
  });

  it("refetches the count when a notice names it", async () => {
    const answers = [3, 4];
    const registry = shopTestRegistry({
      GetCount: () => Effect.sync(() => ({ value: answers.shift() ?? -1 })),
      Activation: activation,
    });
    const screen = await renderInApp(<ShopPage />, registry);
    await expect.element(screen.getByRole("status", { name: "Count" })).toHaveTextContent("3");

    await PubSub.publish(notices, { _tag: "ShopActorNotice", invalidated: [COUNT_KEY] }).pipe(
      Effect.runPromise,
    );

    await expect.element(screen.getByRole("status", { name: "Count" })).toHaveTextContent("4");
  });

  it("says when the shop cannot be reached", async () => {
    const registry = shopTestRegistry({
      GetCount: () => Effect.die("unreachable"),
      Activation: activation,
    });
    const screen = await renderInApp(<ShopPage />, registry);

    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent("Couldn't reach the shop. Try again.");
  });
});
