import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { chmodSync, readFileSync, statSync } from "node:fs";
import { test as setup } from "playwright/test";

import { storageStatePath } from "../../playwright.config.ts";
import {
  adminSessionFresh,
  CHROME_PROFILE,
  exportShopifyAdminAuth,
} from "../../scripts/lib/shopify-admin-auth.ts";

const StorageState = Schema.fromJsonString(
  Schema.Struct({
    cookies: Schema.Array(
      Schema.Struct({ name: Schema.String, domain: Schema.String, expires: Schema.Number }),
    ),
  }),
);
const decodeStorageState = Schema.decodeUnknownSync(StorageState);

/**
 * Whether the export on disk is still worth using, by the cookies it holds and the file's own
 * age ({@link adminSessionFresh}): a fresh export avoids a Keychain prompt. It does not know
 * whether Shopify revoked the session; the embedded specs exercise the real one.
 */
const exportFresh = (): boolean => {
  try {
    const { cookies } = decodeStorageState(readFileSync(storageStatePath, "utf8"));
    return adminSessionFresh(cookies, statSync(storageStatePath).mtimeMs);
  } catch {
    return false;
  }
};

/**
 * Runs the export effect directly, so cancellation reaches the Keychain process and the scoped
 * files. The export's 150 s deadline fits inside this timeout.
 */
setup("shopify admin auth", async () => {
  setup.setTimeout(180_000);
  if (exportFresh()) {
    chmodSync(storageStatePath, 0o600);
    return;
  }
  await Effect.runPromise(
    exportShopifyAdminAuth({ output: storageStatePath, profile: CHROME_PROFILE }).pipe(
      Effect.tap((count) => Console.log(`Wrote ${String(count)} cookies to ${storageStatePath}`)),
      Effect.provide(NodeServices.layer),
    ),
  );
});
