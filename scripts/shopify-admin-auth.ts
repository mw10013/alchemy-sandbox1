#!/usr/bin/env node
/**
 * `vp run e2e:auth`: exports the logged-in Shopify admin session from Chrome into the Playwright
 * storage state the `embedded` e2e project loads. macOS only; it asks for Keychain access, which a
 * person must answer, so an agent never runs it without `--dry-run` (and `--dry-run` asks too).
 * The logic is in {@link exportShopifyAdminAuth}.
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { CliError, Command, Flag } from "effect/cli";

import { CHROME_PROFILE, ChromeProfile, exportShopifyAdminAuth } from "./lib/shopify-admin-auth.ts";

Command.make(
  "shopify-admin-auth",
  {
    output: Flag.String("output").pipe(Flag.withDefault("playwright/.auth/shopify-admin.json")),
    profile: Flag.String("profile").pipe(
      Flag.withSchema(ChromeProfile),
      Flag.withDescription("Chrome profile directory (chrome://version, Profile Path)"),
      Flag.withDefault(CHROME_PROFILE),
    ),
    dryRun: Flag.Boolean("dry-run").pipe(
      Flag.withDescription(
        "Read and decrypt the cookies without writing the storage state; still asks for Keychain access",
      ),
      Flag.withDefault(false),
    ),
  },
  (options) =>
    Effect.gen(function* () {
      const count = yield* exportShopifyAdminAuth(options);
      yield* Console.log(
        options.dryRun
          ? `dry-run: ${String(count)} Shopify cookie(s) found; not writing ${options.output}`
          : `Wrote ${String(count)} cookies to ${options.output}`,
      );
    }).pipe(
      Effect.mapError(
        (error) => new CliError.UserError({ cause: error, userMessage: error.message }),
      ),
    ),
).pipe(
  Command.withDescription(
    "Export a logged-in Shopify session from Chrome into Playwright storage state. macOS only; asks for Keychain access.",
  ),
  Command.run({ version: "1.0.0" }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
