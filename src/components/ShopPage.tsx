import { useAtom, useAtomMount, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Layout, LayoutContent } from "@astryxdesign/core/Layout";
import { VStack } from "@astryxdesign/core/Stack";
import { Heading, Text } from "@astryxdesign/core/Text";
import * as Match from "effect/Match";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import { useId } from "react";
import type { Caller } from "../api/shop-actor.ts";
import {
  activationAtom,
  countAtom,
  incrementAtom,
  merchantCountAtom,
  merchantWhoAmIAtom,
  noticesAtom,
  resetCountAtom,
  whoAmIAtom,
} from "../shop-actor-client.ts";
import {
  connectionStateAtom,
  lostAtom,
  merchantExpiredAtom,
  notAMemberAtom,
  reconnectAtom,
  shopKeyAtom,
} from "../ticket-client.ts";

/** Copy for any failure to reach the actor; follows the copy rules on `RootDocument`. */
const UNREACHABLE = "Couldn't reach the shop. Try again.";

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
const describeCaller = (caller: Caller, shop: string) =>
  Match.value(caller).pipe(
    Match.discriminatorsExhaustive("role")({
      member: ({ memberEmail }) => `Signed in as ${memberEmail} (member)`,
      merchant: () => `Merchant of ${shop}`,
      system: () => "",
    }),
  );

/**
 * One shop's count, live across browsers: {@link noticesAtom} is mounted while the page is, so
 * a write in any browser refetches the count here. A member increments; a merchant resets.
 * The route loads the role's count, its who-am-I and the ticket the first connect spends; see
 * `loadQuery`.
 *
 * The socket's state shows as a banner: "Reconnecting…" once it has been lost for a few
 * seconds, and "Signed in elsewhere" with Reconnect when a newer window displaced it. When the
 * Backend refuses this browser, the card gives way to why.
 */
export default function ShopPage({ role }: { readonly role: "member" | "merchant" }) {
  useAtomMount(noticesAtom);
  const atoms = ROLES[role];
  const count = useAtomValue(atoms.count);
  const whoAmI = useAtomValue(atoms.whoAmI);
  const activation = useAtomValue(atoms.activation);
  const [writeResult, write] = useAtom(atoms.write);
  const shop = useAtomValue(shopKeyAtom);
  const notAMember = useAtomValue(notAMemberAtom);
  const merchantExpired = useAtomValue(merchantExpiredAtom);
  const connection = useAtomValue(connectionStateAtom);
  const lost = useAtomValue(lostAtom);
  const reconnect = useAtomSet(reconnectAtom);
  const countLabel = useId();

  const refusal = notAMember
    ? "You're not a member of this shop."
    : merchantExpired
      ? "Your Shopify session expired."
      : undefined;

  return (
    <Layout
      height="fill"
      contentWidth={768}
      content={
        <LayoutContent padding={6}>
          <VStack gap={4}>
            <Heading level={1}>Shop</Heading>
            {refusal !== undefined ? (
              <Text as="p" role="alert">
                {refusal}
              </Text>
            ) : (
              <>
                {connection === "displaced" && (
                  <Banner
                    status="warning"
                    title="Signed in elsewhere"
                    endContent={
                      <Button
                        label="Reconnect"
                        variant="secondary"
                        onClick={() => reconnect((n) => n + 1)}
                      />
                    }
                  />
                )}
                {connection === "lost" && lost && <Banner status="info" title="Reconnecting…" />}
                <Card width={380}>
                  <VStack gap={3} hAlign="start">
                    {AsyncResult.isSuccess(whoAmI) && (
                      <Text as="p" type="supporting">
                        {describeCaller(whoAmI.value, shop)}
                      </Text>
                    )}
                    <Text id={countLabel} type="label">
                      Count
                    </Text>
                    {AsyncResult.match(count, {
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
                      onFailure: () => (
                        <Text as="p" role="alert">
                          {UNREACHABLE}
                        </Text>
                      ),
                    })}
                    <Button
                      label={atoms.label}
                      variant="primary"
                      isLoading={writeResult.waiting}
                      onClick={() => write({ payload: undefined })}
                    />
                    {AsyncResult.isFailure(writeResult) && (
                      <Text as="p" role="alert">
                        {UNREACHABLE}
                      </Text>
                    )}
                  </VStack>
                </Card>
                {AsyncResult.isSuccess(activation) && (
                  <Text as="p" type="supporting">
                    Activation {activation.value.id}
                  </Text>
                )}
              </>
            )}
          </VStack>
        </LayoutContent>
      }
    />
  );
}
