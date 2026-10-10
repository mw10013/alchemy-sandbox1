import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import path from "node:path";

import { runCommand } from "./command.ts";

/**
 * A checkout of this repository is either the main checkout, whose `.git` is
 * the repository, or a long-lived linked worktree on branch `wt-NN`, which T3
 * Code creates under `~/.t3/worktrees/<project>/wt-NN`. Each checkout has its
 * own `.env`, `.alchemy/` and `logs/`, so each runs its own dev server on its
 * own `WEBSITE_PORT`: the main checkout's port plus `NN`.
 *
 * `refs/` exists once, in the main checkout; a linked worktree has a symlink
 * named `refs` pointing at it. `.gitignore` lists `/refs` without a trailing
 * slash so the one rule ignores both the directory and the symlink.
 */

export class WorktreeError extends Schema.TaggedError<WorktreeError>()("WorktreeError", {
  message: Schema.String,
}) {}

export const MAX_INDEX = 99;

/**
 * A linked worktree's branch, folder and herdr workspace label, `wt-01` for
 * index 1, as a codec: decode a branch name to its index (1 to 99, so `wt-00`
 * is not a worktree), encode an index to the name.
 */
export const WorktreeBranch = Schema.String.check(Schema.isPattern(/^wt-\d{2}$/u)).pipe(
  Schema.decodeTo(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_INDEX })),
    SchemaTransformation.transform({
      decode: (branch) => Number(branch.slice("wt-".length)),
      encode: (index) => `wt-${String(index).padStart(2, "0")}`,
    }),
  ),
);

/** The index in a `wt-NN` branch name; none for any other branch, or `wt-00`. */
export const worktreeIndex = Schema.decodeUnknownOption(WorktreeBranch);

/** `wt-01` for index 1. */
export const worktreeName = Schema.encodeSync(WorktreeBranch);

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
