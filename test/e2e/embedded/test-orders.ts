import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import * as Schema from "effect/Schema";

/**
 * Real orders on the e2e store for the embedded specs, through `scripts/test-order.ts` as a child
 * process: the runner is plain Node, and the CLI's store auth is the credential. Each order is
 * tagged with a fresh id that fits Shopify's 40-character tag limit, and a spec finds its row by
 * the order's own name, so no other run's order is mistaken for it. The store needs the one-time
 * `shopify store auth` in the stores runbook. A spec cancels every order it creates.
 *
 * @module
 */

const run = promisify(execFile);

const CreatedOrder = Schema.fromJsonString(
  Schema.Struct({ id: Schema.String, name: Schema.String }),
);
const decodeCreated = Schema.decodeUnknownSync(CreatedOrder);

/** A real order: its GID and its name (`#1001`). */
export type TestOrder = typeof CreatedOrder.Type;

/** `scripts/test-order.ts <args>` on this checkout's `.env`; its last stdout line. */
const testOrder = async (...args: ReadonlyArray<string>) => {
  const { stdout } = await run("node", ["--env-file=.env", "scripts/test-order.ts", ...args]);
  return stdout.trim().split("\n").at(-1) ?? "";
};

/** Creates a paid, open order with one custom line; Shopify then sends its webhooks. */
export const createTestOrder = async (): Promise<TestOrder> =>
  decodeCreated(await testOrder("create", `e2e-${randomUUID()}`));

/** Cancels an order {@link createTestOrder} made. */
export const cancelTestOrder = async (order: TestOrder): Promise<void> => {
  await testOrder("cancel", order.id);
};
