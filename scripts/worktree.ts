#!/usr/bin/env node
/**
 * `pnpm worktree:init`: prepares the linked worktree `wt-NN` it runs in to
 * serve its own dev server beside the main checkout's. Run it after
 * `pnpm install --frozen-lockfile` in a worktree T3 Code just created; it
 * needs `node_modules` to run.
 *
 * The index comes from the branch name: `wt-01` is index 1 and serves on the
 * main checkout's `WEBSITE_PORT` + 1.
 *
 * Idempotent: a file that exists is verified, never rewritten, so a second
 * run only checks. Steps, in order:
 *
 * 1. Refuse the main checkout, a branch other than `wt-NN`, and a port
 *    another checkout's `.env` already holds.
 * 2. `.env`: copied from the main checkout's (not `.env.example`, which has
 *    no secrets) with `WEBSITE_PORT` set for this worktree.
 * 3. `refs`: a symlink to the main checkout's `refs/`.
 *
 * It does not start the server; `pnpm dev:start` does.
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import { CliError, Command } from "effect/cli";
import path from "node:path";

import {
  checkoutKind,
  checkoutPaths,
  currentBranch,
  setEnvKey,
  websitePortOf,
  worktreeIndex,
  WorktreeError,
} from "./lib/worktree.ts";

const fail = (message: string) => new WorktreeError({ message });

const readIfExists = Effect.fn("readIfExists")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  return (yield* fs.exists(file)) ? Option.some(yield* fs.readFileString(file)) : Option.none();
});

/** `WEBSITE_PORT` of the checkout at `checkout`, none without a `.env` or a port in it. */
const checkoutPort = Effect.fn("checkoutPort")(function* (checkout: string) {
  const env = yield* readIfExists(path.join(checkout, ".env"));
  return yield* Option.match(env, {
    onNone: () => Effect.succeedNone,
    onSome: (text) => websitePortOf(text).pipe(Effect.option),
  });
});

type RefsLink =
  | { readonly _tag: "Symlink"; readonly target: string }
  | { readonly _tag: "Directory" }
  | { readonly _tag: "Absent" };

const refsLinkState = Effect.fn("refsLinkState")(function* (
  link: string,
): Effect.fn.Return<RefsLink, never, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem;
  const target = yield* fs.readLink(link).pipe(Effect.option);
  if (Option.isSome(target)) return { _tag: "Symlink", target: target.value };
  return (yield* fs.exists(link).pipe(Effect.orElseSucceed(() => false)))
    ? { _tag: "Directory" }
    : { _tag: "Absent" };
});

const init = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const { root, linked, mainCheckout } = yield* checkoutKind;
  if (!linked)
    return yield* fail("this is the main checkout: run worktree:init in a linked worktree");
  const branch = yield* currentBranch;
  const index = yield* Effect.fromOption(worktreeIndex(branch)).pipe(
    Effect.mapError(() =>
      fail(
        `this worktree is on ${branch === "" ? "a detached HEAD" : branch}; expected a branch wt-01 to wt-99`,
      ),
    ),
  );

  const mainEnv = yield* readIfExists(path.join(mainCheckout, ".env")).pipe(
    Effect.flatMap(Effect.fromOption),
    Effect.mapError(() => fail(`no .env in the main checkout (${mainCheckout})`)),
  );
  const mainPort = yield* websitePortOf(mainEnv).pipe(
    Effect.mapError((error) => fail(`${mainCheckout}/.env: ${error.message}`)),
  );
  const port = mainPort + index;

  const others = (yield* checkoutPaths).filter((checkout) => checkout !== root);
  yield* Effect.forEach(others, (checkout) =>
    checkoutPort(checkout).pipe(
      Effect.filterOrFail(
        (used) => !Option.contains(used, port),
        () => fail(`WEBSITE_PORT=${String(port)} is already used by ${checkout}`),
      ),
    ),
  );

  const envFile = path.join(root, ".env");
  yield* Option.match(yield* readIfExists(envFile), {
    onNone: () =>
      fs
        .writeFileString(envFile, setEnvKey(mainEnv, "WEBSITE_PORT", String(port)))
        .pipe(
          Effect.andThen(
            Console.log(`ok    .env copied from the main checkout, WEBSITE_PORT=${String(port)}`),
          ),
        ),
    onSome: (text) =>
      websitePortOf(text).pipe(
        Effect.option,
        Effect.filterOrFail(
          (have) => Option.contains(have, port),
          (have) =>
            fail(
              `.env has WEBSITE_PORT=${Option.match(have, { onNone: () => "(missing)", onSome: String })}, expected ${String(port)}; fix it by hand`,
            ),
        ),
        Effect.andThen(Console.log(`ok    .env verified, WEBSITE_PORT=${String(port)}`)),
      ),
  });

  const refsLink = path.join(root, "refs");
  const refsTarget = path.join(mainCheckout, "refs");
  yield* Match.valueTags(yield* refsLinkState(refsLink), {
    Symlink: ({ target }) =>
      target === refsTarget
        ? Console.log("ok    refs link verified")
        : fail(`refs points at ${target}, expected ${refsTarget}`),
    Directory: () =>
      fail(
        "refs is a real directory: remove it; the main checkout's refs/ is shared through a symlink",
      ),
    Absent: () =>
      fs
        .symlink(refsTarget, refsLink)
        .pipe(Effect.andThen(Console.log(`ok    refs -> ${refsTarget}`))),
  });

  yield* Console.log(`\n${branch} ready on port ${String(port)}. Next: pnpm dev:start`);
});

// Every failure of `init` is a message for the person at the terminal.
const toUserError = <E extends { readonly message: string }>(error: E) =>
  new CliError.UserError({ cause: error, userMessage: error.message });

const initCommand = Command.make("init", {}, () => init.pipe(Effect.mapError(toUserError))).pipe(
  Command.withDescription(
    "Prepare this wt-NN worktree: .env with its WEBSITE_PORT, and the refs link. Verifies instead of rewriting on a second run.",
  ),
);

Command.make("worktree").pipe(
  Command.withDescription("Set up long-lived linked worktrees of this repository"),
  Command.withSubcommands([initCommand]),
  Command.run({ version: "1.0.0" }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
