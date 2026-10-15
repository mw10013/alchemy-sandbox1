/**
 * A checkout of this repository is either the main checkout, whose `.git` is
 * the repository, or a long-lived linked worktree on branch `wt-NN`, which T3
 * Code creates under `~/.t3/worktrees/<project>/wt-NN`. Each checkout has its
 * own `.env`, `.alchemy/` and `.logs/`, so each runs its own dev server on its
 * own `WEBSITE_PORT`, the main checkout's port plus `NN`, and its own
 * `shopify app dev` session on its own dev store ({@link DevStore}).
 *
 * `refs/` exists once, in the main checkout; a linked worktree has a symlink
 * named `refs` pointing at it. `.gitignore` lists `/refs` without a trailing
 * slash so the one rule ignores both the directory and the symlink.
 *
 * @module
 */
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import path from "node:path";

import { Checkout, PerDeveloperStage, type PerDeveloper } from "../../src/backend/stage.ts";
import { runCommand } from "./command.ts";

export class WorktreeError extends Schema.TaggedError<WorktreeError>()("WorktreeError", {
  message: Schema.String,
}) {}

/** The index in a `wt-NN` branch name ({@link Checkout}); none for any other branch, or `wt-00`. */
export const worktreeIndex = Schema.decodeUnknownOption(Checkout);

/**
 * `WEBSITE_PORT` from a `.env`'s text, read with Effect's dotenv rules. Fails
 * with a `ConfigError` naming the key when it is missing or not a port.
 */
export const websitePortOf = (envText: string) =>
  Config.Port("WEBSITE_PORT").pipe(
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromDotEnvContents(envText),
    ),
  );

/**
 * A checkout's Shopify dev store, `sandbox-shop-NN` for index `NN` (the main checkout is `00`), as
 * a codec: decode the name to its index, encode an index to the name. One store per checkout,
 * because the CLI rewrites the app's URL per store: two `shopify app dev` sessions on one store
 * overwrite each other's app URL, and the last one started wins.
 */
export const DevStore = Schema.String.check(Schema.isPattern(/^sandbox-shop-\d{2}$/u)).pipe(
  Schema.decodeTo(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 99 })),
    SchemaTransformation.transform({
      decode: (name) => Number(name.slice("sandbox-shop-".length)),
      encode: (index) => `sandbox-shop-${String(index).padStart(2, "0")}`,
    }),
  ),
);

/** The {@link DevStore} name of checkout `index`. */
export const devStoreName = Schema.encodeSync(DevStore);

/**
 * `SHOPIFY_DEV_STORE` from a `.env`'s text, as written (a {@link DevStore} name); none when the key
 * is missing. Fails with a `ConfigError` naming the key when it is not a store name.
 */
export const devStoreOf = (envText: string) =>
  Config.schema(DevStore, "SHOPIFY_DEV_STORE").pipe(
    Config.map(devStoreName),
    Config.option,
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromDotEnvContents(envText),
    ),
  );

const KEY_LINE = /^(?<key>[A-Z][A-Z0-9_]*)=(?<value>.*)$/u;

/**
 * Sets `key` in a `.env`'s text: an existing `KEY=` line is replaced in place,
 * a missing key is appended. Every other line, comments included, is kept.
 */
export const setEnvKey = (text: string, key: string, value: string): string => {
  const line = `${key}=${value}`;
  const lines = text.split("\n");
  if (lines.some((existing) => KEY_LINE.exec(existing)?.groups?.key === key))
    return lines
      .map((existing) => (KEY_LINE.exec(existing)?.groups?.key === key ? line : existing))
      .join("\n");
  return `${text.replace(/\n*$/u, "")}\n${line}\n`;
};

const Lines = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Array(Schema.String),
    SchemaTransformation.transform({
      decode: (output): ReadonlyArray<string> => output.trim().split("\n"),
      encode: (lines) => lines.join("\n"),
    }),
  ),
);

/** This checkout's git directory and the repository's common one, both absolute. */
const gitDirs = runCommand("git", [
  "rev-parse",
  "--path-format=absolute",
  "--git-dir",
  "--git-common-dir",
]).pipe(
  Effect.flatMap(
    Schema.decodeUnknownEffect(
      Lines.pipe(Schema.decodeTo(Schema.Tuple([Schema.String, Schema.String]))),
    ),
  ),
  Effect.map(([gitDir, commonDir]) => ({ gitDir, commonDir })),
);

/**
 * Where this checkout sits: `root` is its top level, `mainCheckout` the main
 * checkout's root (the parent of the common git directory), and `linked` is
 * true in a linked worktree, whose git directory differs from the common one.
 */
export const checkoutKind = Effect.all([
  gitDirs,
  runCommand("git", ["rev-parse", "--show-toplevel"]),
]).pipe(
  Effect.map(([{ gitDir, commonDir }, toplevel]) => ({
    root: toplevel.trim(),
    linked: gitDir !== commonDir,
    mainCheckout: path.dirname(commonDir),
  })),
);

/** The branch checked out here; empty on a detached HEAD. */
export const currentBranch = runCommand("git", ["branch", "--show-current"]).pipe(
  Effect.map((output) => output.trim()),
);

/** Every checkout of the repository, main first, as absolute paths. */
export const checkoutPaths = runCommand("git", ["worktree", "list", "--porcelain"]).pipe(
  Effect.flatMap(Schema.decodeUnknownEffect(Lines)),
  Effect.map((lines) =>
    lines
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length)),
  ),
);

/**
 * The stage of `environment` for a checkout: `<environment>-<user>` in the main checkout,
 * whatever branch it is on, and `<environment>-<user>-wt-NN` in a linked worktree on branch
 * `wt-NN` ({@link PerDeveloperStage}). Fails, rather than falling back to a guess, when `user` is
 * not lowercase letters and digits or a linked worktree is on another branch.
 */
export const stageOf = Effect.fn("stageOf")(function* (
  environment: PerDeveloper,
  user: string | undefined,
  checkout: { readonly linked: boolean },
  branch: string,
) {
  const index = checkout.linked
    ? yield* Effect.fromOption(worktreeIndex(branch)).pipe(
        Effect.map(Option.some),
        Effect.mapError(
          () =>
            new WorktreeError({
              message: `a linked worktree must be on a wt-NN branch to name a stage, got "${branch}"`,
            }),
        ),
      )
    : Option.none<number>();
  return yield* Schema.encodeUnknownEffect(PerDeveloperStage)({
    environment,
    user,
    checkout: index,
  }).pipe(
    Effect.mapError(
      () =>
        new WorktreeError({
          message: `$USER must be lowercase letters and digits to name a stage, got ${JSON.stringify(user)}`,
        }),
    ),
  );
});

/** This checkout's stage of `environment`, from `$USER` and the checkout; see {@link stageOf}. */
export const stage = (environment: PerDeveloper) =>
  Effect.all([checkoutKind, currentBranch]).pipe(
    Effect.flatMap(([checkout, branch]) =>
      stageOf(environment, process.env.USER, checkout, branch),
    ),
  );
