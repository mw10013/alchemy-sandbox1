#!/usr/bin/env node
/**
 * `vp run worktree:init`: prepares the linked worktree `wt-NN` it runs in to
 * serve its own dev server beside the main checkout's. Run it after
 * `vp install --frozen-lockfile` in a worktree T3 Code just created; it
 * needs `node_modules` to run.
 *
 * The index comes from the branch name: `wt-01` is index 1, serves on the
 * main checkout's `WEBSITE_PORT` + 1 and runs `shopify app dev` on dev store
 * `sandbox-shop-01`.
 *
 * Idempotent: a file that exists is verified, never rewritten, so a second
 * run only checks; the one exception is a `.env` without `SHOPIFY_DEV_STORE`,
 * which gets the key appended, so a worktree set up before the key existed
 * catches up. Steps, in order:
 *
 * 1. Refuse the main checkout, a branch other than `wt-NN`, and a port or
 *    dev store another checkout's `.env` already holds.
 * 2. `.env`: copied from the main checkout's (not `.env.example`, which has
 *    no secrets) with `WEBSITE_PORT` and `SHOPIFY_DEV_STORE` set for this
 *    worktree.
 * 3. `refs`: a symlink to the main checkout's `refs/`.
 * 4. `.env.<environment>` for each {@link Deployed} environment: a symlink to
 *    the main checkout's, so a deployed stage's values exist once; skipped
 *    when the main checkout has no such file.
 *
 * It does not start the server; `vp run dev` does.
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import { CliError, Command } from "effect/cli";
import path from "node:path";

import { Deployed } from "../src/backend/stage.ts";
import {
  checkoutKind,
  checkoutPaths,
  currentBranch,
  devStoreName,
  devStoreOf,
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

/**
 * `WEBSITE_PORT` and `SHOPIFY_DEV_STORE` of the checkout at `checkout`, each none without a `.env`
 * or the key in it.
 */
const checkoutClaims = Effect.fn("checkoutClaims")(function* (checkout: string) {
  const env = yield* readIfExists(path.join(checkout, ".env"));
  return yield* Option.match(env, {
    onNone: () => Effect.succeed({ port: Option.none<number>(), store: Option.none<string>() }),
    onSome: (text) =>
      Effect.all({
        port: websitePortOf(text).pipe(Effect.option),
        store: devStoreOf(text).pipe(Effect.orElseSucceed(Option.none<string>)),
      }),
  });
});

type LinkState =
  | { readonly _tag: "Symlink"; readonly target: string }
  | { readonly _tag: "Real" }
  | { readonly _tag: "Absent" };

const linkState = Effect.fn("linkState")(function* (
  link: string,
): Effect.fn.Return<LinkState, never, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem;
  const target = yield* fs.readLink(link).pipe(Effect.option);
  if (Option.isSome(target)) return { _tag: "Symlink", target: target.value };
  return (yield* fs.exists(link).pipe(Effect.orElseSucceed(() => false)))
    ? { _tag: "Real" }
    : { _tag: "Absent" };
});

/**
 * Links `name` in the worktree at `root` to the same name in the main checkout: a link to it is
 * verified, a link elsewhere fails naming both, a real file or directory fails because it would
 * shadow the main checkout's, and an absent one is created.
 */
const linkToMain = Effect.fn("linkToMain")(function* (
  root: string,
  mainCheckout: string,
  name: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const link = path.join(root, name);
  const target = path.join(mainCheckout, name);
  yield* Match.valueTags(yield* linkState(link), {
    Symlink: (have) =>
      have.target === target
        ? Console.log(`ok    ${name} link verified`)
        : fail(`${name} points at ${have.target}, expected ${target}`),
    Real: () =>
      fail(
        `${name} is not a link: remove it; the main checkout's ${name} is shared through a symlink`,
      ),
    Absent: () =>
      fs.symlink(target, link).pipe(Effect.andThen(Console.log(`ok    ${name} -> ${target}`))),
  });
});

/**
 * Verifies `SHOPIFY_DEV_STORE` in an existing `.env`: the expected store passes, another value
 * fails, and a missing key is appended (the one write to an existing `.env`, see the module doc).
 */
const verifyStore = Effect.fn("verifyStore")(function* (
  envFile: string,
  text: string,
  store: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const have = yield* devStoreOf(text).pipe(
    Effect.mapError((error) => fail(`.env: ${error.message}; expected ${store}, fix it by hand`)),
  );
  if (Option.isNone(have)) {
    yield* fs.writeFileString(envFile, setEnvKey(text, "SHOPIFY_DEV_STORE", store));
    return yield* Console.log(`ok    .env gained SHOPIFY_DEV_STORE=${store}`);
  }
  if (have.value !== store)
    return yield* fail(
      `.env has SHOPIFY_DEV_STORE=${have.value}, expected ${store}; fix it by hand`,
    );
  yield* Console.log(`ok    .env verified, SHOPIFY_DEV_STORE=${store}`);
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
  const store = devStoreName(index);

  const others = (yield* checkoutPaths).filter((checkout) => checkout !== root);
  yield* Effect.forEach(others, (checkout) =>
    checkoutClaims(checkout).pipe(
      Effect.filterOrFail(
        (used) => !Option.contains(used.port, port),
        () => fail(`WEBSITE_PORT=${String(port)} is already used by ${checkout}`),
      ),
      Effect.filterOrFail(
        (used) => !Option.contains(used.store, store),
        () => fail(`SHOPIFY_DEV_STORE=${store} is already used by ${checkout}`),
      ),
    ),
  );

  const envFile = path.join(root, ".env");
  yield* Option.match(yield* readIfExists(envFile), {
    onNone: () =>
      fs
        .writeFileString(
          envFile,
          setEnvKey(setEnvKey(mainEnv, "WEBSITE_PORT", String(port)), "SHOPIFY_DEV_STORE", store),
        )
        .pipe(
          Effect.andThen(
            Console.log(
              `ok    .env copied from the main checkout, WEBSITE_PORT=${String(port)}, SHOPIFY_DEV_STORE=${store}`,
            ),
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
        Effect.andThen(verifyStore(envFile, text, store)),
      ),
  });

  yield* linkToMain(root, mainCheckout, "refs");
  yield* Effect.forEach(Deployed.literals, (environment) =>
    Effect.gen(function* () {
      const name = `.env.${environment}`;
      if (yield* fs.exists(path.join(mainCheckout, name)))
        return yield* linkToMain(root, mainCheckout, name);
      yield* Console.log(`skip  ${name}: none in the main checkout`);
    }),
  );

  yield* Console.log(`\n${branch} ready on port ${String(port)}. Next: vp run dev`);
});

/** Every failure of `init` is a message for the person at the terminal. */
const toUserError = <E extends { readonly message: string }>(error: E) =>
  new CliError.UserError({ cause: error, userMessage: error.message });

const initCommand = Command.make("init", {}, () => init.pipe(Effect.mapError(toUserError))).pipe(
  Command.withDescription(
    "Prepare this wt-NN worktree: .env with its WEBSITE_PORT and SHOPIFY_DEV_STORE, and links to the main checkout's refs and .env.<deployed environment> files. Verifies instead of rewriting on a second run.",
  ),
);

Command.make("worktree").pipe(
  Command.withDescription("Set up long-lived linked worktrees of this repository"),
  Command.withSubcommands([initCommand]),
  Command.run({ version: "1.0.0" }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
