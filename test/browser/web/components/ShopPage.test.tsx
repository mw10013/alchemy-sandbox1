import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { renderInApp } from "../../render.tsx";
import { shopTestRegistry } from "../../shop-actor.ts";
import {
  applyCloseOutcome,
  closeOutcome,
  reconnectAtom,
} from "../../../../src/web/client/actor-connection.ts";
import { EmailFromInput } from "../../../../src/contract/auth.ts";
import { SEED_SHOP } from "../../../seed-shops.ts";
import {
  CONNECTION_CLOSE_DISPLACED,
  CONNECTION_CLOSE_NOT_A_MEMBER,
  COUNT_KEY,
  type ConnectionCaller,
} from "../../../../src/contract/shop-actor.ts";
import type { ShopPageData } from "../../../../src/web/server/shop.ts";
import { noticeBus } from "../../../../src/web/client/shop-actor-client.ts";
import ShopPage from "../../../../src/web/components/ShopPage.tsx";

const member: ConnectionCaller = {
  role: "member",
  memberId: "mem-1",
  memberEmail: Schema.decodeUnknownSync(EmailFromInput)("m1@m.com"),
  teamIds: [],
  userId: "user-1",
  sessionId: "session-1",
  sessionExpiresAt: 0,
};
const merchant: ConnectionCaller = { role: "merchant" };

const snapshotOf = (caller: ConnectionCaller, value: number): ShopPageData => ({
  _tag: "Snapshot",
  caller,
  snapshot: { count: { value }, activation: { id: "activation-1" } },
});

const memberPage = (data: ShopPageData) => (
  <ShopPage role="member" shop={SEED_SHOP} merchantToken={Option.none()} data={data} />
);

/** A notice from the actor, as the socket would deliver it to this registry's page. */
const notice = (registry: ReturnType<typeof shopTestRegistry>) =>
  PubSub.publish(registry.get(noticeBus), {
    _tag: "ShopActorNotice",
    invalidated: [COUNT_KEY],
  }).pipe(Effect.runPromise);

/** The socket closing with `code`, as the browser protocol's retry policy reports it. */
const closeWith = (registry: ReturnType<typeof shopTestRegistry>, code: number) =>
  Effect.runPromise(
    applyCloseOutcome(
      registry,
      closeOutcome(
        new Socket.SocketError({ reason: new Socket.SocketCloseError({ code }) }),
        false,
      ),
    ),
  );

describe("ShopPage", () => {
  it("renders the snapshot before hydration, with no socket", () => {
    // React's server markup separates adjacent text parts with `<!-- -->`.
    const text = renderToString(memberPage(snapshotOf(member, 7))).replaceAll("<!-- -->", "");
    expect(text).toContain("Signed in as m1@m.com (member)");
    expect(text).toContain(">7<");
    expect(text).toContain("Activation activation-1");
    expect(text).not.toContain("Loading…");
  });

  it("shows the snapshot at once and asks the actor for nothing", async () => {
    let reads = 0;
    const registry = shopTestRegistry({
      MemberGetCount: () => Effect.sync(() => ({ value: 100 + ++reads })),
    });
    const screen = await renderInApp(memberPage(snapshotOf(member, 7)), registry);

    await expect.element(screen.getByRole("status", { name: "Count" })).toHaveTextContent("7");
    await expect.element(screen.getByText("Signed in as m1@m.com (member)")).toBeVisible();
    await expect.element(screen.getByText("Activation activation-1")).toBeVisible();
    expect(reads).toBe(0);
  });

  it("increments through the actor and shows the value a notice refetches", async () => {
    let value = 0;
    const registry = shopTestRegistry({
      MemberGetCount: () => Effect.sync(() => ({ value })),
      MemberIncrement: () => Effect.sync(() => ({ value: ++value })),
    });
    const screen = await renderInApp(memberPage(snapshotOf(member, 0)), registry);
    await expect.element(screen.getByRole("status", { name: "Count" })).toHaveTextContent("0");
    await expect.element(screen.getByRole("button", { name: "Reset" })).not.toBeInTheDocument();

    await screen.getByRole("button", { name: "Increment" }).click();
    // The page refetches on the actor's notice, not on the mutation's result.
    await notice(registry);

    await expect.element(screen.getByRole("status", { name: "Count" })).toHaveTextContent("1");
    expect(value).toBe(1);
  });

  it("a merchant sees Reset, not Increment, and resets through the actor", async () => {
    let value = 5;
    const registry = shopTestRegistry({
      MerchantGetCount: () => Effect.sync(() => ({ value })),
      MerchantResetCount: () => Effect.sync(() => ({ value: (value = 0) })),
    });
    const screen = await renderInApp(
      <ShopPage
        role="merchant"
        shop={SEED_SHOP}
        merchantToken={Option.some("token")}
        data={snapshotOf(merchant, 5)}
      />,
      registry,
    );
    await expect.element(screen.getByRole("status", { name: "Count" })).toHaveTextContent("5");
    await expect.element(screen.getByText(`Merchant of ${SEED_SHOP}`)).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Increment" })).not.toBeInTheDocument();

    await screen.getByRole("button", { name: "Reset" }).click();
    await notice(registry);

    await expect.element(screen.getByRole("status", { name: "Count" })).toHaveTextContent("0");
  });

  it("says when the shop cannot be reached", async () => {
    const registry = shopTestRegistry({ MemberGetCount: () => Effect.die("unreachable") });
    const screen = await renderInApp(memberPage(snapshotOf(member, 1)), registry);
    await notice(registry);

    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent("Couldn't reach the shop. Try again.");
  });

  it("a displaced socket (4409) shows Signed in elsewhere, and Reconnect asks again", async () => {
    const registry = shopTestRegistry({});
    const screen = await renderInApp(memberPage(snapshotOf(member, 1)), registry);
    await closeWith(registry, CONNECTION_CLOSE_DISPLACED);
    await expect.element(screen.getByText("Signed in elsewhere")).toBeVisible();

    const before = registry.get(reconnectAtom);
    await screen.getByRole("button", { name: "Reconnect" }).click();
    expect(registry.get(reconnectAtom)).toBe(before + 1);
  });

  it("a member removed while the page is open (4404) is told so instead of the count", async () => {
    const registry = shopTestRegistry({});
    const screen = await renderInApp(memberPage(snapshotOf(member, 1)), registry);
    await closeWith(registry, CONNECTION_CLOSE_NOT_A_MEMBER);

    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent("You're not a member of this shop.");
    await expect.element(screen.getByRole("status", { name: "Count" })).not.toBeInTheDocument();
  });

  it("a member of another shop is told so by the loader, and no socket is opened", async () => {
    const registry = shopTestRegistry({});
    const screen = await renderInApp(memberPage({ _tag: "NotAMember" }), registry);

    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent("You're not a member of this shop.");
    await expect.element(screen.getByRole("status", { name: "Count" })).not.toBeInTheDocument();
  });

  it("a merchant whose Shopify session expired is told so by the loader, and no socket is opened", async () => {
    const registry = shopTestRegistry({});
    const screen = await renderInApp(
      <ShopPage
        role="merchant"
        shop={SEED_SHOP}
        merchantToken={Option.some("token")}
        data={{ _tag: "Expired" }}
      />,
      registry,
    );

    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent("Your Shopify session expired.");
    await expect.element(screen.getByRole("status", { name: "Count" })).not.toBeInTheDocument();
  });
});
