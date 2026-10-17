import * as Effect from "effect/Effect";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import type { OrdersListPage } from "../../../../src/contract/shop-actor.ts";
import type { OrderDetail, OrdersSyncStatus } from "../../../../src/domain/orders.ts";
import type { AppBridge } from "../../../../src/web/client/app-bridge.ts";
import OrdersPage, { type OrdersActions } from "../../../../src/web/components/OrdersPage.tsx";
import { renderInApp } from "../../render.tsx";
import { shopTestRegistry } from "../../shop-actor.ts";
import { SEED_SHOP } from "../../../seed-shops.ts";

const order = (n: number, overrides: Partial<OrderDetail["order"]> = {}): OrderDetail => ({
  order: {
    id: `gid://shopify/Order/${n}`,
    legacyId: String(n),
    name: `#${n}`,
    processedAt: Date.UTC(2026, 9, n),
    updatedAt: Date.UTC(2026, 9, n),
    cancelledAt: null,
    fulfillmentStatus: "UNFULFILLED",
    fullyPaid: true,
    note: null,
    syncedAt: Date.UTC(2026, 9, n),
    ...overrides,
  },
  lineItems: [
    {
      id: `gid://shopify/LineItem/${n}`,
      orderId: `gid://shopify/Order/${n}`,
      title: "Mug",
      variantTitle: null,
      sku: null,
      quantity: 3,
      currentQuantity: 2,
      productTags: [],
      properties: [],
    },
  ],
});

const pageOf = (orders: ReadonlyArray<OrderDetail>): OrdersListPage => ({
  orders,
  limit: 25,
  nextCursor: null,
});

const idle: OrdersSyncStatus = { inFlight: false, lastError: null };

/** Presses that answer nothing interesting unless a test says otherwise. */
const quiet: OrdersActions = {
  syncOpenOrders: () => Promise.resolve({ _tag: "Started" }),
  syncOrder: () => Promise.resolve({ _tag: "Stored" }),
};

/**
 * App Bridge's `shopify` global, which the embedded document defines and a test page does not:
 * a stub whose toasts are recorded in {@link toasts}.
 */
let toasts: Array<{ message: string; isError: boolean }> = [];
const appBridge: AppBridge = {
  idToken: () => Promise.resolve("token"),
  toast: {
    show: (message, options) => {
      toasts.push({ message, isError: options?.isError === true });
    },
  },
};

beforeEach(() => {
  toasts = [];
  globalThis.shopify = appBridge;
});
afterEach(() => {
  Reflect.deleteProperty(globalThis, "shopify");
});

const render = (
  page: OrdersListPage,
  options: { status?: OrdersSyncStatus; actions?: OrdersActions } = {},
) =>
  renderInApp(
    <OrdersPage
      shop={SEED_SHOP}
      page={page}
      merchantToken={Effect.succeed("token")}
      actions={options.actions ?? quiet}
    />,
    shopTestRegistry({
      MerchantListOrders: () => Effect.succeed(page),
      MerchantSyncStatus: () => Effect.succeed(options.status ?? idle),
    }),
  );

describe("OrdersPage", () => {
  it("renders a page of orders: name, payment, status, units to make and the Shopify link", async () => {
    const screen = await render(
      pageOf([order(2, { fullyPaid: false }), order(1, { cancelledAt: Date.UTC(2026, 9, 3) })]),
    );
    await expect.element(screen.getByText("#2", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("#1", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("Unpaid").first()).toBeVisible();
    await expect.element(screen.getByText("Cancelled")).toBeVisible();
    await expect.element(screen.getByText("2026-10-02")).toBeVisible();
    await expect
      .element(screen.getByRole("link", { name: "Open #2 in Shopify" }))
      .toHaveAttribute("href", "shopify://admin/orders/2");
    await expect
      .element(screen.getByRole("button", { name: "Sync #1 from Shopify" }))
      .toBeVisible();
    await expect.element(screen.getByText("No open orders")).not.toBeInTheDocument();
  });

  it("an empty list is the empty state, with Sync open orders", async () => {
    const screen = await render(pageOf([]));
    await expect.element(screen.getByText("No open orders")).toBeVisible();
    await expect
      .element(screen.getByText(/^Press Sync open orders to bring in your open orders/u))
      .toBeVisible();
  });

  it("a press while a sync runs toasts that one is already running", async () => {
    // The empty state's twin: outside the admin, the title bar's copy is in `s-page`'s actions,
    // which a narrow test page folds away; in the admin App Bridge hoists it.
    const screen = await render(pageOf([]), {
      actions: { ...quiet, syncOpenOrders: () => Promise.resolve({ _tag: "InFlight" }) },
    });
    await screen.getByRole("button", { name: "Sync open orders" }).click();
    await expect
      .poll(() => toasts)
      .toStrictEqual([{ message: "A sync is already running", isError: false }]);
  });

  it("Sync from Shopify on an order Shopify no longer has toasts Gone", async () => {
    const screen = await render(pageOf([order(1)]), {
      actions: { ...quiet, syncOrder: () => Promise.resolve({ _tag: "Gone" }) },
    });
    await screen.getByRole("button", { name: "Sync #1 from Shopify" }).click();
    await expect
      .poll(() => toasts)
      .toStrictEqual([{ message: "Shopify no longer has this order", isError: false }]);
  });

  it("a failed sync's error is the banner in the list's head", async () => {
    const screen = await render(pageOf([order(1)]), {
      status: { inFlight: false, lastError: "Step failed: poll-bulk-orders" },
    });
    await expect.element(screen.getByText("Step failed: poll-bulk-orders")).toBeVisible();
  });
});
