#!/usr/bin/env node
/**
 * Prints this checkout's dev stage and nothing else, for the `dev:alchemy` script to pass to
 * `alchemy dev --stage`. Exits non-zero with the reason on stderr when there is no valid stage.
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { CliError, Command } from "effect/cli";

import { devStage } from "./lib/worktree.ts";

Command.make("dev-stage", {}, () =>
  devStage.pipe(
    Effect.flatMap(Console.log),
    Effect.mapError(
      (error) => new CliError.UserError({ cause: error, userMessage: error.message }),
    ),
  ),
).pipe(
  Command.withDescription("Print this checkout's dev stage."),
  Command.run({ version: "1.0.0" }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
