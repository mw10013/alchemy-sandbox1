#!/usr/bin/env node
/**
 * `vp run stores:check`: this checkout's Shopify dev stores. `check` verifies that the dev store
 * (`SHOPIFY_DEV_STORE`) and the e2e store (`SHOPIFY_E2E_STORE`) exist. It reads `.env` through
 * `node --env-file`, and the logic is in {@link checkStores}. Writing the dev fixture's store half
 * is `vp run fixture`'s.
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { CliError, Command } from "effect/cli";

import { requireStore, checkStores, StoresError } from "./lib/stores.ts";

/** Every failure is a message for the person at the terminal. */
const toUserError = <E extends { readonly message: string }>(error: E) =>
  new CliError.UserError({ cause: error, userMessage: error.message });

const storeFromEnv = (key: string) =>
  Config.NonEmptyString(key).pipe(
    Effect.mapError(
      () => new StoresError({ message: `${key} is not set: add it to .env (see .env.example)` }),
    ),
  );

const checkCommand = Command.make("check", {}, () =>
  Effect.gen(function* () {
    // The dev store is checked before the e2e key is read, so a `.env` still on the old scheme
    // fails on its dev store, the first thing to fix.
    const dev = yield* storeFromEnv("SHOPIFY_DEV_STORE");
    yield* requireStore("dev", "SHOPIFY_DEV_STORE", dev);
    yield* checkStores({ dev, e2e: yield* storeFromEnv("SHOPIFY_E2E_STORE") });
  }).pipe(Effect.mapError(toUserError)),
).pipe(
  Command.withDescription(
    "Check that this checkout's dev and e2e stores exist as dev stores on basic. Only reads; a missing store fails with the command to create it by hand.",
  ),
);

Command.make("stores").pipe(
  Command.withDescription("Check this checkout's Shopify dev stores"),
  Command.withSubcommands([checkCommand]),
  Command.run({ version: "1.0.0" }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
