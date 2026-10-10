import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, DateTime, Effect, FileSystem, Path, Schema } from "effect";
import { Argument, CliError, Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

interface Ref {
  readonly name: string;
  readonly repo: string;
  readonly dep?: string;
  readonly tag?: string;
  readonly branch?: string;
  readonly private?: boolean;
}

const refs: readonly Ref[] = [
  { name: "baton", repo: "mw10013/baton", branch: "main", private: true },
  { name: "cloudflare-docs", repo: "cloudflare/cloudflare-docs", branch: "production" },
  { name: "alchemy", repo: "alchemy-run/alchemy", dep: "alchemy", tag: "v{v}" },
  { name: "vite-plus", repo: "voidzero-dev/vite-plus", dep: "vite-plus", tag: "v{v}" },
  {
    name: "tan-start",
    repo: "TanStack/router",
    dep: "@tanstack/react-start",
    tag: "@tanstack/react-start@{v}",
  },
  {
    name: "tan-router",
    repo: "TanStack/router",
    dep: "@tanstack/react-router",
    tag: "@tanstack/react-router@{v}",
  },
  {
    name: "tan-query",
    repo: "TanStack/query",
    dep: "@tanstack/react-query",
    tag: "@tanstack/react-query@{v}",
  },
  {
    name: "tan-form",
    repo: "TanStack/form",
    dep: "@tanstack/react-form",
    tag: "@tanstack/react-form@{v}",
  },
  { name: "astryx", repo: "facebook/astryx", dep: "@astryxdesign/core", tag: "v{v}" },
  { name: "effect", repo: "Effect-TS/effect", dep: "effect", tag: "effect@{v}" },
  { name: "effect-tanstack-start", repo: "lucas-barake/effect-tanstack-start", branch: "main" },
  { name: "yielded-auth", repo: "yielded-dev/auth", dep: "@yielded/auth", tag: "@yielded/auth@{v}" },
  { name: "better-auth", repo: "better-auth/better-auth", dep: "better-auth", tag: "v{v}" },
];

const Manifest = Schema.fromJsonString(
  Schema.Struct({
    dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    devDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  }),
);
const ExactVersion = Schema.String.pipe(
  Schema.check(Schema.isPattern(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u)),
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

const userError = (message: string) =>
  new CliError.UserError({
    cause: message,
    userMessage: message,
  });
const toUserError = (error: unknown) =>
  error instanceof CliError.UserError
    ? error
    : userError(error instanceof Error ? error.message : String(error));

const root = Effect.gen(function* () {
  const path = yield* Path.Path;
  return path.resolve(path.dirname(yield* path.fromFileUrl(new URL(import.meta.url))), "..");
});

const resolve = Effect.fn("resolveRef")(function* (ref: Ref) {
  if (ref.branch) return { target: ref.branch, version: undefined };
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const manifest = yield* Schema.decodeEffect(Manifest)(
    yield* fs.readFileString(path.join(yield* root, "package.json")),
  );
  const pin = manifest.dependencies?.[ref.dep ?? ""] ?? manifest.devDependencies?.[ref.dep ?? ""];
  const version = yield* Schema.decodeUnknownEffect(ExactVersion)(pin).pipe(
    Effect.mapError(() =>
      userError(`${ref.name}: ${ref.dep} must have an exact version pin; got ${String(pin)}`),
    ),
  );
  return { target: (ref.tag ?? "{v}").replace("{v}", version), version };
});

const download = Effect.fn("downloadRef")(function* (ref: Ref, target: string, staging: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const command = ref.private
    ? ChildProcess.make("gh", ["api", `repos/${ref.repo}/tarball/${target}`], { stderr: "inherit" })
    : ChildProcess.make(
        "curl",
        [
          "-fsSL",
          `https://github.com/${ref.repo}/archive/refs/${ref.branch ? "heads" : "tags"}/${target}.tar.gz`,
        ],
        { stderr: "inherit" },
      );
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
        return yield* userError(
          `${ref.name}: download/extraction failed (${String(downloaded)}/${String(extracted)})`,
        );
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

const report = Effect.fn("reportRefs")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(yield* root, "refs");
  let stale = 0;
  for (const ref of refs) {
    yield* Effect.gen(function* () {
      const { target } = yield* resolve(ref);
      const file = path.join(directory, ref.name, ".ref.json");
      if (!(yield* fs.exists(file))) {
        stale++;
        return yield* Console.log(`${ref.name}: MISSING (want ${target})`);
      }
      const stamp = yield* Schema.decodeEffect(Stamp)(yield* fs.readFileString(file));
      if (stamp.repo !== ref.repo || stamp.resolved !== target) {
        stale++;
        return yield* Console.log(`${ref.name}: STALE (have ${stamp.resolved}, want ${target})`);
      }
      yield* Console.log(
        `${ref.name}: ok ${target}${ref.branch ? ` (snapshot fetched ${stamp.fetchedAt}; upstream freshness not checked)` : ""}`,
      );
    }).pipe(
      Effect.catch((error) => {
        stale++;
        return Console.error(`${ref.name}: ERROR ${toUserError(error).userMessage}`);
      }),
    );
  }
  return stale;
});

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
    const failures: string[] = [];
    for (const ref of refs.filter((ref) => all || names.includes(ref.name))) {
      yield* fetchRef(ref).pipe(
        Effect.catch((error) => {
          failures.push(ref.name);
          return Console.error(`${ref.name}: ${toUserError(error).userMessage}`);
        }),
      );
    }
    if (failures.length > 0) return yield* userError(`Failed to fetch: ${failures.join(", ")}`);
  }),
).pipe(Command.withDescription("Download pinned sources; private repos use gh authentication"));

const checkCommand = Command.make("check", {}, () =>
  Effect.gen(function* () {
    const stale = yield* report();
    if (stale > 0)
      return yield* userError(`${String(stale)} reference(s) missing, stale, or invalid`);
  }),
);
const listCommand = Command.make("list", {}, () => report().pipe(Effect.asVoid));

Command.make("refs").pipe(
  Command.withDescription("Manage reference sources in refs/"),
  Command.withSubcommands([fetchCommand, checkCommand, listCommand]),
  Command.run({ version: "1.0.0" }),
  Effect.mapError(toUserError),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
