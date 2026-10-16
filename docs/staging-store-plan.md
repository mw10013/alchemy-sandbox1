# Plan: move staging to its own store, `mw10013-staging-shop-00`

Plan date: 2026-10-15 · Base commit `10dea97`. Done 2026-10-15: installed, embedded load verified, seeded (second run changed nothing), uninstalled from `sandbox-shop-00`.
Background: [Shopify stores runbook](./shopify-stores-runbook.md) (the store scheme and the two apps on every store); [staging config research](./staging-config-research.md) §3.4 (how the staging app was set up and installed on `sandbox-shop-00`).

## 1. Facts

- Staging's Shopify app is "Baton Staging" (`shopify.app.staging.toml`, `client_id` `54b4c701f5c568d4cf4a11fd42d6fe7b`). Its `application_url` is the staging Website Worker; its key and secret reach staging through the stage config record. None of that changes.
- It is installed on `sandbox-shop-00`, through the Dev Dashboard. Nothing in the repository names the store staging uses: `sandbox-shop-00` appears only in unit-test sample data and in the messages about the old scheme.
- `mw10013-staging-shop-00` exists (claimed on `basic`, empty, no app installed).
- On the first embedded load, staging's Backend does a real token exchange and stores a `ShopSession` for the store. Logs: `cf o11y telemetry query` on `cloudflare-workers`, `$metadata.service` = `alchemy-sandbox1-website-staging-a6uwn3bzazl3yzgy` (the Backend's service has its own name; find it the same way).
- Staging has no webhook routes yet; every subscription answers 404 there too.

## 2. Decisions (recommendations; confirm when picking this up)

1. **Seed the staging store:** let `stores:seed` accept `mw10013-staging-shop-NN` as well as dev stores, with the same table (`seed/dev-shop.ts`), so staging has realistic products and orders for manual checks. Recommended.
2. **Uninstall Baton Staging from `sandbox-shop-00`** once the new store works, so one store carries staging. Recommended. The uninstall sends `app/uninstalled` to staging, which answers 404 today: harmless. Staging's `ShopSession` for `sandbox-shop-00` stays in its database until the webhook routes handle uninstalls.

## 3. Steps

1. **Install** (the user): Dev Dashboard → Apps → Baton Staging → **Install app** → `mw10013-staging-shop-00`, approve the scopes. Never use `shopify app dev` for the staging app: it would point the app at a local tunnel.
2. **Embedded load** (the user, reviewer checking): open the app in `mw10013-staging-shop-00`'s admin; the page shows the store; staging's logs show `Shopify.authenticateAdmin: exchanged shop=mw10013-staging-shop-00.myshopify.com`.
3. **Seed** (decision 1): change `stores:seed`'s store check from "dev store" to "dev or staging store" (`StoreOf` per environment in `scripts/lib/worktree.ts`; the refusal message and the runbook follow); `vp check`, unit tests. Then the user runs the one-time `shopify store auth` for `mw10013-staging-shop-00.myshopify.com` with the seed's scopes, and `vp run stores:seed --store mw10013-staging-shop-00` twice (the second changes nothing).
4. **Uninstall** (decision 2, the user): `sandbox-shop-00` admin → Settings → Apps → Baton Staging → Uninstall.
5. **Docs:** `docs/shopify-stores-runbook.md` gains a short "Staging's store" section: the store, that its app is installed through the Dev Dashboard and never `shopify app dev`, and seeding it. `docs/e2e-real-shopify-research.md` Q2 status: done.
6. Commit; push (Workers Builds redeploys staging; the code change does not touch the Worker, so the deploy is a no-op for staging's behavior).

## 4. Out of scope

Production's store (`mw10013-production-shop-00`) and a production app; webhook routes; deleting `sandbox-shop-NN`.
