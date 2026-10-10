# Research: Idiomatic Effect patterns for this codebase

Date: 2026-10-10  
Status: implemented 2026-10-10 per §8 ([Decisions](#decisions-round-1-2026-10-10-via-plannotator)); verification notes at the end of that section.  
Versions: Effect `4.0.1`, `@effect/platform-node` `4.0.1`, `@effect/atom-react` `4.0.1`, `@tanstack/react-form` `1.33.5` (installed, unused).  
Vocabulary: [glossary](./glossary.md). Background: [IPC plan](./start-to-effect-worker-ipc-plan.md), [query pattern plan](./query-pattern-and-proxy-hardening-plan.md), [worktrees research](./t3-code-worktrees-research.md).

Sources: `refs/effect` at tag `effect@4.0.1`: its agent guidance (`.agents/AGENTS.md`, `.agents/skills/effect-development/SKILL.md`), the AI docs under `ai-docs/src`, `packages/effect/SCHEMA.md`, and the module sources named per finding. `refs/effect-tanstack-start` (Lucas Barake, Effect 3) for the RPC input pattern. Anchors are relative to `refs/effect` unless they say otherwise. Runtime claims about RPC payload constructors come from a probe run against the installed `effect` package (§2.2).

Scope: every TypeScript file we own: `src/**` (12 files) and `scripts/**` (6 files, the four new ones uncommitted). `src/routeTree.gen.ts` is generated and excluded.

## Summary

- **The codebase is in better shape than it looks.** `backend-client.ts`, `query.ts`, `router.tsx`, `worker.ts`, `env.server.ts` and `scripts/lib/herdr.ts` already follow the patterns Effect's own docs prescribe. The hand-rolled code concentrates in four places: the `Shout` handler, the `/api/rpc` proxy guard, `HomePage.tsx`'s failure rendering, and the `scripts/` CLIs.
- **The `Shout` case you spotted is the headline, and it hides a contract question.** Trim-and-length-check by hand in `src/backend/handlers.ts:14-21` should be a Schema. But a Schema with checks on an RPC payload field is enforced **on the client too**: `RpcClient` builds the payload with the schema's `make`, which throws on an invalid value (§2.2, verified). So "let the schema errors flow through" cannot mean "the server returns a SchemaError": there is no typed path for that over RPC (§2.3). The idiomatic shape is: one shared `ShoutText` codec, decoded **at the client edge** before the mutation, with the RPC payload typed as the decoded value. `InvalidInput` then has no job and goes away (§2.4).
- **Effect's AI docs are explicit and short.** "All validation and domain modeling in Effect is done with `Schema`. AVOID using predicates or manual parsing." "NEVER write your own helper functions like `isRecord` or `isString`, use the `Predicate` module." Prefer `Effect.gen` inline, `Effect.fn("name")` for reusable functions, and avoid plain functions that only wrap an `Effect.gen` (§1). We violate each of these a handful of times, all listed in §3 to §6.
- **`Match` replaces every `_tag ===` ternary and `switch`** we have: two in `HomePage.tsx`, one in `scripts/dev.ts`. `AsyncResult.match` replaces the three-way `_tag` checks in JSX (§3, §6.4).
- **Scripts: the biggest wins are `Config` and `Schema` for every `Number(...)`/`isInteger` parse, `Effect.repeat` for the polling loop, `Effect.try` for the `try/catch` blocks, and typed `catchTags` instead of `instanceof` chains** (§6). `ConfigProvider.fromDotEnvContents` can replace our `.env` parser for reads (§6.2).
- **Two consistency choices are yours**: `effect/X` path imports (src) vs the `"effect"` barrel (scripts), and `Schema.TaggedError` (src) vs `Data.TaggedError` (scripts). Recommendations in §9.
- **Recommended order**: `src/` first (four files, one afternoon), scripts second. Each step is independently typecheckable.

## 1. What Effect's own guidance says

The repository ships guidance meant for agents and reviewers. The rules that bear on us, quoted or paraphrased:

| Rule                                                                                                                                                                                                                         | Where                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| "All validation and domain modeling in Effect is done with `Schema`. **AVOID using predicates or manual parsing**, instead use `Schema` to parse untrusted data and validate it."                                            | `ai-docs/src/01_effect/02_schema/index.md`                              |
| "**NEVER** write your own helper functions like `isRecord` or `isString`, instead use the helpers from the `Predicate` module." Compose with `Predicate.and/or/not/compose`.                                                 | `ai-docs/src/10_predicate/index.md`                                     |
| "Prefer `Effect.gen` for inline Effect code. For reusable functions, prefer `Effect.fn("name")` when tracing is useful and `Effect.fnUntraced` when it is not. **Avoid functions that only wrap and return `Effect.gen`.**"  | `ai-docs/src/01_effect/01_basics/index.md`                              |
| With `Effect.fn`, pass extra combinators as further arguments: "**Do not** use `.pipe` with `Effect.fn`." See the note below the table.                                                                                      | `ai-docs/src/01_effect/01_basics/02_effect-fn.ts`                       |
| "Always return when raising an error" (`return yield* new MyError(...)`).                                                                                                                                                    | same                                                                    |
| Errors are `Schema.TaggedError` classes; a wrapped unknown goes in a `cause: Schema.Defect()` field.                                                                                                                         | `ai-docs/src/01_effect/04_errors/*`, `01_basics/10_creating-effects.ts` |
| "Reuse parsers at the edges of your application instead of rebuilding them for every request. Use the Effect-returning APIs when you are already inside Effect code so validation errors remain typed in the error channel." | `ai-docs/src/01_effect/02_schema/10_schema-basics.ts`                   |
| Wrap throwing sync code with `Effect.try`, Promises with `Effect.tryPromise`, nullable values with `Effect.fromNullishOr`.                                                                                                   | `ai-docs/src/01_effect/01_basics/10_creating-effects.ts`                |
| CLI: validate arguments and flags with `Argument.withSchema` / `Flag.withSchema` "so the handler only ever sees valid input".                                                                                                | `ai-docs/src/70_cli/10_basics.ts`                                       |
| Child processes: `spawner.string` and `spawner.lines` for collected output, `spawner.spawn` when you need the handle; `ChildProcess.pipeTo` for pipelines.                                                                   | `ai-docs/src/60_child-process/10_working-with-child-processes.ts`       |

**What "pass combinators as further arguments" means.** `Effect.fn("name")` takes the generator first, then any number of functions of shape `(effect) => effect`: the same things you would put in a `.pipe(...)`. It applies them to the body **inside** the span and stack-frame capture it sets up, so a `catch`, `retry` or `annotateLogs` passed this way is part of the traced function. A trailing `.pipe` does not do what it looks like: `Effect.fn` returns a **function**, not an effect, so `.pipe` there would wrap the function value, not its result.

```ts
// Idiomatic: combinators are extra arguments to Effect.fn.
const fetchRef = Effect.fn("fetchRef")(
  function* (ref: Ref) { /* ... */ },
  Effect.catch((error) => Console.error(String(error))),
  Effect.annotateLogs({ step: "fetch" }),
);

// Not this: fetchRef is a function; piping applies to the function, not to its result.
const fetchRef = Effect.fn("fetchRef")(function* (ref: Ref) { /* ... */ }).pipe(Effect.catch(...));

// Piping the *call* is fine; it just sits outside the span.
fetchRef(ref).pipe(Effect.catch(...));
```

Our code already does this right in `scripts/refs.ts` (no `Effect.fn` there has a trailing pipe). The rule only bites when converting the arrow-wrapped `Effect.gen` helpers in `scripts/dev.ts` (§6.4): any `.pipe(...)` on the inner `Effect.gen` moves to extra arguments of `Effect.fn`.

Two Effect 4 facts that shape the recommendations below:

- **Filters run on the Type side in both directions.** `Schema.String.check(Schema.isBetweenLength(1, 80))` rejects a bad string whether you decode, encode, or construct it with `make`. `Schema.Trim` is a transformation (`String` → `Trimmed`), so its Type side is a string that is already trimmed (`packages/effect/src/Schema.ts:9969-9995`).
- **Constructors come in three flavours.** `make` throws, `makeOption` discards the detail, `makeEffect` keeps the issue in the error channel (`Schema.ts:195-267`). Library code calls `make`.

## 2. The `Shout` case

### 2.1 What we have

`src/backend/handlers.ts:14-21` trims, checks `1..80`, and builds an `InvalidInput` message by hand. The contract in `src/api/backend.ts:24-29` declares `payload: { input: Schema.String }` and `error: InvalidInput`. The page passes the raw textbox value (`src/components/HomePage.tsx:88`) and renders `InvalidInput.message` (`:25-32`).

### 2.2 What a Schema on the payload actually does (verified)

I ran a probe against the installed package with `payload: { input: Schema.Trim.check(Schema.isBetweenLength(1, 80)) }`:

| Call                                      | Result                                                                  |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| `payloadSchema.make({ input: "  hi  " })` | **throws** `Schema validation failed` (not trimmed on the Type side)    |
| `payloadSchema.make({ input: "   " })`    | **throws**                                                              |
| `decodeUnknownExit(schema)("  hi  ")`     | `Success("hi")`                                                         |
| `decodeUnknownExit(schema)("   ")`        | `Failure(SchemaError: Expected a value with a length between 1 and 80)` |

`RpcClient` calls `rpc.payloadSchema.make(payload)` for every request (`packages/effect/src/rpc/RpcClient.ts:332,346`), and `Rpc.make` turns a `payload` field map into a `Schema.Class` (`rpc/Rpc.ts:966-970`). So a check on a payload field is a **client-side precondition**, enforced by a throw, before anything is sent. On the server, a payload that fails to decode is answered as a request **defect**, formatted with `SchemaIssue.defaultFormatter` (`rpc/RpcServer.ts:796-802`). Either way the UI sees a defect, never a typed failure.

### 2.3 Why "let schema errors flow through" has no typed path over RPC

`Schema.SchemaError` is a `Data.TaggedError`, not a Schema (`Schema.ts:1172`), so it cannot be an `Rpc.make` `error`. The only ways a schema failure reaches the client are a thrown `make` (client) or a defect (server). Both are the correct behaviour for a **contract violation**; neither is a user-facing validation message.

### 2.4 Recommendation: one shared codec, decoded at the client edge

```ts
// src/api/backend.ts
export const ShoutText = Schema.Trimmed.check(
  Schema.isBetweenLength(1, 80, { message: "Enter 1 to 80 characters." }),
).pipe(Schema.brand("ShoutText"));
export type ShoutText = typeof ShoutText.Type;

// Raw textbox value -> ShoutText. Trim is a decode step, so the check sees the trimmed text.
export const ShoutTextFromInput = Schema.Trim.pipe(Schema.decodeTo(ShoutText));

Rpc.make("Shout", { payload: { input: ShoutText }, success: Shouted });
```

Probe results for this exact shape: `"  hi  "` decodes to `"hi"`; `"   "` fails with `Enter 1 to 80 characters.`; `decodeUnknownResult(...)` exposes that text as `failure.message`; `payloadSchema.make({ input: <decoded> })` succeeds.

Consequences:

- **Handler**: `Shout: ({ input }) => Effect.succeed({ input, output: input.toUpperCase() })`, wrapped in the existing `Effect.gen` for the log line. No validation, no `InvalidInput`.
- **Client**: decode before calling. Either `Schema.decodeUnknownResult(ShoutTextFromInput)(input)` and `Result.match` to show the message or run the mutation, or the form-library route (§2.5). The message comes from the filter's `message` annotation, so UI copy lives next to the rule.
- **Contract**: `InvalidInput` is deleted from `BackendRpcs`. The `error` channel of `Shout` becomes `Never` (the RPC default). `describeShoutFailure` in `HomePage.tsx` loses its `InvalidInput` branch and only has to describe `RpcClientError` and defects.
- **Branding** is type-only (`SCHEMA.md` §Branding, line 2810). It costs nothing at runtime and makes "a string that went through `ShoutTextFromInput`" a distinct type, which is exactly the guarantee the handler now relies on. The Lucas Barake reference brands its ids the same way (`refs/effect-tanstack-start/src/api/todo-schema.ts:4`).

This is also the pattern that reference uses for input: the client trims, the schema (`Schema.minLength(1)`) guards the contract, and there is no typed validation error on the wire (`create-todo-form.tsx:11-16`, `domain-rpc.ts:22-25`).

Keep `InvalidInput` only if a **business** rule needs a typed server error later (a reserved word, a quota). None exists today.

### 2.5 TanStack Form

`@tanstack/react-form` is a dependency and unused. Effect 4 exports `Schema.toStandardSchemaV1(schema, { leafHook? })` (`Schema.ts:1295-1340`), and TanStack Form accepts Standard Schema validators (`refs/tan-form/packages/form-core/src/FieldApi.ts`). So the same `ShoutTextFromInput` can become a field validator with no adapter when forms arrive. For one textbox today, `decodeUnknownResult` plus `Result.match` is less code; the schema shape is form-ready either way.

## 3. `src/components/HomePage.tsx`

| Lines  | Now                                                                              | Idiom                                                                                                                                                                                                                     |
| ------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 18-23  | `failureTag`: `Option.match` over `Cause.findErrorOption` returning `error._tag` | Fine as is. `Cause.findErrorOption` is the right primitive. Keep.                                                                                                                                                         |
| 25-32  | `describeShoutFailure`: ternary on `error._tag === "InvalidInput"`               | `Match.valueTags(error, { InvalidInput: ..., RpcClientError: ... })` (`Match.ts`, `valueTags`): exhaustive, so adding an RPC error later is a compile error here. After §2.4 the branch list shrinks to `RpcClientError`. |
| 62-77  | `hello._tag === "Initial"` / `"Success"` / `"Failure"` as three JSX guards       | `AsyncResult.match(hello, { onInitial, onSuccess, onFailure })` (`reactivity/AsyncResult.ts:609`). `AsyncResult.builder` also exists but is marked `@stability unstable`; avoid.                                          |
| 93-103 | same for `shoutResult`                                                           | same                                                                                                                                                                                                                      |
| 88     | `shout({ payload: { input }, ... })` with the raw string                         | decode with `ShoutTextFromInput` first (§2.4)                                                                                                                                                                             |

`Cause.pretty(cause).split("\n")[0]` on line 27 is string-munging a formatted cause. `Cause.squash(cause)` returns the underlying defect value; `String(Cause.squash(cause))` is the honest one-liner.

## 4. `src/routes/api.rpc.ts`: the proxy guard

Lines 11-20 parse `content-type` and `content-length` by hand: `split(";")[0]?.trim().toLowerCase()`, a regex, `Number(...)`, four early returns with four status codes.

Schema expresses the two rules directly:

```ts
const NdjsonMediaType = Schema.String.check(
  Schema.isPattern(/^application\/ndjson\s*(?:;.*)?$/iu, { message: "Unsupported Media Type" }),
);
const BodyLength = Schema.NumberFromString.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 1, maximum: MAX_RPC_BODY_BYTES }),
);
```

`Schema.NumberFromString` exists (`Schema.ts:9884`); `isInt`, `isBetween`, `isPattern` take an annotations object with `message` (`SCHEMA.md` §Filter error messages, line 2562; `ai-docs/src/70_cli/10_basics.ts` shows `isPattern(re, { message })`).

The catch: one decode yields one issue, and we currently answer four distinct statuses (415, 411, 400, 413). Two ways to keep them:

1. **A schema per header, a tagged rejection, a `Match`.** `Schema.decodeUnknownResult(NdjsonMediaType)(...)` → `UnsupportedMediaType`; missing header → `LengthRequired`; `BodyLength` failure split by `Option.isNone(Schema.decodeUnknownOption(BodyLength)(...))` into `BadRequest` vs `PayloadTooLarge` (too large needs its own check so the status can differ). Then `Match.valueTags(rejection, { UnsupportedMediaType: () => text(415, ...), ... })`. More named things, but every status has a name and the hand parsing is gone.
2. **Collapse to three statuses**: 415 for media type, 413 when the length parses but exceeds the cap, 400 for everything else (missing, non-numeric, zero). `411 Length Required` is a nicety no client of ours relies on. One `Schema.Struct` over `Object.fromEntries(request.headers)` with the two fields, plus one extra `isLessThanOrEqualTo` probe for the 413 split.

Either way, `Schema.is(schema)` (`Schema.ts`, `is`) gives a type guard when a boolean is all a branch needs. Question Q3.

## 5. Already idiomatic: leave alone

- `src/backend-client.ts`, `src/query.ts`, `src/router.tsx`, `src/routes/index.tsx`, `src/routes/__root.tsx`, `src/backend/worker.ts`, `alchemy.run.ts`: Layers, `AtomRpc.Service`, `Config.Port`, `Effect.orDie` at the boundary. Nothing to do.
- `src/env.server.ts`: a `Proxy` over `cloudflare:workers` for a Vite dev quirk. Not Effect territory.
- `scripts/lib/herdr.ts`: every `herdr` call decodes its JSON envelope through a `Schema` that names only the fields read. This file is the model for the other scripts.
- `scripts/lib/worktree.ts` `setEnvKey`: rewrites one line of a `.env` while preserving comments. String code is the right tool.
- `scripts/dev.ts` `withDescendants`: a pure parent-to-children walk over `ps` output. Readable; `HashMap` would not improve it.

## 6. Scripts

The four new scripts are uncommitted, so this is the cheapest moment to reshape them. Findings per file, most valuable first.

### 6.1 Cross-cutting

| Pattern                                                                                                                                                 | Where                                                                                                                   | Idiom                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `toUserError(error: unknown)` with `instanceof Error` / `instanceof CliError.UserError`, applied by `Effect.mapError` to an already-typed error channel | `scripts/refs.ts:71-80`, `scripts/dev.ts:400-404`, `scripts/worktree.ts:103-111`                                        | The error channel is typed (`DevError \| CommandError \| PlatformError \| SchemaError`). Map it with `Effect.catchTags({...})` or one `Match.valueTags`, each arm building a `CliError.UserError` with the right `userMessage`. `Predicate.isError` if a guard is still needed (`Predicate.ts`, `isError`). |
| Plain arrow functions that only wrap `Effect.gen`                                                                                                       | `dev.ts` `step`, `waitUntil`, `stopServer`, `launchServer`, `idlePaneIn`, `waitAnswering`; `worktree.ts` `readIfExists` | `Effect.fn("name")` (traced) or `Effect.fnUntraced` for the hot or trivial ones. `refs.ts` already does this.                                                                                                                                                                                               |
| `Data.TaggedError` with a `message` field                                                                                                               | `lib/command.ts:4`, `lib/worktree.ts:18`, `dev.ts:52`                                                                   | `Schema.TaggedError`, as `src/api/backend.ts` and every ai-docs example do. Add `cause: Schema.Defect()` where a wrapped error is kept (`command.ts`).                                                                                                                                                      |
| `Number(x)` + `Number.isInteger(x) && x > 0`                                                                                                            | `lib/worktree.ts:35-36`, `worktree.ts:56-57`, `dev.ts:91-95`                                                            | A schema: `Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThan(0))`, decoded with `decodeUnknownOption` when "not a pid" means "skip" and `decodeUnknownEffect` when it means "fail".                                                                                                        |
| Barrel import `from "effect"`                                                                                                                           | all scripts                                                                                                             | `src/` uses `import * as Effect from "effect/Effect"`. Pick one (Q4).                                                                                                                                                                                                                                       |

### 6.2 `scripts/lib/worktree.ts`

- `worktreeName` / `worktreeIndex` (lines 27-36) are one codec written as two functions. `WorktreeBranch = Schema.String.check(Schema.isPattern(/^wt-\d{2}$/u)).pipe(Schema.decodeTo(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 99 })), SchemaTransformation.transform({ decode: s => Number(s.slice(3)), encode: n => \`wt-${String(n).padStart(2, "0")}\` })))`. Then `Schema.decodeUnknownOption(WorktreeBranch)(branch)`replaces`worktreeIndex`and`Schema.encodeSync(WorktreeBranch)(index)`replaces`worktreeName`. The regex is written once and `MAX_INDEX` becomes a schema bound. (`Schema.TemplateLiteralParser` (`SCHEMA.md`line 452) is the other option; the zero-padding makes`transform` clearer.)
- `parseEnv` (lines 41-50): for **reads**, `ConfigProvider.fromDotEnvContents(text)` plus `Config.Port("WEBSITE_PORT")` gives a validated port with Effect's own dotenv rules (`ConfigProvider.ts:1194-1210`). That covers both callers in `scripts/worktree.ts` (main checkout's port, other checkouts' ports). Keep `setEnvKey` for the write.
- `gitDirs` (lines 68-78): `output.trim().split("\n")` with defaults of `""`. `spawner.lines` plus `Schema.Tuple([Schema.String, Schema.String])` names the shape and fails loudly on a short answer. Minor.

### 6.3 `scripts/lib/command.ts`

The `Effect.mapError` on lines 37-45 tests `cause instanceof CommandError` to avoid double-wrapping. Raise `CommandError` from the exit-code path only, and give `PlatformError` from `spawn`/`exitCode` its own `Effect.mapError` at those call sites (the ai-docs child-process example does exactly this, `60_child-process/10_working-with-child-processes.ts`). Or model it the Effect 4 way: `CommandError` with a `reason: Schema.Union([NonZeroExit, SpawnFailed])` and `Effect.catchReason` at callers (`ai-docs/src/01_effect/04_errors/20_reason-errors.ts`). The reason model is the more future-proof one; the first is a two-line change.

### 6.4 `scripts/dev.ts`

| Lines   | Now                                                                      | Idiom                                                                                                                                                                                                                                                                          |
| ------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 57-63   | `loadPort`: `process.env` read, empty-string check                       | `Config.Port("WEBSITE_PORT")` (`Config.ts`, `Port`). It validates the range and reports a `ConfigError` with the key name. Same call `alchemy.run.ts:14` already makes. Port becomes a `number`; three template strings adapt.                                                 |
| 80-92   | `waitUntil`: `while` loop with `Date.now()` deadline and `Effect.sleep`  | `check.pipe(Effect.repeat({ until: (ok) => ok, schedule: Schedule.spaced(intervalMs) }), Effect.timeoutOption(timeoutMs))` (`Effect.ts:7673` `repeat` with `Repeat.Options`, `Schedule.spaced`, `timeoutOption`). Returns `Option<true>`; callers already branch on a boolean. |
| 94-98   | `pidsFrom`: split, `Number`, `isInteger && > 0`                          | `Array.filterMap(lines, Schema.decodeUnknownOption(Pid))` with `Pid = Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThan(0))`.                                                                                                                                 |
| 179-186 | `processAlive`: `try { process.kill(pid, 0) } catch { return false }`    | `Effect.try(() => process.kill(pid, 0)).pipe(Effect.isSuccess)` or `Effect.option` + `Option.isSome`. The kill loop at 240-246 becomes `Effect.forEach(pids, (pid) => Effect.try(() => process.kill(pid, "SIGTERM")).pipe(Effect.ignore))`.                                    |
| 289-305 | `switch (placement._tag)`                                                | `Match.valueTags(placement, { Pane: ..., Background: ..., Foreground: ... })`. The `Placement` union stays a plain type; `Data.TaggedEnum` is optional (Q9).                                                                                                                   |
| 161-165 | `Herdr.processInfo(...)` per pane with `Effect.orElseSucceed` to swallow | Fine. `Effect.forEach` with `{ concurrency: 4 }` is the idiom.                                                                                                                                                                                                                 |
| 433-437 | `Option.getOrNull(Option.map(server.pane, ...))`                         | Fine.                                                                                                                                                                                                                                                                          |

`step` and `elapsed` time a step by hand with `Date.now()`. `Effect.timed` returns `[Duration, A]`; `Duration.format` prints it. Optional polish.

### 6.5 `scripts/refs.ts`

- `Ref` (lines 8-15) is an interface with four optional fields and an either/or meaning: a ref is pinned by a **branch** or by a **dependency's version + tag template**. `resolve` (line 85) encodes that with `if (ref.branch)` and `ref.dep ?? ""`. A tagged union says it: `{ _tag: "Branch", name, repo, branch, private? } | { _tag: "Dependency", name, repo, dep, tag }`, and `resolve` becomes `Match.valueTags(ref, { Branch: ..., Dependency: ... })`. `download` keys on `ref.branch ? "heads" : "tags"` the same way. A `Schema.TaggedUnion` would also give `Argument.Literals("name", ...)` its list from the schema, but the array of literals is already fine.
- `report` (lines 164-192) counts with `let stale = 0` inside a `for` over `yield*`, and `fetchCommand` collects `failures.push(ref.name)`. `Effect.partition(refs, check)` (`Effect.ts`, `partition`) returns `[failures, successes]` in one pass, no mutation; or `Effect.forEach(..., Effect.result)` then `Array.partition`.
- `userError(...)` / `Effect.mapError(() => userError(...))` on line 96: the message is built by hand from a `SchemaError` we just threw away. Keep the `SchemaError` in the channel and let the single error mapper (§6.1) format it with `error.message`; the schema's `expected` annotation carries the version-pin wording.
- Everything else (`Effect.fn` per step, `makeTempDirectoryScoped`, `Effect.uninterruptible` around the rename, `Schema.fromJsonString` for both JSON files) is the pattern to copy.

### 6.6 `scripts/worktree.ts`

- Lines 55-58 and 80-85: port parsing and comparison by hand. After §6.2 both are `Config.Port` reads, and the comparison is between numbers.
- Lines 73-87 and 89-103: `if (Option.isNone(x)) ... else ...` and the three-way `linkTarget` / `exists` ladder. `Option.match` for the first; the second is genuinely three cases (symlink present, real directory, absent), so a small tagged state and `Match.valueTags` reads better than nested `else if`. Lower priority than the rest.
- `fail` and `toUserError` fold into the shared error mapper (§6.1).

## 7. Consistency choices

| Topic            | `src/`                                    | `scripts/`                        | Effect docs                               | Recommendation                                                                                                                                                                    |
| ---------------- | ----------------------------------------- | --------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Imports          | `import * as Effect from "effect/Effect"` | `import { Effect } from "effect"` | barrel in examples                        | Path imports everywhere. They are what the Worker bundle wants, and the Lucas Barake reference uses them. The barrel is fine for Node scripts but one style is simpler to review. |
| Error base class | `Schema.TaggedError`                      | `Data.TaggedError`                | `Schema.TaggedError` throughout           | `Schema.TaggedError` everywhere.                                                                                                                                                  |
| Reusable effects | n/a                                       | mix of `Effect.fn` and arrows     | `Effect.fn("name")` / `Effect.fnUntraced` | `Effect.fn` for anything named; `Effect.gen` only inline.                                                                                                                         |
| Filter messages  | n/a                                       | n/a                               | `message` annotation on the filter        | Custom `message` only where a person reads it (`ShoutText`, the proxy's 415). Defaults elsewhere.                                                                                 |

## 8. Proposed order of work

1. **`src/api/backend.ts`**: add `ShoutText` and `ShoutTextFromInput`, retype the payload, delete `InvalidInput` (Q1, Q2).
2. **`src/backend/handlers.ts`**: drop the validation.
3. **`src/components/HomePage.tsx`**: decode at the edge, `Match.valueTags` for failures, `AsyncResult.match` for the three states.
4. **`src/routes/api.rpc.ts`**: schemas for the two headers, status map per Q3.
5. `pnpm typecheck && pnpm check`, then exercise Hello and Shout on the dev server (padded, blank, 81 characters, valid).
6. **Scripts**, one file at a time: `lib/command.ts`, `lib/worktree.ts`, `worktree.ts`, `refs.ts`, `dev.ts`. Run `pnpm refs:check`, `pnpm worktree:init` in a worktree, and `dev:status` after each.

## 9. Questions and recommendations

| #   | Question                                                                                                                                                            | Recommendation                                                                                                                                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Validate `Shout` at the **client edge** with the shared codec and delete `InvalidInput`, given that a server-side `SchemaError` cannot be a typed RPC error (§2.3)? | **Yes.** It is the only shape where the schema is the single source of the rule, and it matches the reference project. Reintroduce a typed error only for a business rule.                                                                                                              |
| Q2  | Brand `ShoutText`?                                                                                                                                                  | **Yes.** Type-only, zero runtime cost, and it makes "already validated" visible in the handler's signature.                                                                                                                                                                             |
| Q3  | `/api/rpc` guard: keep four status codes (schema per header + `Match`) or collapse to 415/413/400 (one struct schema)?                                              | Revised after review (you asked whether option 1 over-engineers; it does). **Collapse**, option 2 in §4: one `Schema.Struct` over the two headers decides accept vs 400, plus two one-line `Schema.is` probes for the 415 and 413 statuses. `411` goes. No rejection union, no `Match`. |
| Q4  | Import style: `effect/X` path imports everywhere?                                                                                                                   | **Yes**, convert the scripts. Mechanical.                                                                                                                                                                                                                                               |
| Q5  | `Schema.TaggedError` everywhere, replacing `Data.TaggedError` in scripts?                                                                                           | **Yes.** Same API surface, and it is what Effect's docs teach.                                                                                                                                                                                                                          |
| Q6  | Scope: `src/` only, or also the four uncommitted scripts?                                                                                                           | **Both**, `src/` first. The scripts are uncommitted, so reshaping now avoids a second review.                                                                                                                                                                                           |
| Q7  | Replace `parseEnv` reads with `ConfigProvider.fromDotEnvContents` + `Config.Port`?                                                                                  | **Yes.** Keep `setEnvKey` for the write; it preserves comments, which the provider cannot do.                                                                                                                                                                                           |
| Q8  | Adopt TanStack Form + `Schema.toStandardSchemaV1` for the Shout input now?                                                                                          | **Not yet.** One field; `decodeUnknownResult` + `Result.match` is less code. The codec is form-ready when a real form arrives.                                                                                                                                                          |
| Q9  | `Placement` and the refs `Ref` union: plain tagged types with `Match.valueTags`, or `Data.TaggedEnum` with `$match`?                                                | **Plain types + `Match.valueTags`.** One concept (`Match`) covers every tag dispatch in the codebase.                                                                                                                                                                                   |
| Q10 | `command.ts` errors: two-line fix (map `PlatformError` at call sites) or the reason-union model?                                                                    | **Two-line fix now.** Reason unions earn their keep when callers branch on the reason; none do.                                                                                                                                                                                         |

## Decisions (round 1, 2026-10-10, via Plannotator)

- Q1, Q2, Q4, Q5, Q6, Q7, Q8, Q9, Q10: **accepted as recommended.** Validate `Shout` at the client edge with a branded `ShoutText`; delete `InvalidInput`; path imports and `Schema.TaggedError` everywhere; refactor `src/` first, then the four scripts; `ConfigProvider.fromDotEnvContents` for `.env` reads; no TanStack Form yet; plain tagged types with `Match.valueTags`; two-line fix in `command.ts`.
- Q3: reviewer flagged option 1 as over-engineering. Recommendation revised to **collapse to 415/413/400 with one struct schema** (§4 option 2). **Confirmed.**
- Reviewer asked for the `Effect.fn` vs `.pipe` rule to be explained; added under §1.

### Implementation notes (2026-10-10)

- All ten decisions applied across `src/api/backend.ts`, `src/backend/handlers.ts`, `src/components/HomePage.tsx`, `src/routes/api.rpc.ts`, `scripts/lib/command.ts`, `scripts/lib/worktree.ts`, `scripts/worktree.ts`, `scripts/refs.ts`, `scripts/dev.ts`. `pnpm typecheck` and `pnpm check` pass.
- Verified on the dev server: `/api/rpc` answers 415 (wrong media type), 400 (zero length), 413 (oversize), 405 (GET); SSR renders the Hello query; in the browser, blank Shout input shows `Enter 1 to 80 characters.` under the field without a request, and padded input is trimmed, shouted, and refreshes the Hello query through the reactivity key. `pnpm refs:check`, `pnpm worktree:init` (refuses the main checkout), `pnpm dev:start|status|logs` all run.
- Deviations from the plan: `Match.valueTags` could not return a `ChildProcess.Command` directly (`Command` is yieldable, so the matcher unifies the arms into an `Effect`); `download` in `refs.ts` matches to plain `{ bin, args }` data and builds the command once. `Array.filterMap` takes a `Result`, so pid parsing uses `Schema.decodeUnknownResult`. The `TextInput` error is its `status` prop.
- `scripts/lib/herdr.ts` changed on disk during this work (`openCheckout` became `openMainCheckout` and `openLinkedWorktree`, the latter taking the main workspace id). `dev.ts` was rewritten from the earlier reading, so its `checkoutWorkspace` was re-derived against the new API rather than preserved; re-check it against whatever the herdr change intended.

## Sources

- `refs/effect/.agents/AGENTS.md`, `.agents/skills/effect-development/SKILL.md`
- `refs/effect/ai-docs/src/01_effect/01_basics/{index.md,01_effect-gen.ts,02_effect-fn.ts,10_creating-effects.ts}`
- `refs/effect/ai-docs/src/01_effect/02_schema/{index.md,10_schema-basics.ts}`
- `refs/effect/ai-docs/src/01_effect/04_errors/{01_error-handling.ts,10_catch-tags.ts,20_reason-errors.ts}`
- `refs/effect/ai-docs/src/10_predicate/{index.md,01_basics.ts}`, `70_cli/10_basics.ts`, `60_child-process/10_working-with-child-processes.ts`
- `refs/effect/packages/effect/SCHEMA.md`: Strings (line 296), Template literal parser (452), Filter error messages (2562), Branding (2810), Constructors in composed schemas (2982), Schema composition (3408)
- `refs/effect/packages/effect/src/Schema.ts:127-135` (`MakeOptions`), `:195-267` (`make` / `makeOption` / `makeEffect`), `:1172` (`SchemaError`), `:1295-1340` (`toStandardSchemaV1`), `:7678` (`Int`), `:8842` (`NonEmptyString`), `:9884` (`NumberFromString`), `:9969-9995` (`Trimmed`, `Trim`)
- `refs/effect/packages/effect/src/rpc/RpcClient.ts:332,346`, `rpc/RpcServer.ts:790-802`, `rpc/Rpc.ts:964-970`, `rpc/RpcClientError.ts:41-60`
- `refs/effect/packages/effect/src/Match.ts` (`valueTags`, `tags`, `exhaustive`), `Predicate.ts` (`isError`, `isTagged`), `reactivity/AsyncResult.ts:609` (`match`), `Effect.ts:1637` (`try`), `:4563` (`timeout`), `:7673` (`repeat`), `Config.ts` (`Port`, `schema`), `ConfigProvider.ts:1045` (`fromDotEnvContents`), `:1200-1210` (`fromDotEnv`)
- `refs/effect-tanstack-start/src/api/{todo-schema.ts,domain-rpc.ts}`, `src/routes/-index/{create-todo-form.tsx,atoms.tsx}`
- Probe: `node --experimental-strip-types` against the installed `effect@4.0.1`, results in §2.2 and §2.4
