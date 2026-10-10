import { NodeRuntime, NodeServices } from "@effect/platform-node";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Match from "effect/Match";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Argument, CliError, Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { checkoutKind } from "./lib/worktree.ts";

/** A reference source is pinned either to a branch or to a dependency's installed version. */
type Ref =
  | {
      readonly _tag: "Branch";
      readonly name: string;
      readonly repo: string;
      readonly branch: string;
      readonly private?: boolean;
    }
  | {
      readonly _tag: "Dependency";
      readonly name: string;
      readonly repo: string;
      readonly dep: string;
      /** The tag template; `{v}` is the installed version. */
      readonly tag: string;
    };

const refs: readonly Ref[] = [
  { _tag: "Branch", name: "baton", repo: "mw10013/baton", branch: "main", private: true },
  {
    _tag: "Branch",
    name: "cloudflare-docs",
    repo: "cloudflare/cloudflare-docs",
    branch: "production",
  },
  { _tag: "Dependency", name: "alchemy", repo: "alchemy-run/alchemy", dep: "alchemy", tag: "v{v}" },
  {
    _tag: "Dependency",
    name: "vite-plus",
    repo: "voidzero-dev/vite-plus",
    dep: "vite-plus",
    tag: "v{v}",
  },
  {
    _tag: "Dependency",
    name: "tan-start",
    repo: "TanStack/router",
    dep: "@tanstack/react-start",
    tag: "@tanstack/react-start@{v}",
  },
  {
    _tag: "Dependency",
    name: "tan-router",
    repo: "TanStack/router",
    dep: "@tanstack/react-router",
    tag: "@tanstack/react-router@{v}",
  },
  {
    _tag: "Dependency",
    name: "tan-query",
    repo: "TanStack/query",
    dep: "@tanstack/react-query",
    tag: "@tanstack/react-query@{v}",
  },
  {
    _tag: "Dependency",
    name: "tan-form",
    repo: "TanStack/form",
    dep: "@tanstack/react-form",
    tag: "@tanstack/react-form@{v}",
  },
  {
    _tag: "Dependency",
    name: "astryx",
    repo: "facebook/astryx",
    dep: "@astryxdesign/core",
    tag: "v{v}",
  },
  {
    _tag: "Dependency",
    name: "effect",
    repo: "Effect-TS/effect",
    dep: "effect",
    tag: "effect@{v}",
  },
  {
    _tag: "Branch",
    name: "effect-tanstack-start",
    repo: "lucas-barake/effect-tanstack-start",
    branch: "main",
  },
  {
    _tag: "Dependency",
    name: "yielded-auth",
    repo: "yielded-dev/auth",
    dep: "@yielded/auth",
    tag: "@yielded/auth@{v}",
  },
  {
    _tag: "Dependency",
    name: "better-auth",
    repo: "better-auth/better-auth",
    dep: "better-auth",
    tag: "v{v}",
  },
];

const Manifest = Schema.fromJsonString(
  Schema.Struct({
    dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    devDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  }),
);
const ExactVersion = Schema.String.check(
  Schema.isPattern(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u, {
    message: "the dependency must have an exact version pin, like 1.2.3",
  }),
);
const Stamp = Schema.fromJsonString(
  Schema.Struct({
    repo: Schema.String,
    resolved: Schema.String,
    version: Schema.optional(Schema.String),
    fetchedAt: Schema.String,
  }),
  { space: 2 },
);

export class RefError extends Schema.TaggedError<RefError>()("RefError", {
  message: Schema.String,
}) {}

const root = Effect.gen(function* () {
  const path = yield* Path.Path;
  return path.resolve(path.dirname(yield* path.fromFileUrl(new URL(import.meta.url))), "..");
});

/** The git ref to download, and the installed version for a dependency-pinned ref. */
const resolve = Effect.fn("resolveRef")(function* (ref: Ref) {
  return yield* Match.valueTags(ref, {
    Branch: ({ branch }) => Effect.succeed({ target: branch, version: undefined }),
    Dependency: ({ dep, tag }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const manifest = yield* Schema.decodeEffect(Manifest)(
          yield* fs.readFileString(path.join(yield* root, "package.json")),
        );
        const pin = manifest.dependencies?.[dep] ?? manifest.devDependencies?.[dep];
        const version = yield* Schema.decodeUnknownEffect(ExactVersion)(pin).pipe(
          Effect.mapError((error) => new RefError({ message: `${dep}: ${error.message}` })),
        );
        return { target: tag.replace("{v}", version), version };
      }),
  });
});

const download = Effect.fn("downloadRef")(function* (ref: Ref, target: string, staging: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  // The tarball comes from `gh` for a private repo (authenticated), from GitHub's archive URL otherwise.
  const { bin, args } = Match.valueTags(ref, {
    Branch: ({ repo, private: isPrivate }) =>
      isPrivate
        ? { bin: "gh", args: ["api", `repos/${repo}/tarball/${target}`] }
        : {
            bin: "curl",
            args: ["-fsSL", `https://github.com/${repo}/archive/refs/heads/${target}.tar.gz`],
          },
    Dependency: ({ repo }) => ({
      bin: "curl",
      args: ["-fsSL", `https://github.com/${repo}/archive/refs/tags/${target}.tar.gz`],
    }),
  });
  const command = ChildProcess.make(bin, args, { stderr: "inherit" });
  yield* Effect.scoped(
    Effect.gen(function* () {
      const source = yield* spawner.spawn(command);
      const extracted = yield* spawner.exitCode(
        ChildProcess.make("tar", ["-xz", "-C", staging, "--strip-components=1"], {
          stdin: source.stdout,
          stderr: "inherit",
        }),
      );
      const downloaded = yield* source.exitCode;
      if (downloaded !== 0 || extracted !== 0) {
        return yield* new RefError({
          message: `download/extraction failed (${String(downloaded)}/${String(extracted)})`,
        });
      }
    }),
  );
});

const fetchRef = Effect.fn("fetchRef")(function* (ref: Ref) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { target, version } = yield* resolve(ref);
  const directory = path.join(yield* root, "refs");
  yield* fs.makeDirectory(directory, { recursive: true });
  yield* Console.log(`${ref.name}: ${target}`);
  // Stage on the same filesystem, and retain the previous copy until replacement succeeds.
  yield* Effect.scoped(
    Effect.gen(function* () {
      const staging = yield* fs.makeTempDirectoryScoped({ directory, prefix: `.${ref.name}-` });
      const contents = path.join(staging, "contents");
      const backup = path.join(staging, "previous");
      const destination = path.join(directory, ref.name);
      yield* fs.makeDirectory(contents);
      yield* download(ref, target, contents);
      yield* fs.writeFileString(
        path.join(contents, ".ref.json"),
        `${yield* Schema.encodeEffect(Stamp)({
          repo: ref.repo,
          resolved: target,
          version,
          fetchedAt: DateTime.formatIso(yield* DateTime.now),
        })}\n`,
      );
      yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const previous = yield* fs.exists(destination);
          if (previous) yield* fs.rename(destination, backup);
          yield* fs
            .rename(contents, destination)
            .pipe(
              Effect.onError(() =>
                previous ? fs.rename(backup, destination).pipe(Effect.orDie) : Effect.void,
              ),
            );
        }),
      );
      yield* Console.log(`  -> refs/${ref.name}`);
    }),
  );
});

/** Succeeds with the status line of an up-to-date ref; fails with the line of a missing, stale or broken one. */
const checkRef = Effect.fn("checkRef")(function* (ref: Ref) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { target } = yield* resolve(ref);
  const file = path.join(yield* root, "refs", ref.name, ".ref.json");
  if (!(yield* fs.exists(file)))
    return yield* new RefError({ message: `MISSING (want ${target})` });
  const stamp = yield* Schema.decodeEffect(Stamp)(yield* fs.readFileString(file));
  if (stamp.repo !== ref.repo || stamp.resolved !== target)
    return yield* new RefError({ message: `STALE (have ${stamp.resolved}, want ${target})` });
  const freshness = Match.valueTags(ref, {
    Branch: () => ` (snapshot fetched ${stamp.fetchedAt}; upstream freshness not checked)`,
    Dependency: () => "",
  });
  return `ok ${target}${freshness}`;
});

/** Prints one line per ref and returns the names of the refs that are not ok. */
const report = Effect.partition(refs, (ref) =>
  checkRef(ref).pipe(
    Effect.tap((line) => Console.log(`${ref.name}: ${line}`)),
    Effect.tapError((error) => Console.error(`${ref.name}: ${error.message}`)),
    Effect.mapError(() => ref.name),
  ),
).pipe(Effect.map(([, failed]) => failed));

const userError = (message: string) =>
  new CliError.UserError({ cause: message, userMessage: message });

const fetchCommand = Command.make(
  "fetch",
  {
    all: Flag.Boolean("all").pipe(Flag.withDefault(false)),
    names: Argument.Literals(
      "name",
      refs.map((ref) => ref.name),
    ).pipe(Argument.variadic()),
  },
  Effect.fn("fetchRefs")(function* ({ all, names }) {
    if (!all && names.length === 0) return yield* userError("Name refs to fetch, or pass --all");
    // A linked worktree's refs is a symlink to the main checkout's; fetch there.
    const { linked, mainCheckout } = yield* checkoutKind.pipe(
      Effect.mapError((error) => userError(error.message)),
    );
    if (linked) return yield* userError(`refs are shared: run refs fetch in ${mainCheckout}`);
    const [, failed] = yield* Effect.partition(
      refs.filter((ref) => all || names.includes(ref.name)),
      (ref) =>
        fetchRef(ref).pipe(
          Effect.tapError((error) => Console.error(`${ref.name}: ${error.message}`)),
          Effect.mapError(() => ref.name),
        ),
    );
    if (failed.length > 0) return yield* userError(`Failed to fetch: ${failed.join(", ")}`);
  }),
).pipe(Command.withDescription("Download pinned sources; private repos use gh authentication"));

const checkCommand = Command.make("check", {}, () =>
  Effect.gen(function* () {
    const failed = yield* report;
    if (failed.length > 0)
      return yield* userError(`${String(failed.length)} reference(s) missing, stale, or invalid`);
  }),
);
const listCommand = Command.make("list", {}, () => report.pipe(Effect.asVoid));

Command.make("refs").pipe(
  Command.withDescription("Manage reference sources in refs/"),
  Command.withSubcommands([fetchCommand, checkCommand, listCommand]),
  Command.run({ version: "1.0.0" }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
