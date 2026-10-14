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
import * as Yaml from "effect/encoding/Yaml";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import * as Stream from "effect/Stream";

import { POLARIS_URL } from "../src/polaris.ts";
import { checkoutKind } from "./lib/worktree.ts";
import * as ShopifyDocs from "./refs-shopify-docs.ts";

/** Toolchain refs follow Vite+'s bundled versions rather than a separately maintained pin. */
type GitRef =
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
    }
  | {
      readonly _tag: "Toolchain";
      readonly name: string;
      readonly repo: string;
      readonly tool: "vite" | "vitest";
      readonly tag: string;
    };

type Ref =
  | GitRef
  | {
      readonly _tag: "ShopifyDocs";
      readonly name: string;
      readonly repo: string;
      /** A multi-minute site fetch must be requested explicitly rather than through `--all`. */
      readonly optIn: true;
    }
  | {
      /**
       * A script bundle served from a CDN, saved raw as `<file>.min.js` and formatted as
       * `<file>.js` for reading, where `<file>` is the URL's file name. The CDN sends no version
       * header, so the stamp's `version` is the build hash in the bundle's leading comment.
       */
      readonly _tag: "Cdn";
      readonly name: string;
      /** The CDN's origin. */
      readonly repo: string;
      readonly url: string;
    };

const refs: readonly Ref[] = [
  { _tag: "ShopifyDocs", name: "shopify-docs", repo: ShopifyDocs.ORIGIN, optIn: true },
  // The URL the site loads, so the snapshot follows the channel the pages run on.
  { _tag: "Cdn", name: "polaris", repo: new URL(POLARIS_URL).origin, url: POLARIS_URL },
  { _tag: "Branch", name: "baton", repo: "mw10013/baton", branch: "main", private: true },
  {
    _tag: "Branch",
    name: "cloudflare-docs",
    repo: "cloudflare/cloudflare-docs",
    branch: "production",
  },
  { _tag: "Branch", name: "agents", repo: "cloudflare/agents", branch: "main" },
  // Hosts partysocket and partyserver, the source the agents lifecycle code was vendored from.
  { _tag: "Branch", name: "partykit", repo: "cloudflare/partykit", branch: "main" },
  { _tag: "Dependency", name: "alchemy", repo: "alchemy-run/alchemy", dep: "alchemy", tag: "v{v}" },
  {
    _tag: "Dependency",
    name: "vite-plus",
    repo: "voidzero-dev/vite-plus",
    dep: "vite-plus",
    tag: "v{v}",
  },
  {
    _tag: "Toolchain",
    name: "vite",
    repo: "vitejs/vite",
    tool: "vite",
    tag: "v{v}",
  },
  {
    _tag: "Toolchain",
    name: "vitest",
    repo: "vitest-dev/vitest",
    tool: "vitest",
    tag: "v{v}",
  },
  {
    _tag: "Dependency",
    name: "playwright",
    repo: "microsoft/playwright",
    dep: "playwright",
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
const WorkspaceCatalogs = Schema.Struct({
  catalog: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  catalogs: Schema.optional(
    Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.String)),
  ),
});
const CatalogReference = Schema.TemplateLiteral(["catalog:", Schema.String]);
const Stamp = Schema.fromJsonString(
  Schema.Struct({
    repo: Schema.String,
    resolved: Schema.String,
    version: Schema.optional(Schema.String),
    fetchedAt: Schema.String,
  }),
  { space: 2 },
);

/** The first line of a Polaris CDN bundle: a `/*!` comment holding only the build hash. */
const BuildBanner = Schema.TemplateLiteralParser(["/*!", Schema.String, "*/"]);
const BuildHash = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8,}$/u, { message: "the bundle's build hash must be hex" }),
);

export class RefError extends Schema.TaggedError<RefError>()("RefError", {
  message: Schema.String,
}) {}

const root = Effect.gen(function* () {
  const path = yield* Path.Path;
  return path.resolve(path.dirname(yield* path.fromFileUrl(new URL(import.meta.url))), "..");
});

const dependencyVersion = Effect.fn("dependencyVersion")(function* (dep: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const manifest = yield* Schema.decodeEffect(Manifest)(
    yield* fs.readFileString(path.join(yield* root, "package.json")),
  );
  let version = manifest.dependencies?.[dep] ?? manifest.devDependencies?.[dep];
  if (Schema.is(CatalogReference)(version)) {
    const source = yield* fs.readFileString(path.join(yield* root, "pnpm-workspace.yaml"));
    const workspace = yield* Schema.decodeUnknownEffect(WorkspaceCatalogs)(
      yield* Effect.try({
        try: () => Yaml.parse(source),
        catch: (error) =>
          new RefError({ message: `Cannot read workspace catalogs: ${String(error)}` }),
      }),
    );
    const name = version.slice("catalog:".length);
    version = (
      name === "" ? (workspace.catalog ?? workspace.catalogs?.default) : workspace.catalogs?.[name]
    )?.[dep];
  }
  return yield* Schema.decodeUnknownEffect(ExactVersion)(version).pipe(
    Effect.mapError((error) => new RefError({ message: `${dep}: ${error.message}` })),
  );
});

/**
 * Reject stale installations so refs follow the project's pinned Vite+ release.
 * Vite's reported version selects an upstream release baseline; Vite+ may include
 * additional patches.
 * @see refs/vite-plus/packages/tools/src/brand-vite.ts — brandVite
 */
const toolchainVersion = Effect.fn("toolchainVersion")(function* (
  tool: Extract<Ref, { readonly _tag: "Toolchain" }>["tool"],
) {
  const expected = yield* dependencyVersion("vite-plus");
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const packageUrl = yield* Effect.try({
    try: () => import.meta.resolve("vite-plus/package.json"),
    catch: () => new RefError({ message: "Vite+ is not installed; run vp install" }),
  });
  const installed = yield* Schema.decodeEffect(
    Schema.fromJsonString(Schema.Struct({ version: ExactVersion })),
  )(yield* fs.readFileString(yield* path.fromFileUrl(new URL(packageUrl))));
  if (installed.version !== expected)
    return yield* new RefError({
      message: `Vite+ installation is stale (have ${installed.version}, want ${expected}); run vp install`,
    });
  const { versions } = yield* Effect.tryPromise({
    try: () => import("vite-plus/versions"),
    catch: () => new RefError({ message: "Cannot load vite-plus/versions; run vp install" }),
  });
  return yield* Schema.decodeUnknownEffect(ExactVersion)(versions[tool]).pipe(
    Effect.mapError((error) => new RefError({ message: `${tool}: ${error.message}` })),
  );
});

const resolve = Effect.fn("resolveRef")(function* (ref: Ref) {
  return yield* Match.valueTags(ref, {
    ShopifyDocs: () => Effect.succeed({ target: ShopifyDocs.API_VERSION, version: undefined }),
    // The build hash is known only once the bundle is downloaded; `downloadCdn` returns it.
    Cdn: ({ url }) => Effect.succeed({ target: url, version: undefined }),
    Branch: ({ branch }) => Effect.succeed({ target: branch, version: undefined }),
    Dependency: ({ dep, tag }) =>
      Effect.gen(function* () {
        const version = yield* dependencyVersion(dep);
        return { target: tag.replace("{v}", version), version };
      }),
    Toolchain: ({ tool, tag }) =>
      Effect.gen(function* () {
        const version = yield* toolchainVersion(tool);
        return { target: tag.replace("{v}", version), version };
      }),
  });
});

const downloadArchive = Effect.fn("downloadRefArchive")(function* (
  ref: GitRef,
  target: string,
  staging: string,
) {
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
    Toolchain: ({ repo }) => ({
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

/**
 * Saves a CDN bundle raw and formatted, and returns its build hash. The raw copy is kept so the
 * formatted one can be regenerated, or compared by hash. `vp fmt` runs from the project root so
 * it reads the project's formatter config; the `.js` stdin path picks the JavaScript parser.
 */
const downloadCdn = Effect.fn("downloadCdnRef")(function* (url: string, staging: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const client = yield* HttpClient.HttpClient;
  const raw = yield* client.get(url).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((response) => response.text),
    Effect.mapError((error) => new RefError({ message: `${url}: ${error.message}` })),
  );
  const hash = yield* Schema.decodeUnknownEffect(BuildBanner)(raw.split("\n", 1)[0]).pipe(
    Effect.flatMap(([, hash]) => Schema.decodeUnknownEffect(BuildHash)(hash)),
    Effect.mapError(
      (error) => new RefError({ message: `${url}: no leading build hash: ${error.message}` }),
    ),
  );
  const file = path.basename(new URL(url).pathname, ".js");
  yield* fs.writeFileString(path.join(staging, `${file}.min.js`), raw);
  const formatted = yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make("vp", ["fmt", `--stdin-filepath=${file}.js`], {
          cwd: yield* root,
          stdin: Stream.make(new TextEncoder().encode(raw)),
          stderr: "inherit",
        }),
      );
      const [text, exitCode] = yield* Effect.all(
        [Stream.mkString(Stream.decodeText(handle.stdout)), handle.exitCode],
        { concurrency: 2 },
      );
      if (exitCode !== 0)
        return yield* new RefError({ message: `vp fmt failed (${String(exitCode)})` });
      return text;
    }),
  );
  yield* fs.writeFileString(path.join(staging, `${file}.js`), formatted);
  return hash;
}, Effect.provide(FetchHttpClient.layer));

/** Fills `staging`, and returns the version to stamp when only the download can tell it. */
const download = Effect.fn("downloadRef")((ref: Ref, target: string, staging: string) =>
  Match.valueTags(ref, {
    ShopifyDocs: () => ShopifyDocs.downloadInto(staging).pipe(Effect.as(undefined)),
    Cdn: ({ url }) => downloadCdn(url, staging),
    Branch: (source) => downloadArchive(source, target, staging).pipe(Effect.as(undefined)),
    Dependency: (source) => downloadArchive(source, target, staging).pipe(Effect.as(undefined)),
    Toolchain: (source) => downloadArchive(source, target, staging).pipe(Effect.as(undefined)),
  }),
);

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
      const downloaded = yield* download(ref, target, contents);
      yield* fs.writeFileString(
        path.join(contents, ".ref.json"),
        `${yield* Schema.encodeEffect(Stamp)({
          repo: ref.repo,
          resolved: target,
          version: downloaded ?? version,
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
    ShopifyDocs: () => ` (snapshot fetched ${stamp.fetchedAt}; live docs freshness not checked)`,
    // The CDN's `last-modified` moves daily even when the bytes do not, so the hash is reported
    // and the live bundle is not compared.
    Cdn: () =>
      ` (build ${stamp.version?.slice(0, 8) ?? "unknown"}, fetched ${stamp.fetchedAt}; live bundle not checked)`,
    Branch: () => ` (snapshot fetched ${stamp.fetchedAt}; upstream freshness not checked)`,
    Dependency: () => "",
    Toolchain: () => "",
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

/** Fails unless this checkout's refs resolves to the main checkout's refs, so every snapshot lands in one place. */
const requireSharedRefs = Effect.fn("requireSharedRefs")(function* (mainCheckout: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const realPath = (directory: string, hint: string) =>
    fs.realPath(directory).pipe(Effect.mapError(() => userError(hint)));
  const local = yield* realPath(
    path.join(yield* root, "refs"),
    "refs is missing in this worktree; link it with `ln -s <main>/refs refs`",
  );
  const shared = yield* realPath(
    path.join(mainCheckout, "refs"),
    `refs is missing in ${mainCheckout}; run refs fetch there first`,
  );
  if (local !== shared)
    return yield* userError(`refs must link to ${shared}; run refs fetch in ${mainCheckout}`);
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
    const { linked, mainCheckout } = yield* checkoutKind.pipe(
      Effect.mapError((error) => userError(error.message)),
    );
    if (linked) yield* requireSharedRefs(mainCheckout);
    const [, failed] = yield* Effect.partition(
      refs.filter((ref) => names.includes(ref.name) || (all && !("optIn" in ref && ref.optIn))),
      (ref) =>
        fetchRef(ref).pipe(
          Effect.tapError((error) => Console.error(`${ref.name}: ${error.message}`)),
          Effect.mapError(() => ref.name),
        ),
    );
    if (failed.length > 0) return yield* userError(`Failed to fetch: ${failed.join(", ")}`);
  }),
).pipe(
  Command.withDescription(
    "Download refs; --all skips opt-in site mirrors; private repos use gh authentication",
  ),
);

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
