/**
 * A checkout of this repository is either the main checkout, whose `.git` is
 * the repository, or a long-lived linked worktree on branch `wt-NN`, which T3
 * Code creates under `~/.t3/worktrees/<project>/wt-NN`. Each checkout has its
 * own `.env`, `.alchemy/` and `.logs/`, so each runs its own dev server on its
 * own `WEBSITE_PORT`, the main checkout's port plus `NN`, and its own
 * `shopify app dev` session on its own dev store ({@link StoreName}).
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

/** The environments that have a Shopify store, which is not {@link Environment}: `test` has none, and `production` has a store before it has a stage. */
export const StoreEnvironment = Schema.Literals(["dev", "e2e", "staging", "production"]);
export type StoreEnvironment = typeof StoreEnvironment.Type;

const StoreIndex = Schema.String.check(Schema.isPattern(/^\d{2}$/u)).pipe(
  Schema.decodeTo(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 99 })),
    SchemaTransformation.transform({
      decode: (digits) => Number(digits),
      encode: (index) => String(index).padStart(2, "0"),
    }),
  ),
);

/**
 * A Shopify store's name, `mw10013-<environment>-shop-NN`, as a codec between the name and
 * `{ environment, index }`. `NN` is two digits: the store's index, which for `dev` and `e2e` is the
 * checkout's worktree index (`00` for the main checkout), so each checkout has one store per
 * environment. Store names share one namespace across all of Shopify and a taken name silently
 * becomes a suffixed domain, so generic names are taken; `mw10013`, the organization's handle,
 * keeps ours unique. One dev store per checkout also because the CLI rewrites the app's URL per
 * store: two `shopify app dev` sessions on one store overwrite each other's, and the last wins.
 */
export const StoreName = Schema.TemplateLiteralParser([
  "mw10013-",
  StoreEnvironment,
  "-shop-",
  StoreIndex,
]).pipe(
  Schema.decodeTo(
    Schema.Struct({ environment: StoreEnvironment, index: Schema.Int }),
    SchemaTransformation.transform({
      decode: (parts) => ({ environment: parts[1], index: parts[3] }),
      encode: ({ environment, index }) => ["mw10013-", environment, "-shop-", index] as const,
    }),
  ),
);
export type StoreName = typeof StoreName.Type;

const encodeStoreName = Schema.encodeSync(StoreName);

/** The name of `environment`'s store at `index`. */
export const storeNameOf = (environment: StoreEnvironment, index: number) =>
  encodeStoreName({ environment, index });

/** The name of checkout `index`'s dev store, the one `shopify app dev` runs on. */
export const devStoreName = (index: number) => storeNameOf("dev", index);

/** The name of checkout `index`'s e2e store. */
export const e2eStoreName = (index: number) => storeNameOf("e2e", index);

/** A {@link StoreName} whose environment is `environment`. */
export const StoreOf = (environment: StoreEnvironment) =>
  StoreName.pipe(
    Schema.check(
      Schema.makeFilter(
        (store: StoreName) =>
          store.environment === environment || `expected a ${environment} store`,
      ),
    ),
  );

const storeKeyOf = (key: string, environment: "dev" | "e2e") => (envText: string) =>
  Config.schema(StoreOf(environment), key).pipe(
    Config.map(encodeStoreName),
    Config.option,
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromDotEnvContents(envText),
    ),
  );

/**
 * `SHOPIFY_DEV_STORE` from a `.env`'s text, as written; none when the key is missing. Fails with a
 * `ConfigError` naming the key when it is not a {@link StoreName} of a dev store.
 */
export const devStoreOf = storeKeyOf("SHOPIFY_DEV_STORE", "dev");

/** `SHOPIFY_E2E_STORE` from a `.env`'s text; see {@link devStoreOf}, with an e2e store. */
export const e2eStoreOf = storeKeyOf("SHOPIFY_E2E_STORE", "e2e");

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
