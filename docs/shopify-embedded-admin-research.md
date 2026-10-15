# Research: the sandbox as an embedded app in the Shopify admin, on Baton's app config

Research date: 2026-10-14. Status: research; nothing implemented. Scope is the local spike only: embedded App Home under `alchemy dev` in the Shopify admin; staging, e2e and more dev stores come after. All ten questions in [§10](#10-questions-with-recommendations) were answered in Plannotator on 2026-10-14: every recommendation accepted, with Q6 changed in review to the full auth port and Q10's refresh family committed to the follow-up. Next step: the plan.
Versions: Alchemy `2.0.0-beta.81`, `@alchemy.run/cloudflare-runtime` `2.0.0-beta.81`, Shopify CLI `4.9.0` (installed by Vite+'s tool manager: `~/.local/share/vite-plus/bin/shopify`, a `vp` shim; not brew, not npm), `@shopify/polaris-types` `2.0.0-rc.3`; Baton as pinned in `refs/baton`. Do not bump dependencies.
Background: [Baton port spikes](./baton-port-spikes-research.md) (§7 deferred everything Shopify to this phase), [dev stages](./dev-stages-research.md) and [stages and test infrastructure](./stages-and-test-infrastructure-research.md) (per-checkout stages, local state), [worktrees runbook](./worktrees-runbook.md), [website port runbook](./website-port-runbook.md), [Playwright e2e plan](./playwright-e2e-plan.md) (the e2e server on `WEBSITE_PORT + 100`), [staging research](./staging-research.md), [glossary](./glossary.md).

Sources: `refs/baton/{shopify.app.toml,shopify.app.staging.toml,shopify.web.toml,package.json,vite.config.ts,.env.example}`, `refs/baton/src/{routes/__root.tsx,routes/app.tsx,routes/index.tsx,routes/auth.$.tsx,lib/Shopify.ts,lib/ShopifyServerFnMiddleware.ts,lib/shopifyConstants.ts}`, `refs/baton/scripts/{dev.ts,worktree.ts,lib/worktree.ts}`, `refs/baton/e2e/{shopify-admin.setup.ts,devStore.ts}`, `refs/baton/docs/{shopify-web-toml-conflict-research,dev-browser-profile-research,worktrees-runbook}.md`; the live Baton checkouts (`~/Documents/src/baton`, `~/.herdr/worktrees/baton/wt-0{1,2}`: `.env` keys and `.shopify/project.json` only); the installed CLI bundle (`~/.local/share/vite-plus/packages/@shopify/cli/*/lib/node_modules/@shopify/cli/dist/chunk-{3DMDSAWK,2KLXRVGQ,YTJ3EPD3}.js`); `refs/shopify-docs/docs/{api/shopify-cli/app/app-dev,apps/build/cli-for-apps/app-structure,apps/build/cli-for-apps/networking-options,apps/build/cli-for-apps/app-configuration,apps/build/cli-for-apps/test-apps-locally,apps/build/authentication-authorization/{id-tokens,implement-token-exchange},apps/build/security/set-up-iframe-protection,apps/build/stores/development-stores,api/app-home/latest/app-bridge-web-components}.md`; `node_modules/alchemy/src/{Cloudflare/Workers/{LocalWorkerProvider,ViteChildRunner,ViteChild,ViteChild.shared,Worker,WorkerProvider,Sources/Vite}.ts,Command/{Dev,Command}.ts,Cli/commands/{dev,flags}.ts,Util/ConfigProvider.ts}`, `node_modules/@alchemy.run/cloudflare-runtime/src/{core/proxy/WorkerProxy,vite/forwarded-host}.ts`, `refs/alchemy/website/src/content/docs/{command/dev-servers,environments/local-development,cloudflare/security/secrets-env,cloudflare/frontend/vite}.mdx`; this repo's `alchemy.run.ts`, `vite.config.ts`, `playwright.config.ts`, `scripts/{dev,worktree,stage}.ts`, `src/backend/{stack,shopify,stage}.ts`, `src/web/routes/{__root,app,index,merchant.$key}.tsx`.

## 1. Summary

- **It fits, in Baton's shape.** Shopify CLI (`shopify app dev`) stays the parent: it opens the tunnel, rewrites the app's URLs for the chosen dev store, and starts our web command with the variables it injects. The web command becomes `vp run dev:alchemy`, so `alchemy dev` runs as its child. Nothing in Alchemy fights this: `alchemy dev` inherits the parent's environment, process environment wins over `.env`, and `Config.*` in `alchemy.run.ts` reads the CLI's variables at plan time (§3, §4).
- **Ports line up with one rule.** The CLI proxies to `localhost:$BACKEND_PORT` when `shopify.web.toml` has no `port`, and Alchemy's public proxy for the Website binds `127.0.0.1` and `[::1]` on `WEBSITE_PORT` with `strictPort`. So the app-dev script sets `BACKEND_PORT=$WEBSITE_PORT`, exactly as Baton sets `BACKEND_PORT=$PORT`, and every checkout keeps its one port (§3.2).
- **Two things the sandbox lacks that Baton has.** Vite's `server.allowedHosts` for the tunnel hostname (Alchemy's proxy forwards the client's real `Host` header untouched, so Vite would refuse `*.trycloudflare.com`), and a `shopify.app.staging.toml` carrying `web_directories = ["."]`, without which the CLI finds `refs/baton/shopify.web.toml` and refuses to start (§5.3).
- **The stack reads the CLI's variables when they are there and keeps today's fakes when they are not.** `alchemy dev` under the CLI gets `APP_URL`, `SHOPIFY_API_KEY` and `SHOPIFY_API_SECRET`; integ, e2e, a plain `vp run dev` and staging get none and keep the fake key, the random secret and the local URL. A changed tunnel URL is a binding update, not a replacement (§4).
- **The page is small; the auth under it is Baton's, ported in full (Q6).** Shopify loads `application_url` (the tunnel root) with `shop`, `host`, `embedded=1` and `id_token`. The sandbox takes Baton's layout: `/app` is the App Home and the Better Auth member area moves to Baton's `/shop` paths (Q4). Baton's auth splits cleanly across the two Workers: the Backend does the token work (decode, token exchange, `ShopSession`, refresh) behind one method, and the Website does the request-shaped guards (`/auth/session-token`, `/auth/exit-iframe`, the embedded redirect, the bearer middleware with the `401` retry header, the CSP header). Every guard outcome here is a redirect or a server route, so Baton's worker preflight is not needed (§6).
- **Dev stores are the shared scarce thing.** The CLI's URL rewrite is per dev store, and two `shopify app dev` sessions on one store overwrite each other. Baton's checkouts hold `sandbox-shop-00`, `-01`, `-02`. Taking over `baton-local` means the sandbox's checkouts use the same stores by worktree index, and a Baton checkout and a sandbox checkout with the same index must not run at once (§5.1, Q2).
- **Out of scope, on purpose:** staging, the e2e stage and new dev stores. Nothing in them changes; the stack keeps today's fakes wherever the CLI is not the parent (§4). What the research learned about e2e dev shops is parked in §8 for the next slice.

## 2. Where things stand

| Piece          | Baton                                                                                                                             | Sandbox today                                                                                                                                          |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Dev server     | `shopify app dev` → `pnpm dev` (`vite dev --port $PORT`), controller `scripts/dev.ts`                                             | `vp run dev` → `vp run dev:alchemy` (`alchemy dev --stage dev-<user>[-wt-NN]` through `s6-log`), controller `scripts/dev.ts`                           |
| Port           | `PORT` in `.env` (3800 + NN); CLI gets `BACKEND_PORT=$PORT`                                                                       | `WEBSITE_PORT` in `.env` (3900 + NN), `strictPort`; Backend on an ephemeral port behind the service binding                                            |
| App config     | `shopify.app.toml` (`baton-local`, client id `7c6cceb7…`), `shopify.app.staging.toml` skeleton, `shopify.web.toml`, `extensions/` | None. `SHOPIFY_API_KEY = "fake-api-key"`, `SHOPIFY_API_SECRET = makeRandom("ShopifyApiSecret")`, both bound to the Backend (`stack.ts`)                |
| Session tokens | `@shopify/shopify-api` 15.0.1: token exchange, D1 `ShopSession`, document guards, CSP                                             | `src/backend/shopify.ts`: HS256 verify of `aud`, `exp`, `nbf`; `signSessionToken` for test control; `/merchant/$key?token=` renders without App Bridge |
| Embedded page  | `/app` tree; `/` redirects there when `shop=` is present; App Bridge via the route's `head.scripts` with `data-api-key`           | `/app` is the Better Auth member area; `/` is the public home; Polaris loads in `<head>` after `HeadContent`, leaving the first-script slot free       |
| Dev store      | `SHOPIFY_DEV_STORE=sandbox-shop-NN` in `.env`, NN the worktree index; `.shopify/project.json` records the store per checkout      | None                                                                                                                                                   |
| Stages         | wrangler `local`, `staging`, `production`                                                                                         | `dev-<user>[-wt-NN]`, `test-…`, `e2e-…` with local state; `staging` with Cloudflare state, deployed on every push to `main`                            |

## 3. The process shape

### 3.1 What `shopify app dev` does to the web process

Verified in the installed 4.9.0 bundle (`chunk-3DMDSAWK.js`, functions `js`, `Ms`, `Rn`) and `refs/shopify-docs/docs/apps/build/cli-for-apps/app-structure.md`:

- It discovers `shopify.web.toml` files (every one under the app directory, following symlinks, `node_modules` excluded; §5.3) and runs each web's `commands.dev` from the file's directory. The command string is split on `&&` and each part is spawned directly, with no shell.
- The environment it sets for that command: `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `HOST`, `APP_URL` and `REMIX_DEV_ORIGIN` (all the proxy URL, `https://<x>.trycloudflare.com`), `SCOPES`, `BACKEND_PORT`, `FRONTEND_PORT`, `PORT`, `SERVER_PORT`, `NODE_ENV=development`, `APP_ENV=development`. It never sets `SHOPIFY_APP_URL`; Baton's `Config` chain `SHOPIFY_APP_URL → APP_URL → HOST` is why it works there.
- Port, for one web with both roles: the toml's `port` wins when set; otherwise `Number(process.env.BACKEND_PORT)`; otherwise a random port. `FRONTEND_PORT` in the environment is ignored. The proxy dials `http://localhost:<that port>`. This is why Baton's toml has no `port` and `app:dev` sets `BACKEND_PORT=$PORT`.
- The proxy is `http-proxy` with no `changeOrigin` and no `xfwd`: the tunnel's `Host` header reaches the web process unchanged. WebSocket upgrades are forwarded (`default` route), so Vite's HMR socket can get through. `OPTIONS` is answered by the proxy itself.
- Networking modes (`networking-options.md`): the default opens a Cloudflare quick tunnel on a random local port; `--tunnel-url https://host:port` uses a tunnel you run; `--use-localhost` serves `https://localhost:3458` (`--localhost-port` to change it) with an mkcert certificate the CLI generates into `.shopify/`, and the docs say webhooks, app proxy, Flow and POS do not work in that mode.
- `[build] automatically_update_urls_on_dev = true` rewrites `application_url` and `auth.redirect_urls` to the proxy URL for the chosen dev store, per store (`test-apps-locally.md`: "isolated to the chosen dev store"). Per-checkout state: `.shopify/project.json` (the store), `~/Library/Preferences/shopify-cli-app-nodejs/config.json` keyed by absolute directory (app, org, `previousAppId`). On the first run in a new directory the CLI POSTs a sample `app/uninstalled` webhook to `webhooks_path`.
- The preview URL it prints is `https://admin.shopify.com/store/<store>/apps/<client_id>?dev-console=show`.

### 3.2 What `alchemy dev` does with a Website

Verified in `node_modules/alchemy/src` and `@alchemy.run/cloudflare-runtime/src`:

- `alchemy dev` spawns the program with `extendEnv: true` and `ALCHEMY_DEV=true` (`Cli/commands/dev.ts`); `loadConfigProvider` (`Util/ConfigProvider.ts`) reads `.env` from the cwd and lets the process environment override it. So every variable the CLI injects is visible to `Config.String(...)` in `alchemy.run.ts` and `stack.ts`, and `.env` cannot shadow it. The Vite child also gets the whole process environment, so `vite.config.ts` can read `APP_URL`.
- The Website's public port is a byte-pipe proxy (`WorkerProxy.ts`): it binds `127.0.0.1:<port>` and, when IPv6 loopback exists, `[::1]:<port>` too, so `localhost` resolves to it either way. It rewrites nothing: the Worker and Vite see the client's real `Host`. Vite itself runs in a child on `127.0.0.1` and a random port (`ViteChildRunner.ts`); `dev: { port, strictPort }` in `alchemy.run.ts` configures only the proxy. Inline `host`, `port` and `strictPort` override `vite.config.ts`; every other `server.*` key in our config, `allowedHosts` included, survives the merge.
- `request.url` inside the Worker is built from `X-Forwarded-Host`/`X-Forwarded-Proto` when a tunnel sets them, else `Host` (`vite/forwarded-host.ts`). Cloudflare's quick tunnel sets them, so the Worker sees `https://<x>.trycloudflare.com/...`.
- `website.url` is `http://localhost:<port>` in dev, never the tunnel. `Config` values are plain strings at plan time and can go straight into `env:` bindings; `Config.Redacted` becomes a `secret_text` binding (`secrets-env.mdx`). A changed binding value is an update; a Worker is replaced only on account, namespace, version mode or explicit `name` change (`WorkerProvider.ts` diff).
- `Command.Dev` runs a long-lived process under `alchemy dev` (no-op on deploy), stdin ignored when non-interactive, and extracts a URL from its output within five seconds, preferring a localhost URL (`Command/Dev.ts`). `dev: { mode: "external", url }` on a Worker skips the local Worker and reports that URL.
- Alchemy has no Shopify provider or resource and no doc on running `alchemy dev` behind a tunnel.

### 3.3 Options

**A. The CLI is the parent (Baton's shape).** `shopify.web.toml` says `dev = "vp run dev:alchemy"`, the raw server, not `vp run dev`: the CLI's web command must be the long-lived foreground process that receives the injected variables, and `vp run dev` is the controller, which adopts a running server or launches `dev:alchemy` into a herdr pane or a detached process (neither inherits the CLI's environment) and then exits, which the CLI would read as its web command dying. Baton's `shopify.web.toml` makes the same split (`pnpm dev`, never `pnpm dev:start`). A package script `app:dev` runs `BACKEND_PORT=$WEBSITE_PORT shopify app dev --config shopify.app.toml --store $SHOPIFY_DEV_STORE` with `.env` loaded. The CLI's variables flow into `alchemy dev` and from there into bindings. Everything else (stage, local state, `s6-log`, port) stays as it is. The tunnel changes every run, which the URL rewrite handles. Cost: the dev controller has to start the CLI rather than `dev:alchemy` when a Shopify session is wanted (Q3), and `allowedHosts` must admit the tunnel host.

**B. Alchemy is the parent, running `shopify app dev` as `Command.Dev`.** Inverted: the CLI must spawn the web command and inject its variables, so a `Command.Dev` would need a no-op `commands.dev` and the stack would never see `APP_URL` or the secret. `Command.Dev`'s URL extraction looks for a localhost URL within five seconds and the tunnel URL arrives later and is not local. Not viable without `--tunnel-url` (option D).

**C. `--use-localhost`.** No tunnel: the admin loads `https://localhost:3458`, proxied to `WEBSITE_PORT`. Simpler and never flaky, but no webhooks, an mkcert prompt and certificate under `.shopify/`, and every checkout needs its own `--localhost-port` (3458 + NN, say). The App Home itself renders fine this way. Not needed for the spike; if the quick tunnel proves flaky (Baton's e2e has a reload workaround for module requests stalling through it), it is one flag on the app-dev script to add later.

**D. A stable named Cloudflare Tunnel per checkout, passed as `--tunnel-url`.** `application_url` stops changing, the CLI's role shrinks to credentials and the dev store, and Alchemy's own `Cloudflare.Tunnel` resource could manage it. But a live Cloudflare resource in a dev stage moves dev state to the Cloudflare store (`stack.ts` says so), needs a zone and `cloudflared` running, and is a design of its own. A later option, not the spike.

Recommendation: **A**, plain. It is the shape Baton has run for months, and every piece of it maps onto something Alchemy already does. **C** stays a known fallback, not part of the slice.

## 4. Wiring the CLI's variables into the stack

- **`alchemy.run.ts` / `stack.ts`.** Read `Config.option` of `APP_URL`, `SHOPIFY_API_KEY` and `Config.Redacted("SHOPIFY_API_SECRET")`. When all three are present (only under the CLI), bind the real key and secret to the Backend in place of `SHOPIFY_API_KEY = "fake-api-key"` and `makeRandom("ShopifyApiSecret")`, and bind `SHOPIFY_APP_URL` to the Website (and the Backend, which will build Admin API calls later). When any is absent, keep today's fakes: integ, e2e, a plain `vp run dev` and staging all stay as they are (Q5). The binding names stay, so nothing is recreated. The random secret resource stays declared on every stage so its state record is untouched.
- **Nothing in `.env`.** The CLI is the only source of the key and secret, as in Baton. `SHOPIFY_DEV_STORE=sandbox-shop-NN` does go into `.env`, and `worktree:init` sets it from the worktree index the way it sets `WEBSITE_PORT`.
- **`vite.config.ts`.** `server.allowedHosts: ["localhost", "127.0.0.1", ".trycloudflare.com", <hostname of APP_URL>]`, the hostname parsed as Baton's `parseAllowedHost` does (the CLI may hand a bare host or a URL). `host` and `strictPort` stay Alchemy's business.
- **The API key on the page.** The Website's loader or `beforeLoad` gets it from the Backend, or the Website reads its own `SHOPIFY_API_KEY` binding; it is rendered server-side into the App Bridge meta tag. No `VITE_` prefix: it would inline the key at build time for every stage, and the value differs per app.
- **Logs.** `dev:alchemy` already captures Alchemy's output in `.logs/dev/current`; the CLI's own output (tunnel URL, preview URL, status panel) goes to the terminal or pane it runs in. Baton's controller reads the tunnel URL from the dev process's environment (`ps -E` on whatever listens on the port, matching `APP_URL=`), not from the CLI's redrawn output; that technique ports as is.
- **Non-TTY.** The CLI spawns `commands.dev` with piped stdio, so `alchemy dev` runs non-interactive. It already does today, behind the `s6-log` pipe.

## 5. Checkouts, stores and the `refs/` trap

### 5.1 Dev stores

- The URL rewrite is per store, and two `shopify app dev` sessions on one store overwrite each other's `application_url`: last run wins, the other session's admin page loads the wrong tunnel. Baton's rule is one store per checkout, `sandbox-shop-NN` for worktree `NN`, main being `00`. Its live checkouts hold `00` (main), `01` (`wt-01`), `02` (`wt-02`).
- Baton's worktrees runbook says the pool is shared across projects "because each project is its own app on the store". That no longer holds here: the sandbox takes over the same app (`baton-local`), so a Baton checkout and a sandbox checkout with the same index would collide. Since Baton is being ported away, the simplest rule is: the sandbox's checkouts use the same indexes, and Baton's dev servers are not run while the sandbox's are (Q2).
- The app is already installed on `sandbox-shop-00` and friends, so first open needs no install step; a new store would show Shopify's managed-install prompt for `read_orders,read_products` on first open.

### 5.2 Worktrees and stages

- Each checkout already has its own `.env`, port, `.alchemy/` and stage. It gains `SHOPIFY_DEV_STORE` in `.env` and an untracked `.shopify/` (store, mkcert files); `.gitignore` gets `.shopify/` and `.shopify.lock`. The CLI's app cache is keyed by absolute directory, so main and `wt-NN` do not share it.
- The stage is unaffected: the CLI runs `alchemy dev --stage dev-mw-wt-01` as before, state stays under `.alchemy/`, and the controller's `pgrep` match on ` dev --stage <stage>` still finds Alchemy's process, now a grandchild of the CLI.
- The e2e server (`vp run test:e2e:server`, `WEBSITE_PORT + 100`, `ALCHEMY_STAGE`) does not run under the CLI and keeps the fakes. Nothing in `vp test` changes.

### 5.3 `refs/baton/shopify.web.toml`

The CLI's discovery glob runs over the whole app directory, follows symlinks and ignores `.gitignore`. `find -L refs -name shopify.web.toml` finds exactly one file today, Baton's, and a root `shopify.web.toml` beside it gives "You can only have one web configuration file with the backend role". Baton's research (`refs/baton/docs/shopify-web-toml-conflict-research.md`) found the only fix that keeps the dev layout: `web_directories = ["."]` in a non-active app config (its `shopify.app.staging.toml` skeleton, blank `client_id`, so it cannot deploy), never in the active one, where the CLI's second filter silently loads zero webs. Copying both app tomls verbatim, as asked, brings the fix along. Verify with `shopify app info --config shopify.app.toml`: "📂 … /" under directory components means the web loaded. The sweep that Baton's doc attributes to brew's CLI 4.7.0 is unchanged in 4.9.0.

### 5.4 What copying Baton's config carries

`shopify.app.toml` names webhook subscriptions (`/webhooks/compliance`, `/webhooks/app/*`, `/webhooks/orders`) and the CLI's startup sample `app/uninstalled` goes to `webhooks_path`. The sandbox has none of those routes: `dev` never pushes the subscriptions (only `deploy` does; never run `shopify app deploy` from this repo while the config is Baton's), and the sample webhook gets a 404 the CLI only logs. `extensions/baton-order-link` is not copied; `dev` is unaffected by its absence. `[access_scopes]` and `[auth]` stay as they are. `shopify.web.toml` changes in one line, `dev`, and its comments about `CLOUDFLARE_INCLUDE_PROCESS_ENV` and `set -a` no longer apply (Alchemy passes the environment through on its own).

## 6. The App Home page

**How it arrives.** The admin loads `application_url` (after the rewrite, the tunnel root, path `/`) with `shop`, `host`, `embedded=1`, `locale`, `session`, `timestamp`, `hmac` and `id_token`. Shopify's minimum for an App Home to render (`app-bridge-web-components.md`, `set-up-iframe-protection.md`): HTML with `<meta name="shopify-api-key">` and the App Bridge script, no `X-Frame-Options: DENY`, and `Content-Security-Policy: frame-ancestors https://<shop> https://admin.shopify.com`. Token exchange and an access token are only needed to call the Admin API, which the spike does not.

**What Baton does.** `/` is a public landing whose loader redirects into `/app` with the search string when `shop=` is present. `/app` is the embedded merchant area: its `beforeLoad` runs `authenticateAdmin` (verify the `id_token`, exchange it for an offline token, store `ShopSession`), and its `head` adds the App Bridge script with the API key. The document guards in `src/lib/Shopify.ts` handle the edge cases: no `shop`/`host` renders an App Bridge-only page so the admin re-embeds; `embedded !== "1"` redirects to the embedded URL; no `id_token` redirects to `/auth/session-token?…&shopify-reload=<url>`, an App Bridge-only page that reloads the app with a fresh token. Members use `/shop` and `/shop/$shop`, sign-in is `/login`, the operator `/admin`.

**What the spike renders**, taking Baton's layout (Q4):

1. `/app` is the App Home. The Better Auth member area moves from `/app` and `/app/shop/$key` to `/shop` and `/shop/$key`, Baton's paths; `homeFor`, the sign-in redirect, the member bar links and the e2e specs' URLs follow (nine references). `/merchant/$key?token=` stays as the App Bridge-less merchant page that test control and the e2e specs use: App Bridge loaded in a top-level window outside the admin redirects to the admin, so an e2e merchant window cannot go through `/app` (Baton's e2e runs against the real admin; §8).
2. `/app`'s `beforeLoad` calls a server function under the Shopify middleware (§6.2), which gives the route the shop and the API key.
3. `head`: the meta tag and `scripts: [{ src: APP_BRIDGE_URL }]`. The root document already places `HeadContent` before Polaris so the App Bridge script is the document's first script, as the admin requires.
4. The page: `s-page` with one `s-section` saying the shop's domain. Polaris is already on the CDN in `<head>`.
5. `/`'s loader redirects to `/app` with the search string when `shop=` is present, as Baton's does.
6. The `frame-ancestors` CSP header through the route's `headers` option (TanStack Start supports `headers: () => ({...})` on a file route; `refs/tan-start/docs/start/framework/react/guide/isr.md`). Baton's `Link: preconnect/preload` headers are optional.

### 6.1 Baton's auth, in order

From `refs/baton/src/lib/Shopify.ts`, `ShopifyServerFnMiddleware.ts`, `worker.ts` and `routes/app.tsx`:

1. **Context.** `shop` and `host` sanitized from the query; the token is the `Authorization: Bearer` header, else `?id_token`; a request is a server-function call when it carries `x-tsr-serverFn: true` (the same Start version as here, `1.168.60`), and a document request when it has neither bearer nor that header.
2. **Document guards**, first match wins: `/auth/session-token` renders an App Bridge-only page (the `data-api-key` script tag, nothing else) with the `Link` and CSP headers when `shop` is valid; `/auth/exit-iframe` renders the same page plus `window.open(dest, "_top")`, `dest` allowed only on the app's origin or the admin's `…/charges/<handle>/pricing_plans`; a server-function call without a bearer is `401`; a document request without `shop` or `host` gets the App Bridge-only page (the admin re-embeds it); with `embedded !== "1"` a `302` to `https://admin.shopify.com/store/<store>/apps/<apiKey>` (`auth.getEmbeddedAppUrl`); without `id_token` a `302` to `/auth/session-token?…&shopify-reload=<appUrl><path>?<query>`, from which App Bridge reloads the app with a token.
3. **Decode.** `session.decodeSessionToken`; the shop is the `dest` hostname. An invalid token answers a bearer request with `401` and `X-Shopify-Retry-Invalid-Session-Request: 1` (App Bridge retries with a fresh token) and a document request with the session-token bounce.
4. **Exchange and store.** The `ShopSession` row is rebuilt as an offline `Session`; when it `isActive` with a 30 s buffer (non-null access token, not within 30 s of `accessTokenExpiresAt`, scope unchanged) it is reused and Shopify is not called. Otherwise `auth.tokenExchange({ requestedTokenType: OfflineAccessToken, expiring: true })`; on first install `shop { id }` is fetched over GraphQL for `shopGid`; the row is upserted (`shop`, `shopGid`, `shopAgentId`, `scope`, `accessToken`, `accessTokenExpiresAt`, `refreshToken`, `refreshTokenExpiresAt`), never touching the plan columns. A Shopify `401` on a later GraphQL call clears the access token so the next request re-exchanges.
5. **Server functions.** App Bridge patches the browser's `fetch`, so every same-origin server-function call carries the bearer; the function middleware runs the pipeline, turns a redirect into TanStack's `redirect({ href })` and lets the `401`s through unchanged.
6. **The route.** `authenticateAppRoute` returns `{ apiKey, shop, … }` into route context; `head` puts `data-api-key` on the App Bridge script; the socket gets `await shopify.idToken()` on every connect.
7. **The worker preflight.** For `GET /app*` without a bearer, Baton runs the pipeline before Start, because a non-redirect `Response` thrown from `beforeLoad` during SSR cannot be serialized and became a 500. Every response then passes `withShopifyDocumentHeaders` (`Link` and CSP on `text/html` with a valid `shop`).
8. **Background refresh** (`ensureShopSession`, `refreshShopSessionIfExpired`, `refreshShopSession` with retries, `recoverRefreshRace`): for callers with no browser (webhooks, order sync). The sandbox has no such caller yet (Q10).

Library surface used: `shopifyApi` (`hostName` from the app URL, `isEmbeddedApp: true`, `ApiVersion.October26`), `session.decodeSessionToken`, `session.getOfflineId`, `Session.isActive`, `auth.tokenExchange`, `auth.refreshToken`, `auth.getEmbeddedAppUrl`, `utils.sanitizeShop/sanitizeHost`, `webhooks.validate`, `flow.validate`, `clients.Graphql`, and the `InvalidJwtError`/`HttpResponseError` classes. `@shopify/shopify-api` `15.0.1` with `adapters/web-api`, which runs in workerd.

### 6.2 The same auth across the Website and the Backend

The sandbox's rule is that the Backend holds secrets and checks every call, and the Website calls it schemaless over the binding. Baton's pipeline splits along the line between token work and request shape:

- **Backend.** A `Shopify` service over `@shopify/shopify-api` (Q9) with the real `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET` and `SHOPIFY_APP_URL` bindings, keeping `signSessionToken` for test control. One schemaless method, `authenticateAdmin({ sessionToken })`, does steps 3 and 4 and returns `{ shop, shopGid, scope, accessTokenExpiresAt }` or fails with `InvalidSessionToken`; `ShopSession` gets Baton's repository methods (`findShopSession`, `upsertShopSession`, `clearShopSessionAccessToken`, `updateShopSessionTokens`, `updateShopSessionScope`, `deleteShopSession`) in `shop-access.ts`'s module or a sibling. `decodeSessionToken` stays for the actor gate. No `Response` leaves the Backend.
- **Website.** A function middleware (Baton's `ShopifyServerFnMiddleware`): bearer from the request, `authenticateAdmin` over the binding, `InvalidSessionToken` becomes `401` with the retry header, success puts the shop in context. The document guards (step 2) run in `/app`'s `beforeLoad` for the embedded flags and token presence, and every outcome is a `redirect()`: to the embedded admin URL, or to `/auth/session-token` with or without `shopify-reload`. `/auth/session-token` and `/auth/exit-iframe` are server routes (Start's `server.handlers`) returning Baton's HTML with its headers. Because no guard throws a raw `Response` from `beforeLoad`, Baton's worker preflight (step 7) has no counterpart here; the CSP header rides on the route's `headers`.
- **The API key on the Website.** A `SHOPIFY_API_KEY` binding on the Website too (the key is public; the secret stays on the Backend), read through `env.server.ts` for the meta tag and the embedded-URL redirect. Under the fakes it is `fake-api-key`.
- **Test stages.** The seed's `ShopSession` rows have a non-null access token with `accessTokenExpiresAt` in 2100 and a `shopGid`, so a test-minted token takes the reuse path and never calls Shopify. One check for the plan: `Session.isActive(undefined, buffer)` must treat an undefined scope list as unchanged (Baton relies on it; confirm in the installed library). The e2e merchant specs keep `/merchant/$key?token=` as said above.
- **Webhooks and flow validation** stay out: no webhook route yet, and `deploy` never runs from here.

## 7. Risks to retire in the spike

| Risk                                              | Why it might bite                                                                              | How the spike checks                                                               |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Vite host check                                   | `Host` passes through two proxies; Vite blocks unknown hosts                                   | `allowedHosts` as §4; the first page load through the tunnel                       |
| HMR through the tunnel                            | Vite's client connects to the page origin; two proxies and `cloudflared` in between            | Edit the page while embedded; a full reload is an acceptable fallback              |
| Module requests stalling through the quick tunnel | Baton's e2e reloads once for this                                                              | Note it; `--use-localhost` is the fallback if it is frequent                       |
| The sample `app/uninstalled` webhook              | 404 on first run in a new directory                                                            | Confirm the CLI only logs it                                                       |
| `vp run dev:stop` under the CLI                   | SIGTERM to Alchemy's tree leaves the CLI, which may exit or restart the web                    | The controller stops the CLI's process tree, as Baton's does (Q3)                  |
| `request.url` scheme and `AUTH_ORIGIN`            | Better Auth's origin is `website.url` (`http://localhost`), while pages arrive over the tunnel | Out of scope for the embedded page; member sign-in is used on `localhost` as today |

## 8. Parked for the follow-up

**Background refresh (Q10).** `ensureShopSession`, `refreshShopSessionIfExpired`, `refreshShopSession` and `recoverRefreshRace` from `refs/baton/src/lib/Shopify.ts`, with Baton's `shopify-offline-refresh.test.ts` (it fakes Shopify's token endpoint through the library's `setAbstractFetchFunc`). Committed to the follow-up that brings the first webhook or background job.

**E2e dev shops.** Not this slice (Q8 accepted). For when it comes: an App Bridge page opened outside the admin redirects to the admin, so an embedded e2e needs a real admin session; the URL rewrite is per store, so an e2e stage needs its own store (`shopify store create dev` exists in CLI 4.9.0); Baton drives the embedded app headless on a Playwright storage state built from everyday Chrome's `admin.shopify.com` cookies (`refs/baton/scripts/lib/shopify-playwright-auth.ts`), and whether `accounts.shopify.com` lets a Playwright-driven browser log in is the open question to answer first.

## 9. The slice this proposes

1. Copy `shopify.app.toml` and `shopify.app.staging.toml` verbatim; `shopify.web.toml` with `dev = "vp run dev:alchemy"` and fresh comments. `.gitignore`: `.shopify/`, `.shopify.lock`.
2. `.env.example` and `worktree:init`: `SHOPIFY_DEV_STORE`. Package script `app:dev` with `BACKEND_PORT=$WEBSITE_PORT`.
3. `vite.config.ts`: `allowedHosts`.
4. `stack.ts` / `alchemy.run.ts`: real key, secret and app URL when the CLI supplies them; untouched otherwise.
5. Auth, as §6.2: `@shopify/shopify-api` in the Backend behind `authenticateAdmin` with token exchange and the `ShopSession` repository; the Website's Shopify function middleware, `/auth/session-token` and `/auth/exit-iframe` server routes, the embedded guards in `/app`'s `beforeLoad`, the CSP header.
6. Routes: member area to `/shop` and `/shop/$key`; `/app` as the App Home; `/` redirect; `/merchant/$key` unchanged for test control.
7. The controller: `vp run dev` starts the CLI, a missing `SHOPIFY_DEV_STORE` is a hard error, `stop` ends the CLI's tree (Q3).
8. README: how to run embedded, the store rule, and that `shopify` comes from Vite+'s tool manager (Baton's doc still says brew).

Done means: `vp run dev` in main and in `wt-01`, each on its own store, shows the Polaris page with the shop's name inside the admin, the `ShopSession` row for that store holds a real access token after the first load, a refresh inside the iframe comes back through the session-token bounce, and `vp check` and `vp test` stay green.

## 10. Questions with recommendations

:::question
Q1. Process shape: which process is the parent in dev?

Shopify CLI as the parent with the quick tunnel (A, §3.3) is Baton's proven shape and every CLI contract maps onto something Alchemy already does. `--use-localhost` (C) has no webhooks and needs a port per checkout; it is a one-flag fallback if the tunnel proves flaky, not part of the slice. A stable named tunnel (D) is a later design once a stable dev URL earns its keep.

- [x] A: CLI parent, quick tunnel
- [ ] C only: `--use-localhost`, no tunnel
- [ ] D: stable named tunnel per checkout

Recommended: A: CLI parent, quick tunnel
:::

:::question
Q2. Dev stores: which stores do the sandbox's checkouts use?

The URL rewrite is per store and one `shopify app dev` per store is the rule (§5.1). It is one app now (`baton-local`) and Baton is being ported away, so sharing Baton's `sandbox-shop-NN` by worktree index costs nothing but "don't run a Baton checkout and a sandbox checkout with the same index at once".

- [x] Same pool, NN = worktree index (main is 00)
- [ ] A separate index range for the sandbox
- [ ] New stores

Recommended: Same pool, NN = worktree index (main is 00)
:::

:::question
Q3. `vp run dev` always starts through the CLI, and a missing store is a hard error. Confirm?

Revised after review: no silent fallback to plain `alchemy dev`. The controller starts `vp run app:dev` (the CLI) as Baton's does, refuses to start when `.env` has no `SHOPIFY_DEV_STORE` (the same hard error it gives for a missing `WEBSITE_PORT`), and `stop` ends the CLI's process tree. The e2e server and the integ harness do not go through the controller and are unaffected. `vp run dev:alchemy` stays the raw server the CLI runs.

- [x] Yes: always the CLI; no store is a hard error
- [ ] Always the CLI, but a plain `alchemy dev` behind an explicit flag for a checkout without a store

Recommended: Yes: always the CLI; no store is a hard error
:::

:::question
Q4. Take Baton's layout now: `/app` is the App Home, members move to `/shop`?

Yes, this is what Baton does, confirmed in its routes: `app.tsx` is the embedded merchant area, whose `beforeLoad` runs `authenticateAdmin`; `shop.tsx` is the member layout behind Better Auth (`requireUserFn`), `shop.index.tsx` is "Your stores" at `/shop`, `shop.$shop.tsx` is one shop's member area at `/shop/$shop`, `login.tsx` is the magic-link form, `admin.*` the operator; `index.tsx` redirects into `/app` when `shop=` is present. The sandbox's `/app` is the Better Auth member area today, so taking Baton's `/app` means moving it to `/shop` and `/shop/$key` (`homeFor`, the sign-in redirect, the member bar, nine e2e references). `/merchant/$key?token=` stays as the test-control merchant page: App Bridge outside the admin redirects to the admin, so e2e cannot use `/app` (§6).

- [x] `/app` App Home, members to `/shop` and `/shop/$key`; `/merchant/$key` stays for test control
- [ ] `/app` App Home, members stay at `/app/shop/$key` under another prefix of your choosing

Recommended: `/app` App Home, members to `/shop` and `/shop/$key`; `/merchant/$key` stays for test control
:::

:::question
Q5. Scope check: the stack changes only under the CLI; everything else is left alone. Confirm?

Reworded after review. Under the CLI, the Backend gets the real key and secret and the Website the app URL; without the CLI (integ, e2e, staging) nothing changes and nothing is touched. No staging work, no e2e work, no new stores in this slice.

- [x] Confirmed

Recommended: Confirmed
:::

:::question
Q6. How much of Baton's auth does the spike port?

Decided in review: the full port. §6.1 lists Baton's pipeline and §6.2 how it splits across the Website and the Backend. The background refresh family is Q10.

- [ ] `id_token` verification plus the session-token bounce page; token exchange in the next slice
- [x] Port Baton's auth in full now (token exchange, `ShopSession`, middleware, exit-iframe)
- [ ] `id_token` verification only; no bounce

Recommended: Port Baton's auth in full now (token exchange, `ShopSession`, middleware, exit-iframe)
:::

:::question
Q7. Copy Baton's app config verbatim, webhook subscriptions included?

`shopify app dev` never pushes the subscriptions (only `deploy` does, and `deploy` must not be run from this repo while the config is Baton's); the CLI's startup sample `app/uninstalled` gets a 404 it only logs (§5.4). `shopify.app.staging.toml` must come along for `web_directories` (§5.3).

- [x] Verbatim: both app tomls as they are; `shopify.web.toml` changes only its `dev` line
- [ ] Trim the webhook subscriptions the sandbox cannot serve

Recommended: Verbatim: both app tomls as they are; `shopify.web.toml` changes only its `dev` line
:::

:::question
Q8. E2e dev stores: create any now?

`shopify store create dev` exists in CLI 4.9.0 (§8). The follow-up's first question is whether `accounts.shopify.com` lets a Playwright-driven browser log in; stores can wait for that answer.

- [x] Nothing now
- [ ] Create `e2e-shop-00` and `e2e-shop-01` now

Recommended: Nothing now
:::

:::question
Q9. `@shopify/shopify-api` in the Backend, as Baton, or keep hand-rolling in Effect?

Baton wraps the library in Effect for decode, token exchange, refresh, `getEmbeddedAppUrl`, webhook and Flow HMAC validation and the GraphQL client (§6.1). The sandbox hand-rolled only the HS256 decode. A full auth port by hand is one `POST /admin/oauth/access_token` plus the refresh variant today, and every next piece (webhooks, Admin API, billing) adds another call the library already has. The library runs in workerd with `adapters/web-api`, as in Baton, and the bundle cost is paid once. The hand-rolled decoder stays only as `signSessionToken` for test control.

- [x] `@shopify/shopify-api` 15.0.1 in the Backend, wrapped in Effect as Baton does
- [ ] Hand-rolled token exchange in Effect; the library later if needed

Recommended: `@shopify/shopify-api` 15.0.1 in the Backend, wrapped in Effect as Baton does
:::

:::question
Q10. Port the background refresh family now?

`ensureShopSession`, `refreshShopSessionIfExpired`, `refreshShopSession` (3 retries with backoff on network, 429 and 5xx) and `recoverRefreshRace` serve callers with no browser: webhooks and order sync. The embedded page never needs them (a browser request always carries an `id_token` to re-exchange with). The sandbox has no background caller yet, and Baton's `shopify-offline-refresh.test.ts` fakes Shopify's token endpoint, which is the test to port with them.

- [x] Not now; with the first webhook or background job (accepted; it is part of the follow-up, not optional)
- [ ] Now, with Baton's offline-refresh test

Recommended: Not now; with the first webhook or background job
:::
