# Research: the first e2e specs against real Shopify

Research date: 2026-10-15 · Base commit `da28f0e`. Status: every question answered in Plannotator on 2026-10-15 with the recommendation. Nothing implemented.
Background: [E2E against real Shopify](./e2e-real-shopify-research.md) (phases 1 to 4: stores, the e2e server, logs). This is phase 5.

## 1. Summary

The e2e server now runs on real Shopify: `shopify app dev` on `mw10013-e2e-shop-NN`, with the real Baton Dev credentials, a tunnel, and logs in `.logs/e2e/`. But no spec uses it yet. The 20 specs still test the app through the fake shop in `seed/test.sql`, and none opens the Shopify admin.

What the app does with Shopify today is small (§3):

- the embedded App Home (`/app`): the guards, a real token exchange, and a page that shows the shop;
- one Admin API call (`shop { id }`, on first install);
- no webhook handlers, though `shopify.app.toml` subscribes to four webhook paths.

So the first real-Shopify specs can only cover what exists: **the embedded load, end to end**. Webhooks, store data and the e2e store's seed only matter once the features that read them are ported from Baton (orders sync, the webhook routes). Recommendation: phase 5 builds the admin login and the embedded spec group, with one or two specs, and defers the rest to the features that need it (Q1).

## 2. What Baton did

Baton's e2e ran its embedded specs against the real admin, on the dev store (not a separate e2e store, and not beside the dev server).

**Admin login** (`refs/baton/scripts/lib/shopify-playwright-auth.ts`, `refs/baton/e2e/shopify-admin.setup.ts`):

- It reads the Shopify cookies (`.shopify.com`, `admin.shopify.com`, `accounts.shopify.com`) from the person's Chrome profile (`Default` unless told otherwise), from Chrome's cookie database.
- It decrypts them with the "Chrome Safe Storage" key from the macOS Keychain. macOS asks the person to allow that, with a 120 s wait.
- It writes a Playwright storage state, `playwright/.auth/shopify-admin.json` (mode 0600, written atomically).
- A `setup` project refreshes it only when it is stale: `koa.sid` near expiry, or the export older than 24 hours. So the Keychain prompt comes at most about once a day.
- macOS only. A Chrome that has been running a long time may not have written its cookies to disk; the error then says to quit Chrome.
- Only the embedded project depends on `setup`; the member, operator and public projects never trigger the prompt.

**Embedded specs** (`refs/baton/e2e/app.ts`):

- The base URL is the admin URL, `https://admin.shopify.com/store/<store>/apps/<handle>/app`.
- `appFrame` finds the app's iframe (`iframe[src*="embedded=1"]`), and the specs wait for the hydration marker inside it.
- App Bridge lifts nav links and title-bar buttons into the admin's own page, where Playwright's clicks need special handling (`clickHoisted`).
- The Shopify CLI dev console overlay swallows clicks and is collapsed first (`closeDevConsole`).
- One admin boot per spec file, in serial mode; `expect` at 10 s, actions 10 s, navigation 30 s; one worker.
- Real Chrome (`channel: "chrome"`), headless by default. The billing specs run headed and by hand only: a bot check on Shopify's pricing page challenges headless browsers.

**Data:** Baton's specs seeded the app (members, teams, workflows, orders) through an app endpoint, which required a `ShopSession` for the shop. Only the orders sync spec read Shopify-side data: real open orders in the store. No spec touched webhooks.

## 3. What this app does with Shopify today

- **`/app`** (`src/web/routes/app.tsx`): Baton's guards as redirects (`/auth/session-token`, the embedded redirect, the bounce), then `authenticateApp(idToken)`, the CSP `frame-ancestors`, App Bridge, and a "We got here" section showing the shop.
- **`/auth/session-token`, `/auth/exit-iframe`**: App Bridge pages for the guards.
- **`/merchant/$key`**: the shop page outside the admin, authenticated by a session token in `?token=`. The specs use it with tokens that test control signs (`IssueMerchantSessionToken`).
- **Backend** (`src/backend/shopify.ts`): `authenticateAdmin` reuses a stored session, or does the token exchange for an expiring offline token and stores a `ShopSession`. `fetchShopGid` is the only Admin API call. Nothing refreshes a token yet.
- **Webhooks:** no routes, no handlers. `shopify.app.toml` subscribes to `/webhooks/compliance`, `/webhooks/app/scopes_update`, `/webhooks/app/uninstalled` and `/webhooks/orders`, which all answer 404 today.
- **Test control:** `AddMember`, `RemoveMember`, `IssueMerchantSessionToken`, `IssueMagicLink`, and a test-only actor upgrade route.
- **The e2e database seed** is `seed/test.sql`, shared with `test`: two fake shops (`alchemy-sandbox1.myshopify.com`, `other-shop.myshopify.com`) with fake tokens, members, a team and the operator.

## 4. The proposal

1. **Admin login,** ported from Baton: a `setup` project that exports the Shopify cookies from Chrome into `playwright/.auth/shopify-admin.json` when the saved one is stale.
2. **An embedded project** whose base URL is the e2e store's admin URL (`https://admin.shopify.com/store/<SHOPIFY_E2E_STORE>/apps/baton-local/app`), depending on the login, on real Chrome. The existing specs stay in their own project, without the login.
3. **Helpers** ported from Baton as needed: `appFrame`, waiting for hydration inside the frame, collapsing the dev console. `clickHoisted` waits until there is a hoisted control.
4. **First specs:**
   - The app loads embedded and shows the store's domain. This proves the iframe, App Bridge, the ID token, the exchange and the page.
   - The exchange stored a real session: a new read-only test-control procedure returns the stored session's non-secret fields (`shopGid`, `scope`, expiry), never the tokens. The spec checks that `shopGid` is a real `gid://shopify/Shop/…`, which proves the Admin API call worked.
5. **Unchanged:** the existing 20 specs, the fake shops in `seed/test.sql`, `/merchant/$key` with signed tokens.
6. **Deferred:** the e2e store's own data and seed, `store auth` on the e2e stores, webhook specs. Each comes with the feature that needs it.

## 5. Questions, with recommendations

:::question
Q1. What does phase 5 cover?

The app has the embedded load and one Admin API call; no webhooks and no store data (§3).

- [x] The admin login and the embedded group with its first specs; store data, store seeding and webhooks wait for the features that use them
- [ ] All of it now, including webhook handlers and store data, ahead of the features
- [ ] Port a Baton feature first (orders sync, webhooks), then write specs for it

Recommended: The admin login and the embedded group with its first specs; store data, store seeding and webhooks wait for the features that use them
:::

:::question
Q2. Admin login: port Baton's Chrome cookie export?

It reads your Chrome profile's Shopify cookies through a Keychain prompt about once a day, and is proven against Shopify's checks. Note: you mentioned Chrome issues earlier; it reads Chrome's cookie file, not a running Chrome, but Chrome must have written its cookies to disk.

- [x] Port it as is, profile `Default`, macOS only
- [ ] A dedicated Playwright browser profile you log into by hand, kept under `playwright/`
- [ ] Log in through Shopify's login form in a setup test (2FA and bot checks make this fragile)

Recommended: Port it as is, profile `Default`, macOS only
:::

:::question
Q3. Which Chrome profile holds your Shopify admin login?

Baton defaults to `Default`. If your logged-in Shopify account lives in another profile (`Profile 1`, …; see chrome://version), the export needs that name.

- [x] `Default`
- [ ] Another profile (name it)

Recommended: `Default`
:::

:::question
Q4. Browser for the embedded specs?

- [x] Real Chrome (`channel: "chrome"`), headless by default, with a headed variant script — as Baton
- [ ] Playwright's bundled Chromium, like the existing specs

Recommended: Real Chrome (`channel: "chrome"`), headless by default, with a headed variant script
:::

:::question
Q5. How do the embedded specs check the stored session?

- [x] A read-only test-control procedure that returns the session's non-secret fields (`shopGid`, `scope`, expiry); never the tokens
- [ ] Only what the page shows; no session check
- [ ] Read the e2e stage's local database file directly

Recommended: A read-only test-control procedure that returns the session's non-secret fields (`shopGid`, `scope`, expiry); never the tokens
:::

:::question
Q6. What happens to the existing specs and the fake shops in `seed/test.sql`?

They test the app's own logic (members, the actor, sign-in, guards) and never call Shopify; the real store's session comes from the embedded spec's exchange.

- [x] Keep them as they are, in their own project without the login
- [ ] Move them onto the real e2e store (its domain differs per checkout, so the seed would be generated from `SHOPIFY_E2E_STORE`)

Recommended: Keep them as they are, in their own project without the login
:::

:::question
Q7. The webhook paths in `shopify.app.toml` answer 404 today. Do anything about it in phase 5?

Shopify retries failed deliveries, and an app that keeps failing compliance webhooks may be flagged; in dev and e2e it is noise in the logs.

- [x] No; note it, and handle it when the webhook routes are ported
- [ ] Add routes that answer 200 and log, so deliveries stop failing
- [ ] Remove the subscriptions from the dev app's TOML until the handlers exist

Recommended: No; note it, and handle it when the webhook routes are ported
:::

:::question
Q8. One embedded admin boot per spec file, serial, one worker — as Baton?

The admin is slow to load (seconds), and specs in one file share it.

- [x] Yes, serial within a file, one worker for the embedded project; the other projects keep their parallelism
- [ ] Fully parallel like the existing specs

Recommended: Yes, serial within a file, one worker for the embedded project; the other projects keep their parallelism
:::
