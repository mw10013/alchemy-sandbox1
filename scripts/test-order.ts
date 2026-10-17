#!/usr/bin/env node
/**
 * A real order on this checkout's e2e store (`SHOPIFY_E2E_STORE`), for the e2e orders spec, which
 * runs it as a child process: `create <tag>` prints the new order's `{"id","name"}` as one JSON
 * line, `cancel <id>` cancels it. The logic is {@link createTestOrder} and {@link cancelTestOrder},
 * which admit the e2e store only. Run with `node --env-file=.env`.
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { Argument, CliError, Command } from "effect/cli";

import { cancelTestOrder, createTestOrder, StoresError } from "./lib/stores.ts";

const toUserError = <E extends { readonly message: string }>(error: E) =>
  new CliError.UserError({ cause: error, userMessage: error.message });

const e2eStore = Config.NonEmptyString("SHOPIFY_E2E_STORE").pipe(
  Effect.mapError(
    () => new StoresError({ message: "SHOPIFY_E2E_STORE is not set: add it to .env" }),
  ),
);

const createCommand = Command.make("create", { tag: Argument.String("tag") }, ({ tag }) =>
  Effect.gen(function* () {
    const order = yield* createTestOrder(yield* e2eStore, tag);
    yield* Console.log(JSON.stringify(order));
  }).pipe(Effect.mapError(toUserError)),
).pipe(Command.withDescription("Create a paid test order tagged <tag> on the e2e store"));

const cancelCommand = Command.make("cancel", { id: Argument.String("id") }, ({ id }) =>
  Effect.gen(function* () {
    yield* cancelTestOrder(yield* e2eStore, id);
  }).pipe(Effect.mapError(toUserError)),
).pipe(Command.withDescription("Cancel test order <id> (a GID) on the e2e store"));

Command.make("test-order").pipe(
  Command.withDescription("Test orders on this checkout's e2e store"),
  Command.withSubcommands([createCommand, cancelCommand]),
  Command.run({ version: "1.0.0" }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
