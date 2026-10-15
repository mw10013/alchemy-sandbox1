#!/usr/bin/env node
/**
 * Prints {@link webEnvironment} and nothing else, for the `dev:alchemy` package script, which runs
 * `web:<environment>`. Exits non-zero on a value that is not an environment.
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { CliError, Command } from "effect/cli";

import { webEnvironment } from "./lib/web.ts";

Command.make("web", {}, () =>
  webEnvironment.pipe(
    Effect.flatMap(Console.log),
    Effect.mapError(
      (error) => new CliError.UserError({ cause: error, userMessage: error.message }),
    ),
  ),
).pipe(
  Command.withDescription("Print the environment the Shopify CLI's web command serves."),
  Command.run({ version: "1.0.0" }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
