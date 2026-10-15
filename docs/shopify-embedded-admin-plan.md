# Plan: the sandbox as an embedded app in the Shopify admin

Plan date: 2026-10-14 · Alchemy `2.0.0-beta.81` · Shopify CLI `4.9.0` (Vite+ tool manager) · Base commit `5060ea0`.
Research: [Shopify embedded admin research](./shopify-embedded-admin-research.md). Every question there is answered; this plan implements the answers. Read the research first, §3 to §6 in particular: it explains why each step exists and what Baton does.

## 0. Rules for the implementer

- Follow `AGENTS.md`: Vite+ only (`vp`, never npm/npx), Effect idioms (Schema for every parse and check, `Match`, `Schema.TaggedError`, `Effect.fn`), its comment rules (JSDoc on symbols, a rule stated once, no references to plans or research docs in code or comments), and the Polaris layout rule (layout only in `src/web/components/screen/`).
- **No commits, no pushes, no staging deploy, no `shopify app deploy`.** A push to `main` deploys staging; `shopify app deploy` would push Baton's webhook subscriptions at Baton's app.
- **Do not run a Baton checkout's dev server while the sandbox's runs on the same store.** Main uses `sandbox-shop-00`, `wt-01` uses `sandbox-shop-01`. Check `pgrep -fl "shopify app dev"` before starting.
- **Do not touch the `wt-01` worktree** until Step 9 says so; its server may be running.
- Run `vp check --fix` after code changes. Each step ends green (`vp check`, the tests it names) before the next starts.
- Baton's code is the reference: port it closely, renaming to this repo's words (`Website`, `Backend`, `ShopKey`, `shop`), and leave out only what a step says to leave out. When a step and Baton disagree on a detail the step does not mention, Baton wins; record it in §12.
- Anything that differs from this plan, or any problem you could not solve, goes in §12 with the date and step. Do not silently change the design; if a step cannot work as written, stop that step, record why, and continue with what does not depend on it.

## 1. Outcome

- `vp run dev` in the main checkout starts `shopify app dev` on `sandbox-shop-00`, which runs `alchemy dev --stage dev-<user>` through a Cloudflare quick tunnel. Opening the app from the store's admin shows a Polaris page naming the shop, inside the admin iframe, at `/app`.
- The same in `wt-01` on `sandbox-shop-01` and its own port, at the same time.
- The Backend authenticates the admin as Baton does: it verifies the session token with the app's real secret, exchanges it for an offline access token, and stores it in `ShopSession`. A refresh inside the iframe comes back through the session-token bounce. Server functions called from the embedded page carry App Bridge's bearer token.
- The member area lives at `/shop` and `/shop/$key`; `/merchant/$key?token=` is unchanged.
- Without the CLI (integ, e2e, staging, `vp run test:e2e`) nothing changes: the fake key, the random secret and the local URL stay bound, and `vp check`, `vp test` and `vp run test:e2e` stay green.

## 2. The pieces, in dependency order

| #   | Piece                                                                 | Step |
| --- | --------------------------------------------------------------------- | ---- |
| 1   | Baton's app config in the repo; the CLI finds exactly one web         | 1    |
| 2   | Store per checkout, `app:dev` script, Vite admits the tunnel host     | 2    |
| 3   | The stack binds the CLI's key, secret and app URL when present        | 3    |
| 4   | Backend auth: `@shopify/shopify-api`, token exchange, `ShopSession`   | 4    |
| 5   | Website auth: middleware, guards, bounce and exit-iframe routes, CSP  | 5    |
| 6   | Member area to `/shop`; `/app` is the App Home; `/` redirects into it | 6    |
| 7   | `vp run dev` starts the CLI; a missing store is a hard error          | 7    |
| 8   | README and runbooks                                                   | 8    |
| 9   | The live check: main, then `wt-01`                                    | 9    |

Steps 1 to 3 can be verified with `shopify app info` and `vp check` alone. Step 4 and 5 are the bulk of the work and are testable without Shopify through the seeded `ShopSession` rows. Step 9 is the spike itself.

## 3. Step 1: Baton's app config

Copy, byte for byte, from `refs/baton/`:

- `shopify.app.toml` (client id `7c6cceb7f8f9991a543d43648b08e72d`, handle `baton-local`, `automatically_update_urls_on_dev = true`). Its webhook subscriptions name routes this repo does not have; `dev` never pushes them.
- `shopify.app.staging.toml`. This is load-bearing: its `web_directories = ["."]` narrows the CLI's web discovery to the repo root, so `refs/baton/shopify.web.toml` is not found (research §5.3). Keep its header comment; it says why. Never add `web_directories` to `shopify.app.toml`.

Write `shopify.web.toml` fresh:

```toml
name = "alchemy-sandbox1"
roles = ["frontend", "backend"]
webhooks_path = "/webhooks/app/uninstalled"
# No `port`: the CLI reads BACKEND_PORT from the app:dev script, which sets it to this
# checkout's WEBSITE_PORT, so .env is the one place the port is written and each checkout
# runs its own session. A port here would collide between checkouts.

[commands]
# The raw server, not `vp run dev`: the CLI's web command must be the long-lived foreground
# process that receives the variables it injects (APP_URL, SHOPIFY_API_KEY,
# SHOPIFY_API_SECRET, PORT); `vp run dev` is the controller, which places or adopts a server
# and exits. `alchemy dev` passes its environment through to the stack and the Vite child.
dev = "vp run dev:alchemy"
```

`.gitignore`: add `.shopify/` and `.shopify.lock` (the CLI's per-checkout store record, mkcert files and lock).

Verify: `shopify app info --config shopify.app.toml` prints no "You can only have one web configuration" error and lists the web under directory components (`📂 alchemy-sandbox1 /`). If it lists no web, the active config has `web_directories`; remove it. Do not run `shopify app dev` yet.

## 4. Step 2: store, script, Vite

### 4.1 `.env` and `worktree:init`

- `.env.example`: add `SHOPIFY_DEV_STORE=sandbox-shop-00` with a comment: this checkout's dev store, `sandbox-shop-NN` for worktree `wt-NN`; one store per checkout, because two `shopify app dev` sessions on one store overwrite each other's app URL.
- `.env` (untracked, main): add `SHOPIFY_DEV_STORE=sandbox-shop-00`.
- `scripts/worktree.ts` and `scripts/lib/worktree.ts`: `init` sets `SHOPIFY_DEV_STORE=sandbox-shop-NN` beside `WEBSITE_PORT`, verifies it on a second run the way it verifies the port, and refuses a store another checkout's `.env` already holds. Model it on Baton's `scripts/lib/worktree.ts` `worktreeEnv` and `claimConflicts`. The store name is a Schema: `sandbox-shop-` plus two digits, encoded from the index as `Checkout` is.

### 4.2 `app:dev`

`package.json`:

```json
"app:dev": "bash -o pipefail -c 'set -a && source .env && set +a && BACKEND_PORT=\"${WEBSITE_PORT:?WEBSITE_PORT is not set in .env}\" exec shopify app dev --config shopify.app.toml --store \"${SHOPIFY_DEV_STORE:?SHOPIFY_DEV_STORE is not set in .env}\"'"
```

`exec` so the CLI is the script's process (the controller finds and stops it by name and cwd). `source .env` also exports `WEBSITE_PORT`, which `alchemy dev` then reads from its environment, the same value `.env` holds.

### 4.3 `vite.config.ts`

Add `server.allowedHosts` to the `serve` branch. Alchemy's proxy forwards the tunnel's `Host` header untouched and Vite refuses hosts it does not know. The list: `localhost`, `127.0.0.1`, `.trycloudflare.com`, and the hostname of `APP_URL` when set (the CLI may hand a bare host or a URL; parse with a Schema that accepts both, as Baton's `parseAllowedHost` does by hand). `host`, `port` and `strictPort` stay as they are; Alchemy overrides the first two.

Verify: `vp check`; `vp run worktree:init` is not run here (Step 9 does, in `wt-01`).

## 5. Step 3: the stack binds the CLI's variables

### 5.1 What is present when

Under the CLI, `alchemy dev` has `APP_URL`, `SHOPIFY_API_KEY` and `SHOPIFY_API_SECRET` in its environment, and the process environment wins over `.env`. Nowhere else are they set. So "under the CLI" is "all three present".

### 5.2 Code

`src/backend/stack.ts`:

- A `ShopifyApp` value, read once: `Effect.all` of `Config.option(Config.String("APP_URL"))`, `Config.option(Config.String("SHOPIFY_API_KEY"))`, `Config.option(Config.Redacted("SHOPIFY_API_SECRET"))`, combined into `Option<{ appUrl, apiKey, apiSecret }>` that is `Some` only when all three are. JSDoc: these are the variables Shopify CLI injects into the web command it runs, so they exist only under `shopify app dev`; everywhere else the fakes below stand in.
- `wireBackend` gains an `appUrl` option beside `authOrigin` (the same `Alchemy.Output<string | undefined>` shape; the real stack passes the CLI's URL when `Some`, else `website.url`; the integ stack passes `backend.url`). The `Shopify` binding becomes: under the CLI `{ SHOPIFY_API_KEY: apiKey, SHOPIFY_API_SECRET: apiSecret (Redacted, so a `secret_text`), SHOPIFY_APP_URL: appUrl }`; otherwise today's `SHOPIFY_API_KEY` constant, `Alchemy.makeRandom("ShopifyApiSecret")` and `SHOPIFY_APP_URL: options.appUrl`. Keep `makeRandom("ShopifyApiSecret")` declared on every stage so its state record is unchanged; only the binding's value differs. Update the `wireBackend` JSDoc: the key and secret are real under `shopify app dev` and fakes elsewhere.
- Export the `SHOPIFY_API_KEY` fake from `stack.ts`'s neighbour as today (it stays in `src/backend/shopify.ts` or moves to `src/contract/shop.ts` if the Website needs it; the Website reads its own binding, so it should not).

`alchemy.run.ts`:

- The `Website` gets two more `env` entries: `SHOPIFY_API_KEY` (the CLI's or the fake; public, it goes in the page) and `SHOPIFY_APP_URL` (the CLI's or the Website's own URL output). The Website's props are built inside the class, so read `ShopifyApp` there too, or compute both in the stack body and pass them in; whichever keeps one read, the implementer chooses and records.
- `wireBackend(backend, { authOrigin: website.url, appUrl, delivery, e2eToken })`.

`test/integ/stack.ts`: `appUrl: backend.url`.

### 5.3 Verify

- `vp check`. `vp test --project integ` plans the Backend with the fakes.
- `vp run dev` (today's controller, plain `alchemy dev`) still starts and the home page loads; `.alchemy/local` shows the Backend bound `SHOPIFY_APP_URL` to the local URL. Stop it.
- Dry run under the CLI: `vp run app:dev` from a terminal. The CLI opens its tunnel, runs `vp run dev:alchemy`, and `.logs/dev/current` shows `alchemy dev` starting with the stage. It will not show a page in the admin yet (no `/app` route with App Bridge), and `/webhooks/app/uninstalled` 404s in the log. Confirm in the CLI's output that the app URL was updated for the store, then Ctrl-C. If the CLI refuses the store or the config, stop and record.

## 6. Step 4: Backend auth

### 6.1 Dependency

`vp add -E @shopify/shopify-api@15.0.1`, Baton's pin. Import `@shopify/shopify-api/adapters/web-api` once, at the top of `src/backend/shopify.ts`, as Baton's `Shopify.ts` does; it registers the runtime adapter for workerd.

### 6.2 Contract

`src/contract/shop.ts`:

- Move `InvalidSessionToken` here from `src/backend/shopify.ts` (it now crosses the binding as a typed failure).
- `AuthenticateAdminInput = Schema.Struct({ sessionToken: Schema.NonEmptyString })`.
- `AdminSession = Schema.Struct({ shop: ShopKey, shopGid: Schema.String })`, what the Website learns about an authenticated admin.

### 6.3 `ShopSessions`

New `src/backend/shop-sessions.ts`, a `Context.Service` over `SQL.D1(AuthDb)` in the shape of `Members`:

- Row schema `ShopSessionRow` (Baton's `ShopSession` in `src/lib/domain/Platform.ts`): `shop: ShopKey`, `shopGid`, `shopAgentId`, `scope: NullOr(String)`, `accessTokenExpiresAt: NullOr(Number)`, `accessToken: NullOr(String)`, `refreshToken: NullOr(String)`, `refreshTokenExpiresAt: NullOr(Number)`, the three plan columns `NullOr`. Epoch ms.
- Methods, each `Effect.fn` with `Effect.orDie` as `Members` does: `find(shop): Option<Row>`, `upsert(ShopSessionUpsert)` (Baton's SQL: insert the eight non-plan columns, `on conflict(shop) do update` setting `shopGid`, `scope`, the two tokens and the two expiries, never `shopAgentId` or the plan columns), `clearAccessToken(shop)`, `updateTokens({ shop, accessToken, accessTokenExpiresAt, refreshToken, refreshTokenExpiresAt })`, `updateScope(shop, scope)`, `remove(shop)`.
- `shopAgentId` is the shop domain: the actor is named by it here (`ShopActors.getByName(key)`); Baton stored the Agents SDK's id. The seed already does this.

`ShopAccess.shopExists` keeps its own one-column query or switches to `ShopSessions.find`; either, recorded.

### 6.4 `Shopify` service

Rewrite `src/backend/shopify.ts` over the library, keeping the service name, `layer` and `layerWith` shape, and the unit tests' expectations where they still apply:

- Config: `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET` (Redacted), `SHOPIFY_APP_URL`. `shopifyApi({ apiKey, apiSecretKey, hostName, hostScheme, apiVersion: ApiVersion.October26, isEmbeddedApp: true, future: Baton's two flags })`, `hostName`/`hostScheme` from the app URL as Baton's `makeShopifyApi` does. `layer` keeps the rule "absent while the stack is planned, broken in a running Worker" for all three; `layerWith` takes `{ apiKey, apiSecret, appUrl }` and the two existing tests pass an `appUrl` of `http://localhost`.
- `decodeSessionToken(token)`: `shopify.session.decodeSessionToken`, mapping `InvalidJwtError` to `InvalidSessionToken`; returns `{ dest, exp }` as today so `ShopAccess` and its tests are unchanged.
- `signSessionToken`: unchanged, hand-rolled, test control only. JSDoc stays.
- `authenticateAdmin(sessionToken)`: Baton's `decodeAdminToken` + `exchangeAndStore`, without the HTTP responses:
  1. decode; shop is the `dest` hostname, decoded through `ShopKey`;
  2. `ShopSessions.find(shop)`; rebuild Baton's offline `Session` (`id: shopify.session.getOfflineId(shop)`, `expires: accessTokenExpiresAt`, tokens, scope); if `Some` and `session.isActive(undefined, EMBEDDED_SESSION_REEXCHANGE_BUFFER_MS)` return `{ shop, shopGid }` (the library treats an undefined scope list as unchanged; checked in `session.mjs` 15.0.1);
  3. else `shopify.auth.tokenExchange({ shop, sessionToken, requestedTokenType: RequestedTokenType.OfflineAccessToken, expiring: true })`; an `InvalidJwtError`, or an HTTP 400 whose body says `invalid_subject_token`, is `InvalidSessionToken`; any other failure is a defect with the response in its cause (Baton's `tryShopifyPromise`);
  4. `shopGid`: the existing row's, else Baton's `query ShopGid { shop { id } }` through `new shopify.clients.Graphql({ session })`;
  5. `ShopSessions.upsert` with the exchanged session's fields and `shopAgentId: shop`; return `{ shop, shopGid }`.
     Log one line on the exchange path (`Shopify.authenticateAdmin: exchanged shop=…`); Step 9 reads it.
- Not ported: `authenticateAdmin`'s request rebuilding, document guards, `respondToInvalidSessionToken`, `withShopifyDocumentHeaders`, `getEmbeddedAppUrl` (the Website computes it), `validateWebhook`, `authenticateFlowAction`, `graphql`, the refresh family, `sessionIdFromShop`. Each returns with its first caller.

### 6.5 `BackendApi`

`authenticateAdmin(request, payload: AuthenticateAdminInput)` in `src/backend/api.ts`: decode the payload (a defect when it does not decode, as the others), call `Shopify.authenticateAdmin`, return the `AdminSession` encoded plain. Failure: `InvalidSessionToken`. It takes `RequestInfo` like every method and ignores it; the token is the credential.

### 6.6 Tests

- `test/unit/backend/shopify.test.ts`: the decode tests over `layerWith` with the new `appUrl`; the library's decoder must accept the hand-signed tokens (same claims as Baton's `mintSessionToken`). If it rejects one of the existing cases (for example the `nbf` or `aud` case), record which and keep Baton's behaviour.
- `test/unit/backend/api.test.ts` (look at `layers.ts` for how services are faked): `authenticateAdmin` with a minted token for `SANDBOX_SHOP` against an in-memory `ShopSessions` holding the seed's row (far-future expiry, non-null token) returns the shop and never calls the library's exchange; a token signed with another secret fails with `InvalidSessionToken`. The live exchange path is Step 9's.
- `vp test --project unit` and `--project integ` green. The integ stage seeds the same rows, so the Backend starts with the library configured against the fakes.

## 7. Step 5: Website auth

### 7.1 What the Website knows

`src/web/server/env.server.ts` already proxies the Website's bindings; after Step 3 `env.SHOPIFY_API_KEY` and `env.SHOPIFY_APP_URL` exist on `WebsiteEnv`.

### 7.2 Server function and middleware

New `src/web/server/shopify.ts`:

- `shopifyAdmin`, a `createMiddleware({ type: "function" }).server(...)`: the token is the `Authorization: Bearer …` header (`getRequestHeader("authorization")`, which App Bridge adds to every same-origin `fetch` from the embedded page, server-function calls included), else the `idToken` in the function's data (the document load during SSR, where `beforeLoad` calls the function in-process with the `id_token` search param). It calls `backend().authenticateAdmin(requestInfo(), { sessionToken })`. On `InvalidSessionToken` (through `rescue`): with a bearer, respond `401` with `X-Shopify-Retry-Invalid-Session-Request: 1` and an empty body (App Bridge retries with a fresh token); without one, `redirect({ href: sessionTokenBounce(...) })` of §7.3. On success, `next({ context: { shop, shopGid } })`.
- `authenticateApp = createServerFn({ method: "GET" }).middleware([shopifyAdmin]).validator(Schema of { idToken?: string })`, returning `{ shop, apiKey: env.SHOPIFY_API_KEY }`.
- The bounce and embedded URL builders, pure functions over the validated search, tested in `test/unit/web/`:
  - `embeddedAppUrl(host, apiKey)`: `https://${decodedHost}/apps/${apiKey}` where `host` is base64 of `admin.shopify.com/store/<store>` or `<shop>.myshopify.com/admin` (Shopify's `host` param; the library's `getEmbeddedAppUrl` does the same). Decode with `Schema.StringFromBase64` and a pattern check on the result.
  - `sessionTokenBounce(appUrl, path, search)`: `/auth/session-token?<search without id_token>&shopify-reload=<appUrl><path>?<search without id_token>`, Baton's `respondToInvalidSessionToken` shape, with `appUrl` from the binding (inside the proxies the request URL is not the public one).
  - `exitIframeDestination(appUrl, candidate)`: Baton's `parseExitIframeDestination`, as a Schema: same origin as `appUrl`, or `https://admin.shopify.com/store/<x>/charges/<y>/pricing_plans` with no search or hash; credentials rejected.

### 7.3 Routes

- `src/web/routes/auth.session-token.ts`, server route `GET`: Baton's App Bridge-only page: `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="shopify-api-key" content="…"><script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script></head><body></body></html>`, `content-type: text/html;charset=utf-8`; when `?shop` decodes as `ShopKey`, also `Content-Security-Policy: frame-ancestors https://<shop> https://admin.shopify.com https://*.spin.dev https://admin.myshopify.io https://admin.shop.dev;` and Baton's `Link` preconnect/preload header. App Bridge reads `shopify-reload` from the URL itself.
- `src/web/routes/auth.exit-iframe.ts`, server route `GET`: the same page plus `<script>window.open(<JSON of dest, "<" escaped>, "_top")</script>`; `dest` is `?exitIframe` through `exitIframeDestination`, default the app URL; a rejected destination is `400 Bad Request`.
- `src/web/routes/app.tsx` becomes the App Home (after Step 6 has moved the member area):
  - `validateSearch` with a Schema: `shop`, `host`, `embedded`, `id_token`, all optional strings (Shopify also sends `locale`, `session`, `timestamp`, `hmac`; keep them through `search` untouched).
  - `beforeLoad`, Baton's document guards as redirects, in order: no `shop` or no `host` → `redirect` to `/auth/session-token` (App Bridge re-embeds); `embedded !== "1"` → `redirect` to `embeddedAppUrl(host, apiKey)`; no `id_token` → `redirect` to `sessionTokenBounce(...)`; else `await authenticateApp({ data: { idToken } })` into context `{ shop, apiKey }`. The API key for the first two redirects comes from a tiny server function or from `authenticateApp`'s module; one read, implementer's choice.
  - `head: ({ match }) => ({ meta: [{ name: "shopify-api-key", content: apiKey }], scripts: [{ src: APP_BRIDGE_URL }] })`. `HeadContent` renders before the Polaris script in `__root.tsx`, so App Bridge is the first script. Put `APP_BRIDGE_URL` beside `POLARIS_URL` in `src/web/components/polaris.ts`.
  - `headers: () => ({ "Content-Security-Policy": "frame-ancestors https://<shop> https://admin.shopify.com https://*.spin.dev https://admin.myshopify.io https://admin.shop.dev;" })` with the shop from the validated search (through `ShopKey`; without one, no header).
  - `component`: one Polaris page: `<s-page heading="Alchemy-sandbox1"><s-section heading="We got here">…the shop's domain…</s-section></s-page>`. No `MemberBar`, no Better Auth. Keep it to that.
- `src/web/routes/index.tsx`: `beforeLoad` redirects to `/app` with the current search when `shop` is in it (Baton's `index.tsx`); everything else unchanged.

### 7.4 Verify

- `vp check`; unit tests for the three builders.
- `vp test --project browser` still green (no browser test for the new page is required by this plan).
- `vp run dev` (still today's controller): `GET /app` without search redirects to `/auth/session-token`; `GET /auth/session-token?shop=alchemy-sandbox1.myshopify.com` returns the App Bridge page with the CSP header; `GET /app?shop=…&host=<base64>&embedded=1&id_token=<token minted through test control, see `test/e2e/fixtures.ts`>` renders the page naming the shop, through the reuse path. Record the exact commands used.
- Start's CSRF middleware is on for server functions by default; a same-origin call from the iframe passes it. If a later bearer call from the embedded page is refused, that is the first suspect (record under Issues).

## 8. Step 6: Baton's layout

Move the member area; `/app` is now the embedded area of Step 5.

- `src/web/routes/app.tsx` (guard + `MemberBar`) → `shop.tsx` with `createFileRoute("/shop")`; `app.index.tsx` → `shop.index.tsx` (`/shop/`, links to `/shop/${SANDBOX_SHOP}`); `app.shop.$key.tsx` → `shop.$key.tsx` (`/shop/$key`, `BackLink` to `/shop`). Baton's `/shop` index is "Your stores"; keep the heading "Member area" or take Baton's wording, recorded.
- `src/web/client/session.ts` `homeFor`: `"/shop"`. `src/web/components/MemberBar.tsx`: `to="/shop"` and its JSDoc. `src/web/server/shop.ts`: the sign-in `redirect` path and its JSDoc. `src/web/client/actor-connection.ts`: JSDoc mention.
- `src/backend/api.ts` and `src/backend/test-control.ts`: the magic link's default `callbackURL` is `/shop`. `test/unit/backend/auth.test.ts`: the two `/app` strings.
- `test/e2e`: `shell.spec.ts` (`goto("/shop")`), `http.spec.ts` (the three member-area assertions: `/sign-in?redirect=%2Fshop`, `/shop`), `shop.spec.ts` (`path`), `actor-upgrade.spec.ts` (`/shop/${otherShop}`). `fixtures.ts` and the merchant lines stay on `/merchant/...`.
- `src/web/routeTree.gen.ts` regenerates on the next `vp check` or dev start; do not edit it.
- README line 25 to 27 (the member page's path) and the `/app` mentions in `docs/glossary.md` if any.

Verify: `vp check`, `vp test`, `vp run test:e2e` (on the e2e stage, no CLI, no Shopify) all green.

## 9. Step 7: the controller starts the CLI

`scripts/dev.ts`, keeping its shape and its module JSDoc updated:

- **Config.** `Config.String("SHOPIFY_DEV_STORE")` beside `loadPort`, both from `.env` through `--env-file`; a missing or empty store fails with `SHOPIFY_DEV_STORE is not set: add it to .env (sandbox-shop-NN, NN the worktree index)`. There is no plain-`alchemy dev` fallback. The client id is read from `shopify.app.toml` with a Schema over the `client_id = "…"` line (Baton's `loadConfig` uses a regex; a Schema here), for the admin URL below.
- **Launch.** Every placement runs `vp run app:dev` instead of `vp run dev:alchemy` (`runDev`, `launchServer`'s pane command). The JSDoc rule "the raw server stays separate from the public `dev` script" now reads: `app:dev` is the CLI, `dev:alchemy` the server the CLI runs; `dev` starts the first.
- **Find.** `serverPids` matches both: Alchemy's ` dev --stage <stage>` process as today (adoption, status, logs) and the CLI, `pgrep -f "shopify app dev"` filtered by cwd (Baton `serverPids`, `scripts/dev.ts:187`). `findServerPane` matches a pane whose foreground process is either.
- **Stop.** SIGTERM goes to the CLI's pids, Alchemy's pids, their descendants and the port's listeners (`withDescendants` already walks the tree), after the Ctrl-C attempt in a pane. Then wait for both to be gone.
- **Status and summary.** Add the tunnel URL, read from the environment of whatever listens on the port (`ps -wwwE -p <pid> -o command=` matched for `APP_URL=https://…`; Baton `findTunnelUrl`, `scripts/dev.ts:238`), and the admin URL `https://admin.shopify.com/store/<store>/apps/<client_id>`. `summarize` prints `app: <admin URL>` and `tunnel: <url>` under `dev:`; `status` adds them and `--json` carries them.
- **Not ported:** Baton's install wait (`hasShopSession`, `finishStart`'s reopen loop) and `--seed`. The app is already installed on the sandbox stores, and the first embedded load writes the row through token exchange.
- `db:reset` keeps working: it stops, removes `.alchemy/local` and `.alchemy/state`, starts; the CLI's `.shopify/` is not touched.

Verify: `vp run dev` from a terminal in the main checkout; `vp run dev:status` reports healthy with the tunnel and admin URLs; `vp run dev:stop` leaves no `shopify app dev`, `alchemy dev`, `workerd` or port listener behind (`pgrep -fl "shopify app dev|alchemy dev|workerd"`, `lsof -nP -iTCP:$(pnpm port) -sTCP:LISTEN`). Removing `SHOPIFY_DEV_STORE` from `.env` and running `vp run dev` prints the hard error and starts nothing; put it back.

## 10. Step 8: docs

- `README.md`: "Run locally" says the server is `shopify app dev` on this checkout's store, which runs `alchemy dev` through a tunnel; how to open the app (the admin URL `vp run dev` prints); the one-store-per-checkout rule; that `vp run dev` fails without `SHOPIFY_DEV_STORE`; that `shopify` comes from Vite+'s tool manager (`shopify version`), not brew or npm. The architecture paragraph: `/app` is the embedded App Home authenticated by Shopify session tokens and token exchange; `/shop` the member area; `/merchant/<shop>?token=` the merchant page test control mints tokens for. Replace "fakes until the Shopify slice" with what is now real under the CLI and fake elsewhere.
- `docs/worktrees-runbook.md`: the layout table gains `SHOPIFY_DEV_STORE` (`sandbox-shop-NN`); the bootstrap action is unchanged (`worktree:init` writes the store; `vp run dev` now starts the CLI). `docs/website-port-runbook.md`: a line that the CLI proxies to `WEBSITE_PORT` through `BACKEND_PORT`, so the port rule is unchanged.
- `docs/glossary.md`: only if a term changed meaning (`/app`).

## 11. Step 9: the live check

Main checkout first, then `wt-01`.

1. `pgrep -fl "shopify app dev"`: no Baton session on `sandbox-shop-00` or `-01`. If there is one, stop and ask.
2. `vp run dev`. Note the tunnel URL and the admin URL it prints. In `.logs/dev/current`, `alchemy dev` starts under `dev-<user>`; the CLI's sample `app/uninstalled` webhook gets a 404 and nothing else happens.
3. Open the admin URL in a browser signed in to the Partner organization. Expected: the admin loads the app, the iframe shows the Polaris page with `sandbox-shop-00.myshopify.com`, the log shows `Shopify.authenticateAdmin: exchanged shop=sandbox-shop-00.myshopify.com` once. Check the row: `sqlite3 "$(ls .alchemy/local/**/*.sqlite | grep -i authdb | head -1)" "select shop, scope, accessTokenExpiresAt from ShopSession"` (find the D1 file under `.alchemy/local`; record the actual path). If the embedded load shows Shopify's install prompt first, accept it; the scopes are `read_orders,read_products`.
4. Refresh inside the iframe (the browser's reload while the app is focused, and the admin's own reload). Expected: no dead page; a second load goes through the reuse path and logs no exchange.
5. Edit the page's heading; expected: the iframe updates (HMR) or reloads; record which, and any `Blocked request. This host … is not allowed` in the log (that is `allowedHosts`).
6. `vp run dev:status`, then `vp run dev:stop`; confirm nothing is left (Step 7's checks).
7. `wt-01`: open a thread there (the worktrees runbook), `vp run worktree:init` (adds `SHOPIFY_DEV_STORE=sandbox-shop-01` to its `.env`, or verifies it), `vp run dev`, the same checks on `sandbox-shop-01` while main's server also runs. Both admins show their own shop; `pnpm port` differs; the two tunnels differ.
8. With main's CLI running, `vp run test:e2e` in main still passes on the e2e stage.

Record every observation under §12 "Spike results", including the tunnel hostnames, timings and anything the CLI printed that was unexpected.

## 12. Deviations and issues

For the implementer. Append as you go; keep each entry short and dated, with the step. A deviation is anything built differently from the step that specified it; an issue is anything observed that the plan did not predict (a failing assumption, an API that differs from the sketch, a flaky test, a limit hit). Do not rewrite the steps above; this section is the record.

### Deviations

- 2026-10-14, Step 1: `shopify.app.staging.toml` copied byte for byte as the step says, header comment included; that comment still points at Baton's `docs/shopify-web-toml-conflict-research.md` and `refs/bang/…`, neither of which exists in this repo (Baton's doc is at `refs/baton/docs/`). Left as is because the step says byte for byte; fix the pointer when staging gets a real config.
- 2026-10-14, Step 2: `worktree:init` on an existing `.env` that lacks `SHOPIFY_DEV_STORE` appends it (Step 9 item 7 says "adds … or verifies"); a present but different or malformed value fails with "fix it by hand", as the port does. Baton's `envDisagreements` fails on a missing key instead. The store codec is `DevStore` in `scripts/lib/worktree.ts` (index 0 to 99, so main's `00` is valid, unlike `Checkout`).
- 2026-10-14, Step 2: `allowedHosts` reads only `APP_URL`, as the step says; Baton also reads `HOST` and `SHOPIFY_APP_URL` (the CLI sets `HOST` to the same URL and never sets `SHOPIFY_APP_URL`). The URL-or-bare-host parse is a Schema union (`http(s)://` URL, or a bare host read as `https://<host>`).
- 2026-10-14, Step 3: `ShopifyApp` is a `Config` read in two places: the `Website` class body (its props are built inside the class) and `wireBackend`. Both read the same process environment, so they cannot disagree. `wireBackend` takes `appUrl` and uses it only in the fake branch; under the CLI it binds the CLI's URL itself, so both stacks pass their own URL unconditionally (`website.url`, `backend.url`).
- 2026-10-14, Step 3: the Website's `SHOPIFY_APP_URL` outside the CLI is `Cloudflare.Worker.URL` (Alchemy's self-URL binding: the dev proxy URL locally, the deployed URL on staging), since the class cannot reference its own `url` output.
- 2026-10-14, Step 4: `ShopAccess.shopExists` keeps its own one-column query (recorded choice); `ShopSessions` is provided to `Shopify` only (`Shopify.layer.pipe(Layer.provide(ShopSessions.layer))` in the Worker).
- 2026-10-14, Step 4: the library instance (`shopifyApi(...)`) is built lazily on first use (`Effect.cached`), so planning the stack, where the three bindings are absent, never builds it; `shopifyApi` throws on an empty key, secret or host. Baton builds it eagerly at layer construction because its config is always present. No `logger` option: Baton sets `LogSeverity.Warning` off local; this repo has no `ENVIRONMENT` and the default is Info.
- 2026-10-14, Step 4: `decodeSessionToken` maps only `InvalidJwtError` to `InvalidSessionToken`; any other rejection is a defect. `authenticateAdmin` rebuilds the stored `Session` without Baton's "row that fails to rehydrate is absent" fallback: a row that does not decode is a defect, as every other repository read here. The shop is the `dest` claim through `URLFromString` then `ShopKey`.
- 2026-10-14, Step 4: `ShopSessionRow`/`ShopSessionUpsert` live in `src/backend/shop-sessions.ts` (not the contract): only the Backend reads rows. `shopGid` and `shopAgentId` are plain `Schema.String` (Baton brands them `NonEmptyString`). `ShopSessions.layerTest(rows)` is the in-memory fake; `test/unit/backend/layers.ts` gained `testShopify(rows)` and `TEST_SHOPIFY_APP`, used by the api, auth and test-control unit tests (every `BackendApi` test now needs `Shopify`).
- 2026-10-14, Step 4: the reuse-path test asserts the answer and that the `ShopSession` row is unchanged; it does not stub the library's fetch. An exchange there would reach the network for `alchemy-sandbox1.myshopify.com` and fail as a defect, so a pass means no exchange ran.
- 2026-10-14, Step 5: the three URL builders and `frameAncestors` are in a new pure module `src/web/server/shopify-urls.ts`, not `src/web/server/shopify.ts`, which imports `env.server.ts` (`cloudflare:workers`) and cannot load in a unit test. `src/web/server/shopify.ts` holds the middleware, `authenticateApp`, `getShopifyApp` (the "tiny server function" for the API key and app URL the first two guards need; recorded choice) and `appBridgePage`. Test: `test/unit/web/server/shopify-urls.test.ts`.
- 2026-10-14, Step 5: `shopifyAdmin` refuses a browser server-function call (`x-tsr-serverFn: true`) that has no bearer with a bare `401`, Baton's `resolveDocumentGuards` rule; the step only names the bearer `401` and the document bounce, and a server-function request has no document URL to bounce to. The bounce is built from the request URL's path and search, which during SSR is the document's.
- 2026-10-14, Step 5: `/app` has no `validateSearch`. The router parses search values as JSON (`embedded=1` arrives as the number `1`) and rewrites the URL whenever `validateSearch` returns anything else: a schema that coerced `1` back to `"1"` produced a 307 to `embedded=%221%22`. The guards decode the raw `location.searchStr` through the `AppSearch` Schema instead, and every redirect is built from that string.
- 2026-10-14, Step 5: the App Home's CSP header takes the shop from the authenticated route context (`match.context.shop`), not from the search: the route's `headers` receives no raw search string, and the authenticated shop is the token's own `dest`. Redirects carry no CSP; the App Bridge-only pages carry it from `?shop`.
- 2026-10-14, Step 5: the App Bridge pages use `<meta name="shopify-api-key">` plus a plain script tag, as the step writes; Baton puts `data-api-key` on the script. The `/app` route's `head` does the same (meta, then `scripts: [{ src: APP_BRIDGE_URL }]`); the rendered head has the meta before App Bridge and App Bridge as the first `<script>` (a `modulepreload` link precedes it).
- 2026-10-14, Step 5: `embeddedAppUrl` decodes `host` with padding added first: Shopify sends `host` unpadded and `Schema.StringFromBase64` rejects unpadded input (the library uses `atob`, which accepts it). A `host` that does not decode to an admin host falls back to the App Bridge-only page.
- 2026-10-14, Step 5: `APP_BRIDGE_URL` and `CDN_URL` sit in `src/web/components/polaris.ts` beside `POLARIS_URL`; the polaris module JSDoc's "No App Bridge loads beside it" now says "outside the embedded App Home".
- 2026-10-14, Step 6: done together with Step 5's `/app` rewrite (`app.tsx` could only become the App Home once the member area had moved). Kept the heading "Member area" on `/shop`. Four e2e URL waits the step did not list also moved to `/shop`: `test/e2e/fixtures.ts` (`ownMember`), `test/e2e/auth.setup.ts`, `test/e2e/sign-in.spec.ts`, `test/e2e/shell.spec.ts` (`/\/app$/` and `redirect=%2Fapp`). `src/web/routes/merchant.$key.tsx`'s JSDoc now says it sits outside `/shop`.
- 2026-10-14, Step 7: `serverPids` matches the CLI with `pgrep -f "shopify app dev|@shopify/cli/.*bin/run\.js app dev"` (`CLI_PROCESS`), not Baton's `shopify app dev`, because the Vite+-managed CLI's command line never contains that phrase (Issues, Step 3). `findServerPane` uses the same pattern through a Schema `isPattern` guard.
- 2026-10-14, Step 7: `SHOPIFY_DEV_STORE` is read with `Config.NonEmptyString` (so `SHOPIFY_DEV_STORE=` is the same hard error as a missing key) and required only by `start` (and so `db:reset`); `status` reads it optionally and reports `store`, `app`, `tunnel` (null when unknown) in text and `--json`. The client id comes from the `client_id = "<32 hex>"` line through a `TemplateLiteralParser`. The tunnel is the `APP_URL=https://…` word in `ps -wwwE` of the port's listener, decoded with a Schema.
- 2026-10-14, Step 8: README, worktrees runbook (a `SHOPIFY_DEV_STORE` column and `.shopify/` per checkout), website-port runbook (the `BACKEND_PORT` line). `docs/glossary.md`: only the "Merchant" row, whose "until the Shopify slice" was no longer true; `/app` had no glossary entry.

### Issues

- 2026-10-14, Step 3: under Vite+'s tool manager the CLI's process is `node …/@shopify/cli/./bin/run.js app dev --config … --store …`; no process command line contains `shopify app dev`, so `pgrep -fl "shopify app dev"` (§0, Step 9 item 1, and Baton's `serverPids`) never finds a running session. The check that works is `pgrep -fl "bin/run.js app dev"`. Every pre-start check in this run used both.
- 2026-10-14, Step 3: SIGINT to the CLI's node process (what Ctrl-C does when it is not a terminal's foreground group) ends the CLI and its `cloudflared`, but leaves the `alchemy dev` tree (bash, `alchemy dev`, `s6-log`, workerd) running and listening on `WEBSITE_PORT`. `vp run dev:stop` cleaned it up. Step 7's stop must kill both trees, as it says.
- 2026-10-14, Step 3: under the CLI the real `SHOPIFY_API_SECRET` lands in `.alchemy/state/…/Backend.json` as a `__redacted__` value in clear JSON, as `BetterAuthSecret` already does. `.alchemy/` is untracked; noted because it is the first real third-party secret in local state.
- 2026-10-14, Step 3: the main checkout had a dev server running in a herdr pane (`wC:p2`, plain `alchemy dev`) when this work began; the running server re-planned the Step 3 changes on its own (Website gained `SHOPIFY_API_KEY`/`SHOPIFY_APP_URL`, `Backend/Shopify` updated). It was stopped with `vp run dev:stop` for the dry run and not restarted.
- 2026-10-14, Step 5: the dev stage has no `E2E_TOKEN`, so test control (the plan's suggested token source for the Step 5 check) is off under `vp run dev`. The check minted the token with a throwaway Node script (`/tmp/sbx-dryrun/mint.mjs`, not in the repo) that signs the same claims as `signSessionToken` with the stage's random `ShopifyApiSecret` read from `.alchemy/state/Alchemy-sandbox1/dev-mw/Backend.json`. That state stores the random secret as a bare `__redacted__` string, the CLI's real secret as a JSON-encoded `Redacted`.
- 2026-10-14, Step 5: the `migrations/0002_baton_schema.sql` header still says the ShopSession token columns hold seed values "until the Shopify slice"; not edited (applied migrations stay as written). The `docs/glossary.md` "Merchant" row said the same and was updated in Step 8.
- 2026-10-14, Step 7: under the CLI in a herdr pane (a TTY), the CLI injects `FORCE_COLOR=1` into the web command's environment, which beats `dev:alchemy`'s `NO_COLOR=1`: `.logs/dev/current` gets ANSI colour codes (`[37m[21:00:35.443][0m [32mINFO[0m …`). Under the non-TTY dry run it did not. Not fixed; `grep` still works on the text. Also seen: the CLI sets `NODE_ENV=development` and `APP_ENV=development` on `alchemy dev`, while Alchemy's proxy child (the port listener) runs with `NODE_ENV=production`.
- 2026-10-14, Step 9: `lsof -nP -iTCP:$(pnpm port) -sTCP:LISTEN` (Step 7's check) does not work as written: `pnpm port` prints its script header line (`$ node --env-file=.env -p …`) on stdout before `3900`, so the substitution is not a port. The checks here used `lsof -nP -iTCP:3900 -sTCP:LISTEN`.
- 2026-10-14, Step 9: every start under the CLI changes the tunnel, so `Backend/Shopify`, `Backend/AuthOrigin` and `Website/SHOPIFY_APP_URL` are binding updates on each start (as predicted; no replacement). `Backend/AuthOrigin` updating too was not predicted; it is bound to `website.url`, which did not change, so the cause is unknown.

- 2026-10-14, Step 5 (review): `/auth/exit-iframe` escaped `<` in its inline script as `<` (a no-op) instead of Baton's `\u003c`; fixed to `\u003c`. No exposure in practice, since `exitIframeDestination` percent-encodes `<` in any accepted URL, but the escape is the rule.

### Spike results (Step 9)

- 2026-10-14, Step 3 dry run: `vp run app:dev` (non-TTY, output to a file) in main. The CLI printed "Using shopify.app.toml … Dev store: sandbox-shop-00.myshopify.com, Update URLs: Yes", preview URL `https://admin.shopify.com/store/sandbox-shop-00/apps/7c6cceb7f8f9991a543d43648b08e72d?dev-console=show`, "Proxy server started on port 57261", ran `vp run dev:alchemy`, sent the sample `APP_UNINSTALLED` webhook ("delivery failed"), "Access scopes auto-granted: read_orders, read_products", "Using URL: https://consumer-beth-local-cruz.trycloudflare.com". It retried twice ("App isn't responding yet") while `alchemy dev` planned (~12 s to Website ready). `alchemy dev` started on `dev-mw`; Backend and Website state then held the real client id and the tunnel URL as `SHOPIFY_API_KEY`/`SHOPIFY_APP_URL`. `GET /` through the tunnel answered 200, no "Blocked request" in the log. `s6-log`'s `1` action also echoes Alchemy's log lines into the CLI's output.
- 2026-10-14, Step 5 check (plain `alchemy dev`, `vp run dev` placed it in herdr pane `wC:p2`): `curl -s -o /dev/null -w '%{http_code} %{redirect_url}' http://localhost:3900/app` → `307 …/auth/session-token`. `curl -s -D - 'http://localhost:3900/auth/session-token?shop=alchemy-sandbox1.myshopify.com'` → 200, `content-type: text/html;charset=utf-8`, the `frame-ancestors` CSP and the `Link` header, body = the App Bridge-only page with `fake-api-key`; without `?shop`, no CSP. With `HOST=$(printf 'admin.shopify.com/store/alchemy-sandbox1' | base64 | tr -d '=')`: `/app?shop=…&host=$HOST` → 307 `https://admin.shopify.com/store/alchemy-sandbox1/apps/fake-api-key`; `+&embedded=1&locale=en` → 307 to `/auth/session-token?…&locale=en&shopify-reload=http%3A%2F%2Flocalhost%3A3900%2Fapp%3F…` (no `id_token`); `+&embedded=1&id_token=<minted>` → 200 with the CSP header, the page shows `alchemy-sandbox1.myshopify.com` under "We got here", and no `exchanged` line in the log (reuse path); `id_token=garbage` → the bounce. `/auth/exit-iframe?exitIframe=https://evil.example.com` → 400; `?exitIframe=/app` → `window.open("http://localhost:3900/app", "_top")`. `/?shop=…&host=x` → 307 `/app?shop=…&host=x`.
- 2026-10-14, Step 7 check: with `SHOPIFY_DEV_STORE` removed from `.env`, `vp run dev` printed `ERROR  SHOPIFY_DEV_STORE is not set: add it to .env (sandbox-shop-NN, NN the worktree index)` and started nothing (no new process, port 3900 free); `.env` restored. With it, `pgrep -fl "shopify app dev"` and `pgrep -fl "bin/run.js app dev"` empty, then `vp run dev` (21:00:24): `ok started in herdr tab "dev" (pane wC:p2)`, `ok server answering (20.8s)`, summary `app: https://admin.shopify.com/store/sandbox-shop-00/apps/7c6cceb7f8f9991a543d43648b08e72d`, `tunnel: https://fate-dans-despite-midlands.trycloudflare.com`. `vp run dev:status` and `vp run dev:status --json` healthy with `pids` [CLI 2771, Alchemy 3057], `store`, `app`, `tunnel`. Through the tunnel: `/` 200, `/app` 307 to `/auth/session-token`. `vp run dev:stop`: `ok stop (1.2s)` (Ctrl-C in the pane); afterwards `pgrep -fl "shopify app dev|bin/run.js app dev|alchemy dev|workerd|cloudflared"` showed only `wt-01`'s server, another repo's workerd and a Homebrew `cloudflared` that is not the CLI's; `lsof -nP -iTCP:3900 -sTCP:LISTEN` and the GraphiQL port 3457 empty.
- 2026-10-14, Step 9 item 1 (main): `pgrep -fl "shopify app dev"` and `pgrep -fl "bin/run.js app dev"` empty; `ps` showed no `@shopify/cli` process. No Baton session (the first pattern alone would not have shown a Vite+-managed one; see Issues).
- 2026-10-14, Step 9 item 2 (main): `vp run dev` at 21:02:16, answering at 21:02:37 (20.2 s): `server: herdr tab "dev" (pane wC:p2)`, `app: https://admin.shopify.com/store/sandbox-shop-00/apps/7c6cceb7f8f9991a543d43648b08e72d`, `tunnel: https://headline-modelling-bags-acre.trycloudflare.com`. `.logs/dev/current`: `Dev · dev-mw`, plan "2 to update, 3 binding changes" (`Backend/AuthOrigin`, `Backend/Shopify`, `Website/SHOPIFY_APP_URL`), Seed skipped, Website ready at `http://localhost:3900` about 8 s after Alchemy started; plus `NO_COLOR … ignored due to FORCE_COLOR` warnings and ANSI codes (Issues). No webhook line in the log: the CLI sends the sample `app/uninstalled` webhook only on the first run in a directory, which was the Step 3 dry run, and its failure ("APP_UNINSTALLED webhook delivery failed") shows only in the CLI's own output. Through the tunnel with the real key: `/?shop=sandbox-shop-00.myshopify.com&host=…` → 307 `/app?…`; `/app?shop&host` → 307 `https://admin.shopify.com/store/sandbox-shop-00/apps/7c6cceb7f8f9991a543d43648b08e72d`; `+&embedded=1` → 307 to `/auth/session-token?…&shopify-reload=https%3A%2F%2Fheadline-modelling-bags-acre.trycloudflare.com%2Fapp%3F…` (so `SHOPIFY_APP_URL` is the tunnel); `/auth/session-token` carries `shopify-api-key` = `7c6cceb7f8f9991a543d43648b08e72d`.
- 2026-10-14, Step 9 item 8 (main): with main's CLI running, `vp run test:e2e` passed, 20 of 20 (24.6 s, 21:02:51 to 21:03:17); `vp run dev:status` stayed healthy afterwards with the same tunnel.
- 2026-10-14, Step 9 item 6 (main): `vp run dev:status` healthy (`store: sandbox-shop-00`, app and tunnel as above); `vp run dev:stop` → `ok stop (1.2s)`; `pgrep -fl "shopify app dev|bin/run.js app dev|alchemy dev|workerd|cloudflared"` showed only `wt-01`'s server (pid 35871 and its workerd), another repo's workerd and the Homebrew `cloudflared` (not the CLI's); `lsof -nP -iTCP:3900 -sTCP:LISTEN` empty. The main checkout's dev server is left stopped.
- 2026-10-14, Step 9 item 3 (main): done by the user in Chrome. `vp run dev` at 21:23 (tunnel `else-commander-file-revolutionary.trycloudflare.com`); the admin loaded `admin.shopify.com/store/sandbox-shop-00/apps/baton-local/app` and the iframe showed the Polaris page with `sandbox-shop-00.myshopify.com`; no install prompt. Log: `[Backend] Shopify.authenticateAdmin: exchanged shop=sandbox-shop-00.myshopify.com` once, at 21:24:53. The row, in `.alchemy/local/d1/cloudflare-runtime-D1DatabaseObject/<hash>.sqlite` (the file whose `ShopSession` holds the shop; several D1 files exist, one per stage): `shopGid gid://shopify/Shop/78879752329`, `scope read_orders,read_products`, `accessTokenExpiresAt` 24 h out, `refreshTokenExpiresAt` 90 days out, both tokens present. The sqlite3 one-liner in the step does not find the file: D1's files are not named after the binding.
- 2026-10-14, Step 9 item 3 (main): the controller placed the CLI in herdr workspace `alchemy-sandbox1` (wC), tab `dev`, pane `wC:p2`; the user, focused on the `wt-01` workspace (wD), did not see it. `vp run dev:status` names the pane; the workspace is the main checkout's, as the controller's rule 2 says.
- 2026-10-14, Step 9 item 4 (main): done by the user in Chrome: a reload inside the iframe came back with the page; main's log still shows one `exchanged` line, so the reload took the reuse path. The admin's own reload was not tried separately.
- 2026-10-14, Step 9 item 3 (review): the first embedded load logged a Vite `[import-protection] Import denied in client environment` warning for `appBridgePage` in `src/web/server/shopify.ts`, which read `env` (the server-only bindings) in plain code while `app.tsx`, a client-rendered route, imported the module; Start strips server-function and middleware bodies from the client build but not a plain export. Moved `appBridgePage` to `src/web/server/app-bridge-page.ts`, imported only by the two server routes. The warning no longer appears on a fresh `/app` load.
- 2026-10-14, Step 9 items 5 and 7: not done; the user chose to stop here. HMR through the tunnel and `wt-01` on `sandbox-shop-01` are unverified. wt-01's old plain `alchemy dev` (port 3901) was stopped with `vp run dev:stop` so it would not be mistaken for main's server.
 They need a browser signed in to the Partner organization (the embedded load, the token exchange and the `ShopSession` row, refresh inside the iframe, HMR through the tunnel) and the `wt-01` worktree, which is the user's and was not touched. No `Shopify.authenticateAdmin: exchanged` line has been observed yet: the live exchange path is unexercised.

### API confirmations

Facts about `@shopify/shopify-api`, Shopify CLI, TanStack Start or Alchemy that the plan asserted and the implementation confirmed or refuted; one line each.

- 2026-10-14, Step 1: confirmed. `shopify app info --config shopify.app.toml` lists one web, `📂 alchemy-sandbox1 /`, no conflict error.
- 2026-10-14, Step 3: confirmed. Under the CLI, `alchemy dev` sees `APP_URL`, `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET` and they reach bindings; `BACKEND_PORT=$WEBSITE_PORT` makes the CLI proxy to Alchemy's public proxy on 3900.
- 2026-10-14, Step 3: confirmed. Vite's host check admits the tunnel host with `allowedHosts` (`.trycloudflare.com`); the forwarded `Host` reaches Vite unchanged.
- 2026-10-14, Step 4: confirmed. `Session.isActive(undefined, buffer)` treats an undefined scope list as unchanged (`isScopeChanged` returns false for `undefined`), `session.mjs` 15.0.1.
- 2026-10-14, Step 4: confirmed with a nuance. The library's `decodeSessionToken` accepts the hand-signed tokens and rejects the four existing failure cases. It verifies `exp`/`nbf` through `jose` with `clockTolerance: 10` s and checks `aud` itself; the `expiresIn: -10` case still fails because jose rejects `exp <= now - 10`. A token expired by under ten seconds would now pass, as in Baton.
- 2026-10-14, Step 4: confirmed. `@shopify/shopify-api` 15.0.1 with `adapters/web-api` loads in workerd (integ suite green) and in Node at plan time.
- 2026-10-14, Step 5: confirmed. A `Response` thrown from server-function middleware is returned as is by Start's server-functions handler (`server-functions-handler.ts`, `catch (error) { if (error instanceof Response) return error }`), so the `401` with the retry header reaches App Bridge unchanged.
- 2026-10-14, Step 5: refuted in part. TanStack Router parses search values as JSON and canonicalizes the URL to what `validateSearch` returns, so a string-only search Schema cannot be the route's `validateSearch` for Shopify's params (see Deviations).
- 2026-10-14, Step 5: confirmed. A file route's `headers` option sets response headers on the SSR document (`content-security-policy` on `/app`).

## 13. Verification checklist

- [ ] `shopify app info --config shopify.app.toml` lists one web and no conflict (Step 1).
- [ ] `vp check` green after every step.
- [ ] `vp test` green after Steps 4, 6; `vp run test:e2e` green after Steps 6 and 9.
- [ ] Unit: decode tests, `authenticateAdmin` reuse path, the three URL builders.
- [ ] `vp run dev` fails without `SHOPIFY_DEV_STORE`; starts the CLI with it; `dev:stop` leaves nothing.
- [ ] Main: embedded page shows the shop; `ShopSession` holds a real token; refresh survives; HMR observed and recorded.
- [ ] `wt-01`: the same on its own store and port, concurrently.
- [ ] No commit, no push, no `shopify app deploy`.

## 14. Out of scope

Staging (the Shopify app for staging, its `client_id`, `application_url`); the e2e stage under the CLI and e2e dev stores; the background refresh family and its test (committed to the follow-up with the first webhook); webhook routes and HMAC validation; the Admin API beyond `shop { id }`; billing; `extensions/`; folding `/merchant/$key` into `/app`; App Bridge on the member or merchant pages; `--use-localhost`.

## 15. File plan

| File                                                                                                    | Change                                                                                  |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `shopify.app.toml`, `shopify.app.staging.toml`                                                          | Copied from Baton                                                                       |
| `shopify.web.toml`                                                                                      | New                                                                                     |
| `.gitignore`, `.env.example`, `.env`                                                                    | `.shopify/`, `.shopify.lock`; `SHOPIFY_DEV_STORE`                                       |
| `package.json`                                                                                          | `app:dev`; `@shopify/shopify-api`                                                       |
| `vite.config.ts`                                                                                        | `server.allowedHosts`                                                                   |
| `alchemy.run.ts`, `src/backend/stack.ts`, `test/integ/stack.ts`                                         | `ShopifyApp`; real or fake bindings; `SHOPIFY_API_KEY`/`SHOPIFY_APP_URL` on the Website |
| `src/contract/shop.ts`                                                                                  | `InvalidSessionToken`, `AuthenticateAdminInput`, `AdminSession`                         |
| `src/backend/shopify.ts`                                                                                | Over `@shopify/shopify-api`; `authenticateAdmin`                                        |
| `src/backend/shop-sessions.ts`                                                                          | New repository                                                                          |
| `src/backend/api.ts`                                                                                    | `authenticateAdmin`; `/shop` callback                                                   |
| `src/backend/test-control.ts`                                                                           | `/shop` callback                                                                        |
| `src/web/server/shopify.ts`                                                                             | New: middleware, `authenticateApp`, URL builders                                        |
| `src/web/routes/app.tsx`                                                                                | The App Home                                                                            |
| `src/web/routes/auth.session-token.ts`, `auth.exit-iframe.ts`                                           | New server routes                                                                       |
| `src/web/routes/shop.tsx`, `shop.index.tsx`, `shop.$key.tsx`                                            | Moved from `app.*`                                                                      |
| `src/web/routes/index.tsx`                                                                              | Redirect on `shop=`                                                                     |
| `src/web/components/polaris.ts`, `MemberBar.tsx`, `src/web/client/session.ts`, `src/web/server/shop.ts` | `APP_BRIDGE_URL`; `/shop`                                                               |
| `scripts/dev.ts`, `scripts/worktree.ts`, `scripts/lib/worktree.ts`                                      | CLI as the server; store per checkout                                                   |
| `test/unit/backend/{shopify,api,auth}.test.ts`, `test/unit/web/*`                                       | Updated and new                                                                         |
| `test/e2e/{shell,http,shop,actor-upgrade}.spec.ts`                                                      | `/shop`                                                                                 |
| `README.md`, `docs/worktrees-runbook.md`, `docs/website-port-runbook.md`                                | Updated                                                                                 |

## 16. Order of work and stopping points

Steps 1 → 2 → 3, then the Step 3 dry run (the first time the CLI runs here; stop and record if it does not reach `alchemy dev`). Steps 4 → 5 (testable without Shopify) → 6 → 7 → 8. Step 9 last, main before `wt-01`. If Step 9's first embedded load fails at the host check or the tunnel, fix `allowedHosts` or record the tunnel behaviour before anything else; do not switch to `--use-localhost` without recording why.
