# Research: taking S1 to staging

Research date: 2026-10-12. Status: research for a later follow-up; nothing here has been run against staging.
Background: [socket identity plan](./socket-identity-plan.md) (S1, implemented and green locally), [Alchemy stages and deployments](./alchemy-stages-and-deployments-research.md) (how staging was set up), [Glossary](./glossary.md).

## 1. Why this exists

S1 was built and tested only on local stages (`dev`, `e2e_<user>`, `test_<user>`) under `alchemy dev` and workerd. Several of its open items only exist on a deployed stage: the operator's user row, whether the random secrets are stored as secrets, and whether close codes survive Cloudflare's edge. This document collects everything S1 left for staging, so the first S1 deploy is a planned step, not a side effect of a push.

## 2. Where staging stands

- Stage `staging`, Worker `alchemy-sandbox1-website-staging-a6uwn3bzazl3yzgy`, at <https://alchemy-sandbox1-website-staging-a6uwn3bzazl3yzgy.mw10013.workers.dev>. State is in Alchemy's Cloudflare state store (not `ALCHEMY_STATE=local`).
- **A push to `main` deploys staging.** Cloudflare Builds runs `pnpm exec vp run deploy:staging` (`alchemy deploy --stage staging --yes`) on every push; there is no review gate between push and deploy.
- On 2026-10-12, `origin/main` is `1691798`. Local `main` is 3 commits ahead (the ShopActor POC `dfbc557`, the Shopify docs mirror, the `vp run dev` change), plus the uncommitted S1 work. So staging has Better Auth with the old invite list, and **none** of the ShopActor POC or S1.
- Staging delivers magic links by mail (`MAGIC_LINK_DELIVERY = mailed`): no `E2E_TOKEN`, so no test control and no inline links. Mail goes from `noreply@mail.mw10013.com` through the `AuthEmail` Email Service binding.
- Staging's seed is `seed/staging.sql`. Before S1 it inserted the operator `support@mw10013.com` into the old `member` invite table with role `admin`; since S1 it inserts only the sandbox shop's `ShopSession` row.
- Logs: `cf o11y telemetry query` on `cloudflare-workers`, filtered by `$metadata.service` (see `AGENTS.md`).

## 3. What the next push deploys

All of it at once, because the POC and S1 have never been deployed:

| Change                             | Effect on staging                                                                                                                                                                      |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ShopActor` Durable Object (POC)   | A new SQLite-backed Durable Object class and namespace on the Backend. First deploy of a Durable Object on this account's staging.                                                     |
| Migration `0002_baton_schema.sql`  | `DROP TABLE member` (staging's invite list, one row) and creates `ShopSession`, `Member`, `Team`, `TeamMember`. Not reversible by a redeploy.                                          |
| `seed/staging.sql` (changed)       | `importFiles` re-runs a changed seed: inserts `alchemy-sandbox1.myshopify.com` into `ShopSession`. No `Member` rows, no user row.                                                      |
| `TicketSecret`, `ShopifyApiSecret` | New `Alchemy.makeRandom` values, held in the state store and bound to the Backend as `TICKET_SECRET` and `SHOPIFY_API_SECRET`; `SHOPIFY_API_KEY` is the literal `fake-api-key`.        |
| Sign-in rule                       | A new user is admitted only with a `Member` row; a magic link is requested only for an existing user or a `Member` row (`Auth.maySignIn`). The invite list and its role copy are gone. |
| Website `/api/actor/$key`          | Upgrade only, with the `Origin` check; the `POST` forward is gone.                                                                                                                     |
| Better Auth hooks                  | `session.delete.after` and `user.update.after` call `SystemRevoke` on each of the user's shops' actors.                                                                                |

## 4. Findings

### 4.1 The operator may be locked out

Since S1, a magic link is issued only for an existing Better Auth user or a `Member` row, and the operator never has a `Member` row. So `support@mw10013.com` can sign in on staging only if its `user` row already exists, which is the case only if it signed in on staging before (the old flow created the row, copying `admin` from the invite). The seed cannot insert the row, because `importFiles` runs before `@alchemy.run/better-auth` creates its tables on a fresh database (seen on a scratch test stage during S1). On the existing staging database the tables do exist, but the seed still runs inside `AuthDb`, so relying on that order would break the next fresh stage.

Options: (a) read staging's `user` table before the push and insert the row once if missing; (b) an Alchemy step that runs after `BetterAuthMigrate` and inserts operator rows from a list in source; (c) let `Auth.maySignIn` admit a configured operator address, which S1 deliberately rejected (no `ADMIN_EMAILS`).

### 4.2 Nobody can open the shop page on staging

The staging seed has no `Member` rows, there is no admin UI to add one (S1 kept membership edits in test control), and test control is off on staging. The operator is refused by the gate even with a `Member` row (an operator is not a member). So after the push, the member page answers "not a member" to everyone and the S1 socket path cannot be exercised on staging.

Options: (a) seed a `Member` row in `seed/staging.sql` for a real, non-operator inbox (for example a plus-address on the `mw10013.com` domain, if the mailbox accepts plus-addressing); (b) an operator-only "add member" procedure and page, which S1 left out of scope; (c) enable test control on staging, which also switches staging to inline magic links (the stack ties inline delivery to `E2E_TOKEN`).

### 4.3 No merchant on staging

A merchant needs a Shopify session token signed with `SHOPIFY_API_SECRET`. Only test control mints one, and the secret is a random value in Alchemy state that nobody holds. So the merchant page cannot be opened on staging until the Shopify slice brings a real app, or test control runs there (4.2 c).

### 4.4 Secrets as secrets

`Alchemy.makeRandom` gives a `Redacted<string>`, and Alchemy's docs say a `Redacted` binding deploys as `secret_text`. Not observed: locally the Worker reads both values, but the secret-or-plain classification exists only on Cloudflare. Check after the deploy in the Worker's Settings → Variables and Secrets (or the Workers script settings API): `TICKET_SECRET` and `SHOPIFY_API_SECRET` secret, `SHOPIFY_API_KEY` and `MAGIC_LINK_DELIVERY` plain. If they come out plain, the fix is in how `alchemy.run.ts` passes them. The values live in the shared state store, so whoever can read staging's state can read them; that is Alchemy's model for every `makeRandom`.

### 4.5 Behaviour proven only in workerd

Proven locally, not on Cloudflare's edge:

- **Close codes.** 3401 (revoked) and 4409 (displaced) reached the client unchanged with nothing in front (S1 step 0.2). On staging the socket passes the Website Worker, the service binding and the edge. The browser's retry policy reads the code, so a rewritten code would turn "Signed in elsewhere" into an endless reconnect.
- **Hibernation.** Identity in the socket's attachment survived local hibernation. Production hibernation timing differs (the local window is about 10 seconds).
- **Origin check.** The Website compares `Origin` with its own URL. On `workers.dev` that is the staging URL; a custom domain later adds a second origin to think about.
- **Refused upgrades.** Under `alchemy dev` a refused upgrade reaches the client as a dropped connection, not as 401/403/404. Whether Cloudflare passes the status through is unobserved; the browser does not depend on it (it learns the reason from `IssueActorTicket` over HTTP).

### 4.6 Mail on staging

Staging is the only stage that mails links. Sign-in on staging has never been exercised end to end in this repo's notes: whether `mail.mw10013.com` is a verified sending domain, whether mail lands, and whether the Builds API token's missing email-routing permission (a warning recorded at setup) matters for the `AuthEmail` binding. The first S1 check on staging is a sign-in, so this needs to work first.

### 4.7 Deploy mechanics

- The deploy is unreviewed: a push runs `deploy --yes`. Running `vp exec alchemy plan --stage staging` locally before the push shows the Durable Object namespace, the two new secrets, the D1 migration and the changed seed, and is the only review point.
- The plan step needs Cloudflare credentials and the state store (an Alchemy profile), as for any staging plan.
- A failed deploy can leave D1 migrated (`member` dropped) with the old Worker still serving. The old Worker reads `member` for sign-in, so sign-in would break until the deploy is fixed. This is a reason to deploy deliberately, not on an incidental push.
- e2e against staging (`PLAYWRIGHT_TEST_BASE_URL`) needs test control, so it runs only if 4.2 (c) is chosen.

## 5. Proposed sequence for the first S1 deploy

1. Read staging's `user` row for `support@mw10013.com` (read-only, D1 console or API). If missing, insert it once (4.1 a).
2. Decide 4.2 and 4.3. Under the recommendations below, add one `Member` row for a real non-operator inbox to `seed/staging.sql`.
3. Confirm staging mail works (4.6) before relying on sign-in.
4. `vp exec alchemy plan --stage staging` locally; check it shows only the expected changes (section 3).
5. Push `main`. Watch the Cloudflare build.
6. Verify on staging: the operator signs in and sees the admin members page with the staging `Member` rows; the member opens `/app/shop/alchemy-sandbox1.myshopify.com` in three windows and the oldest shows "Signed in elsewhere"; sign-out in one window sends another to sign-in; the bindings are classified as in 4.4; `cf o11y` shows `ShopActor.displace` and `SystemRevoke` lines and no `Unable to close RPC WebSocket`.

## 6. Questions

:::question
How should the operator's user row reach a deployed stage?

Today it comes from test control's `ResetData` on test stages and a manual insert on dev. Staging needs it before anyone can administer it (4.1).

- [ ] One-off insert per deployed stage, checked before the first S1 deploy — no new code; a manual step for each new deployed stage
- [ ] An Alchemy step after `BetterAuthMigrate` that inserts operator rows from source — automatic on fresh stages; new deploy plumbing
- [ ] Admit configured operator addresses in `Auth.maySignIn` — reverses the S1 decision against `ADMIN_EMAILS`

Recommended: One-off insert per deployed stage, checked before the first S1 deploy
:::

:::question
How should staging get a member who can open the shop page?

Without one, nobody can exercise the S1 socket path on staging (4.2).

- [ ] Seed a `Member` row in `seed/staging.sql` for a real, non-operator inbox — one line; needs an address that receives mail
- [ ] Build an operator-only add-member page — real feature; S1 left it out of scope
- [ ] Enable test control on staging — also switches staging to inline magic links

Recommended: Seed a `Member` row in `seed/staging.sql` for a real, non-operator inbox
:::

:::question-text
Which inbox should the staging member use?

If the seeded-member option is chosen: an address you can read that is not `support@mw10013.com`, for example a plus-address on `mw10013.com` if that mailbox accepts plus-addressing.
:::

:::question
When should the merchant page be exercised on a deployed stage?

It needs a minted Shopify session token, which only test control can produce (4.3).

- [ ] When the Shopify slice brings a real app — no test-only surface on staging
- [ ] Now, by enabling test control on staging — inline links on staging

Recommended: When the Shopify slice brings a real app
:::

:::question
Should staging deploys stop being automatic on push?

A push to `main` deploys with `--yes`, and the next push carries a Durable Object, an irreversible D1 migration and new secrets (4.7).

- [ ] Keep auto-deploy, and always run `alchemy plan --stage staging` locally before pushing a stack change — no setup change; relies on discipline
- [ ] Turn off the build on push and deploy staging by hand for now — a deliberate gate; Builds stays configured for later

Recommended: Keep auto-deploy, and always run `alchemy plan --stage staging` locally before pushing a stack change
:::
