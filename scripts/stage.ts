#!/usr/bin/env node
/**
 * Prints this checkout's stage of a per-developer environment and nothing else, for scripts and
 * configs that pass it to Alchemy: `node scripts/stage.ts dev` gives `dev-mw`, or `dev-mw-wt-01`
 * in worktree `wt-01`. Exits non-zero with the reason on stderr when there is no valid stage.
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { Argument, CliError, Command } from "effect/cli";

import { PerDeveloper } from "../src/backend/stage.ts";
import { stage } from "./lib/worktree.ts";

Command.make(
  "stage",
  {
    environment: Argument.Literals("environment", PerDeveloper.literals).pipe(
      Argument.withDescription("A per-developer environment: dev, test or e2e"),
    ),
  },
  ({ environment }) =>
    stage(environment).pipe(
      Effect.flatMap(Console.log),
      Effect.mapError(
        (error) => new CliError.UserError({ cause: error, userMessage: error.message }),
      ),
    ),
).pipe(
  Command.withDescription("Print this checkout's stage of an environment."),
  Command.run({ version: "1.0.0" }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
