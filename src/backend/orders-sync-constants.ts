/**
 * The open-orders sync's bounds, shared by the Workflow that runs it and the actor that tracks it.
 *
 * @module
 */

/**
 * When to stop the spinner, not when to expect success. An open-work export
 * of a shop under the order ceiling completes in well under a minute, so this
 * is ten times the expected duration; Shopify itself only fails a bulk query
 * after 10 days, and the operation it leaves running is cancelled rather than
 * abandoned (`OrdersSyncWorkflow`).
 */
export const BULK_GIVE_UP_MS = 5 * 60_000;

/**
 * The gap between polls of the bulk operation. Small enough that a typical
 * sync is noticed within seconds of finishing, and `BULK_GIVE_UP_MS / this`
 * steps is nothing against a Workflow instance's 10,000-step limit.
 */
export const BULK_POLL_INTERVAL_MS = 5000;

/**
 * How long a tracking record (`SyncState.workflowId` and `startedAt`) is trusted. Nothing
 * reaps a record a Workflow left behind when it died without reaching its sink. Ten
 * minutes is comfortably past the workflow's own give-up bound plus its
 * stream, so a record older than this is dead.
 *
 * **A tracking record disables Sync open orders only while it is fresh.** The orders index
 * reads a stale record as no sync, so the button comes back, and the next press clears the
 * record without asking Cloudflare (`OrderRepository.beginSync`) and starts a new
 * sync. Were a stale record to keep the button disabled, the press that clears
 * it could never happen, and one dead instance would disable the button for
 * good. Rule 3 on `syncOrder`.
 */
export const SYNC_STALE_MS = 10 * 60 * 1000;

/**
 * What the merchant is told when Shopify has not finished the export inside
 * {@link BULK_GIVE_UP_MS}. It is the whole of what they can do about it, and
 * re-running is always safe because the query is fixed
 * (`bulkOrdersQueryText`).
 */
export const GAVE_UP_MESSAGE = "Shopify did not finish the export in time. Try again.";
