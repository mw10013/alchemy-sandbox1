import * as Effect from "effect/Effect";
import { ORDERS_SYNC_WORKFLOW } from "../orders-sync-constants.ts";
import type { OrdersSyncParams } from "../orders-sync-workflow.ts";

/**
 * The shop's actor's handle on `OrdersSyncWorkflow`: `create` only, the one call it makes. A
 * failed create is a defect, as Alchemy's own handle has it.
 */
export interface OrdersSyncWorkflows {
  readonly create: (options: {
    readonly id: string;
    readonly params: OrdersSyncParams;
  }) => Effect.Effect<void>;
}

/**
 * {@link OrdersSyncWorkflows} over the Workflow's binding in `env`, found by
 * {@link ORDERS_SYNC_WORKFLOW}. Not the Workflow class: yielding it runs the Workflow's outer
 * phase, which yields `ShopActors`, which yields the actor, so the actor cannot yield it. The
 * Backend yields the class, which keeps the binding and the export on its script, the script the
 * actor shares. `env` is empty while the stack is planned, so it is read only when `create` runs;
 * a missing binding then is a defect.
 */
export const makeOrdersSyncWorkflows = (env: Record<string, unknown>): OrdersSyncWorkflows => ({
  create: (options) =>
    Effect.suspend(() => {
      const binding = env[ORDERS_SYNC_WORKFLOW];
      if (typeof binding !== "object" || binding === null || !("create" in binding))
        return Effect.die(new Error(`Workflow binding ${ORDERS_SYNC_WORKFLOW} not found`));
      const workflow = binding as {
        readonly create: (options: unknown) => Promise<unknown>;
      };
      return Effect.tryPromise(() => workflow.create(options)).pipe(Effect.asVoid, Effect.orDie);
    }),
});
