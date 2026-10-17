import { RegistryContext, useAtomMount, useAtomValue } from "@effect/atom-react";
import { useHydrated } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";
import type * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { useContext, useMemo, useState } from "react";
import { isFixtureOrder } from "../../contract/fixture.ts";
import { ORDER_SYNC_WINDOW_DAYS, type OrdersCallFailure } from "../../contract/orders.ts";
import type { ShopKey } from "../../contract/shop.ts";
import type { OrdersListInput, OrdersListPage } from "../../contract/shop-actor.ts";
import type { OrderDetail, OrdersSyncResult, SyncOrderResult } from "../../domain/orders.ts";
import { formatNumber, ShopLimits } from "../../domain/platform.ts";
import { ORDER_POSITION_LABEL, orderPosition } from "../../domain/shop-work.ts";
import { lostAtom, merchantExpiredAtom, uninstalledAtom } from "../client/actor-connection.ts";
import { toast } from "../client/app-bridge.ts";
import {
  merchantOrdersAtom,
  merchantSyncStatusAtom,
  nameOrdersSocket,
  noticesAtom,
  seedOrders,
} from "../client/shop-actor-client.ts";
import type { OrdersCallAnswer } from "../server/orders.ts";
import { EmptyLine } from "./screen/EmptyLine.tsx";
import { IndexSection } from "./screen/IndexSection.tsx";

/** What the screen asks the Backend to do; the route passes the server functions. */
export interface OrdersActions {
  readonly syncOpenOrders: () => Promise<OrdersCallAnswer<OrdersSyncResult>>;
  readonly syncOrder: (orderId: string) => Promise<OrdersCallAnswer<SyncOrderResult>>;
}

/**
 * The Next page link's `href` and click for the page starting after `cursor`; the route builds
 * them, because the URL and the router are its.
 */
export type OrdersPageLink = (cursor: string) => {
  readonly href: string;
  readonly onClick: (event: Event) => void;
};

/**
 * The order ceiling's sentence, as the quota banner words it. Sync open orders answers `Refused`
 * at the ceiling, and until the billing slice brings that banner, a toast is the only place the
 * merchant learns why the press did nothing.
 */
const CEILING = `New orders stopped syncing at ${formatNumber(ShopLimits.maxOpenOrders)} open orders. Fulfill or cancel orders in Shopify, then Sync open orders.`;
const UNINSTALLED = "Baton was uninstalled from this shop.";
const EXPIRED = "Your Shopify session expired.";

/** Why a Backend order call could not act, as the toast says it; `what` names the press. */
const failureCopy = (reason: OrdersCallFailure["_tag"], what: string) =>
  Match.value(reason).pipe(
    Match.when(
      "ReauthorizationRequired",
      () => "Couldn't reach Shopify. Reload Baton to reconnect.",
    ),
    Match.when("ShopifyUnavailable", () => "Couldn't reach Shopify. Try again."),
    Match.orElse(() => `Couldn't ${what}: Baton isn't installed on this shop.`),
  );

/** A press that threw: its message, as legacy shows it, or `fallback`. */
const thrownCopy = (error: unknown, fallback: string) =>
  error instanceof Error && error.message !== "" ? error.message : fallback;

/** Legacy's `adminOrderUrl`: the order in the Shopify admin, which App Bridge resolves. */
const adminOrderUrl = ({ legacyId }: OrderDetail["order"]) => `shopify://admin/orders/${legacyId}`;

/** The units still to make on the order: legacy's Items cell. */
const itemUnits = ({ lineItems }: OrderDetail) =>
  lineItems.reduce((sum, item) => sum + item.currentQuantity, 0);

/**
 * The Status cell: legacy's position badge over a run-free row, so an order reads Unpaid, No
 * workflow, Fulfilled or Cancelled until runs arrive.
 */
function PositionBadge({ order }: { readonly order: OrderDetail["order"] }) {
  const state = orderPosition({ order, runs: { open: 0, done: 0, blocked: 0, started: 0 } });
  return (
    <s-badge
      tone={Match.value(state).pipe(
        Match.when("making", () => "info" as const),
        Match.when("made", () => "success" as const),
        Match.when("cancelled", () => "critical" as const),
        Match.orElse(() => "neutral" as const),
      )}
    >
      {ORDER_POSITION_LABEL[state]}
    </s-badge>
  );
}

/** What the screen renders, the same before and after hydration. */
interface OrdersView {
  readonly page: OrdersListPage;
  readonly pageLink: OrdersPageLink;
  readonly banners: ReadonlyArray<string>;
  readonly syncInFlight: boolean;
  readonly syncing: boolean;
  readonly syncingOrders: ReadonlySet<string>;
  readonly onSyncOpenOrders: () => void;
  readonly onSyncOrder: (orderId: string) => void;
}

/**
 * The screen itself: Sync open orders in the title bar on every visit (and again, primary, in the
 * empty state, where it is the only thing to do), the banners in the list's head, then the table
 * or the empty line, and Next page under the table while there is one. App Bridge hoists the
 * slotted button into the admin's title bar.
 *
 * There is no Previous: the keyset cursor pages forward only, and page one is the Orders link
 * away. A fixture order ({@link isFixtureOrder}) is not in Shopify, so its row has no Shopify link
 * and no Sync from Shopify.
 */
function OrdersScreen(view: OrdersView) {
  const syncButton = (slotted: boolean) => (
    <s-button
      {...(slotted ? { slot: "secondary-actions" as const } : { variant: "primary" as const })}
      loading={view.syncing}
      disabled={view.syncing || view.syncInFlight}
      onClick={view.onSyncOpenOrders}
    >
      Sync open orders
    </s-button>
  );
  return (
    <s-page heading="Orders" inlineSize="large">
      {syncButton(true)}
      <IndexSection
        label="Orders"
        foot={
          view.page.nextCursor === null ? undefined : (
            <s-link {...view.pageLink(view.page.nextCursor)}>Next page</s-link>
          )
        }
        head={
          view.banners.length === 0
            ? undefined
            : view.banners.map((banner) => (
                <s-banner key={banner} tone="critical">
                  {banner}
                </s-banner>
              ))
        }
      >
        {view.page.orders.length === 0 ? (
          <EmptyLine heading="No open orders" action={syncButton(false)}>
            {`Press Sync open orders to bring in your open orders from the last ${String(ORDER_SYNC_WINDOW_DAYS)} days, or wait for the next order. After that, Baton adds each new order as it is placed.`}
          </EmptyLine>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Order</s-table-header>
              <s-table-header listSlot="secondary">Placed</s-table-header>
              <s-table-header listSlot="inline">Payment</s-table-header>
              <s-table-header listSlot="inline">Status</s-table-header>
              <s-table-header listSlot="labeled" format="numeric">
                Items
              </s-table-header>
              <s-table-header listSlot="labeled">Shopify</s-table-header>
              <s-table-header listSlot="labeled">Sync</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {view.page.orders.map((detail) => (
                <s-table-row key={detail.order.id}>
                  <s-table-cell>{detail.order.name}</s-table-cell>
                  <s-table-cell>
                    {DateTime.formatIsoDateUtc(DateTime.makeUnsafe(detail.order.processedAt))}
                  </s-table-cell>
                  <s-table-cell>
                    <s-badge tone={detail.order.fullyPaid ? "success" : "warning"}>
                      {detail.order.fullyPaid ? "Paid" : "Unpaid"}
                    </s-badge>
                  </s-table-cell>
                  <s-table-cell>
                    <PositionBadge order={detail.order} />
                  </s-table-cell>
                  <s-table-cell>{formatNumber(itemUnits(detail))}</s-table-cell>
                  {isFixtureOrder(detail.order.legacyId) ? (
                    <>
                      <s-table-cell />
                      <s-table-cell />
                    </>
                  ) : (
                    <>
                      <s-table-cell>
                        <s-button
                          icon="external"
                          variant="tertiary"
                          href={adminOrderUrl(detail.order)}
                          target="_blank"
                          accessibilityLabel={`Open ${detail.order.name} in Shopify`}
                        />
                      </s-table-cell>
                      <s-table-cell>
                        <s-button
                          variant="tertiary"
                          loading={view.syncingOrders.has(detail.order.id)}
                          accessibilityLabel={`Sync ${detail.order.name} from Shopify`}
                          onClick={() => view.onSyncOrder(detail.order.id)}
                        >
                          Sync from Shopify
                        </s-button>
                      </s-table-cell>
                    </>
                  )}
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </IndexSection>
    </s-page>
  );
}

/**
 * The screen once hydrated: the merchant socket's atoms, the shown page's seeded from the
 * loader's before its first read, so the first live render of each page shows what the loader
 * read and the socket only keeps it current. The socket is named once; a new page is a new
 * cursor, so a new node to seed, on the same socket. A node already there (the page was shown
 * before) is refetched instead. {@link noticesAtom} is mounted while the
 * page is, so a webhook, a sync or a sweep refetches the page shown, and a sync starting or ending
 * refetches its status.
 */
function LiveOrders(props: OrdersPageProps) {
  const registry = useContext(RegistryContext);
  useState(() =>
    nameOrdersSocket(registry, { key: props.shop, merchantToken: props.merchantToken }),
  );
  useMemo(
    () => seedOrders(registry, { cursor: props.cursor, page: props.page }),
    // Once per page shown, so not on `page`, which changes with its cursor: a refresh of the
    // node this render reads would notify it mid-render.
    [registry, props.cursor],
  );
  useAtomMount(noticesAtom);
  const orders = useAtomValue(merchantOrdersAtom(props.cursor));
  const status = AsyncResult.value(useAtomValue(merchantSyncStatusAtom));
  const uninstalled = useAtomValue(uninstalledAtom);
  const expired = useAtomValue(merchantExpiredAtom);
  const lost = useAtomValue(lostAtom);
  const [syncing, setSyncing] = useState(false);
  const [syncingOrders, setSyncingOrders] = useState<ReadonlySet<string>>(new Set());

  const onSyncOpenOrders = () => {
    setSyncing(true);
    props.actions
      .syncOpenOrders()
      .then((answer) =>
        Match.valueTags(answer, {
          Started: () => toast("Syncing open orders"),
          InFlight: () => toast("A sync is already running"),
          Refused: () => toast(CEILING, { isError: true }),
          Failed: () => toast("Couldn't start the sync.", { isError: true }),
        }),
      )
      .catch((error: unknown) =>
        toast(thrownCopy(error, "Couldn't start the sync."), { isError: true }),
      )
      .finally(() => setSyncing(false));
  };

  const onSyncOrder = (orderId: string) => {
    setSyncingOrders((current) => new Set([...current, orderId]));
    props.actions
      .syncOrder(orderId)
      .then((answer) =>
        Match.valueTags(answer, {
          Stored: () => {},
          Gone: () => toast("Shopify no longer has this order"),
          Failed: ({ reason }) => toast(failureCopy(reason, "sync the order"), { isError: true }),
        }),
      )
      .catch((error: unknown) =>
        toast(thrownCopy(error, "Couldn't sync the order."), { isError: true }),
      )
      .finally(() =>
        setSyncingOrders((current) => new Set([...current].filter((id) => id !== orderId))),
      );
  };

  const banners = [
    ...(uninstalled ? [UNINSTALLED] : []),
    ...(expired ? [EXPIRED] : []),
    ...(lost ? ["Reconnecting…"] : []),
    ...(AsyncResult.isFailure(orders) ? ["Couldn't load orders."] : []),
    ...Option.toArray(Option.flatMapNullishOr(status, ({ lastError }) => lastError)),
  ];
  return (
    <OrdersScreen
      page={Option.getOrElse(AsyncResult.value(orders), () => props.page)}
      pageLink={props.pageLink}
      banners={banners}
      syncInFlight={Option.exists(status, ({ inFlight }) => inFlight)}
      syncing={syncing}
      syncingOrders={syncingOrders}
      onSyncOpenOrders={onSyncOpenOrders}
      onSyncOrder={onSyncOrder}
    />
  );
}

/** {@link OrdersPage}'s props: `cursor` is the one `page` starts after, null on page one. */
interface OrdersPageProps {
  readonly shop: ShopKey;
  readonly cursor: OrdersListInput["cursor"];
  readonly page: OrdersListPage;
  readonly pageLink: OrdersPageLink;
  readonly merchantToken: Effect.Effect<string>;
  readonly actions: OrdersActions;
}

/**
 * The merchant's orders: a page of what the shop's actor has stored, newest first, with Sync
 * open orders, per row Sync from Shopify, and Next page. A live screen: the loader paints the
 * page, then the merchant socket keeps it current. Until React has hydrated it renders the
 * loader's page with no socket, so the server markup and the first client render agree.
 *
 * A sync's failure is the critical banner in the list's head (`lastError`); a press is a toast:
 * a sync started, or a press that did nothing or failed.
 */
export default function OrdersPage(props: OrdersPageProps) {
  const hydrated = useHydrated();
  if (hydrated) return <LiveOrders {...props} />;
  return (
    <OrdersScreen
      page={props.page}
      pageLink={props.pageLink}
      banners={[]}
      syncInFlight={false}
      syncing={false}
      syncingOrders={new Set()}
      onSyncOpenOrders={() => {}}
      onSyncOrder={() => {}}
    />
  );
}
