#!/usr/bin/env node
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as Array from "effect/Array";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { CliError, Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  appFrame,
  awaitHydration,
  closeDevConsole,
  gotoApp,
  prepareApp,
} from "./lib/embedded-app.ts";
import { StoreName, StoreOf } from "./lib/worktree.ts";

class BrowserError extends Schema.TaggedError<BrowserError>()("BrowserError", {
  message: Schema.String,
}) {}

const storageState = "playwright/.auth/shopify-admin.json";
const session = "dev";
const HandleLine = Schema.Trim.pipe(
  Schema.decodeTo(Schema.TemplateLiteralParser(['handle = "', Schema.NonEmptyString, '"'])),
);
const decodeHandleLine = Schema.decodeUnknownOption(HandleLine);

const runCLI = Effect.fn("browser.runCLI")(function* (
  args: readonly string[],
  env: Record<string, string> = {},
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make("vp", ["exec", "playwright", "cli", `-s=${session}`, ...args], {
      env,
      extendEnv: true,
      stdout: "inherit",
      stderr: "inherit",
    }),
  );
  const code = yield* child.exitCode;
  if (code !== ChildProcessSpawner.ExitCode(0)) {
    return yield* new BrowserError({
      message:
        "Browser command failed; see output above. Check vp run dev:status; if the login expired, run vp run e2e:auth and reopen.",
    });
  }
}, Effect.scoped);

/**
 * The CLI's run-code VM cannot import modules. Serialize the shared helpers with their complete
 * closure here; keep new helper dependencies in this list so tests and the CLI use the same rules.
 * Node's TypeScript loader erases types before Function.toString exposes these bodies.
 */
const readinessCode = (url?: string) => `async (page) => {
  const appFrame = ${appFrame.toString()};
  const awaitHydration = ${awaitHydration.toString()};
  const closeDevConsole = ${closeDevConsole.toString()};
  const prepareApp = ${prepareApp.toString()};
  const gotoApp = ${gotoApp.toString()};
  await ${url === undefined ? "prepareApp(page)" : `gotoApp(page, ${JSON.stringify(url)})`};
  return { ready: true };
}`;

const ready = Effect.gen(function* () {
  yield* runCLI(["--raw", "run-code", readinessCode()]);
  yield* runCLI(["snapshot", "--filename=.playwright-cli/dev-ready.yml"]);
});

const open = Effect.fn("browser.open")(function* (headed: boolean) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(storageState))) {
    return yield* new BrowserError({
      message: "Shopify login is missing. Run vp run e2e:auth, then vp run browser open.",
    });
  }
  const port = yield* Config.Port("WEBSITE_PORT");
  const store = Schema.encodeSync(StoreName)(
    yield* Config.schema(StoreOf("dev"), "SHOPIFY_DEV_STORE"),
  );
  const toml = yield* fs.readFileString("shopify.app.toml");
  const handle = yield* Effect.fromOption(
    Array.findFirst(toml.split("\n"), (line) =>
      Option.map(decodeHandleLine(line), ([, value]) => value),
    ),
  ).pipe(
    Effect.mapError(() => new BrowserError({ message: "shopify.app.toml has no app handle" })),
  );
  yield* Effect.tryPromise({
    try: async () => {
      const response = await fetch(`http://localhost:${port}/`, {
        signal: AbortSignal.timeout(5000),
      });
      await response.body?.cancel();
      return response.ok;
    },
    catch: () =>
      new BrowserError({ message: "Dev server is not answering. Start it with vp run dev." }),
  }).pipe(
    Effect.flatMap((ok) =>
      ok
        ? Effect.void
        : Effect.fail(
            new BrowserError({ message: "Dev server is not healthy. Check vp run dev:status." }),
          ),
    ),
  );
  const url = `https://admin.shopify.com/store/${store}/apps/${handle}/app`;
  yield* Effect.gen(function* () {
    yield* runCLI(["open", "--browser=chrome", ...(headed ? ["--headed"] : [])], {
      PLAYWRIGHT_MCP_STORAGE_STATE: storageState,
      PLAYWRIGHT_MCP_HEADLESS: headed ? "false" : "true",
    });
    yield* runCLI(["--raw", "run-code", readinessCode(url)]);
    yield* runCLI(["snapshot", "--filename=.playwright-cli/dev-ready.yml"]);
    yield* Console.log("Ready: session=dev; snapshot=.playwright-cli/dev-ready.yml");
  }).pipe(Effect.onError(() => runCLI(["close"]).pipe(Effect.ignore)));
});

const toUserError = <E extends { readonly message: string }>(error: E) =>
  new CliError.UserError({ cause: error, userMessage: error.message });

Command.make("browser").pipe(
  Command.withDescription("Drive the embedded app in this checkout's Shopify dev store"),
  Command.withSubcommands([
    Command.make(
      "open",
      { headed: Flag.Boolean("headed").pipe(Flag.withDefault(false)) },
      ({ headed }) => open(headed).pipe(Effect.mapError(toUserError)),
    ),
    Command.make("ready", {}, () => ready.pipe(Effect.mapError(toUserError))),
    Command.make("close", {}, () => runCLI(["close"]).pipe(Effect.mapError(toUserError))),
  ]),
  Command.run({ version: "1.0.0" }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
