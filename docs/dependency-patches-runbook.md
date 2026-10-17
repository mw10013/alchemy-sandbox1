# Dependency patches runbook

What our pnpm patches are, and what to do when one blows up on an upgrade.

## How patching works

- A patch is a recorded diff that pnpm applies to a package every time it installs it: locally, in CI, in a new worktree. Nothing under `node_modules` is edited by hand, and nothing is lost on reinstall.
- The diff lives in `patches/<package>@<version>.patch`. `patchedDependencies` in `pnpm-workspace.yaml` maps the package to it, keyed by **exact version**. `pnpm-lock.yaml` records the patch's hash; it is generated, not edited.
- Because the key is an exact version, a patch never silently applies to a different release. Upgrading the package leaves the patch matching nothing, and the install fails with an error naming the patch, until it is carried forward (below).

## Current patches

One patch file per package; `patches/alchemy@2.0.0-beta.81.patch` carries two changes, each retired on its own.

### `alchemy@2.0.0-beta.81`: export `RpcWebSocket`

- **What it changes:** Alchemy's `package.json`. It adds one entry to the `exports` map, copied from the `./Cloudflare/RpcWebSocketClient` entry beside it:

  ```json
  "./Cloudflare/RpcWebSocket": {
    "types": "./lib/Cloudflare/Workers/RpcWebSocket.d.ts",
    "bun": "./src/Cloudflare/Workers/RpcWebSocket.ts",
    "default": "./lib/Cloudflare/Workers/RpcWebSocket.js"
  },
  ```

- **Why:** the Backend's actor socket (`src/backend/actor-socket.ts`) builds on Alchemy's server-side WebSocket RPC transport. Alchemy ships that file but leaves it out of `exports`, so it cannot be imported by name. Without the patch, the only way in is a relative path into `node_modules`, which breaks quietly, at bundle time, whenever Alchemy moves the file.
- **Retire it when:** Alchemy exports `./Cloudflare/RpcWebSocket` (or the same module under another public path) itself.

### `alchemy@2.0.0-beta.81`: local `precreate` of a self-bound Durable Object

- **What it changes:** `LocalWorkerProvider`'s `precreate`, in both `src/Cloudflare/Workers/LocalWorkerProvider.ts` and the `lib/…/LocalWorkerProvider.js` Node loads. For a `durable_object_namespace` binding, the namespace id was `` `${binding.scriptName}-${binding.className}` ``; it now uses the Worker's own `name` when `scriptName` is absent, not a string yet, or the Worker's own name, as `resolveConfig` in the same file already does:

  ```ts
  const host =
    typeof binding.scriptName === "string" && binding.scriptName !== name
      ? binding.scriptName
      : name;
  durableObjectNamespaces[binding.className] =
    binding.namespaceId ?? encodeURIComponent(`${host}-${binding.className}`);
  ```

- **Why:** the orders sync Workflow binds the shop's actor by identity, `ShopActor.from(<the Backend>)` (`ShopActors.layerFrom`), because the actor yields the Workflow. That binding's `scriptName` is the Backend's own `workerName`, an `Output` that cannot resolve while the Backend itself is being precreated, and the template string threw `Cannot coerce Output<…workerName> to a string via JS coercion` on every fresh local stack (each integ file, the e2e server, a first `alchemy dev`). Only the local provider; the deployed provider is separate code.
- **Retire it when:** Alchemy's `LocalWorkerProvider.precreate` no longer interpolates an unresolved `scriptName` for a self binding (an upstream issue was requested when the hunk landed; link it here once filed). Check: drop the hunk, then a fresh integ file (`vp test test/integ/orders-sync.test.ts`) deploys.

## Upgrading a patched package

Example for Alchemy; the same steps work for any patched package.

1. **Drop the old patch.** Remove the `alchemy@…` line from `patchedDependencies` in `pnpm-workspace.yaml`, and delete its file in `patches/`. If `patchedDependencies` is now empty, remove the key.
2. **Upgrade.** `vp add -E alchemy@<version>`, with the `@alchemy.run/*` packages at the same version.
3. **Check whether each change is still needed.** Look for `"./Cloudflare/RpcWebSocket"` in `node_modules/alchemy/package.json`, and read `precreate` in `node_modules/alchemy/lib/Cloudflare/Workers/LocalWorkerProvider.js`. A change Alchemy now makes itself is retired; if both are, skip to step 6.
4. **Check the transport still exists.** `node_modules/alchemy/lib/Cloudflare/Workers/RpcWebSocket.js` and its `.d.ts`. If they moved or were renamed, find the module that `RpcDurableObject` imports its transport from, and point the new entry there.
5. **Re-create the patch.**

   ```sh
   vp pm patch alchemy@<version> -- --edit-dir /tmp/alchemy-patch
   # add the exports entry above to /tmp/alchemy-patch/package.json
   # make the precreate change above in src/ and lib/ LocalWorkerProvider
   vp pm patch-commit /tmp/alchemy-patch
   ```

   `patch-commit` writes `patches/alchemy@<version>.patch`, adds it to `patchedDependencies` and reinstalls.

6. **Verify.**

   ```sh
   vp check
   vp test --project integ   # drives the actor socket in workerd; each file is a fresh local stack
   ```

   If the patch was retired, the import in `src/backend/actor-socket.ts` stays `alchemy/Cloudflare/RpcWebSocket` (or moves to Alchemy's new public path), and its comment about `patches/` goes.

Commit `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` and `patches/` together.

## Troubleshooting and rollback

- **Install fails naming a patch:** the version moved under it. Follow "Upgrading a patched package".
- **Install fails because the patch does not apply:** the patched file changed within the same version string, which should not happen for a published release. Re-create the patch (step 5).
- **Type check fails on `alchemy/Cloudflare/RpcWebSocket`:** the patch is missing or did not apply. Check `patchedDependencies`, then run `vp install`.
- **Undo a patch entirely:** remove it from `patchedDependencies`, delete its file, `vp install`. For Alchemy, without the `precreate` change every fresh local stack fails to deploy while `ShopActors.layerFrom` binds the actor by `from`; and the import in `src/backend/actor-socket.ts` must fall back to the relative path `../../node_modules/alchemy/lib/Cloudflare/Workers/RpcWebSocket.js`.
