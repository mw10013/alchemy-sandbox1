# Dev-server console capture with s6-log

Research date: 2026-10-08.

## Recommendation

Use the installed `s6-log` to capture combined server stdout/stderr into rotating,
searchable text files while forwarding the same lines to the terminal. No `tee`,
s6 supervisor, daemon, or root privileges are needed.

Adopt the sibling Notes research's proposed starting policy: approximately 5 MiB
per file, at most 20 archives, a 100 MiB archive-byte limit, local timestamps in
files only, and history retained across restarts. These are reasonable initial
limits, not a measured requirement or a strict disk quota.

Integration adopted: `pnpm dev` now pipes `alchemy dev --stage dev` through
s6-log into `./logs/dev`, covered by the existing `logs` ignore rule. The underlying
dev command changed from `vp dev` after the original research; integration
preserves that newer command. The logger was tested in temporary directories,
not against the actual development server.

## Findings in this checkout

- Source research: [`../../notes/systems/s6-log-research.md`](../../notes/systems/s6-log-research.md), dated 2026-10-07.
- Originally, `package.json` had `dev: vp dev` and `dev:worker: alchemy dev`.
  At integration time, `dev` was `alchemy dev --stage dev`, and `dev:worker`
  had been removed. The adopted pipeline wraps the current Alchemy command.
- `vite.config.ts` configures port 3000 with `strictPort: true` and a Cloudflare
  runtime plugin. Do not assume the two commands should run together: test them
  separately first, especially for port conflicts.
- `command -v s6-log` returned `/opt/homebrew/bin/s6-log`.
- `brew list --versions s6` returned `s6 2.15.1.0`.
- `.gitignore` already excludes `logs`, including `current` and timestamp-named
  archives beneath it. No additional ignore rule is needed. Use visible `logs/`
  rather than hidden `.log/` so debugging output is easy to discover and browse.
  The existing `*.log` rule alone does not cover these files.

## Adopted command

Run from this project's root in bash or zsh. The `./` prefix on the directory is
significant: an s6-log directory action must begin with `.` or `/`.

Default dev server:

```sh
pnpm dev
```

Equivalent expanded command (do not pipe `pnpm dev` again):

```sh
mkdir -p ./logs/dev
set -o pipefail
NO_COLOR=1 alchemy dev --stage dev 2>&1 |
  s6-log -b -l 65536 n20 s5242880 S104857600 T ./logs/dev 1
```

`2>&1` merges the producer's stderr into stdout **before** the pipe. Without it,
errors could appear in the terminal without being saved. The final `1` is an
s6-log action that forwards selected lines to stdout; it is not an archive count.
`T` applies only to the next action, so files get timestamps and terminal output
does not. Add another `T` before `1` if timestamps are wanted in the terminal too.

`NO_COLOR=1` requests plain output, but is not an ANSI stripper and must be
verified with each CLI. Piping changes the producer's stdout from a TTY to a pipe;
prompts, hotkeys, progress animations, and buffering may change. This captures
only output emitted by the command and its children to these descriptors—not
browser DevTools console output or remote deployment logs automatically.

### Package-script integration

The existing `dev` entry is now wrapped directly. Explicit bash avoids depending
on the package runner's default shell supporting `pipefail`:

```json
{
  "dev": "bash -o pipefail -c 'mkdir -p ./logs/dev && NO_COLOR=1 alchemy dev --stage dev 2>&1 | s6-log -b -l 65536 n20 s5242880 S104857600 T ./logs/dev 1'"
}
```

This is the script entry, not a replacement `package.json`. It invokes Alchemy
directly rather than `pnpm dev`, avoiding recursion. Install s6 first
(`brew install s6` on another Mac); the script does not preflight the executable.

`bash -c` executes the quoted command. `mkdir -p` creates missing directories
and accepts existing ones; `&&` starts the pipeline only if that succeeds.
s6-log creates the final log directory itself, but not missing parents, so
`mkdir -p` handles the complete path on first run.

`pipefail` reports a failing pipeline component rather than just the logger's
status. If multiple components fail, it returns the rightmost failing status;
it does not preserve every status or supervise the process tree.

## Where logs are saved

s6-log has no implicit Homebrew or system-wide destination. Its directory action
chooses the location; relative paths are resolved against the launch directory.
For the commands above:

| Producer | Active file |
| --- | --- |
| `pnpm dev` | `./logs/dev/current` |

Each directory contains:

- `current`: active, append-only log until rotation; history survives clean restarts.
- `@<TAI64N timestamp>.s`: rotated archives; filenames encode rotation time.
- `@<TAI64N timestamp>.u`: unprocessed archives associated with interrupted logging.
- `lock`: ensures one logger owns the directory; do not delete it to bypass locking.
- `state` and potentially transient `previous`, `processed`, or `newstate` files:
  internal rotation/processor bookkeeping, not ordinary log files to search.

One directory per independently running producer is essential. Two concurrent
instances of the same command need distinct paths, such as `logs/dev-instance2`.
Do not delete the directory on startup: that would discard the retained history.

## Evaluation of the Notes settings

| Setting | Meaning and assessment |
| --- | --- |
| `-b` | Stop consuming input while output buffers remain unflushed. Good initial choice to avoid unbounded pending output; slow disks or terminals can backpressure the server. |
| `-l 65536` | Split input lines longer than 65,536 bytes. More generous than the 8,192-byte default, but can break large JSON records. Suitable provisionally for text logs. |
| `n20` | Retain up to 20 archives. Count is not a duration guarantee. |
| `s5242880` | Rotate near 5 MiB. Default rotation tolerance is 2,000 bytes; this is not an exact file-size cap. |
| `S104857600` | Limit archive bytes to 100 MiB, excluding `current`. Works alongside the archive-count limit; either can remove older files. |
| `T` | Local-time timestamp before each saved line. Useful for text; omit for JSON Lines if the application already supplies timestamps. |
| directory followed by `1` | Save and echo through the same logger; no extra `tee` process required. |

Keep archives uncompressed initially so agents can search them directly. Leave
default retry and partial-line timeout settings alone; do not add `-p`, processors,
filters, or time-based rotation without a demonstrated need. The default `R0`
means size-based rotation only. `R<seconds>` is available if time-based archive
boundaries later become useful, but it is not an age-based retention policy.

Nominal storage is around 105 MiB per producer, plus bookkeeping and transient
rotation overhead; two producers roughly double that. At a **stored** rate of
1 MiB/minute this is about 105 minutes of history; at 100 KiB/minute, about
18 hours. Timestamp overhead and actual output volume matter. Measure a normal
session before increasing retention.

For structured JSON logs, omit `T` and evaluate `-l 0` only after measuring maximum
record size: unlimited lines preserve records but can consume excessive memory.
For text logs, keep 64 KiB initially and check long error messages explicitly.

## Local validation

Tests used the installed binary and separate directories under the approved
OpenCode temporary directory. They did not start Vite or Alchemy, write project
logs, or change project configuration.

| Check | Result |
| --- | --- |
| Production logger arguments, two newline-delimited markers | Exit 0; stdout unchanged; `current` contained local-time-prefixed markers. |
| Clean restart into the same directory | Earlier markers remained and the new marker was appended. |
| Real shell stdout/stderr merge, producer exit 7, bash `pipefail` | Both markers appeared in terminal output and `current`; pipeline status was 7. |
| Paced rotation with `n3 s4096 S0`, numbered 197-byte input lines | Three `.s` archives retained, 2,280 bytes each; older archives removed. |
| Paced byte retention with `n20 s4096 S5000` | Two `.s` archives retained, totaling 4,560 bytes: byte limit applied before count limit. |
| Burst input of 1,500 numbered lines with stdout forwarding | All lines echoed unchanged and the final line was saved. |

One useful caution: the initial fast-burst test with `n3 s4096 S9000` left no
archives. A rotation threshold must not be treated as a hard maximum under burst
input; oversized rotated output can be removed by the archive-byte policy.
The paced tests separately established count and byte retention. Real-server
burst behavior at the proposed 5 MiB threshold remains untested.

Remaining validation (integration is adopted; these checks are still untested):

1. Run each actual command through the logger; verify startup, request logs,
   server-side errors, prompt delivery, and any keyboard shortcuts.
2. Confirm `NO_COLOR=1` removes unwanted ANSI output and progress displays.
3. Test Ctrl-C from an interactive terminal. Confirm the server and descendants
   exit, the logger drains, ports are released, and immediate restart works.
   EOF was tested; the full signal/process-tree behavior was not.
4. Test logger startup failure (missing executable or locked directory), producer
   failure, long records, and restart after an interrupted session.
5. Measure stored bytes over a representative session and adjust retention only
   if debugging history disappears too soon.

The plain pipeline is not a process supervisor. In particular, `pipefail` alone
does not guarantee child cleanup. s6-log's own diagnostics go to its stderr,
normally the terminal, not automatically into these files. A failed stdout action
is disabled for the logger's remaining lifetime; a slow terminal can also affect
capture with `-b`. Neither this setup nor terminal display guarantees application
logs were flushed before an abrupt crash or power loss.

## Reading logs

From the repository root:

```sh
tail -n 200 ./logs/dev/current

rg --hidden --no-ignore -n -i -C 3 --glob current --glob '@*.s' --glob '@*.u' \
  'error|exception|failed|EADDRINUSE' ./logs/dev

tail -F ./logs/dev/current
```

`--no-ignore` allows this explicitly scoped search to read the ignored logs.
Prefer specific error strings or request IDs and bounded excerpts; do not load
whole multi-megabyte files into agent context. `tail -F` follows the filename
across rotation but runs indefinitely and is not a lossless capture mechanism.
Search results spanning files are not necessarily chronological, and rotation
can split a stack trace across adjacent files.

Logs can contain credentials, request payloads, or personal data. Keep them out
of Git, redact at the application, and review excerpts before sharing them.

## Sources

- [Sibling Notes research](../../notes/systems/s6-log-research.md): initial proposal and previous installation/smoke-test record.
- [Official s6-log manual](https://www.skarnet.org/software/s6/s6-log.html): options, directory layout, actions, retention, timestamps, and signals; checked 2026-10-08.
- [s6 overview](https://www.skarnet.org/software/s6/): independent logging and supervision tools.
- [Homebrew s6 formula](https://formulae.brew.sh/formula/s6): installation reference; installed version verified locally rather than inferred from the formula.
- Local `package.json`, `vite.config.ts`, `.gitignore`, and temporary-directory tests described above.
