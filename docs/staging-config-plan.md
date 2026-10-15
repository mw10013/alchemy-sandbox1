# Plan: staging's externally issued configuration through a stage config stack

Plan date: 2026-10-15 · Alchemy `2.0.0-beta.81` · Base commit `2f352e7` plus the uncommitted Shopify-side setup (§2).
Research: [Staging configuration research](./staging-config-research.md). Every question there is settled (its §11); this plan implements the decisions. Read the research first, §4 to §8 in particular: it explains why a stack with no resources, how the reference resolves on Workers Builds, and how each value's type decides its binding.

## 0. Rules for the implementer

- Follow `AGENTS.md`: Vite+ only (`vp`, never npm/npx), Effect idioms (Schema for every parse and check, `Match`, `Schema.TaggedError`, `Effect.fn`), and its comment rules (JSDoc on symbols, a rule stated once, no references to plans or research docs in code or comments).
- **No commits, no pushes.** A push to `main` deploys staging through Workers Builds, and the next staging deploy carries a lot of unshipped work (see [Taking S1 to staging](./staging-research.md)). This plan ends at a local `alchemy plan --stage staging`; the user decides the push.
- **No Shopify-side changes:** no `shopify app deploy`, `shopify app config link`, `shopify app config use` or `shopify app env pull`. The Shopify side is done (§2). If it looks wrong, stop and record.
- **Never print a secret.** Do not `cat`, `grep` or echo `.env.staging` values, and do not run `alchemy state read` on the stage config record. Check names only (for example `sed -E 's/=.*/=<hidden>/' .env.staging`).
- **Do not touch Baton's files** (`refs/baton`, or the Baton repository). This repository uses Baton's names on purpose.
- Writing the stage config record to Cloudflare's state store (Step 5) is allowed: it creates no Cloudflare resource and only the staging deploy reads it.
- Run `vp check --fix` after code changes. Each step ends green (`vp check`, the tests it names) before the next starts.
- Anything that differs from this plan, or any problem you could not solve, goes in §10 with the date and step. Do not silently change the design; if a step cannot work as written, stop that step, record why, and continue with what does not depend on it.

## 1. Outcome

- A stack `Alchemy-sandbox1-config` (`stacks/stage-config.ts`, handle `StageConfig`) declares no resources. `pnpm run stage-config -- --stage staging` reads `.env.staging` and saves `{ SHOPIFY_API_KEY, SHOPIFY_API_SECRET }` as its output record for `staging` in the Cloudflare state store. Any other stage is refused before a record is written.
- On `staging`, the app stack reads that record (`yield* StageConfig`) and binds the staging Shopify app's key (`plain_text`) and secret (`secret_text`) to the Backend, and the key to the Website. `SHOPIFY_APP_URL` stays the Website's own URL.
- `dev`, `test` and `e2e` are unchanged: Shopify CLI's values under `shopify app dev`, fakes otherwise.
- `vp run worktree:init` links a worktree's `.env.<stage>` to the main checkout's for every deployed environment whose file exists in main.
- `vp exec alchemy plan --stage staging` shows the Shopify bindings changing to the staging app's, and no other change caused by this work.

## 2. Preconditions (done before this plan, by the user)

Verify each; if one fails, stop and record.

| #   | Precondition                                                                               | Check                                                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | The staging Shopify app "Baton Staging" exists and its configuration is deployed           | `shopify.app.staging.toml` has a non-empty `client_id`, `name = "Baton Staging"`, `application_url` = the staging Website URL, no `handle`, `web_directories = ["."]` |
| 2   | It is installed on `sandbox-shop-00`                                                       | Ask the user if unsure; not checkable from the repo                                                                                                                   |
| 3   | `shopify.app.toml` names the dev app "Baton Dev"                                           | `grep '^name' shopify.app.toml`                                                                                                                                       |
| 4   | `.env.staging` exists in the main checkout with `SHOPIFY_API_KEY` and `SHOPIFY_API_SECRET` | `sed -E 's/=.*/=<hidden>/' .env.staging` lists both names                                                                                                             |
| 5   | Its `SHOPIFY_API_KEY` equals the TOML's `client_id`                                        | Compare without printing the secret: `grep '^SHOPIFY_API_KEY=' .env.staging` (the key is public) against `grep '^client_id' shopify.app.staging.toml`                 |
| 6   | Shopify CLI's default config is `shopify.app.toml` again                                   | `app:dev` passes `--config shopify.app.toml` regardless; record what `.shopify/project.json` says if present                                                          |

## 3. Step 1: the deployed environments, as one Schema

`src/backend/stage.ts`. One symbol states which environments are deployed, because two places need that list: the stage config stack (which stages may hold a record) and `worktree:init` (which `.env.<stage>` files to link).

- Add `Deployed = Schema.Literals(["staging"])` and its type, next to `PerDeveloper`. JSDoc: the environments whose single stage is named after the environment and is deployed to Cloudflare; `production` joins when it is designed.
- If `Environment` can be written in terms of `PerDeveloper` and `Deployed` without loss of clarity, do so; otherwise leave `Environment` as it is and add a unit test that every `Environment` is in exactly one of the two. Record which.
- `test/unit/backend/stage.test.ts`: `Deployed` accepts `staging` and rejects `dev`, `dev-mw`, `production`.

Verify: `vp check`, `vp test test/unit/backend/stage.test.ts`.

## 4. Step 2: the handle and the stage config stack

### 4.1 Handle, in `src/backend/stack.ts`

```ts
export class StageConfig extends Alchemy.Stack<
  StageConfig,
  {
    SHOPIFY_API_KEY: string;
    SHOPIFY_API_SECRET: Redacted.Redacted<string>;
  }
>()("Alchemy-sandbox1-config") {}
```

JSDoc (see the research's §8.1 for the content): the values another service issues for a deployed stage; held as the output of their own stack because a deploy in Workers Builds cannot receive them as environment variables; a secret is `Redacted`, which is what binds it as a Worker secret; deployed by hand from a laptop, and every deploy writes the whole record. The stack name is a logical id in state: renaming it orphans every stage's record.

The handle lives here, not in `stacks/stage-config.ts`, so `alchemy.run.ts` (and Workers Builds) never imports the stack file.

### 4.2 Stack, `stacks/stage-config.ts` (new)

```ts
export default StageConfig.make(
  {
    providers: Cloudflare.providers(),
    state: stageState,
    secrets: Alchemy.Secrets.DotEnv(({ stage }) => ({ path: `.env.${stage}` })),
  },
  Effect.gen(function* () {
    // refuse a stage whose environment is not Deployed (Step 1), with a message naming it
    return {
      SHOPIFY_API_KEY: yield* Config.NonEmptyString("SHOPIFY_API_KEY"),
      SHOPIFY_API_SECRET: yield* Config.Redacted("SHOPIFY_API_SECRET"),
    };
  }),
);
```

- The refusal decodes the environment with `Deployed` (Schema, not a string comparison) and fails with a `Schema.TaggedError` whose message names the stage and the allowed environments. Check what `alchemy deploy` prints for it; if a defect reads better, record the choice.
- `Secrets.DotEnv` with a named path fails when the file is missing. For a non-deployed stage that failure may come before the refusal. Either is acceptable as long as no record is written; record which message appears.
- An empty `SHOPIFY_API_SECRET` must fail too. Use whatever `Config` combinator does that idiomatically (a Schema-backed `Config`, or `Config.Redacted` over a non-empty string); record what you used.
- Module JSDoc on the file: what the stack is for, that it creates nothing, how to run it, that it refuses every stage but the deployed ones.

### 4.3 Wiring

- `tsconfig.json`: add `"stacks"` to `include`.
- `package.json` script: `"stage-config": "alchemy deploy --config stacks/stage-config.ts"`.
- `.gitignore` already ignores `.env.*` (keeping `.env.example`); confirm `.env.staging` is ignored with `git check-ignore -v .env.staging`.

Verify, without touching Cloudflare state:

- `vp check`.
- `vp exec alchemy plan --config stacks/stage-config.ts --stage staging` → `Plan: no resources`; the printed outputs show the key and `<redacted>` for the secret. (`plan` writes nothing.)
- `vp exec alchemy plan --config stacks/stage-config.ts --stage dev-mw` → fails, no record. Record the message.
- With a scratch copy where `SHOPIFY_API_SECRET` is missing (for example `SHOPIFY_API_SECRET= vp exec alchemy plan …`, since the process environment overrides the file, or better a temporary env file that is deleted afterwards): the plan fails naming the variable. Record the command and message.

## 5. Step 3: the app stack reads the record on staging

`src/backend/stack.ts`, `alchemy.run.ts`.

Today `ShopifyApp` is a `Config` that is `Some` only under `shopify app dev`. Replace it with an effect that matches on the stage's environment, the same way `stageState` does:

| Environment   | Key and secret                                                                                                              | App URL                      |
| ------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `staging`     | `yield* StageConfig`: `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`                                                               | the Website's own URL        |
| `dev`         | Shopify CLI's `APP_URL`, `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET` when all three are present, else fakes (today's behaviour) | the CLI's tunnel, else local |
| `test`, `e2e` | fakes (today's behaviour)                                                                                                   | local                        |

- `Match.exhaustive` over `Environment`, so a new environment must decide its source.
- The staging record's fields are `Output`s when read through the handle; the bindings and the Website's `env` accept `Output`s. Shape the return type so `wireBackend` and the `Website` take the same value; keep the fixed fake key and the `ShopifyApiSecret` random as they are (the random is declared on every stage, see `wireBackend`'s JSDoc).
- Staging must never read `SHOPIFY_*` from `Config`: a stray variable in the Workers Builds environment must not override the record.
- Update `ShopifyApp`'s and `wireBackend`'s JSDoc and the `Website`'s JSDoc in `alchemy.run.ts` to say where staging's values come from, stating the rule once (on the new effect) and linking it elsewhere.
- **Risk:** `Website` reads the Shopify app inside its own `Effect.gen`. If a stack reference cannot be resolved there, read it in the stack body instead and pass it in, or restructure as the smallest change that works; record what you did.
- `test/integ/stack.ts` runs on a `test` stage and must be unaffected.

Verify:

- `vp check`, `vp test` (unit, browser, integ), `vp run test:e2e`.
- `vp exec alchemy plan --stage staging` **fails** with `InvalidReferenceError` naming `Alchemy-sandbox1-config` at `staging`, because the record is not deployed yet (Step 5 deploys it). That is the expected result here; record the message.
- `vp run dev` (main checkout; it starts `shopify app dev` on `sandbox-shop-00`): the dev plan in `.logs/dev/current` shows no new Shopify binding change beyond what a normal start shows, and the app still loads embedded as Baton Dev. If you cannot open the admin, record that and check through the tunnel as the embedded-admin plan's Step 9 notes did (`/auth/session-token` carries the dev `client_id`).

## 6. Step 4: worktrees link `.env.<stage>`

`scripts/worktree.ts` (and `scripts/lib/worktree.ts` if a helper belongs there).

- After the `refs` link: for each `Deployed` environment (Step 1), if `<main>/.env.<environment>` exists, the worktree gets `.env.<environment>` as a symlink to it, using the same verify-or-create pattern as `refs` (`Symlink` to the right target → verified; wrong target → fail naming both; a real file → fail asking to remove it, since it would shadow main's; absent → create). If main has no such file, print a skip line and continue.
- Update the module JSDoc's step list and the command description.
- `docs/worktrees-runbook.md`: the "Shared" bullet gains `.env.<stage>` files (one copy in main, linked from each worktree by `worktree:init`).

Verify:

- `vp check`.
- If the `wt-01` worktree exists and `git -C <wt-01> status --porcelain` is empty, run `vp run worktree:init` there: it verifies `.env` and `refs` as before and creates `.env.staging -> <main>/.env.staging`; a second run verifies all three. Do not stop or start its dev server. Otherwise record that this was not run.

## 7. Step 5: deploy the stage config record and plan staging

From the main checkout:

1. `pnpm run stage-config -- --stage staging` → `Plan: no resources`, `Done: 0 succeeded`, outputs with the key and `<redacted>`.
2. `vp exec alchemy state list Alchemy-sandbox1-config/staging` shows an `output` entry. Do not `state read` it.
3. `vp exec alchemy plan --stage staging` → succeeds. Record the summary: the Shopify binding changes on `Backend` (key and secret) and `Website` (key) are expected; everything else in the plan is the unshipped work [Taking S1 to staging](./staging-research.md) lists. List anything that is neither.
4. **Stop.** Do not push. Report to the user that staging is ready to deploy on the next push, with the plan summary.

## 8. Step 6: docs

- `README.md`: wherever it describes staging or deploys, one short paragraph: staging's externally issued values come from `.env.staging` through `pnpm run stage-config -- --stage staging`, deployed before the code that needs a new value.
- `docs/stage-config-runbook.md` (new; the procedure is rare and easy to get wrong in order, which is what a runbook here is for):
  - Change a value: edit `.env.<stage>` (Shopify's through `shopify app env pull --config <stage> --env-file .env.<stage>`), `pnpm run stage-config -- --stage <stage>`, then redeploy the app (push, or "Retry build" in Workers Builds). The binding is fixed at upload.
  - Add a value: add the field to `StageConfig` (`Redacted` if secret), read it in `stacks/stage-config.ts`, bind it; deploy the record **before** pushing the code, or the Workers Builds deploy fails at plan time (safe: nothing is touched).
  - Rotate the Shopify secret: follow Shopify's rotation (old and new valid until the old is revoked), pull, redeploy the record, redeploy the app, then revoke the old secret.
  - A new worktree: `vp run worktree:init` links the files.
  - Never print the file or `state read` the record.
- `docs/glossary.md`: add "stage config" only if the glossary defines comparable terms (stage, environment); record the decision.

## 9. Verification checklist

- [ ] §2 preconditions all hold.
- [ ] `vp check` green.
- [ ] `vp test` green; `vp run test:e2e` green.
- [ ] `plan --config stacks/stage-config.ts --stage staging`: no resources, key shown, secret redacted.
- [ ] A non-deployed stage is refused with no record written.
- [ ] A missing or empty secret fails the stage config plan, naming the variable.
- [ ] Before Step 5, `plan --stage staging` fails with `InvalidReferenceError`; after it, succeeds with only the expected Shopify binding changes beyond the staging research's list.
- [ ] Dev under `shopify app dev` still loads embedded, now named Baton Dev.
- [ ] `worktree:init` links `.env.staging` (or recorded as not run).
- [ ] No secret value appears in any recorded output.
- [ ] Nothing committed or pushed; no Shopify-side command run.

## 10. Deviations and issues

For the implementer. Append as you go; keep each entry short and dated, with the step. A deviation is anything built differently from the step that specified it; an issue is anything observed that the plan did not predict (a failing assumption, an API that differs from the sketch, a flaky test, a limit hit). Do not rewrite the steps above; this section is the record.

### Deviations

(none yet)

### Issues

(none yet)

### Command results

Record the exact commands and the relevant lines of output for every "Verify" and for Step 5, with secrets hidden.

(none yet)

## 11. Out of scope

Pushing or deploying staging; the S1 staging items ([Taking S1 to staging](./staging-research.md)); webhook routes and subscriptions; `production` (its environment, Shopify app, `.env.production`); Cloudflare Secrets Store for live rotation; GitHub Actions; any change to the Shopify app's configuration; Baton's files.

## 12. File plan

| File                                                        | Change                                                     |
| ----------------------------------------------------------- | ---------------------------------------------------------- |
| `src/backend/stage.ts`                                      | `Deployed`                                                 |
| `test/unit/backend/stage.test.ts`                           | `Deployed` cases                                           |
| `src/backend/stack.ts`                                      | `StageConfig` handle; `ShopifyApp` by environment; JSDoc   |
| `stacks/stage-config.ts`                                    | New: the stage config stack                                |
| `alchemy.run.ts`                                            | `Website` takes the Shopify app from the new effect; JSDoc |
| `tsconfig.json`                                             | `include` gains `stacks`                                   |
| `package.json`                                              | `stage-config` script                                      |
| `scripts/worktree.ts` (and maybe `scripts/lib/worktree.ts`) | Link `.env.<deployed environment>`                         |
| `docs/worktrees-runbook.md`                                 | Shared `.env.<stage>`                                      |
| `docs/stage-config-runbook.md`                              | New                                                        |
| `README.md`                                                 | Staging values paragraph                                   |

## 13. Order of work and stopping points

Steps 1 → 2 → 3 → 4 → 5 → 6. Step 4 does not depend on Steps 2 and 3 and may be done earlier. Stop and report after Step 5 if anything in the staging plan is unexplained; finish Step 6 either way. The plan is complete when §9 is checked and §10 records every deviation and command result.
