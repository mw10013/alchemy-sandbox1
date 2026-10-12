import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import { describe, expect, it } from "vite-plus/test";
import { shopTestRegistry } from "../../test/browser/shop-actor.ts";
import { renderInApp } from "../../test/browser/render.tsx";
import { EmailFromInput } from "../api/backend.ts";
import { COUNT_KEY } from "../api/shop-actor.ts";
import * as Schema from "effect/Schema";
import { notices } from "../shop-actor-client.ts";
import { connectionStateAtom, notAMemberAtom, reconnectAtom } from "../ticket-client.ts";
import ShopPage from "./ShopPage.tsx";

const activation = () => Effect.succeed({ id: "activation-1" });
const member = {
  role: "member",
  memberId: "mem-1",
  memberEmail: Schema.decodeUnknownSync(EmailFromInput)("m1@m.com"),
  teamIds: [],
  userId: "user-1",
  sessionId: "session-1",
  sessionExpiresAt: 0,
} as const;
const memberWhoAmI = () => Effect.succeed(member);

describe("ShopPage", () => {
  it("shows the count, who is signed in and the activation", async () => {
    const registry = shopTestRegistry({
      MemberGetCount: () => Effect.succeed({ value: 7 }),
      MemberActivation: activation,
      MemberWhoAmI: memberWhoAmI,
    });
    const screen = await renderInApp(<ShopPage role="member" />, registry);

    await expect.element(screen.getByRole("status", { name: "Count" })).toHaveTextContent("7");
    await expect.element(screen.getByText("Signed in as m1@m.com (member)")).toBeVisible();
    await expect.element(screen.getByText("Activation activation-1")).toBeVisible();
  });

  it("increments through the actor and shows the new value", async () => {
    let value = 0;
    const registry = shopTestRegistry({
      MemberGetCount: () => Effect.sync(() => ({ value })),
      MemberIncrement: () => Effect.sync(() => ({ value: ++value })),
      MemberActivation: activation,
      MemberWhoAmI: memberWhoAmI,
    });
    const screen = await renderInApp(<ShopPage role="member" />, registry);
    await expect.element(screen.getByRole("status", { name: "Count" })).toHaveTextContent("0");
    await expect.element(screen.getByRole("button", { name: "Reset" })).not.toBeInTheDocument();

    await screen.getByRole("button", { name: "Increment" }).click();
    // The page refetches on the actor's notice, not on the mutation's result.
    await PubSub.publish(notices, { _tag: "ShopActorNotice", invalidated: [COUNT_KEY] }).pipe(
      Effect.runPromise,
    );

    await expect.element(screen.getByRole("status", { name: "Count" })).toHaveTextContent("1");
    expect(value).toBe(1);
  });

  it("a merchant sees Reset, not Increment, and resets through the actor", async () => {
    let value = 5;
    const registry = shopTestRegistry({
      MerchantGetCount: () => Effect.sync(() => ({ value })),
      MerchantResetCount: () => Effect.sync(() => ({ value: (value = 0) })),
      MerchantWhoAmI: () => Effect.succeed({ role: "merchant" } as const),
    });
    const screen = await renderInApp(<ShopPage role="merchant" />, registry);
    await expect.element(screen.getByRole("status", { name: "Count" })).toHaveTextContent("5");
    await expect.element(screen.getByText(/^Merchant of /)).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Increment" })).not.toBeInTheDocument();

    await screen.getByRole("button", { name: "Reset" }).click();
    await PubSub.publish(notices, { _tag: "ShopActorNotice", invalidated: [COUNT_KEY] }).pipe(
      Effect.runPromise,
    );

    await expect.element(screen.getByRole("status", { name: "Count" })).toHaveTextContent("0");
  });

  it("refetches the count when a notice names it", async () => {
    const answers = [3, 4];
    const registry = shopTestRegistry({
      MemberGetCount: () => Effect.sync(() => ({ value: answers.shift() ?? -1 })),
      MemberActivation: activation,
      MemberWhoAmI: memberWhoAmI,
    });
    const screen = await renderInApp(<ShopPage role="member" />, registry);
    await expect.element(screen.getByRole("status", { name: "Count" })).toHaveTextContent("3");

    await PubSub.publish(notices, { _tag: "ShopActorNotice", invalidated: [COUNT_KEY] }).pipe(
      Effect.runPromise,
    );

    await expect.element(screen.getByRole("status", { name: "Count" })).toHaveTextContent("4");
  });

  it("says when the shop cannot be reached", async () => {
    const registry = shopTestRegistry({
      MemberGetCount: () => Effect.die("unreachable"),
      MemberActivation: activation,
      MemberWhoAmI: memberWhoAmI,
    });
    const screen = await renderInApp(<ShopPage role="member" />, registry);

    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent("Couldn't reach the shop. Try again.");
  });

  it("a displaced socket shows Signed in elsewhere, and Reconnect asks again", async () => {
    const registry = shopTestRegistry({
      MemberGetCount: () => Effect.succeed({ value: 1 }),
      MemberActivation: activation,
      MemberWhoAmI: memberWhoAmI,
    });
    registry.set(connectionStateAtom, "displaced");
    const screen = await renderInApp(<ShopPage role="member" />, registry);
    await expect.element(screen.getByText("Signed in elsewhere")).toBeVisible();

    const before = registry.get(reconnectAtom);
    await screen.getByRole("button", { name: "Reconnect" }).click();
    expect(registry.get(reconnectAtom)).toBe(before + 1);
  });

  it("a member of another shop is told so instead of the count", async () => {
    const registry = shopTestRegistry({});
    registry.set(notAMemberAtom, true);
    const screen = await renderInApp(<ShopPage role="member" />, registry);

    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent("You're not a member of this shop.");
    await expect.element(screen.getByRole("status", { name: "Count" })).not.toBeInTheDocument();
  });
});
