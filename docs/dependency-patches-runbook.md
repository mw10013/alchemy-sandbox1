# Dependency patches runbook

What our pnpm patches are, and what to do when one blows up on an upgrade.

## How patching works

- A patch is a recorded diff that pnpm applies to a package every time it installs it: locally, in CI, in a new worktree. Nothing under `node_modules` is edited by hand, and nothing is lost on reinstall.
- The diff lives in `patches/<package>@<version>.patch`. `patchedDependencies` in `pnpm-workspace.yaml` maps the package to it, keyed by **exact version**. `pnpm-lock.yaml` records the patch's hash; it is generated, not edited.
- Because the key is an exact version, a patch never silently applies to a different release. Upgrading the package leaves the patch matching nothing, and the install fails with an error naming the patch, until it is carried forward (below).

## Current patches

### `alchemy@2.0.0-beta.81`: export `RpcWebSocket`

- **What it changes:** only Alchemy's `package.json`. It adds one entry to the `exports` map, copied from the `./Cloudflare/RpcWebSocketClient` entry beside it:

  ```json
  "./Cloudflare/RpcWebSocket": {
    "types": "./lib/Cloudflare/Workers/RpcWebSocket.d.ts",
    "bun": "./src/Cloudflare/Workers/RpcWebSocket.ts",
    "default": "./lib/Cloudflare/Workers/RpcWebSocket.js"
  },
  ```

- **Why:** the Backend's actor socket (`src/backend/actor-socket.ts`) builds on Alchemy's server-side WebSocket RPC transport. Alchemy ships that file but leaves it out of `exports`, so it cannot be imported by name. Without the patch, the only way in is a relative path into `node_modules`, which breaks quietly, at bundle time, whenever Alchemy moves the file.
- **Retire it when:** Alchemy exports `./Cloudflare/RpcWebSocket` (or the same module under another public path) itself.

## Upgrading a patched package

Example for Alchemy; the same steps work for any patched package.

1. **Drop the old patch.** Remove the `alchemy@…` line from `patchedDependencies` in `pnpm-workspace.yaml`, and delete its file in `patches/`. If `patchedDependencies` is now empty, remove the key.
2. **Upgrade.** `vp add -E alchemy@<version>`, with the `@alchemy.run/*` packages at the same version.
3. **Check whether the patch is still needed.** Look for `"./Cloudflare/RpcWebSocket"` in `node_modules/alchemy/package.json`. If it is there, the patch is retired: skip to step 6.
4. **Check the transport still exists.** `node_modules/alchemy/lib/Cloudflare/Workers/RpcWebSocket.js` and its `.d.ts`. If they moved or were renamed, find the module that `RpcDurableObject` imports its transport from, and point the new entry there.
5. **Re-create the patch.**

   ```sh
   vp pm patch alchemy@<version> -- --edit-dir /tmp/alchemy-patch
   # add the exports entry above to /tmp/alchemy-patch/package.json
   vp pm patch-commit /tmp/alchemy-patch
   ```

   `patch-commit` writes `patches/alchemy@<version>.patch`, adds it to `patchedDependencies` and reinstalls.

6. **Verify.**

   ```sh
   vp check
   vp test --project integ   # drives the actor socket in workerd
   ```

   If the patch was retired, the import in `src/backend/actor-socket.ts` stays `alchemy/Cloudflare/RpcWebSocket` (or moves to Alchemy's new public path), and its comment about `patches/` goes.

Commit `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` and `patches/` together.

## Troubleshooting and rollback

- **Install fails naming a patch:** the version moved under it. Follow "Upgrading a patched package".
- **Install fails because the patch does not apply:** the patched file changed within the same version string, which should not happen for a published release. Re-create the patch (step 5).
- **Type check fails on `alchemy/Cloudflare/RpcWebSocket`:** the patch is missing or did not apply. Check `patchedDependencies`, then run `vp install`.
- **Undo a patch entirely:** remove it from `patchedDependencies`, delete its file, `vp install`. For Alchemy, the import in `src/backend/actor-socket.ts` must then fall back to the relative path `../../node_modules/alchemy/lib/Cloudflare/Workers/RpcWebSocket.js`.
