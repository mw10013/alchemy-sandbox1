# Research: why the tests feel slow, and what to cut

Research date: 2026-10-11.
Status: decisions in [§6](#6-decisions) accepted in Plannotator and applied on `main` on 2026-10-11, uncommitted: five tests removed or folded, `TestBackend` drops `Info` logs, the `test` script unchanged.
Versions: Vite+ `1.1.0` (Vitest `5.0.3`), Effect `4.0.1`, Alchemy `2.0.0-beta.81`, Node `24.21.0`.
Background: [vitest-effect-alchemy-testing-research.md](./vitest-effect-alchemy-testing-research.md) (the setup under review).

## 1. Summary

The whole suite takes about 6 seconds wall clock, and the unit tier alone takes about 2. Neither number is slow in absolute terms, so the first question is which run felt slow ([Q1](#6-questions-with-recommendations)). Three things are plausible:

1. The earlier session's `destroy(Stack)` hang, which sat at the 120 s hook timeout. It is already removed; the stack is never destroyed now.
2. `vp test` without `run` is watch mode, and with both projects selected every save re-plans the stack and re-runs the integ file (about 4 s per save on top of the unit tier).
3. `vp run test` runs both projects, so the quick feedback loop pays for the integ tier every time.

Of the 6 seconds, two costs dominate and both are structural to the integ tier: the Worker bundle and workerd boot on the first request (2.5 s), and importing `alchemy/Cloudflare` (about 1 s). The unit tier's cost is almost entirely module import, led by `@alchemy.run/better-auth` and `alchemy`.

The suite is small and mostly well targeted. Four tests are redundant and one schema case is tautological ([§4](#4-redundant-and-tautological-tests)). Removing them changes maintenance, not speed.

## 2. Measurements

All runs on a warm machine, `pnpm` store populated, stack already deployed unless noted.

| Run                                              | Wall clock | Where it goes                        |
| ------------------------------------------------ | ---------- | ------------------------------------ |
| `vp run test` (both projects, 3 files, 23 tests) | 6.3 s      | tests 57 %, import 41 %              |
| `vp test run --project unit` (2 files, 21 tests) | 2.1 s      | import 93 %, tests 3 %               |
| `src/api/backend.test.ts` alone (11 tests)       | 0.2 s      | import 80 %                          |
| `src/backend/auth.test.ts` alone (10 tests)      | 1.4 s      | import 92 %, tests 4 %               |
| `vp test run --project integ` (1 file, 2 tests)  | 5.9 s      | tests 74 %, import 24 %              |
| integ against a fresh stage (cold deploy)        | 5.8 s      | plan and create 0.9 s, then as above |

Inside the integ file:

| Step                                                  | Time    |
| ----------------------------------------------------- | ------- |
| Plan and no-op redeploy of the reused stack           | 14 ms   |
| Cold deploy (D1 create, Better Auth migration Action) | 917 ms  |
| First request: bundle the Worker and boot workerd     | 2504 ms |
| First test, net of the boot                           | ~0 ms   |
| Second test (`Me` without a session)                  | 10 ms   |

Module import cost in a bare Node process, which is the floor Vitest's import phase sits on:

| Module                     | Import |
| -------------------------- | ------ |
| `effect/Effect`            | 28 ms  |
| `better-auth`              | 180 ms |
| `alchemy`                  | 199 ms |
| `alchemy/Test/Vitest`      | 301 ms |
| `@alchemy.run/better-auth` | 363 ms |
| `alchemy/Cloudflare`       | 964 ms |

Conclusions from the numbers:

- The cold deploy is cheap (under a second). Reusing the stack is not what makes the integ tier fast; the Worker boot is the same either way.
- The 2.5 s workerd boot happens lazily on the first HTTP request, which is why the first integ test reports 2.3 to 2.5 s and the second reports 10 ms. It is the bundle plus process start, and it recurs on every run because the harness's sidecar dies with the test process.
- The unit auth file imports `RuntimeContext` from the `alchemy` root and `Memory` from `@alchemy.run/better-auth`. Those two, plus `better-auth` itself, are most of its 1.3 s. `@alchemy.run/better-auth` exposes only `.` and `./*`, so there is no lighter subpath to reach for without checking what `./*` resolves to.
- The Vitest process itself, with the `mode === "test"` plugin skip in `vite.config.ts`, costs well under a second. The config is already right about not loading the Cloudflare, TanStack Start and React plugins for tests.

## 3. What is structural and what is not

Structural, not worth fighting now:

- **The workerd boot (2.5 s).** The only way to avoid it per run is to not boot workerd per run: either point the integ test at an already running `alchemy dev` Backend, or keep a sidecar alive across runs. Both couple the test to external process state and the harness does not offer the second. Leave it.
- **`alchemy/Cloudflare` import (1 s).** It is the provider set; the integ tier needs it.

Not structural:

- **Running the integ tier on every `vp run test`.** The script runs both projects. Making `test` unit-only and keeping `test:integ` for an explicit run drops the default loop from 6.3 s to about 2 s and keeps watch mode from redeploying on each save.
- **Watch mode scope.** `vp test --project unit` is the watch loop to use while writing code. Nothing in the config enforces that; a note in `package.json` scripts does.
- **Log noise.** Both tiers print the Backend's `INFO` lines (`magic link (dev inline)`, `sign-in requested for a non-member`) into the test output. That is not time, but it makes a 2 s run read as a busy one. The unit tier can provide a quiet `Logger` in `TestBackend`; the integ Worker's log goes to `.alchemy/log/<stage>/Backend` and is also echoed, which is harness behaviour.
- **Unit import cost (1.3 s).** Could be trimmed by importing `RuntimeContext` from a narrower path if one exists, and by checking what the `alchemy` root pulls in. Probably 0.3 to 0.5 s of saving for an afternoon of digging. Not now.

## 4. Redundant and tautological tests

`src/backend/auth.test.ts` (10 tests):

| Test                                 | Verdict   | Why                                                                                                                                                                                                                                                 |
| ------------------------------------ | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the link lands on the requested path | Remove    | `signIn` already asserts the redirect `pathname` on every call; this test adds only that the `/admin/members` literal round-trips, which `ListMembers needs an admin` also exercises by signing in as admin.                                        |
| a new user takes the member's role   | Fold      | Identical to the first test with `admin` in place of `member`. Fold into the first test as an `each` over `[member, "user"], [admin, "admin"]`, or into `ListMembers needs an admin`, which already signs in as admin and could assert `Me().role`. |
| Me without a session is Unauthorized | Keep here | Cheap and the only test of the `CurrentUser` middleware's failure path in-process.                                                                                                                                                                  |
| the remaining seven                  | Keep      | Each proves one rule: invite list enforced at request and at verify, no mail for a stranger, sign-out, admin guard, mail delivery shape, rate limit short-circuits mail.                                                                            |

`src/api/backend.test.ts` (11 cases):

| Test                                | Verdict | Why                                                                                                                                                          |
| ----------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Email normalizes `" A@a.com "`      | Keep    | Proves the decode order: trim and lowercase run before the `isLowercased` check, which is the one non-obvious thing in `EmailFromInput`.                     |
| Email normalizes `"M1@M.COM"`       | Remove  | Tautological: it asserts that `toLowerCase` lowercases. The first case already covers lowercase.                                                             |
| Email rejects 4 cases               | Trim    | `""` and `"not-an-email"` both test "no `@`". Keep `"not-an-email"`, `"a@b"` (no dot) and `"a b@c.com"` (whitespace); drop `""`.                             |
| ReturnPath accepts `/admin/members` | Keep    | One positive case for the regex.                                                                                                                             |
| ReturnPath rejects 4 cases          | Keep    | Each is a distinct open-redirect vector (`//host`, `/\host`, absolute URL, relative). This is the security rule in the schema; four cases is the right size. |

`test/integ/auth.test.ts` (2 tests):

| Test                                       | Verdict | Why                                                                                                                                                                                                     |
| ------------------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a seeded member signs in with a magic link | Keep    | The one test that proves the deployed shape: migrations, seed, D1 adapter, `AUTH_ORIGIN` binding, cookie over HTTP, RPC through the Worker.                                                             |
| Me without a session is Unauthorized       | Remove  | Duplicates the unit test and proves nothing deploy-specific that the first test does not (the first test already shows RPC reaches the Worker). 10 ms, but it is a second thing to read and keep green. |

Net: 23 tests become 19 (the folded role test runs as two cases). Time saved is nil; what is saved is three near-duplicate descriptions to read when one fails.

## 5. Are we over-testing authentication?

No. The unit tier covers the six rules the integration plan called out and nothing else; the schema tier covers the two input types that reach the auth flow; the integ tier covers one happy path. There is no test of the Website routes, the React forms, or the RPC proxy, which is right for where the project is.

The one area to watch is the integ tier. It exists to prove the deployed wiring. As long as it stays at one or two tests and is run on demand rather than on every save, it earns its 6 s. If it grows a test per rule it will duplicate the unit tier at thirty times the cost.

## 6. Decisions

Reviewed in Plannotator on 2026-10-11. Settled:

| #   | Question                                                                                                          | Decision                                                                                                   |
| --- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Q1  | Which run felt slow?                                                                                              | Not pursued. The 6 s full run is the reference point from here on.                                         |
| Q3  | Remove the four redundant tests and the one tautological schema case ([§4](#4-redundant-and-tautological-tests))? | Yes, all five. Fold `a new user takes the member's role` into the first test as an `each` over both roles. |
| Q4  | Keep the integ tier?                                                                                              | Keep it and expect to add to it.                                                                           |
| Q6  | Chase the unit import cost?                                                                                       | Not now. Revisit after a harness bump.                                                                     |
| Q7  | Drop `pool: "forks"` and `fileParallelism: false` on the integ project?                                           | No, keep them.                                                                                             |

Two points came back open and are answered below.

### Q2. One command for everything, or unit by default?

The reviewer's position: one command should run type check, lint and all tests, without having to think about unit versus integration. Make the tests fast and be done.

Agreed, and the numbers support it. The full suite is 6 s and `vp check` (format, lint, type-aware lint) is 1.4 s, so the whole gate is under 8 s. Splitting the default would save 4 s per run at the cost of a second thing to remember, and a project this size does not need that. The earlier recommendation is withdrawn.

What remains true about the two tiers is only relevant to watch mode: `vp test` without `run` keeps the integ project live and re-plans the stack on every save. Nobody has to use watch mode, and if someone does, `vp test --project unit` is the loop to pick. That is a note for the scripts, not a change to them.

So: `vp run test` stays as it is and runs both projects. `test:unit` and `test:integ` stay as escape hatches. The budget to defend is "the whole suite in under 10 s"; when the integ tier grows past that, revisit, and the first lever is not splitting the command but keeping the integ tier to the deploy-shaped tests only ([§5](#5-are-we-over-testing-authentication)).

### Q5. A quiet logger in the unit tier, from first principles

The question is whether the `TestBackend` layer should silence the Backend's `INFO` logs, and whether that is right rather than merely tidy.

From first principles. A unit test owns every effect of the code under test: that is what makes it a unit test rather than a run of the program. `TestBackend` already does this for mail (`Mailer.layerTest` captures into a `Ref`), the invite list (`Members.layerTest`) and the rate limiter (`SignInLimiter.layerTest`). Logging is the one remaining effect the test does not own: `Effect.logInfo` in `makeAuth` and the handlers writes to the process's stdout through the default logger. So the test currently leaks one side effect to the terminal, which is an inconsistency in the test's own design, not a cosmetic one.

What the leak costs. Log lines in test output are read by nobody when tests pass and by the wrong person when they fail: the assertion message is what says why a test failed, and the log lines above it are from other tests in the same file (Vitest interleaves them). Worse, a reader who sees twenty lines of `INFO` for a 2 s run reads the run as heavy, which is half of why this research exists.

What the fix is not. It is not asserting on logs. Logs are an operational channel for the running Worker, and a test that asserts on a log line couples itself to wording that should be free to change. The inline-link flow does not need it either: `takeInlineLink` already returns the link as a value, which is the right channel for a test.

The fix. Provide `References.MinimumLogLevel` at `"Warn"` in `TestBackend`, so `INFO` is dropped and anything the Backend considers a warning or error still prints, which is exactly the signal a failing test wants. That is one `Layer.succeed` line in the test file, and it is the idiom Effect's own guide uses (`refs/effect/ai-docs/src/08_observability/10_logging.ts`, `WarnAndAbove`). Leave the integ Worker alone: there the logs come from a real workerd process via the harness, and the file under `.alchemy/log/<stage>/Backend` is how that process is debugged.

So yes, and for a structural reason: the test should own the logger the same way it owns the mailer.
