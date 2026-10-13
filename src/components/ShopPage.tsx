import {
  RegistryContext,
  useAtom,
  useAtomMount,
  useAtomSet,
  useAtomValue,
} from "@effect/atom-react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Layout, LayoutContent } from "@astryxdesign/core/Layout";
import { VStack } from "@astryxdesign/core/Stack";
import { Heading, Text } from "@astryxdesign/core/Text";
import { useHydrated } from "@tanstack/react-router";
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
} from "../actor-connection.ts";
import type { ShopKey } from "../api/shop.ts";
import type { ConnectionCaller, Count } from "../api/shop-actor.ts";
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
} from "../shop-actor-client.ts";

/** Copy for any failure to reach the actor; follows the copy rules on `RootDocument`. */
const UNREACHABLE = "Couldn't reach the shop. Try again.";
const NOT_A_MEMBER = "You're not a member of this shop.";
const EXPIRED = "Your Shopify session expired.";

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
    <Layout
      height="fill"
      contentWidth={768}
      content={
        <LayoutContent padding={6}>
          <VStack gap={4}>
            <Heading level={1}>Shop</Heading>
            {children}
          </VStack>
        </LayoutContent>
      }
    />
  );
}

function Refusal({ text }: { readonly text: string }) {
  return (
    <Text as="p" role="alert">
      {text}
    </Text>
  );
}

/** The count card and the activation line, the same markup before and after hydration. */
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
    <>
      <Card width={380}>
        <VStack gap={3} hAlign="start">
          {Option.isSome(props.caller) && (
            <Text as="p" type="supporting">
              {describeCaller(props.caller.value, props.shop)}
            </Text>
          )}
          <Text id={countLabel} type="label">
            Count
          </Text>
          {AsyncResult.match(props.count, {
            onInitial: () => (
              <Text as="p" role="status">
                Loading…
              </Text>
            ),
            onSuccess: ({ value }) => (
              <Text as="p" type="display-2" role="status" aria-labelledby={countLabel}>
                {value.value}
              </Text>
            ),
            onFailure: () => <Refusal text={UNREACHABLE} />,
          })}
          <Button
            label={ROLES[props.role].label}
            variant="primary"
            isLoading={props.writing}
            onClick={props.onWrite}
          />
          {props.writeFailed && <Refusal text={UNREACHABLE} />}
        </VStack>
      </Card>
      {Option.isSome(props.activation) && (
        <Text as="p" type="supporting">
          Activation {props.activation.value.id}
        </Text>
      )}
    </>
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
      merchantToken: props.merchantToken,
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
  const connection = useAtomValue(connectionStateAtom);
  const lost = useAtomValue(lostAtom);
  const reconnect = useAtomSet(reconnectAtom);

  if (notAMember) return <Refusal text={NOT_A_MEMBER} />;
  if (merchantExpired) return <Refusal text={EXPIRED} />;
  return (
    <>
      {connection === "displaced" && (
        <Banner
          status="warning"
          title="Signed in elsewhere"
          endContent={
            <Button label="Reconnect" variant="secondary" onClick={() => reconnect((n) => n + 1)} />
          }
        />
      )}
      {connection === "lost" && lost && <Banner status="info" title="Reconnecting…" />}
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
 * gate refuses a reconnect, the card gives way to why.
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
