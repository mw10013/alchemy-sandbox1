# Shopify stores runbook

How this project's Shopify dev stores are named, claimed, authorized and seeded, and how the e2e suite logs into the Shopify admin; what to do when one of them breaks.

## How it works

- **Names:** `mw10013-<environment>-shop-NN`. `mw10013` is the organization's handle; generic names like `dev-shop-01` were already taken by other people, because store names share one namespace across all of Shopify. `NN` is the store's index: for dev and e2e, the worktree index (`00` in main).
- **Claimed, all on `basic`:** `mw10013-dev-shop-00` to `-09`, `mw10013-e2e-shop-00` to `-09`, `mw10013-staging-shop-00`, `mw10013-production-shop-00`. They belong to the organization `mw10013` (id `130059740`) in the Dev Dashboard. `dev-shop-00` and `e2e-shop-00` are from an earlier scheme, kept and unused.
- **Per checkout:** `.env` names `SHOPIFY_DEV_STORE` (the dev server's store) and `SHOPIFY_E2E_STORE` (the e2e server's). `worktree:init` writes both.
- **Two apps on every store, each with its own access:**
  - **Baton Dev**, the app itself. `shopify app dev` installs it on its store and grants its scopes with no click. Its scopes come from `shopify.app.toml`.
  - **Shopify CLI Connector App**, installed by `shopify store auth` with the scopes the seed needs. `store execute` writes store data as this app, so seeding never widens Baton Dev's scopes. Its token lives inside the CLI and renews itself.
- **No script creates or deletes a store.** `vp run stores:check` only reads; a missing store is an error, with the command to create it by hand.
- **One `shopify app dev` per store.** The CLI points the app's URL at its own tunnel per store, so two sessions on one store overwrite each other.

## Set up a checkout's stores (once per checkout)

1. `vp run worktree:init` in a new worktree (main's `.env` is set by hand). It writes both store keys and checks both stores exist.
2. `vp run dev`: the first start installs Baton Dev on the dev store ("Access scopes auto-granted").
3. Authorize seeding on the dev store, once. A browser page asks to install the Shopify CLI Connector App; a person clicks **Install**:

   ```sh
   shopify store auth --store mw10013-dev-shop-NN.myshopify.com --scopes read_products,write_products,read_orders,write_orders,read_draft_orders,write_draft_orders
   ```

4. `vp run stores:seed`. A second run reports everything as already there.

The e2e store needs only the e2e server (`vp run test:e2e` starts it); it is not seeded yet.

## Seed and reset

`vp run stores:seed` (default: this checkout's dev store; `--store <name>` for another dev store or the staging store) brings the store to `seed/dev-shop.ts`:

- products written by handle, with their real workflow tags and no seed marker; products the table does not name are archived;
- every open order **without** the `seed` tag is cancelled, with no refund, restock or notice, so an order made by hand on a dev store does not survive the next seed;
- three orders, each tagged `seed` and its own `seed-…` tag, created when missing. They are the data the help pages' screenshots are taken against.

It is safe to run again: it only writes what differs. It refuses any store that is not `mw10013-dev-shop-NN` or `mw10013-staging-shop-NN`. Cancelled orders stay in the store's history; delete them in the admin if they get in the way.

## Staging's store

Staging uses `mw10013-staging-shop-00`. Its app, Baton Staging, is installed through the Dev Dashboard (Apps, Baton Staging, **Install app**), never with `shopify app dev`: that would point the app at a local tunnel. The store is seeded with the same table as the dev stores, once:

1. `shopify store auth --store mw10013-staging-shop-00.myshopify.com --scopes read_products,write_products,read_orders,write_orders,read_draft_orders,write_draft_orders`, and click **Install** on the page it opens.
2. `vp run stores:seed --store mw10013-staging-shop-00`. A second run reports everything as already there.

## The e2e admin login

The embedded specs open the real admin, so they need a logged-in Shopify session.

- `vp run e2e:auth` reads the Shopify cookies from Chrome's `Default` profile (`--profile` for another; see chrome://version) and saves them to `playwright/.auth/shopify-admin.json`, mode 0600. That file is a live Shopify login: never share or commit it (`playwright/` is ignored).
- macOS asks whether `security` may access **Chrome Safe Storage**: click **Allow**. That is the key Chrome encrypts its cookies with.
- The `shopify-admin` setup project does the same before the embedded specs, but only when the saved login is stale (older than a day, or the admin session near expiry). Expect the prompt about once a day. The other e2e projects never ask.
- macOS only.

## Add a store

Needed for an index past `09`, or a store on another plan (a feature that needs `plus`, say).

1. Decide the plan first: **a store's plan cannot change after creation.**
2. Create it, by hand:

   ```sh
   shopify store create dev --name mw10013-<environment>-shop-NN --plan basic --organization-id 130059740
   ```

3. Check the returned domain is exactly `mw10013-<environment>-shop-NN.myshopify.com`. A taken name does not fail: Shopify silently adds a suffix. If that happens, delete the suffixed store and pick another name.
4. Never delete a store you mean to keep: a deleted store's name does not come back.

## Troubleshooting

- **"`<store>` does not exist in the organization the CLI is signed in to":** check `.env`, then `shopify store list`. If the list is someone else's, the CLI is on another account: `shopify auth logout`, then `shopify auth login`.
- **"`<store>` has no store auth with the scopes the seed needs":** run the `shopify store auth` command it prints (step 3 above).
- **A seed step fails once with no message:** the CLI occasionally fails a call; run it again. If it repeats, run one query by hand with `shopify store execute --store <domain> --query '{ shop { name } }'`.
- **`e2e:auth` finds no Shopify cookies:** Chrome may not have written them to disk yet. Quit Chrome with Cmd-Q (not just close the window), reopen it, check the admin is logged in, run it again.
- **`e2e:auth` says Keychain access failed:** unlock the login keychain, run it again, and click **Allow**.
- **The admin opens the app on the wrong server:** another `shopify app dev` is running on the same store. `pgrep -fl "app dev"` shows each session's `--store`.
