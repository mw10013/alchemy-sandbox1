import {
  RegistryContext,
  useAtom,
  useAtomMount,
  useAtomSet,
  useAtomValue,
} from "@effect/atom-react";
import { useHydrated } from "@tanstack/react-router";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import { type ReactNode, useContext, useId, useState } from "react";
import {
  connectionStateAtom,
  lostAtom,
  merchantExpiredAtom,
  notAMemberAtom,
  reconnectAtom,
  uninstalledAtom,
} from "../client/actor-connection.ts";
import type { ShopKey } from "../../contract/shop.ts";
import type { ConnectionCaller, Count } from "../../contract/shop-actor.ts";
import type { ShopPageData } from "../server/shop.ts";
import {
  activationAtom,
  countAtom,
  incrementAtom,
  merchantCountAtom,
  merchantWhoAmIAtom,
  noticesAtom,
  resetCountAtom,
  seedShop,
  whoAmIAtom,
} from "../client/shop-actor-client.ts";
import { Inline } from "./screen/Inline.tsx";
import { Lines } from "./screen/Lines.tsx";
import { Things } from "./screen/Things.tsx";

/** Copy for any failure to reach the actor; follows the copy rules on `RootDocument`. */
const UNREACHABLE = "Couldn't reach the shop. Try again.";
const NOT_A_MEMBER = "You're not a member of this shop.";
const EXPIRED = "Your Shopify session expired.";
const UNINSTALLED = "Baton was uninstalled from this shop.";

type Role = "member" | "merchant";

/** The atoms each role reads; a member and a merchant never share a procedure. */
const ROLES = {
  member: {
    count: countAtom,
    whoAmI: whoAmIAtom,
    activation: activationAtom,
    write: incrementAtom,
    label: "Increment",
  },
  merchant: {
    count: merchantCountAtom,
    whoAmI: merchantWhoAmIAtom,
    activation: Atom.make(AsyncResult.initial<{ readonly id: string }>()),
    write: resetCountAtom,
    label: "Reset",
  },
} as const;

/** One line naming who the actor says is on this page. */
const describeCaller = (caller: ConnectionCaller, shop: string) =>
  Match.value(caller).pipe(
    Match.discriminatorsExhaustive("role")({
      member: ({ memberEmail }) => `Signed in as ${memberEmail} (member)`,
      merchant: () => `Merchant of ${shop}`,
    }),
  );

function ShopFrame({ children }: { readonly children: ReactNode }) {
  return (
    <s-page heading="Shop" inlineSize="small">
      {children}
    </s-page>
  );
}

/**
 * Why the page cannot show the count. The sentence is the banner's `heading`, not its content:
 * Polaris puts `role="alert"` on an element inside its shadow root, and slotted content is not
 * part of that element's text, while the heading is rendered inside it.
 */
function Refusal({ text }: { readonly text: string }) {
  return <s-banner tone="critical" heading={text} />;
}

/**
 * The count section, the same markup before and after hydration. The count is an `<output>`
 * named by its label: its implicit `status` role announces a new value, and Polaris text
 * elements take neither a role nor `aria-labelledby`.
 */
function ShopCard(props: {
  readonly role: Role;
  readonly shop: ShopKey;
  readonly caller: Option.Option<ConnectionCaller>;
  readonly count: AsyncResult.AsyncResult<Count, unknown>;
  readonly activation: Option.Option<{ readonly id: string }>;
  readonly writing: boolean;
  readonly writeFailed: boolean;
  readonly onWrite: () => void;
}) {
  const countLabel = useId();
  return (
    <s-section accessibilityLabel="Count">
      <Things>
        {Option.isSome(props.caller) && (
          <s-paragraph color="subdued">
            {describeCaller(props.caller.value, props.shop)}
          </s-paragraph>
        )}
        <Lines>
          <s-text id={countLabel} color="subdued">
            Count
          </s-text>
          {AsyncResult.match(props.count, {
            onInitial: () => (
              <output>
                <s-text>Loading…</s-text>
              </output>
            ),
            onSuccess: ({ value }) => (
              <output aria-labelledby={countLabel}>
                <s-heading fontSize="large-400">{value.value}</s-heading>
              </output>
            ),
            onFailure: () => <Refusal text={UNREACHABLE} />,
          })}
        </Lines>
        <Inline>
          <s-button
            variant="primary"
            {...(props.writing ? { loading: true } : {})}
            onClick={props.onWrite}
          >
            {ROLES[props.role].label}
          </s-button>
        </Inline>
        {props.writeFailed && <Refusal text={UNREACHABLE} />}
        {Option.isSome(props.activation) && (
          <s-paragraph color="subdued">Activation {props.activation.value.id}</s-paragraph>
        )}
      </Things>
    </s-section>
  );
}

type Snapshot = Extract<ShopPageData, { readonly _tag: "Snapshot" }>;

/**
 * The page once hydrated: the socket's atoms, seeded from the loader's snapshot before the
 * first read, so the first live render shows what the server rendered and the socket only
 * keeps it current. {@link noticesAtom} is mounted while the page is, so a write in any
 * browser refetches the count here.
 */
function LiveShop(props: {
  readonly role: Role;
  readonly shop: ShopKey;
  readonly merchantToken: Option.Option<string>;
  readonly data: Snapshot;
}) {
  const registry = useContext(RegistryContext);
  useState(() =>
    seedShop(registry, {
      key: props.shop,
      merchantToken: Option.map(props.merchantToken, (token) => Effect.succeed(token)),
      caller: props.data.caller,
      snapshot: props.data.snapshot,
    }),
  );
  useAtomMount(noticesAtom);
  const atoms = ROLES[props.role];
  const count = useAtomValue(atoms.count);
  const whoAmI = useAtomValue(atoms.whoAmI);
  const activation = useAtomValue(atoms.activation);
  const [writeResult, write] = useAtom(atoms.write);
  const notAMember = useAtomValue(notAMemberAtom);
  const merchantExpired = useAtomValue(merchantExpiredAtom);
  const uninstalled = useAtomValue(uninstalledAtom);
  const connection = useAtomValue(connectionStateAtom);
  const lost = useAtomValue(lostAtom);
  const reconnect = useAtomSet(reconnectAtom);

  if (notAMember) return <Refusal text={NOT_A_MEMBER} />;
  if (merchantExpired) return <Refusal text={EXPIRED} />;
  if (uninstalled) return <Refusal text={UNINSTALLED} />;
  return (
    <>
      {connection === "displaced" && (
        <s-banner tone="warning" heading="Signed in elsewhere">
          <s-button
            slot="secondary-actions"
            variant="secondary"
            onClick={() => reconnect((n) => n + 1)}
          >
            Reconnect
          </s-button>
        </s-banner>
      )}
      {connection === "lost" && lost && <s-banner tone="info" heading="Reconnecting…" />}
      <ShopCard
        role={props.role}
        shop={props.shop}
        caller={AsyncResult.value(whoAmI)}
        count={count}
        activation={AsyncResult.value(activation)}
        writing={writeResult.waiting}
        writeFailed={AsyncResult.isFailure(writeResult)}
        onWrite={() => write({ payload: undefined })}
      />
    </>
  );
}

/**
 * One shop's count, live across browsers. A member increments; a merchant resets.
 *
 * The route's loader asks the Backend, which asks the gate and the actor, so the page arrives
 * with its data or with why the gate refused it; a refusal is shown and no socket is opened.
 * Until React has hydrated, the page renders the loader's snapshot, so the server markup and the
 * first client render agree and no socket is built on the server; after that, {@link LiveShop}
 * renders the socket's atoms.
 *
 * The socket's state shows as a banner: "Reconnecting…" once it has been lost for a few
 * seconds, and "Signed in elsewhere" with Reconnect when a newer window displaced it. When the
 * gate refuses a reconnect, or the shop uninstalls Baton, the card gives way to why.
 */
export default function ShopPage(props: {
  readonly role: Role;
  readonly shop: ShopKey;
  readonly merchantToken: Option.Option<string>;
  readonly data: ShopPageData;
}) {
  const hydrated = useHydrated();
  const { data } = props;
  return (
    <ShopFrame>
      {Match.valueTags(data, {
        NotAMember: () => <Refusal text={NOT_A_MEMBER} />,
        Expired: () => <Refusal text={EXPIRED} />,
        Snapshot: (snapshot) =>
          hydrated ? (
            <LiveShop {...props} data={snapshot} />
          ) : (
            <ShopCard
              role={props.role}
              shop={props.shop}
              caller={Option.some(snapshot.caller)}
              count={AsyncResult.success(snapshot.snapshot.count)}
              activation={
                props.role === "member" ? Option.some(snapshot.snapshot.activation) : Option.none()
              }
              writing={false}
              writeFailed={false}
              onWrite={() => {}}
            />
          ),
      })}
    </ShopFrame>
  );
}
