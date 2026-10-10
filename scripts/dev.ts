#!/usr/bin/env node
/**
 * `pnpm dev:start | dev:stop | dev:status | dev:logs`: one command that an
 * agent and a person both use to get this checkout's dev server (`pnpm dev`,
 * which runs `alchemy dev`) running, and to find it again. Every checkout,
 * the main one and each `wt-NN` worktree, runs its own server on its own
 * `WEBSITE_PORT` from its `.env`.
 *
 * Where the server runs; the first rule that applies wins:
 *
 * 1. An `alchemy dev` already serving this checkout, wherever it runs, is
 *    adopted: `start` leaves it running, `stop` stops it, whoever started it.
 *    It is found by process and working directory, not by label.
 * 2. With herdr running, the server belongs to the checkout's workspace,
 *    which is opened if needed: labelled with the project name for the main
 *    checkout, `wt-NN` for a worktree (grouped under the main checkout's
 *    workspace, which is opened first). In it, a tab labelled `dev`:
 *    - typed by a person (a TTY) in the `dev` tab: the caller's terminal, in
 *      the foreground;
 *    - otherwise (an agent, or a person in another tab): an idle pane of the
 *      `dev` tab, a new split when none is idle, or a new `dev` tab. It never
 *      types into a busy pane.
 * 3. Without herdr, typed by a person: the caller's terminal, in the
 *    foreground.
 * 4. Otherwise: a detached background process.
 *
 * herdr is asked whether it runs (`herdr status`), never `HERDR_ENV`: T3 Code
 * agents run outside herdr but can still drive it over its socket.
 *
 * The server's output always goes to `logs/dev/current` (`pnpm dev` pipes it
 * through `s6-log`), and to the pane or terminal it runs in.
 *
 * `start` and `stop` hold `logs/dev.lock` so parallel agents in one checkout
 * cannot start two servers.
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as Array from "effect/Array";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { CliError, Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { runCommand } from "./lib/command.ts";
import * as Herdr from "./lib/herdr.ts";
import { checkoutKind, currentBranch } from "./lib/worktree.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/u, "");
const LOG = "logs/dev/current";
const LOCK = "logs/dev.lock";
const DEV_TAB = "dev";
const SERVER_PROCESS = "alchemy dev";
const START_TIMEOUT_MS = 180_000;
const STOP_TIMEOUT_MS = 20_000;

class DevError extends Schema.TaggedError<DevError>()("DevError", {
  message: Schema.String,
}) {}

const fail = (message: string) => new DevError({ message });

/** The port from `.env`, which the package scripts load with `--env-file-if-exists`. */
const loadPort = Config.Port("WEBSITE_PORT").pipe(
  Effect.mapError(() =>
    fail("WEBSITE_PORT is not set to a port: run through the package scripts, which load .env"),
  ),
);

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/** One line per step with its duration; a failing step says so before its error. */
const step = Effect.fn("step")(function* <A, E, R>(label: string, effect: Effect.Effect<A, E, R>) {
  const started = Date.now();
  const result = yield* effect.pipe(
    Effect.tapError(() => Console.log(`fail  ${label} (${seconds(Date.now() - started)})`)),
  );
  yield* Console.log(`ok    ${label} (${seconds(Date.now() - started)})`);
  return result;
});

/** Polls `check` every `intervalMs` until it is true; false once `timeoutMs` passes first. */
const waitUntil = <E, R>(
  check: Effect.Effect<boolean, E, R>,
  timeoutMs: number,
  intervalMs: number,
) =>
  check.pipe(
    Effect.repeat({ until: (ready) => ready, schedule: Schedule.spaced(intervalMs) }),
    Effect.timeoutOption(timeoutMs),
    Effect.map(Option.isSome),
  );

const Pid = Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThan(0));
const decodePid = Schema.decodeUnknownResult(Pid);

/** The pids in line-oriented command output; anything that is not a pid is skipped. */
const pidsFrom = (output: string) =>
  Array.filterMap(output.split("\n"), (line) => decodePid(line.trim()));

const cwdOf = (pid: number) =>
  runCommand("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]).pipe(
    Effect.map((output) =>
      Option.fromUndefinedOr(
        output
          .split("\n")
          .find((line) => line.startsWith("n"))
          ?.slice(1),
      ),
    ),
    Effect.orElseSucceed(() => Option.none<string>()),
  );

/** Processes whose command line runs `alchemy dev` in this checkout (the `pnpm dev` shell and Alchemy's CLI). */
const serverPids = runCommand("pgrep", ["-f", SERVER_PROCESS]).pipe(
  Effect.map(pidsFrom),
  Effect.orElseSucceed((): number[] => []),
  Effect.flatMap((pids) =>
    Effect.forEach(pids, (pid) =>
      cwdOf(pid).pipe(Effect.map((cwd) => (Option.contains(cwd, ROOT) ? [pid] : []))),
    ),
  ),
  Effect.map((pids) => pids.flat()),
);

const portListeners = (port: number) =>
  runCommand("lsof", ["-t", `-iTCP:${String(port)}`, "-sTCP:LISTEN", "-nP"]).pipe(
    Effect.map(pidsFrom),
    Effect.orElseSucceed((): number[] => []),
  );

/**
 * `pids` and every process below them: Alchemy runs the Website's Vite and
 * the Backend's `workerd` as children, and the Backend listens on an
 * ephemeral port no port check finds.
 */
const withDescendants = (pids: readonly number[]) =>
  runCommand("ps", ["-A", "-o", "pid=,ppid="]).pipe(
    Effect.map((output) => {
      const children = new Map<number, number[]>();
      for (const line of output.split("\n")) {
        const [pid, ppid] = line.trim().split(/\s+/u).map(Number);
        if (pid === undefined || ppid === undefined) continue;
        children.set(ppid, [...(children.get(ppid) ?? []), pid]);
      }
      const found = new Set<number>();
      const visit = (pid: number) => {
        if (found.has(pid)) return;
        found.add(pid);
        for (const child of children.get(pid) ?? []) visit(child);
      };
      for (const pid of pids) visit(pid);
      return [...found];
    }),
  );

/** Any HTTP answer counts: the first request after a start waits on Vite's compile. */
const answering = (port: number) =>
  Effect.tryPromise(() =>
    fetch(`http://localhost:${String(port)}/`, {
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    }),
  ).pipe(Effect.option, Effect.map(Option.isSome));

/** The herdr pane whose foreground process is this checkout's `alchemy dev`. */
const findServerPane = Effect.gen(function* () {
  if (!(yield* Herdr.running)) return Option.none<Herdr.Pane>();
  const panes = yield* Herdr.listPanes;
  const hosting = yield* Effect.forEach(
    panes,
    (pane) =>
      Herdr.processInfo(pane.pane_id).pipe(
        Effect.map(({ processes }) =>
          processes.some(
            (process) =>
              process.argv.join(" ").includes(SERVER_PROCESS) &&
              (process.cwd === undefined || process.cwd === ROOT),
          )
            ? [pane]
            : [],
        ),
        Effect.orElseSucceed((): Herdr.Pane[] => []),
      ),
    { concurrency: 4 },
  );
  return Array.head(hosting.flat());
}).pipe(Effect.orElseSucceed(() => Option.none<Herdr.Pane>()));

/** This checkout's server: its processes and, in herdr, the pane it runs in. */
const findServer = Effect.all({ pids: serverPids, pane: findServerPane });

const describeServer = (server: Effect.Success<typeof findServer>) =>
  Option.match(server.pane, {
    onSome: (pane) => `herdr pane ${pane.pane_id}`,
    onNone: () =>
      server.pids.length > 0
        ? `pid ${server.pids.join(", ")} (background, or a terminal outside herdr)`
        : "not running",
  });

/** Sends `signal` to `pid`; a process that is already gone is not an error. */
const signal = (pid: number, signal: NodeJS.Signals | 0) =>
  Effect.try(() => process.kill(pid, signal)).pipe(Effect.option, Effect.map(Option.isSome));

const processAlive = (pid: number) => signal(pid, 0);

const withLock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(path.join(ROOT, "logs"), { recursive: true });
      const lock = path.join(ROOT, LOCK);
      const holder = yield* fs.readFileString(lock).pipe(
        Effect.map((text) =>
          Option.filter(Result.getSuccess(decodePid(text.trim())), (pid) => pid !== process.pid),
        ),
        Effect.orElseSucceed(() => Option.none<number>()),
      );
      if (Option.isSome(holder) && (yield* processAlive(holder.value)))
        return yield* fail(
          `another dev command (pid ${String(holder.value)}) holds ${LOCK}; wait for it to finish`,
        );
      yield* fs.writeFileString(lock, String(process.pid));
    }),
    () => effect,
    () =>
      FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) => fs.remove(path.join(ROOT, LOCK), { force: true })),
        Effect.ignore,
      ),
  );

/**
 * Stops this checkout's server wherever it runs. In a pane it presses Ctrl-C,
 * as a person would: the whole foreground group exits and the pane is left
 * at its prompt. Otherwise, or when a pane ignores Ctrl-C for
 * {@link STOP_TIMEOUT_MS}, it sends SIGTERM to the server's processes, their
 * descendants and whatever listens on the port.
 */
const stopServer = Effect.fn("stopServer")(function* (port: number) {
  const server = yield* findServer;
  const listeners = yield* portListeners(port);
  if (server.pids.length === 0 && listeners.length === 0) {
    yield* Console.log("no dev server running");
    return;
  }
  const terminate = Effect.all([serverPids, portListeners(port)]).pipe(
    Effect.flatMap(([pids, ports]) => withDescendants([...pids, ...ports])),
    Effect.flatMap((pids) =>
      Effect.forEach(pids, (pid) => signal(pid, "SIGTERM"), { discard: true }),
    ),
  );
  const stopped = Effect.all([serverPids, portListeners(port)]).pipe(
    Effect.map(([pids, ports]) => pids.length === 0 && ports.length === 0),
  );
  if (Option.isSome(server.pane)) {
    yield* Herdr.sendKeys(server.pane.value.pane_id, "ctrl+c");
    if (!(yield* waitUntil(stopped, STOP_TIMEOUT_MS, 500))) yield* terminate;
  } else yield* terminate;
  if (!(yield* waitUntil(stopped, STOP_TIMEOUT_MS, 500)))
    return yield* fail(
      `port ${String(port)} is still held after SIGTERM; check with lsof -i :${String(port)}`,
    );
});

type Placement =
  | { readonly _tag: "Foreground" }
  | { readonly _tag: "Pane"; readonly paneId: string }
  | { readonly _tag: "Background" };
const Placement = {
  Foreground: { _tag: "Foreground" } as Placement,
  Background: { _tag: "Background" } as Placement,
  Pane: (paneId: string): Placement => ({ _tag: "Pane", paneId }),
};

const isTty = () => process.stdin.isTTY && process.stdout.isTTY;

/**
 * The workspace herdr has open on this checkout, opened if needed. A
 * worktree's workspace is grouped under the main checkout's, so that one is
 * opened first.
 */
const checkoutWorkspace = Effect.gen(function* () {
  const open = yield* Herdr.checkoutWorkspace(ROOT);
  if (Option.isSome(open)) return open.value;
  const { linked, mainCheckout } = yield* checkoutKind;
  const openMain = (checkout: string) =>
    Herdr.openMainCheckout(checkout, path.basename(checkout)).pipe(
      Effect.tap(() => Console.log(`ok    opened herdr workspace ${path.basename(checkout)}`)),
    );
  if (!linked) return yield* openMain(ROOT);
  const mainWorkspaceId = yield* Herdr.checkoutWorkspace(mainCheckout).pipe(
    Effect.flatMap(Option.match({ onSome: Effect.succeed, onNone: () => openMain(mainCheckout) })),
  );
  const label = yield* currentBranch;
  yield* Herdr.openLinkedWorktree({ mainWorkspaceId, path: ROOT, label });
  yield* Console.log(`ok    opened herdr workspace ${label}`);
  return yield* Herdr.checkoutWorkspace(ROOT).pipe(
    Effect.flatMap(Effect.fromOption),
    Effect.mapError(() => fail(`herdr opened no workspace on ${ROOT}`)),
  );
});

/** An idle pane of `tabId` in layout order, or a new split. */
const idlePaneIn = Effect.fn("idlePaneIn")(function* (tabId: string) {
  const first = yield* Effect.fromOption(
    Array.findFirst(yield* Herdr.listPanes, (pane) => pane.tab_id === tabId),
  ).pipe(Effect.mapError(() => fail(`the "${DEV_TAB}" tab has no panes`)));
  const ordered = yield* Herdr.panesInLayoutOrder(first.pane_id);
  const idle = yield* Effect.findFirst(ordered, (pane) =>
    Herdr.processInfo(pane).pipe(Effect.map(({ idle }) => idle)),
  );
  return yield* Option.match(idle, {
    onSome: Effect.succeed,
    onNone: () => Herdr.splitPane(ordered[0] ?? first.pane_id, ROOT),
  });
});

/** Where a new server runs: rules 2 to 4 of the module JSDoc (rule 1, adoption, is the caller's). */
const placeServer = Effect.gen(function* () {
  if (!(yield* Herdr.running)) return isTty() ? Placement.Foreground : Placement.Background;
  const workspaceId = yield* checkoutWorkspace;
  const devTab = Array.findFirst(
    yield* Herdr.listTabs(workspaceId),
    (tab) => tab.label === DEV_TAB,
  );
  if (isTty() && Option.isSome(devTab) && Option.contains(Herdr.callerTabId(), devTab.value.tab_id))
    return Placement.Foreground;
  const paneId = yield* Option.match(devTab, {
    onNone: () => Herdr.createTab({ workspaceId, cwd: ROOT, label: DEV_TAB }),
    onSome: (tab) => idlePaneIn(tab.tab_id),
  });
  return Placement.Pane(paneId);
});

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

const pnpmDev = (options: ChildProcess.CommandOptions) =>
  ChildProcess.make("pnpm", ["dev"], { cwd: ROOT, ...options });

/**
 * Starts the server where {@link placeServer} says. A foreground start returns
 * the handle of `pnpm dev`, which owns the caller's terminal until it exits;
 * the other placements return once the server is launched and outlive the
 * command.
 */
const launchServer = Effect.fn("launchServer")(function* (placement: Placement) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* Match.valueTags(placement, {
    Pane: ({ paneId }) =>
      Effect.gen(function* () {
        yield* waitUntil(
          Herdr.processInfo(paneId).pipe(Effect.map(({ idle }) => idle)),
          10_000,
          250,
        );
        yield* Herdr.runInPane(paneId, `cd ${shellQuote(ROOT)} && pnpm dev`);
        yield* Console.log(`ok    started in herdr tab "${DEV_TAB}" (pane ${paneId})`);
        return Option.none<ChildProcessSpawner.ChildProcessHandle>();
      }),
    Background: () =>
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          pnpmDev({ stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true }),
        );
        // Unreferenced, the process survives this command's scope closing.
        yield* handle.unref;
        yield* Console.log(`ok    started in the background (pid ${String(handle.pid)})`);
        return Option.none<ChildProcessSpawner.ChildProcessHandle>();
      }),
    Foreground: () =>
      spawner
        .spawn(pnpmDev({ stdin: "inherit", stdout: "inherit", stderr: "inherit", detached: false }))
        .pipe(Effect.map(Option.some)),
  });
});

const waitAnswering = (port: number) =>
  step(
    "server answering",
    waitUntil(answering(port), START_TIMEOUT_MS, 1000).pipe(
      Effect.filterOrFail(
        (answered) => answered,
        () =>
          fail(
            `no answer on port ${String(port)} after ${String(START_TIMEOUT_MS / 1000)}s; see pnpm dev:logs`,
          ),
      ),
    ),
  );

const summarize = (port: number, where: string) =>
  Console.log(
    ["", `server: ${where}`, `dev:    http://localhost:${String(port)}`, `logs:   ${LOG}`].join(
      "\n",
    ),
  );

// Every failure a command can raise carries a message for the person at the terminal.
const toUserError = <E extends { readonly message: string }>(error: E) =>
  new CliError.UserError({ cause: error, userMessage: error.message });

const startCommand = Command.make("start", {}, () =>
  Effect.gen(function* () {
    const port = yield* loadPort;
    const foreground = yield* withLock(
      Effect.gen(function* () {
        const server = yield* findServer;
        if (server.pids.length > 0) {
          yield* Console.log(`ok    adopted the running server: ${describeServer(server)}`);
          yield* waitAnswering(port);
          yield* summarize(port, describeServer(server));
          return Option.none();
        }
        if ((yield* portListeners(port)).length > 0)
          return yield* fail(
            `port ${String(port)} is held by another process: lsof -nP -iTCP:${String(port)} -sTCP:LISTEN`,
          );
        const placement = yield* placeServer;
        const handle = yield* launchServer(placement);
        if (Option.isSome(handle)) return handle;
        yield* waitAnswering(port);
        yield* summarize(
          port,
          Match.valueTags(placement, {
            Pane: ({ paneId }) => `herdr tab "${DEV_TAB}" (pane ${paneId})`,
            Background: () => "background",
            Foreground: () => "this terminal",
          }),
        );
        return Option.none();
      }),
    );
    // The lock is released before waiting on a foreground server, so an agent can adopt it.
    if (Option.isSome(foreground)) {
      yield* waitAnswering(port).pipe(
        Effect.flatMap(() => summarize(port, "this terminal")),
        Effect.catch((error) => Console.error(`dev: ${error.message}`)),
        Effect.forkChild,
      );
      yield* foreground.value.exitCode;
    }
  }).pipe(Effect.scoped, Effect.mapError(toUserError)),
).pipe(Command.withDescription("Start the dev server, or adopt the one already running."));

const stopCommand = Command.make("stop", {}, () =>
  Effect.gen(function* () {
    const port = yield* loadPort;
    yield* withLock(step("stop", stopServer(port)));
  }).pipe(Effect.mapError(toUserError)),
).pipe(Command.withDescription("Stop the dev server wherever it runs."));

const statusCommand = Command.make(
  "status",
  {
    json: Flag.Boolean("json").pipe(
      Flag.withDescription("Print the report as JSON"),
      Flag.withDefault(false),
    ),
  },
  ({ json }) =>
    Effect.gen(function* () {
      const port = yield* loadPort;
      const server = yield* findServer;
      const listening = (yield* portListeners(port)).length > 0;
      const serving = listening && (yield* answering(port));
      const healthy = server.pids.length > 0 && serving;
      const report = {
        healthy,
        server: describeServer(server),
        pids: server.pids,
        pane: Option.getOrNull(Option.map(server.pane, (pane) => pane.pane_id)),
        port,
        url: `http://localhost:${String(port)}`,
        listening,
        answering: serving,
      };
      yield* Console.log(
        json
          ? JSON.stringify(report, null, 2)
          : [
              `healthy: ${healthy ? "yes" : "no"}`,
              `server:  ${report.server}`,
              `port:    ${String(port)} (${listening ? "listening" : "not listening"}, ${serving ? "answering" : "not answering"})`,
              `url:     ${report.url}`,
            ].join("\n"),
      );
      if (!healthy) yield* Effect.sync(() => (process.exitCode = 1));
    }).pipe(Effect.mapError(toUserError)),
).pipe(
  Command.withDescription(
    "Report where the server runs and whether it answers. Read-only; exit code 1 when unhealthy.",
  ),
);

const logsCommand = Command.make(
  "logs",
  {
    lines: Flag.Int("lines").pipe(
      Flag.withDescription("Lines from the end of the log"),
      Flag.withDefault(80),
    ),
  },
  ({ lines }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const text = yield* fs
        .readFileString(path.join(ROOT, LOG))
        .pipe(Effect.orElseSucceed(() => `(no ${LOG})`));
      yield* Console.log(
        text
          .split("\n")
          .slice(-lines - 1)
          .join("\n"),
      );
    }),
).pipe(Command.withDescription(`Print the tail of ${LOG}.`));

Command.make("dev").pipe(
  Command.withDescription(
    [
      "Run this checkout's dev server (pnpm dev) for an agent or a person.",
      "Where it runs, first match wins:",
      "  1. a server already running for this checkout is adopted;",
      `  2. with herdr running: the checkout's workspace, tab "${DEV_TAB}" (opened if needed);`,
      `     typed by a person in that tab, this terminal; otherwise an idle pane there;`,
      "  3. without herdr, typed in a terminal: this terminal;",
      "  4. otherwise: in the background.",
      `Output always goes to ${LOG}.`,
    ].join("\n"),
  ),
  Command.withSubcommands([startCommand, stopCommand, statusCommand, logsCommand]),
  Command.run({ version: "1.0.0" }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
