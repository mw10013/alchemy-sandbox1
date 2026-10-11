import { useAtom, useAtomMount, useAtomValue } from "@effect/atom-react";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Layout, LayoutContent } from "@astryxdesign/core/Layout";
import { VStack } from "@astryxdesign/core/Stack";
import { Heading, Text } from "@astryxdesign/core/Text";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { useId } from "react";
import { activationAtom, countAtom, incrementAtom, noticesAtom } from "../shop-actor-client.ts";

/** Copy for any failure to reach the actor; follows the copy rules on `RootDocument`. */
const UNREACHABLE = "Couldn't reach the shop. Try again.";

/**
 * One shop's count, live across tabs: {@link noticesAtom} is mounted while the page is, so a
 * write in any tab refetches the count here. The route loads {@link countAtom} and
 * {@link activationAtom}; see `loadQuery`.
 */
export default function ShopPage() {
  useAtomMount(noticesAtom);
  const count = useAtomValue(countAtom);
  const activation = useAtomValue(activationAtom);
  const [incrementResult, increment] = useAtom(incrementAtom);
  const countLabel = useId();

  return (
    <Layout
      height="fill"
      contentWidth={768}
      content={
        <LayoutContent padding={6}>
          <VStack gap={4}>
            <Heading level={1}>Shop</Heading>
            <Card width={380}>
              <VStack gap={3} hAlign="start">
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
                  label="Increment"
                  variant="primary"
                  isLoading={incrementResult.waiting}
                  onClick={() => increment({ payload: undefined })}
                />
                {AsyncResult.isFailure(incrementResult) && (
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
          </VStack>
        </LayoutContent>
      }
    />
  );
}
