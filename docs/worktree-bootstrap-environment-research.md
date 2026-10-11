# Worktree bootstrap and dev startup environment research

Research date: 2026-10-10. Scope: `wt-01` setup, package installation, dev-server startup, and Herdr visibility in the T3 Code execution environment.

**Review update:** the selected direction is a **project-specific setup action registered manually by the user in T3**, paired with explicit `wt-NN` launches. Shared actions are excluded by user preference. The [manual setup details](#manual-project-action-setup) explain the verified UI fields; the runbook now gives concise instructions and assumes the action exists before creation. The action runs through T3's host terminal and gates new-worktree agent startup. Auto remains appropriate for subsequent agent work. No action has been registered or live-tested by this investigation.

## Summary

The worktree was created and initialized successfully. The first install and first dev-server start ran under a restricted `workspace-write` execution profile. The dev-server log confirms a sandbox permission error while Alchemy tried to change the mode of its user profile directory. A later escalated start opened the Herdr workspace and reported the site ready on port 3901.

The evidence strongly supports the filesystem sandbox as the cause of the Alchemy `chmod` failure. The registry DNS problem is consistent with restricted network access, but the successful install reused the local package cache and therefore did not prove registry access was restored. Herdr's initial detection failure is also not fully diagnosed because the helper discards the underlying error.

No repository code or configuration was changed as part of this investigation. This note records the evidence and follow-up questions for later work.

## Observed execution permissions

The execution context reported a managed `workspace-write` sandbox. Writable roots were the current worktree, `/private/tmp`, and the session temp directory. Network access was restricted. The path `/Users/mw/.alchemy/profiles/default` is outside those writable roots.

The command tool can request an escalated execution for a particular command. The later `vp run dev:start` invocation used that route and succeeded. This is different from modifying the persistent sandbox profile: the execution metadata remained managed, and no persistent permission configuration was changed.

## Timeline and evidence

### 1. Worktree setup

- `vp install --frozen-lockfile` initially emitted fetch errors for many packages from `registry.npmjs.org`, with DNS lookup failures (`nodename nor servname provided, or not known`).
- The retry with escalated execution completed successfully: 465 packages were reused from `/Users/mw/Library/pnpm/store/v11`, with **0 packages downloaded**.
- `vp run worktree:init` reported that it copied `.env` from the main checkout, set `WEBSITE_PORT=3901`, linked `refs`, and prepared `wt-01`.
- `git worktree list --porcelain` showed both the main checkout and `wt-01` on branch `wt-01`. The Git worktree existed even while it was missing from the Herdr view.

### 2. First dev-server start

- The initial, non-escalated `vp run dev:start` printed `started in the background (pid 66829)`. This was a launch message, not a readiness result.
- `logs/dev/current` records the error at 18:01:28:

  ```text
  EPERM: operation not permitted, chmod '/Users/mw/.alchemy/profiles/default'
  ```

- The start command later failed its 180-second readiness wait with `no answer on port 3901`.
- Alchemy's installed `ProfileStoreLive` implementation unconditionally creates and chmods the default profile directory during profile initialization (`node_modules/alchemy/src/Auth/Profile.ts`, around lines 251–254). The directory was reported as owned by `mw` with mode `0700`; the failure is consistent with the sandbox denying access to an out-of-root path, rather than an ownership or mode problem.
- `scripts/dev.ts` emits the background-start message immediately after spawning the process, then waits for the server to answer. The message was easy to mistake for success before the final readiness result arrived.

### 3. Retry and successful start

- An escalated retry first reported that another dev command held `logs/dev.lock` (PID 66787). The initial command was still in its readiness-wait period; the lock prevented concurrent starts.
- A subsequent status check reported no server listening or answering on port 3901. The lock holder later exited.
- The next escalated `vp run dev:start` opened the Herdr workspace `wt-01`, started the `dev` tab in pane `wD:p2`, and reported `server answering (24.7s)`.
- `logs/dev/current` records the successful Alchemy deployment at 18:04:58, including `Website` starting and becoming ready at `http://localhost:3901`.
- A later `vp run dev:status` reported `healthy: yes`, with port 3901 listening and answering in Herdr pane `wD:p2`.

## Findings by issue

### Registry DNS

**Confirmed:** the initial sandboxed install could not resolve `registry.npmjs.org`. A sandboxed `dns.lookup("registry.npmjs.org")` also reproduced `ENOTFOUND` during follow-up investigation.

**Not confirmed:** the escalated installation did not demonstrate that registry access worked. It reused all 465 packages from the local pnpm store and downloaded nothing. The DNS failure is consistent with the execution environment's restricted network policy, but it has not been compared with a DNS lookup outside that sandbox.

### Alchemy profile permissions

**Confirmed:** the first dev attempt failed at `chmod` on `/Users/mw/.alchemy/profiles/default`; the profile directory is outside the reported writable roots. A later escalated start passed profile initialization and reached a healthy server.

**Strong inference:** the sandbox boundary caused the `EPERM`. No explicit log line says “chmod succeeded,” but the same Alchemy startup path ran through profile initialization and continued to a successful deployment under escalation.

### Herdr visibility

**Confirmed:** the first launch used the detached-background path and did not open a `wt-01` Herdr workspace. The later escalated start opened that workspace and its `dev` tab.

**Unresolved:** `scripts/lib/herdr.ts` defines `running` by calling `herdr status server --json`, but converts any command or schema error into `false` (`Effect.orElseSucceed(() => false)`). `scripts/dev.ts` therefore cannot distinguish a missing/unavailable Herdr server from a denied socket request or an unexpected response. The initial raw Herdr error was not retained, so the specific reason for fallback is unknown. The shell's missing `HERDR_ENV` was not itself proof that Herdr was unavailable; this script is designed to query the Herdr server instead.

## Follow-up options

1. **Execution policy:** decide whether this project's runner should receive outbound network access and write access to `/Users/mw/.alchemy/profiles` (or a narrower path) for routine setup and dev startup. If not, request escalated execution only for commands that need those capabilities.
2. **Verify network cause:** compare DNS resolution for `registry.npmjs.org` inside the restricted command sandbox and in an approved unsandboxed context. Do not infer successful registry access from a cache-only install.
3. **Diagnose Herdr fallback:** preserve and report the raw `herdr status server --json` failure instead of silently mapping every failure to `false`.
4. **Improve startup reporting:** consider wording the immediate output as “launching” and reserve “started” for after the readiness check succeeds. On timeout, include the profile error or a concise pointer to `vp run dev:logs`.
5. **Use final readiness as success criteria:** after future starts, wait for `server answering` and confirm with `vp run dev:status`; do not treat the initial background PID message as success.

## Local references

- `scripts/dev.ts`: dev command locking, Herdr/background selection, background launch output, and HTTP readiness wait.
- `scripts/lib/herdr.ts`: Herdr status query and current failure-to-`false` behavior.
- `scripts/worktree.ts`: worktree initialization.
- `logs/dev/current`: initial profile failure and later successful startup (ignored runtime log; not committed by this note).
- `docs/worktrees-runbook.md`: worktree bootstrap and verification procedures.
- `docs/t3-code-worktrees-research.md`: T3/Herdr worktree behavior research.

## Independent review: Codex CLI permissions

Reviewed on 2026-10-10 using installed `codex-cli 0.162.0`, the current runtime logs, installed Alchemy source, and official OpenAI documentation. No persistent permission settings or application code were changed. The server was not restarted and packages were not reinstalled.

### Assessment

The central diagnosis is sound, but the original report stopped short of establishing causality for network and Herdr access or supplying a tested CLI configuration. Running Codex locally in a CLI does not give its spawned commands the terminal user's unrestricted access. On macOS, Codex enforces its command sandbox with Seatbelt. Approvals and automatic review control exceptions; they do not themselves widen that sandbox. [OpenAI sandbox documentation](https://learn.chatgpt.com/docs/sandboxing).

The problem is a mismatch between the project's runtime dependencies and the selected execution permissions. This is not evidence that the Alchemy directory needs different Unix ownership or mode, or that Git worktree creation failed.

### Controlled probes

The same Python probe was run through the current restricted command tool and through approved unsandboxed execution. It attempted `chmod` with the directory's **existing** mode (0700), resolved `registry.npmjs.org`, issued an HTTPS HEAD request to that registry, and ran `herdr status server --json`. It did not read credential files, download packages, or control Herdr panes.

- **Current sandbox:** same-mode `chmod` failed with `EPERM`; registry DNS failed with `nodename nor servname provided, or not known`; HTTPS failed with curl exit 6; Herdr exited 1 with `PermissionDenied` / `Operation not permitted`.
- **Unsandboxed:** same-mode `chmod` succeeded; registry DNS resolved; HTTPS returned HTTP 200; Herdr returned `running: true`, `compatible: true`, and socket `/Users/mw/.config/herdr/herdr.sock`.
- **Fresh Codex workspace-write sandbox, Alchemy writable root only:** `chmod` succeeded; DNS, HTTPS, and Herdr still failed.
- **Fresh Codex workspace-write sandbox, network access only:** DNS, HTTPS, and Herdr succeeded; Alchemy `chmod` still failed.
- **Fresh Codex workspace-write sandbox, both permissions:** all four probes succeeded.

The two single-permission experiments also attempted same-mode `chmod` on the unrelated `/Users/mw/.config` directory. Both denied it, confirming that filesystem restrictions remained enforced. The profile directory and process both had UID 501.

These experiments establish separate filesystem and network causes in this environment. In this installed macOS implementation, enabling network access also permits the tested Herdr Unix socket connection; granting write access to Herdr's configuration directory is unnecessary for that connection. The original startup's raw Herdr error was not captured, so its exact historical error remains unproven, but the current failure is directly reproducible.

### Optional standalone CLI configuration

The following is an alternative for a **new standalone Codex CLI session**, not a change required for the existing T3 Auto session. The probes tested equivalent sandbox permissions; they did not test launching a new interactive session or T3's adoption of this configuration:

```sh
codex -C /Users/mw/.t3/worktrees/alchemy-sandbox1/wt-01 \
  --sandbox workspace-write \
  --ask-for-approval on-request \
  --add-dir /Users/mw/.alchemy \
  -c sandbox_workspace_write.network_access=true
```

The installed CLI advertises `--add-dir`; OpenAI documents it as granting additional writable directories, and documents `sandbox_workspace_write.network_access` as allowing outbound command network access. [CLI reference](https://learn.chatgpt.com/docs/developer-commands?surface=cli), [configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

The equivalent filesystem/network settings were tested using:

```sh
codex sandbox \
  -c 'sandbox_mode="workspace-write"' \
  -c 'sandbox_workspace_write.network_access=true' \
  -c 'sandbox_workspace_write.writable_roots=["/Users/mw/.alchemy"]' \
  -- python3 /private/tmp/worktree-permission-probe.py
```

The probe was a temporary diagnostic, not a repository script. This validates the specific access failures, not a complete clean-cache install or fresh deployment. Installation may additionally need write access to the pnpm store (`/Users/mw/Library/pnpm/store/v11` in the initial install), and tool caches discovered during an end-to-end run.

`~/.alchemy/profiles/default` is enough for the first failing `chmod`, but is not a complete Alchemy permission contract. `Auth/Paths.ts` locates profiles, `profiles.json`, and credentials under `~/.alchemy`; `Auth/Lock.ts` also writes `~/.alchemy/lock`. Granting the Alchemy root covers those paths. Alternatively, supported `ALCHEMY_HOME` relocates this state into a writable project-specific directory. That alternative needs an authentication and ignore-file plan because it changes which profile/credentials are used; `ALCHEMY_PROFILE` merely selects a name and does not relocate the root.

Network access here is a broad command-network grant, not an npm-only allowlist. A restricted proxy/domain policy would require a separate design covering registry, Cloudflare, local listeners, and the Herdr socket.

### Persistence and T3-hosted sessions

For reuse, put the settings in a project-scoped Codex configuration or a dedicated user profile after choosing the intended trust boundary. CLI overrides take precedence over project/profile/user configuration; project config loads only for trusted projects, and enforced requirements can constrain overrides. [Configuration precedence](https://learn.chatgpt.com/docs/config-file/config-basic).

Inspection found no explicit sandbox, approval, permission-profile, or workspace-write settings in the relevant keys of `~/.codex/config.toml`, no worktree `.codex/config.toml`, and no `/etc/codex/requirements.toml` or legacy `/etc/codex/managed_config.toml`. This does **not** establish the original launch flags or exclude other policy sources. The runtime label “managed” alone does not establish an organization policy.

For a T3-hosted Codex session, a command launched with new CLI flags does not change this already-running thread's policy. The subsequent source investigation below establishes that T3 explicitly supplies the sandbox and approval policy at turn start, including the Auto defaults. Editing user-level CLI defaults is therefore not a reliable way to provision T3 bootstrap access.

### User clarification: T3 Auto is already enabled

The user supplied a screenshot of T3's permissions menu with **Auto** selected. Its description is “Supported providers approve routine actions; others still ask.” The screenshot also lists Supervised, Auto-accept edits, and Full access. This is direct evidence of the selected UI mode, not of T3's internal provider mapping.

The actual instructions for this Codex session report `sandbox_mode = workspace-write`, restricted network access, and `approvals_reviewer = auto_review`. The selected Auto UI mode is consistent with this runtime configuration. OpenAI documents automatic review as retaining the sandbox while routing eligible approval requests to a reviewer instead of prompting the user. [Sandbox and automatic review](https://learn.chatgpt.com/docs/sandboxing).

**Auto does not mean every command starts with unrestricted access.** An ordinary command-tool request still uses the restricted sandbox. To run a command beyond that boundary, the agent must explicitly request escalation; the reviewer can approve or reject it. This explains why an ordinary bootstrap command can fail even with Auto selected, and a subsequent escalation request can succeed without a user-visible prompt. There is no evidence here that the user's Auto selection is broken or that they need to switch it to Full access.

In the review experiments, “approved escalation” specifically meant **automatic approval**, not manual approval from the user. The command tool was called with `sandbox_permissions = require_escalated` and a diagnostic justification. Those requests were accepted and the commands ran outside the normal sandbox. No persistent permission setting was changed. Future reports should state who approved an escalation explicitly.

The execution sequence was:

1. Ordinary command-tool execution under this session's existing sandbox: access checks failed.
2. A command-tool escalation request accepted by automatic review: the same checks ran outside the normal sandbox and passed.
3. Another accepted escalation request launched `codex sandbox` with explicit filesystem/network settings: the checks ran inside that new sandbox and passed under its selected permissions.

Step 3 was a diagnostic experiment, not part of the proposed development workflow. The outer escalation allowed launching the new sandbox without retaining the original restrictions. Launching a child sandbox from an ordinary restricted command cannot grant that child access denied by the parent sandbox.

The operational issue is that bootstrap/startup requires access beyond the ordinary command boundary. The original report already records an escalated startup that succeeded. The present review confirms an automatic escalation path for diagnostics; it does not guarantee that every future install or startup request will be approved, or establish the exact configuration of the historical session. Requiring an LLM to infer a provider-specific retry procedure is a fragile workaround, not a repeatable bootstrap design.

### Design correction: keep the runbook provider-agnostic

The user requires an LLM-agnostic runbook. The recommendation to teach agents a Codex-specific escalation retry put the responsibility in the wrong place. The runbook should state the commands, required environment capabilities, and verifiable outcomes. The execution integration should translate those requirements into each provider's permissions, approval requests, or a configured host-side task runner. Policy may still require approval or deny access; the runbook should not depend on the model discovering a particular tool argument after a failure.

The generic execution requirements are worktree/log/state and package-cache writes, main-checkout configuration/reference reads, Alchemy authentication-state access, registry/provider network access, local dev listeners and readiness checks, and Herdr socket access when Herdr placement is required. The local runbook now records these prerequisites without naming an LLM or prescribing permission flags.

The intended outcome is that the same documented commands either run in a suitably provisioned environment or report a specific unmet prerequisite. A repository preflight can diagnose missing access, but cannot grant permissions denied by an enclosing sandbox. Likewise, ordinary shell scripts cannot implement Codex command-tool escalation themselves. T3/provider configuration or an explicitly configured host task runner must provide the access. Which mechanism T3 supports for this contract is still unverified; this documentation change does not implement it.

### Recommended next steps

1. Keep the runbook provider-agnostic. Use its execution prerequisites as the bootstrap contract. Leave T3 Auto selected during investigation; the screenshot and tests do not establish that it is defective. No Mac ownership/mode change is indicated by the evidence. Keep provider-specific test details in this research note.
2. Use the T3 project setup action identified below to run bootstrap independently of the selected provider. Keep provider-specific escalation as a temporary workaround. Do not change user-wide CLI defaults to solve host setup.
3. Verify the chosen integration with the unchanged bootstrap/startup commands, then confirm `vp run dev:status` and required Herdr placement. Record actual execution permissions and raw access errors. An existing server can be adopted, so adoption is not evidence of a successful fresh startup. Before calling the workflow provider-agnostic in practice, repeat this verification with each provider intended for use.
4. Improve repository diagnostics separately: preserve Herdr status errors and distinguish “unavailable” from “permission denied”; mark the early PID output as “launched” and readiness as the successful outcome. Consider an early capability preflight. Preserve Effect Schema/TaggedError/Match conventions.
5. Treat Herdr as a host-side process launcher. When `dev:start` sends a command to an already-running Herdr server, the dev process runs in that server's pane, not as a child inheriting Codex's sandbox. Successful Herdr startup therefore does not prove the whole dev process ran inside Codex's sandbox.

One historical detail should also be corrected or supported with retained output: the initial timeline says both checkouts were on `wt-01`. Current `git worktree list --porcelain` shows main on `main` and this worktree on `wt-01`, the expected layout. The current check cannot reconstruct the earlier branch state.

## T3 source investigation: a common bootstrap execution path

Investigated on 2026-10-10 at source revision `50647de0143e68fde051eb1a0ccf4fe63f9947b2` in `/private/tmp/t3code-research`, the revision used by the prior T3 research. The installed app's Info.plist confirms Nightly `0.0.46-nightly.20261010.2922`, matching that research's recorded installation. This is source inspection and live configuration inspection, not a completed live setup-action test or independent binary/source equivalence verification.

### What T3 actually supplies to providers

The live `orchestrator_capabilities` response confirms this thread's runtime mode is `auto` and provider is `codex`. Enabled provider instances include Codex, Claude, and OpenCode. The selected keys of `userdata/settings.json` show `defaultRuntimeMode: auto` and no project override for this project.

In `CodexAdapterV2.ts:661–698`, T3 maps Auto to `approvalPolicy: on-request`, `approvalsReviewer: auto_review`, and `sandboxPolicy: { type: workspaceWrite }`. It does not add the Alchemy root or enable networking in that default. At lines 718–726 and 772–790 it selects runtime-policy overrides or those defaults and sends the policy explicitly to Codex at turn start. This explains the observed ordinary-command restrictions even with Auto selected. [Pinned Codex adapter source](https://github.com/pingdotgg/t3code/blob/50647de0143e68fde051eb1a0ccf4fe63f9947b2/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts).

In `ClaudeAdapterV2.ts:1549–1595`, Auto maps to Claude's native `permissionMode: auto`. ACP and OpenCode have their own operation/permission handling in `packages/provider-acp/src/server/clientPolicy.ts` and `packages/provider-opencode/src/server/adapter.ts`. These are different mechanisms, not one shared filesystem/network grant. Matching the UI label is insufficient to make model-issued bootstrap commands run with identical access. [Pinned Claude adapter source](https://github.com/pingdotgg/t3code/blob/50647de0143e68fde051eb1a0ccf4fe63f9947b2/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts).

### The existing provider-independent mechanism

`ProjectSetupScriptRunner.runForThread` selects the registered setup action, opens a T3 terminal at the target checkout, and writes the shell command into it. It does not invoke the selected model's command tool or its approval mechanism. `TerminalManager` launches that shell through the host PTY adapter; `AgentScope` is process/OOM management and leaves the command unchanged on macOS. Thus this path uses T3's host access, subject to OS or any enclosing host restrictions, rather than the selected provider's command sandbox. [Setup runner](https://github.com/pingdotgg/t3code/blob/50647de0143e68fde051eb1a0ccf4fe63f9947b2/apps/server/src/project/ProjectSetupScriptRunner.ts), [terminal manager](https://github.com/pingdotgg/t3code/blob/50647de0143e68fde051eb1a0ccf4fe63f9947b2/apps/server/src/terminal/Manager.ts), [process scope](https://github.com/pingdotgg/t3code/blob/50647de0143e68fde051eb1a0ccf4fe63f9947b2/packages/shared/src/AgentScope.ts).

For a tracked new-worktree launch, `ThreadLaunchService.ts:543–624` observes setup completion. With `async: false`, it waits for completion before releasing provider work; a nonzero or missing exit code fails preparation. With the default `async: true`, the agent can start while setup is running. This gate occurs before provider execution and is independent of the chosen model. [Thread launch service](https://github.com/pingdotgg/t3code/blob/50647de0143e68fde051eb1a0ccf4fe63f9947b2/apps/server/src/orchestration-v2/ThreadLaunchService.ts).

The project list confirms `alchemy-sandbox1` currently has `scripts: []`; the inspected settings have no default actions or project action override. This project currently uses the model-issued bootstrap message instead. The prior `docs/t3-code-worktrees-research.md` explicitly chose “No T3 project actions.” That decision should be revisited: it omitted the built-in mechanism that gives bootstrap a common host execution path.

### Concrete proposed setup action

Register one project action in T3's Project settings, marked as the worktree setup action, with `async: false`. Its command should install dependencies, initialize the linked worktree, start the dev server, and verify status. Keep the subsequent agent message focused on checking/reporting the result, rather than issuing bootstrap itself.

**Naming constraint:** this proposal is for explicit `t3_thread_launch` creation with `workspaceStrategy.branch: "wt-NN"`, as in our runbook. It is not compatible with arbitrary “New worktree” launches: their temporary/generated branch names fail the current initializer. See the naming investigation below. `async: false` does not wait for background branch naming.

The following proposal uses existing commands and guards the main checkout:

```json
{
  "id": "worktree-bootstrap",
  "name": "Bootstrap worktree",
  "icon": "configure",
  "runOnWorktreeCreate": true,
  "async": false,
  "command": "if [ \"$T3CODE_WORKTREE_PATH\" != \"$T3CODE_PROJECT_ROOT\" ]; then vp install --frozen-lockfile && vp run worktree:init && vp run dev:start && vp run dev:status; fi"
}
```

`projectScriptRuntimeEnv` supplies `T3CODE_PROJECT_ROOT` and `T3CODE_WORKTREE_PATH`. The shell syntax above targets this Mac's POSIX shell. It is provider-agnostic, not cross-platform shell syntax. Existing `worktree:init` enforces the linked-checkout and `wt-NN` branch rules. A dedicated repository bootstrap command can encapsulate the sequence and guard later if desired.

Important configuration and lifecycle details:

- A `t3.json` action is an importable declaration, not proof that it is registered. `docs/user/project-settings.md` documents importing it into Project actions. Register the action or import it and verify the effective action list. A file declaration omits the registered action's `id`.
- `setupProjectScript` selects the first action with `runOnWorktreeCreate`; use one action for the full sequence.
- The launcher calls the setup runner with `cwd = worktreePath ?? project.workspaceRoot`. Despite the flag's name, the inspected launcher can invoke the action for root/existing-checkout launches too. Preserve the main-checkout guard and idempotency.
- Completion observation and the strict startup gate are established here for tracked **new-worktree** launches. Do not assume every existing-checkout or PR-opening path has the same completion gate; those paths require separate verification if included in the workflow.
- The action is a configured host command, executed outside the model's command sandbox. Keep its command explicit and reviewed. Auto continues to govern subsequent agent work; the action does not expand that agent's sandbox.
- Host execution removes provider-specific permission differences; it does not create missing host credentials, repair network outages, or override OS restrictions.

### Recommended implementation and verification

Adopt the setup action as the bootstrap owner. Keep the runbook's commands and success criteria provider-neutral, and retain Auto for agent work. Replace the old “bootstrap as the first model message” recommendation once the action is registered and verified.

Before claiming the solution works end to end, test a new `wt-NN` launch through T3: confirm setup terminal cwd and environment, registry HTTPS and Herdr access, successful install/init/start/status, correct port and Herdr placement, and that provider work begins only after setup exits successfully. Verify that a setup failure prevents agent release. Repeat the launch verification with the intended provider instances; the common host path is established by source, but no cross-provider live test was run in this investigation.

No project settings, setup action, new thread/worktree, or permission mode were changed by this research. The proposed action is concrete and reviewable; registration and live lifecycle verification are the remaining implementation work.

## Naming investigation: explicit branches versus automatic renaming

Investigated at the same pinned T3 revision, `50647de0143e68fde051eb1a0ccf4fe63f9947b2`. No branches were created or renamed for this investigation. Findings below come from source, existing upstream test cases (read, not executed), and the current Git worktree inventory.

### The two creation paths behave differently

**Explicit branch:** `ThreadLaunchService.ts:366–376` uses `workspaceStrategy.branch` directly when supplied. The Git driver creates the worktree with `git worktree add -b <specified branch> <derived path> <base ref>`. The background rename condition at lines 491–497 requires `isTemporaryWorktreeBranch(branch)`. `wt-01` and other `wt-NN` names do not match that predicate. Thus explicitly passing `branch: "wt-02"` skips automatic naming and renaming in this flow. `title: "wt-02"` alone does not name the branch. [Pinned launch source](https://github.com/pingdotgg/t3code/blob/50647de0143e68fde051eb1a0ccf4fe63f9947b2/apps/server/src/orchestration-v2/ThreadLaunchService.ts).

**Automatic branch:** omitting the branch provisions a temporary `t3/<8 hex>` branch (or `t3-<8 hex>` if a plain `t3` branch blocks that namespace). After checkout and metadata recording, T3 forks branch-name generation and renaming in the background, then immediately proceeds to the setup action. Supplying an explicit name that itself matches a temporary-name form still makes it eligible for this rename. The helper also recognizes legacy temporary `t3code` forms. [Temporary-name helper](https://github.com/pingdotgg/t3code/blob/50647de0143e68fde051eb1a0ccf4fe63f9947b2/packages/shared/src/git.ts).

The existing upstream tests explicitly cover “keeps an explicit branch name instead of generating one” and “renames a temporary t3/<hash> branch off the provisioning critical path.” The latter deliberately holds name generation while the provider run reaches `starting`, demonstrating that naming is not a setup/agent prerequisite. [Naming test cases](https://github.com/pingdotgg/t3code/blob/50647de0143e68fde051eb1a0ccf4fe63f9947b2/apps/server/src/orchestration-v2/ThreadLaunchService.test.ts).

### Folder naming and branch naming are separate

`GitVcsDriverCore.ts:3407–3430` derives the folder at creation from the initial branch, replacing `/` with `-`. With the default location, an explicit `wt-02` produces `~/.t3/worktrees/alchemy-sandbox1/wt-02`; a temporary `t3/abcd1234` produces `.../t3-abcd1234`.

The later `renameBranch` implementation at lines 3869–3890 runs `git branch -m`; it does not move the worktree directory. Thread metadata is updated with the renamed branch and the same path. Therefore an automatically generated final branch name does not imply that the folder takes that name. Generated names can also receive a collision suffix; exact custom names fail on collisions instead. [Git creation and rename implementation](https://github.com/pingdotgg/t3code/blob/50647de0143e68fde051eb1a0ccf4fe63f9947b2/apps/server/src/vcs/GitVcsDriverCore.ts).

### Why a generic setup action conflicts with our naming rules

Our `scripts/lib/worktree.ts` decodes only branches `wt-01` through `wt-99`. `scripts/worktree.ts:75–85` rejects other branches before deriving the port. `scripts/dev.ts` also uses the current branch when opening a linked Herdr workspace.

An automatic T3 launch can therefore fail initialization while on `t3/<hash>`, or after a generated rename to a different name. Even custom naming instructions asking the naming model for `wt-NN` do not make this reliable: setup races the background rename, the generated folder retains its temporary name, and number allocation/collision handling is not our fixed-worktree protocol. Setting the action to `async: false` waits for the action's exit; it does not change the separate rename fiber or its ordering.

This establishes a genuine incompatibility between generic automatic worktrees and the current `wt-NN` initializer. It does **not** prove that a specific historical setup-action proposal was rejected for this reason. The retained prior research says actions were “dropped by choice”; it does not retain an action rejection error. The observed first `wt-01` dev failure remains the logged Alchemy `EPERM`. Current Git inventory still shows main on `main` and this worktree on `wt-01` at the expected folder.

### Recommendation for the fixed-worktree workflow

Keep exact naming through T3's explicit launch API, which is independent of the chosen LLM/provider. Pair that API with the host-side setup action. For each new worktree, select an unused `NN`, explicitly pass `workspaceStrategy.branch: "wt-NN"`, and use `startFromOrigin: false` with local `main`. T3 then creates the correct branch/folder before setup and does not run automatic renaming for that branch.

For example, this is the proposed launch **after** the setup action is registered (not executed by this research):

```json
{
  "title": "wt-02",
  "workspaceStrategy": {
    "type": "worktree",
    "baseRef": "main",
    "branch": "wt-02",
    "startFromOrigin": false
  },
  "message": "Check the setup action result, dev health, port, and Herdr placement; report any failure."
}
```

The branch and folder must be unused at creation. T3/Git should fail on a collision rather than silently choose another numbered worktree. To use an existing fixed worktree, bind to it using `existing_worktree` or the branch picker; do not create it again. Do not rely on the generic New worktree UI or generated branch naming for this protocol.

If supporting generic automatic worktrees becomes a requirement, the repository's identity/port allocation must be redesigned to use stable checkout identity or explicitly assigned metadata rather than a mutable branch name. That is a separate change, not solved by enabling the setup action. The immediate named-launch plus setup-action proposal preserves the stated long-lived `wt-NN` design.

## Manual project action setup

The user selected project-specific setup through the T3 interface. Registration is a one-time manual step on this environment; the agent does not change project settings or create a shared action. The [runbook](worktrees-runbook.md#configure-the-project-action-once) now documents the UI procedure and assumes registration is complete before a named launch.

### Verified interface and saved configuration

The live T3 Code Nightly interface on this Mac was inspected after the user reported that the runbook's Settings/project-selection instructions did not exist. The verified route is: open a thread in **alchemy-sandbox1**, open **Thread details** with the top-right panel toggle, then choose **Workspace → Add project script**. This opens **Add Action**, whose description says actions are project-scoped. The thread supplies the project context; no project selector in Settings is required. The dialog was opened and cancelled without saving.

The earlier Settings route was inferred from source and was not verified in the installed interface; it has been removed from the runbook. At pinned revision `50647de`, `ProjectActionsSettings.tsx` provides a settings-based editor and persists project action overrides on the selected environment, but that alone did not establish usable navigation in this installation. [Project action settings source](https://github.com/pingdotgg/t3code/blob/50647de0143e68fde051eb1a0ccf4fe63f9947b2/apps/web/src/components/settings/ProjectActionsSettings.tsx).

`projectScriptEditor.tsx` verifies these exact labels:

- **Name:** `Bootstrap worktree`.
- **Command:** the guarded install/init/start/status sequence in the runbook.
- **Run automatically on worktree creation:** on.
- **Wait for it to finish before the agent starts:** on.
- **Run in the thread's worktree when the thread settles:** off.
- **Keybinding** and **Preview URL (optional):** leave unset. **Open preview automatically when this action runs:** off.
- **Save action:** persists the configuration; reopen the editor to verify it.

The UI's wait switch saves `async: false` via `buildProjectScript` in `apps/web/src/projectScripts.ts`. Saving an action that claims the setup role removes that role from the previous action through `releaseClaimedRoles`; the intended result is one complete bootstrap action. Do not accidentally replace another required setup action without incorporating its commands. [Editor source](https://github.com/pingdotgg/t3code/blob/50647de0143e68fde051eb1a0ccf4fe63f9947b2/apps/web/src/components/projectScriptEditor.tsx), [saved action mapping](https://github.com/pingdotgg/t3code/blob/50647de0143e68fde051eb1a0ccf4fe63f9947b2/apps/web/src/projectScripts.ts).

### What belongs in the action

Include installation **before** `worktree:init`, because init imports Effect from installed dependencies. Include `dev:start` and `dev:status` in the same host-side action so startup is not handed back to the model's differently permissioned command tool. The `&&` sequence stops on failure; `dev:start` already performs a readiness wait. The main-checkout guard is necessary because the inspected launcher can also invoke setup for root-checkout launches. T3 supplies both path variables in the guard.

Keep the action independent of the chosen provider: no Codex flags or model-specific permission instructions. The action uses this Mac's POSIX shell. Keep exact `wt-NN` creation via `t3_thread_launch`; the setup switch does not disable automatic branch naming for generic worktree launches.

### Execution-interface investigation

A separate investigation checked the live T3 MCP catalog, installed `t3 --help`, and pinned source. No agent-facing terminal execution or arbitrary project-command tool was found. The CLI has no terminal execution command; `acp-mcp-call` bridges the existing MCP tools and adds no execution capability. T3's UI terminal RPCs exist in `ws.ts`, but `RpcAuthorization.ts` requires `terminal:operate`; they are not exposed as agent MCP tools. Therefore a direct host-execution tool would require a separate integration/implementation, not just a repository script. This is why the selected direction uses the existing project setup action. [CLI registration](https://github.com/pingdotgg/t3code/blob/50647de0143e68fde051eb1a0ccf4fe63f9947b2/apps/server/src/binCli.ts), [terminal RPC authorization](https://github.com/pingdotgg/t3code/blob/50647de0143e68fde051eb1a0ccf4fe63f9947b2/apps/server/src/auth/RpcAuthorization.ts).

### Status and first-use verification

The creation route and dialog labels were verified in the live UI; configuration mappings were checked in source. The action remains unregistered by this agent, and no new worktree was created. After the user saves it, the first explicit named launch should show the setup terminal/card completing successfully before agent startup, the expected port, a healthy server, and the expected Herdr workspace/tab. If setup is skipped, verify the selected project/environment and saved setup switch. If it fails, inspect its terminal output; do not silently replace host setup with provider-specific model retries.

The former runbook's filesystem/network prerequisites have been removed from its operational procedure; those details remain in this research's controlled probes and execution-contract discussion. The launch message now asks the agent to report setup results instead of running bootstrap itself.
