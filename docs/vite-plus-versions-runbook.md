# Vite+ versions runbook

How to keep the project's Vite+, Vite, Vitest, browser provider, and TypeScript versions aligned; verify the setup; and upgrade it.

## Where versions live

`package.json` declares the packages this project needs. `pnpm-workspace.yaml` owns the toolchain catalog and workspace-wide overrides. `pnpm-lock.yaml` records the resolved dependency graph. Update and review these together.

The baseline verified on 2026-10-12 is:

| Package                      | Manifest entry                | Pin location                                      | Alignment rule                                                                              |
| ---------------------------- | ----------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `vite-plus`                  | Dev dependency, `catalog:`    | Catalog: `1.1.0`                                  | Selects the project's Vite+ release                                                         |
| `vite`                       | Dev dependency, `catalog:`    | Catalog: `npm:@voidzero-dev/vite-plus-core@1.1.0` | Core package release must match `vite-plus`; this is an alias, not an upstream Vite version |
| `vitest`                     | Dev dependency, `catalog:`    | Catalog: `5.0.3`                                  | Match the runner bundled with the selected Vite+ release                                    |
| `@vitest/browser-playwright` | Dev dependency, `catalog:`    | Catalog: `5.0.3`                                  | Match bundled Vitest                                                                        |
| `typescript`                 | Dev dependency, exact version | Manifest: `7.0.2`                                 | Project policy: match the TypeScript version supported by bundled tsgolint                  |
| `playwright`                 | Dev dependency, exact version | Manifest: `1.64.0`                                | Has its own release cycle; satisfy the provider's peer requirements                         |
| `vitest-browser-react`       | Dev dependency, exact version | Manifest: `2.3.0`                                 | Third-party integration; use a release compatible with our Vitest                           |
| `@effect/vitest`             | Dev dependency, exact version | Manifest: `4.0.1`                                 | Follow the Effect release family and check its Vitest peer range                            |

These numbers are a baseline, not permanent targets. Read the current catalog, manifest, and installed toolchain before an upgrade.

## Catalogs and overrides

The catalog stores exact versions once. A `catalog:` manifest entry still declares a direct dependency; pnpm resolves its version from the default catalog.

The overrides make other packages use the same toolchain:

```yaml
overrides:
  vite@*: "catalog:"
  vitest@*: "catalog:"
```

Keep the `@*` selectors. A bare `vite` or `vitest` key also replaces direct `catalog:` specifications, and dependency updates can then write concrete versions back into the manifest. The selectors target semver declarations while leaving our catalog references intact.

The Vite alias and override avoid separate upstream Vite and Vite+ core instances. Vite+ documents a TanStack Start failure where identity checks across two copies caused 404s. Keep the override even though the project imports from `vite-plus`.

Direct `vite` remains useful here: `tsconfig.json` references `vite/client`, and framework/plugins consume Vite. Direct `vitest` remains appropriate because we use browser mode and integrations with required Vitest peers. The Playwright provider is opt-in, so keep it installed even though its API is imported through `vite-plus/test/browser-playwright`.

Official Vitest packages such as `@vitest/browser-playwright` follow Vitest's release version. Vite+ migration places them in the toolchain catalog when catalogs are supported. Third-party packages such as `vitest-browser-react` follow their own versions; do not assign them the Vitest version.

`saveExact: true` preserves our exact-pin convention when adding dependencies. Catalog placement is not required for every development dependency, and catalog membership alone does not synchronize versions automatically.

## TypeScript and the checker

`vp check` uses Oxlint's TypeScript Go/tsgolint backend when `lint.options.typeAware` and `typeCheck` are enabled in `vite.config.ts`. Our explicit `typescript` dependency does not select that backend's version.

Use `vp toolchain` to inspect `oxlint-tsgolint`. Its version encodes the supported TypeScript version: `7.0.2003` means TypeScript `7.0.2` with tsgolint patch `003`. Keep our TypeScript pin aligned with that supported version when upgrading. This is our maintenance policy; Vite+ does not document automatic synchronization of the `typescript` dependency.

Keep TypeScript pinned directly in `package.json`. No TypeScript override is needed for the present graph. Moving it to a catalog would change where the pin is stored, not how the bundled checker is selected. Recheck tsgolint's versioning documentation if its version format changes.

## Check alignment

Run from the checkout's repository root:

```sh
vp toolchain
vp why vite
vp why vitest
vp why typescript
vp install --frozen-lockfile
vp check --fix
vp run refs:check
git diff --check
```

Confirm:

1. Installed `vite-plus` matches the catalog pin, and the core alias uses the same Vite+ release.
2. The Vite consumers resolve to `@voidzero-dev/vite-plus-core`; an unexpected separate upstream `vite` installation needs investigation.
3. Installed Vitest and the browser provider match the selected Vite+ release's bundled Vitest. Check both the catalog and `vp toolchain`; a stale override can force an older Vitest into a newer Vite+ installation.
4. TypeScript matches the version supported by bundled tsgolint.
5. Managed manifest entries remain `catalog:`, and both overrides retain `@*`.
6. Frozen installation succeeds. A failure means the manifest/config and lockfile need reconciliation; do not bypass it in CI.

`vp check --fix` can format or fix files; inspect its diff. For read-only verification or CI, use `vp check`.

The refs script resolves catalog pins and checks installed Vite+ against the declared release. A stale refs snapshot after an upgrade is expected until it is refreshed; a catalog parsing error or stale installation is not.

## Upgrade to the current stable Vite+ release

1. Inspect `git status --short` and preserve unrelated work. Record the existing pins and `vp toolchain` output so the upgrade can be compared or rolled back. Read the target release's migration notes, especially for major Vitest changes.
2. Check the registry's target release, then upgrade the global CLI and use its migration rules:

   ```sh
   vp view vite-plus dist-tags --json
   vp upgrade
   vp migrate --no-interactive --no-hooks --no-agent --no-editor
   ```

   `vp upgrade` updates the machine's global CLI. `vp migrate` updates this project's dependencies and configuration. A newer global CLI upgrades the project to its release. For an existing Vite+ project, migration performs a toolchain upgrade without full setup; do not pass `--full` for routine upgrades.

   If the project must stay on a specifically selected release, use that release's documented migration procedure rather than upgrading the global CLI to latest. The local `./node_modules/.bin/vp migrate` aligns to the installed project release when no newer global CLI takes over; verify which release ran.

3. Review the manifest, workspace config, lockfile, and any source/config rewrites. Ensure the Vite+ and core pins match; Vitest and official browser packages match bundled Vitest; catalog references and overrides are preserved. Do not rely on a successful install alone to prove the intended version was selected.
4. Run `vp toolchain`. Update the exact `typescript` manifest pin if its supported version changed. Review peer compatibility for `@effect/vitest`, `vitest-browser-react`, `playwright`, and the Vite plugins; upgrade these separately only when needed.
5. Install the final configuration and validate it:

   ```sh
   vp install
   vp toolchain
   vp check --fix
   vp test
   vp build
   vp run test:e2e
   vp install --frozen-lockfile
   git diff --check
   ```

   Use the repository's environment and test prerequisites. Start the application with `vp run dev`, never plain `vp dev`, for manual checks. Confirm page loading and navigation through TanStack Start, and browser tests through the Playwright provider. Check `logs/dev/current` for failures. Restart an already-running dev server after installing changed dependencies.

6. Refresh the reference snapshots affected by the upgrade, then verify them:

   ```sh
   vp run refs fetch vite-plus vite vitest
   vp run refs:check
   ```

   If Playwright or another tracked dependency changed, refresh its named ref too. Fetch shared refs from the main checkout; worktrees use the shared `refs` link.

7. Review the final diff and record the versions and validation results in the change description. Do not commit, push, or deploy unless explicitly requested.

## Release-age exceptions

pnpm 12 defaults to a 1440-minute release-age preference. With only the built-in default, it can fall back to a newer release when no eligible version satisfies the dependency. Explicitly configuring `minimumReleaseAge` enables strict behavior by default, so adding that setting changes policy.

`minimumReleaseAgeExclude` bypasses the age check; it does not select or pin a version. The old entries covered Vite+ `1.1.0`, its core, and all platform binaries at that release. They were valid exact-version exceptions but no longer necessary, and installation passed policy verification after their removal.

Keep the exclusion list absent unless a new release actually needs an exception. Prefer waiting for the release to age. If an immediate upgrade is intentional, use narrowly scoped exact-version exceptions for the packages identified by pnpm, including required platform binaries for contributor/CI platforms. Remove them once no longer needed. Avoid permanent organization-wide wildcards or disabling age checks to solve a single upgrade.

## Troubleshooting and rollback

- **TanStack Start returns unexplained 404s after an upgrade:** inspect `vp why vite`, the core alias, and `vite@*`; restore one Vite core resolution and reinstall before debugging application routing.
- **Vitest internals, mocks, or browser provider fail:** check the target Vite+ release's bundled Vitest against the catalog and `vitest@*`. A stale override can silently keep the old runner. Align the official Vitest packages and reinstall.
- **Manifest entries changed from `catalog:` to versions:** look for bare override keys. Restore `@*` selectors, catalog references, and the lockfile through `vp install`.
- **Release-age failure:** inspect the exact packages/versions reported, then follow the exception procedure above.
- **Refs report an old installed Vite+ release:** run `vp install`; do not refresh snapshots to hide an installation mismatch.

To roll back, restore only the upgrade's changes to the manifest, workspace config, lockfile, and any migrated source/config files from the recorded baseline. Preserve unrelated edits. Run `vp install --frozen-lockfile`, restart the dev server, and repeat alignment checks. Restore or refetch matching shared refs if they were updated. Rolling back the project does not require downgrading the global CLI; normal project commands use the installed local toolchain.

## References

- [Vite+ project-local CLI](https://viteplus.dev/guide/local-cli): direct dependency and override setup; TanStack Start duplicate-Vite failure.
- [Vite+ migration rules](https://viteplus.dev/guide/migrate-rules): catalogs, `@*` selectors, required peers, and official Vitest ecosystem packages.
- [Vite+ upgrade procedure](https://viteplus.dev/guide/upgrade-project): global/local migration selection and bundled Vitest alignment.
- [Vite+ check](https://viteplus.dev/guide/check): TypeScript Go/tsgolint checking.
- [tsgolint versioning](https://github.com/oxc-project/tsgolint#versioning): mapping checker releases to supported TypeScript versions.
- [pnpm dependency resolution settings](https://pnpm.io/settings/dependency-resolution#minimumreleaseage): release age, strictness, and exact-version exceptions.
