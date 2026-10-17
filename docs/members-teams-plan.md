# Plan: members and teams (slice C)

Implements `docs/members-teams-research.md` (settled 2026-10-17, Q0–Q19) under `docs/legacy-port-research.md` §0.1 (A1–A3). Read the research's §0, §1.0, §1.3 and §4 first; this plan does not restate the reasons.

Legacy paths are relative to `refs/baton-legacy/`.

## 0. Rules for the implementer

- Follow `AGENTS.md`: Vite+ only (`vp`, never npm or npx); `vp check --fix` after every step; Effect Schema for parsing; `Match` for tag dispatch; `Schema.TaggedError`; `Effect.fn("name")`; the JSDoc rules (no `//` above a declaration, no reference to this plan, the research or any `docs/` file in code); the logging and SQL rules; layout only in parts under `src/web/components/screen/`.
- Work on `main` in the main checkout. Commit at the end of each green step. Stage paths explicitly; never `git add -A` or `git commit -a`.
- Each step ends green: `vp check`, `vp test` (unit, browser, integ) and, from Step 4 on, `vp run test:e2e`. A step that cannot end green is recorded in §7 before moving on.
- A step that adds or deletes a route under `src/web/routes/` regenerates `src/web/routeTree.gen.ts` (`vp build`) before `vp check`.
- No table changes: `migrations/0001_init.sql` and the actor's `0001_init` stay as they are. Never `db:reset` the `staging` stage, `cloud:reset` or `alchemy deploy`; touch the `dev` stage only by running the dev server.
- Each callable lands as the research's §1.3 table says, and nothing else: the four first-render reads are server functions → Backend → `Members`; every write is a `Merchant…` procedure; no new stub method; no notice; no new `DevRpcs` or `IntegRpcs`.
- Legacy is the spec, not the source. Keep legacy's method names, test titles (byte for byte), copy, page sizes and part names. Port SQL and JSDoc rules verbatim, lowercase.
- Do not rewrite the steps. Record what you built differently, and what surprised you, in §7 as you go.
- The integ suite leaks `.alchemy/local/baton-test-…-ShopActor` directories; delete the ones your runs create.

## 1. Outcome

- The merchant's embedded admin has Members (`/app/members`, `/app/members/$memberId`) and Teams (`/app/teams`, `/app/teams/$teamId`), as legacy's: keyset paging and search, Add member, Add to teams, Remove, Delete member, Create team, Rename, Add members, Delete team, with legacy's copy, modals and toasts; and an App nav (Home, Orders, Teams, Members).
- Every write is a merchant procedure on the `/app` layout's socket; the actor writes D1 through `Members` and closes the affected members' sockets with 3401. The pages' first data comes from four server functions reading D1 in the Backend.
- A shop has at most 50 members and 50 teams, with legacy's refusals.
- `Members` carries every member and team method of legacy's `Repository.ts` but those named out of scope; the gate reads `findMemberAccess`; `D1_TABLES` is the D1 spec.
- A member keeps at most `maxSessionsPerMember` Better Auth sessions (the deleted sessions' sockets revoked), and expired sessions and verifications are swept on sign-in.
- `/shop` reads "Your stores" with legacy's empty state.

## 2. What this plan rests on

- **The actor yields Backend services** (the correction): `ShopSessions` over `AuthDb` is in the actor's outer phase today (`makeShopActor` in `src/backend/shop-actor.ts`), provided where `backendBody` yields `ShopActor`. `Members.layer` is provided in the same `Layer.mergeAll`, so the actor can yield it the same way. Unproven only in that nothing has yet written D1 from the actor; Step 2 checks it first.
- **The forged merchant socket** (`openAs(backendUrl, key, { role: "merchant" })` in `test/integ/actor-clients.ts`, the test Backend's forged-caller route) calls `MerchantRpcs` in integ, as `syncOrderAs` does.
- **Revoke is local.** The actor's `revoke` closes sockets tagged `member:<id>` with 3401 (`REVOKED_REASON`); the procedures call the same code without a stub round trip.
- **Procedure errors decode in the browser** only as classes in the procedure's `error` schema, declared in `src/contract/` (the correction's Step 1 review: `OrdersSyncFailure` in `src/contract/shopify.ts`).
- **The orders screen's patterns**: mutation atoms (`ShopActorClient.mutation`, `Atom.family` over `runtime.fn` for per-row presses, `syncOrderAtom`), answers read as an `Exit` with `mode: "promiseExit"`, `thrownCopy` for a lost socket or defect (`src/web/components/OrdersPage.tsx`).
- **Unproven**, checked first where needed: the `node:sqlite` `D1Database` adapter behaving as D1 for `batch`, foreign-key cascades and `insert or ignore … returning` (Step 1); `s-app-nav` clicks keeping the `/app` guards' search (Step 4).

## 3. Names and constants

| Name                                                                                                     | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Members` (`src/backend/members.ts`)                                                                     | Legacy `Repository.ts`'s member and team half: `listMembersPage`, `addMember`, `deleteMember`, `findMemberDetail`, `addMemberTeams`, `listTeamsPage`, `createTeam`, `renameTeam`, `deleteTeam`, `findTeamDetail`, `setTeamMember`, `addTeamMembers`, `findMemberAccess`, `keepNewestSessions`, `sweepExpiredAuth`; plus today's `listShopsOf`, `list` (admin), and the fixture's `replaceShop`, `identityNames`, `addToShop`. `add`, `remove`, `find`, `teamIdsOf` retired where replaced (Q3); a caller left (`DevRpcs`, fixture) moves to the replacement. |
| `PageInput`, `Page`, `toPage`                                                                            | Legacy's paging shape, beside `Members` or in `src/domain/shop-work.ts` if legacy has it there; one home.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `MemberCeilingError`, `TeamLimitError`, `TeamNameTakenError`, `TeamNotFoundError`, `MemberNotFoundError` | `Schema.TaggedError` classes in `src/contract/members.ts`; raised by `Members`, declared by the procedures.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `membersAtCeiling`                                                                                       | `src/domain/billing.ts`, alone, with its legacy JSDoc and test (Q5).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `D1_TABLES`, `BETTER_AUTH_TABLES`                                                                        | `src/backend/d1-tables.ts` (or the name legacy's `D1Schema.ts` suggests), the whole rules table as JSDoc (Q13).                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `MembersAgent`                                                                                           | `makeMembersAgent({ members, revoke, shop })`, `src/backend/shop-actor/members-agent.ts`: one method per procedure below; writes, then closes the members §1.3 names. Plain constructor, like `makeOrdersAgent` (Q19).                                                                                                                                                                                                                                                                                                                                       |
| `MerchantAddMember`                                                                                      | payload `{ email }` → the new `Member`; error `MemberCeilingError`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `MerchantDeleteMember`                                                                                   | `{ memberId }` → void; `MemberNotFoundError`; revokes the member.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `MerchantAddMemberTeams`                                                                                 | `{ memberId, teamIds }` → void; `MemberNotFoundError`; revokes the member.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `MerchantSetTeamMember`                                                                                  | `{ teamId, memberId, inTeam }` → void; `TeamNotFoundError`; revokes the member.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `MerchantCreateTeam`                                                                                     | `{ name }` → the new `Team`; `TeamLimitError \| TeamNameTakenError`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `MerchantRenameTeam`                                                                                     | `{ teamId, name }` → void; `TeamNameTakenError \| TeamNotFoundError`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `MerchantAddTeamMembers`                                                                                 | `{ teamId, memberIds }` → void; `TeamNotFoundError`; revokes the members added.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `MerchantDeleteTeam`                                                                                     | `{ teamId }` → `DeleteTeamResult` (`Deleted \| NotFound`, data); revokes the team's members.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Loader methods                                                                                           | `BackendApi.membersPage`, `memberDetail`, `teamsPage`, `teamDetail` (names free of `listMembers`, the admin's), each over `embeddedSessionToken`, `ShopNotInstalled` with no `ShopSession`; server functions in `src/web/server/members.ts` and `src/web/server/teams.ts`.                                                                                                                                                                                                                                                                                   |
| `INDEX_PAGE_SIZE`, `DETAILS_PAGE_SIZE`, `SEARCH_FROM`                                                    | 25, 10, 6, legacy's.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Parts                                                                                                    | `FilterRow`, `ListSearchField`, `SearchLine`, `TextLimit`, `Token`, `Pairs`, `TableFrame`, `End` under `src/web/components/screen/`; `LocalDateTime` under `src/web/components/`; helpers `searchParams.ts`, `tablePages.ts`, `form.ts` additions, `teams.ts` copy, under `src/web/` where their callers are.                                                                                                                                                                                                                                                |
| Routes                                                                                                   | `src/web/routes/app.members.index.tsx`, `app.members.$memberId.tsx`, `app.teams.index.tsx`, `app.teams.$teamId.tsx`.                                                                                                                                                                                                                                                                                                                                                                                                                                         |

## 4. Steps

### Step 1: `Members`, the D1 test layer, the data-model table

- **Check first (Q4).** A `D1Database` adapter for tests over `node:sqlite` (`prepare`, `bind`, `all`, `raw`, `run`, `first`, `batch` in one transaction), `pragma foreign_keys = on`, migrated from `migrations/0001_init.sql`, under `D1Client.layer`, in `test/unit/backend/layers.ts`. Prove three cases before anything else: a `sql.batch` of two inserts that rolls back on the second's failure; a `Member` delete cascading its `TeamMember` rows; `insert or ignore … returning` answering no row on a conflict. Record the result in §7. **If any fails:** record it, and run the repository tests in integ instead, one `IntegRpcs` procedure per method family on the test Backend (testing research Q15's line: the test Backend only). Continue either way.
- Port the methods of §3's `Members` row from legacy `Repository.ts`: SQL verbatim and lowercase, the JSDoc reasons (idempotent add, ceiling for new emails only with the race named, `or ignore … returning` as the conflict check, edges read before a team delete, cross-shop held by the join), the paging shape, the errors. `D1Primary`/`D1Session` collapse to the one client; drop the "reads through the primary" sentences. Decode failures stay `Effect.orDie`. Rewrite the rest of the file's SQL lowercase.
- `membersAtCeiling` in `src/domain/billing.ts` (Q5). `D1_TABLES` and `BETTER_AUTH_TABLES` (Q13).
- `ShopAccess.member` reads `findMemberAccess` (one query); `MemberCaller.teamIds` from it.
- Tests (unit, on the adapter): legacy `repository.test.ts`'s `Member` and `Team` blocks, titles unchanged; legacy `d1-data-model.test.ts`'s "the migrations create exactly D1_TABLES and better-auth's tables" (against `sqlite_master`) and its member and team rows; `membersAtCeiling`'s legacy test; the existing `Members` and `ShopAccess` tests kept by title or renamed in §7 (old → new) if they named a retired method.
- Verify: green.

### Step 2: `Members` in the actor and the procedures

- **Check first.** Yield `Members` in `makeShopActor`'s outer phase beside `ShopSessions`; make `MerchantAddMember` alone end to end and run it in integ over a forged merchant socket (the row then visible to `Members.listMembersPage` through the Backend). **If D1 writes fail from the actor:** stop, record the error and the stack output under §7 "Issues", end the run.
- `src/contract/members.ts`: the five errors and the eight payload and success schemas (from `src/domain/shop-work.ts`'s `MemberId`, `TeamId`, `TeamName`, `Member`, `Team`, `DeleteTeamResult`; `Email`). `MerchantRpcs` gains the eight procedures of §3.
- `MembersAgent` (§3): each method writes through `Members`, then closes exactly the members §1.3 names, best effort (a failed close logged, the write stands), with the actor's existing close helper; a refusal closes none. `deleteTeam` reads the edges before the delete (inside `Members.deleteTeam`), answers `NotFound` as data. Its JSDoc names E's seam (null and repair task pointers, reconcile, notify) in one sentence. Logs: `MembersAgent.<method>: shop=<shop> memberId=<id>|teamId=<id>: <outcome> closed=<n>`.
- The actor's `revoke` stub and the agent share one close routine.
- Tests. Unit: `MembersAgent` over `Members` on the D1 adapter and a recording `revoke`: each write revokes exactly the members §1.3 names; a refusal revokes none; `deleteTeam` of an unknown id is `NotFound` and revokes none. Integ (`test/integ/members.test.ts`): every procedure over a forged merchant socket, success and its typed failures (the ceiling with 50 members added through `AddToFixture`, the team limit likewise); a forged member socket closes 3401 when the merchant removes the member from a team, deletes the member, and deletes the team ("closes the sockets of everyone who was on the deleted team", legacy's title); a member socket is refused all eight with `Forbidden`.
- Verify: green.

### Step 3: The loaders

- `BackendApi.membersPage`, `memberDetail`, `teamsPage`, `teamDetail` (§3): verify the merchant token to a shop, refuse a shop with no `ShopSession` (`ShopNotInstalled`) before any D1 read, then `Members`. Request schemas in `src/contract/members.ts`, decoded leniently from the URL as legacy (`lenientSearchKey`, `ListSearchParam`). Server functions in `src/web/server/members.ts` (it holds the admin's today; keep both) and `src/web/server/teams.ts`.
- Tests. Unit (`api.test.ts`): each method, a bad token refused, no session → `ShopNotInstalled` and no D1 read. Integ: each with a signed merchant token over fixture rows (`AddToFixture`), paging and search included.
- Verify: green.

### Step 4: The App nav and the members screens

- **Check first (Q9).** Add `s-app-nav` to the `/app` layout (Home with `rel="home"`, Orders, Teams, Members; rendered only once hydrated, legacy's JSDoc reason on it). Run `vp run dev`, open the dev store's admin through the Chrome DevTools MCP, and click each nav link: record whether the `/app` guards see `shop`, `host`, `embedded` and `id_token` (no session-token bounce, no visible reload). **If it bounces:** the nav links carry the raw search the way App Home's Orders link does; record it.
- The parts and helpers of §3, ported with their legacy JSDoc and rows of `Screen.ts`'s parts table; `modal.hide` beside the toast in `src/web/client/app-bridge.ts`.
- `/app/members` and `/app/members/$memberId` from legacy's routes: loader → server function, seeded nothing (no socket read); each write a mutation atom over its procedure, the answer read as an `Exit`; on success `router.invalidate({ sync: true })` (Q18); typed failures → `teams.ts` copy; anything else → `thrownCopy`. Add member lands on the new member's page; Delete member toasts "Member deleted" and goes back to the index. App Home links to Members and Teams.
- `test/e2e/embedded/socket.spec.ts` navigates Orders → App Home by the nav's Home link, not `window.__TSR_ROUTER__`; if the hoisted nav is unreachable from Playwright, by a `BackLink` to App Home; record which.
- Tests. Browser: the parts with logic (`ListSearchField`, `TextLimit`, `SearchLine`), and `MembersIndexPage`/`MemberPage` states from in-memory procedure answers (`test/browser/shop-actor.ts` gains the procedures). e2e (`test/e2e/embedded/members.spec.ts`): legacy's "the members index adds a member and the member page adds it to teams, removes it, and deletes it" and "a 254-character email is added and printed whole, and 255 is refused on Add". The admin's `test/e2e/members.spec.ts` unchanged.
- Verify: green, e2e included.

### Step 5: The teams screens

- `/app/teams` and `/app/teams/$teamId` as Step 4. Delete team: `MerchantDeleteTeam`; `Deleted` hides the modal, toasts `DELETED_TOAST.team` and navigates to `/app/teams`; `NotFound` shows legacy's banner sentence.
- Tests. Browser: the two pages' states. e2e (`test/e2e/embedded/teams.spec.ts`): legacy's "teams screen creates, adds members to, renames, and deletes a team" and "the team page pages its members" (members by `AddToFixture`, names from the test id).
- Verify: green.

### Step 6: The member area, session cap, auth sweep

- `/shop`: legacy `shop.index.tsx`'s "Your stores" heading, the empty state ("You don't have access to any shops yet. Ask the merchant to add your email on their Members page.") and Sign out (Q11). `/shop/$key` unchanged.
- `keepNewestSessions` in Better Auth's `session.create.after` (as legacy `Auth.ts`): it answers the deleted session ids; the hook revokes each with `ShopActors.revoke(shop, "session", id)` on each of the user's shops. `sweepExpiredAuth` on the sign-in path as legacy places it. Their `D1_TABLES` rows.
- Tests. Unit: both SQL methods on the D1 adapter. Integ: legacy "a third sign-in revokes the oldest session; a revoked session's connections are revoked" (`IssueMagicLink` three times, a forged socket on the first session); legacy `member-area.test.ts` "hides a shop the signed-in member has no membership in" if no test covers it. e2e: "a non-member gets the same confirmation and no link" if missing; `shop.spec.ts`' "a member removed while the page is open is told so" unchanged.
- Verify: green.

### Step 7: Docs

- `docs/legacy-port-research.md`: §1.1's D1 row (members and teams read and written) and nothing else; the orchestrator updates §3.
- `docs/glossary.md`: words this slice added (Member ceiling, Team limit, App nav) if a reader needs them.
- `CHECKPOINT: ready for staging (<commit>)` under §7 "Command results". The orchestrator runs staging (`deploy:staging`, no reset: no table changed).
- Verify: `vp check` green.

## 5. Verification checklist

- `vp check`, `vp test`, `vp run test:e2e` green at the end; counts and times in §7.
- The eight procedures exist in `MerchantRpcs` and nowhere else as a write path: `grep -rn "createServerFn" src/web/server/members.ts src/web/server/teams.ts` shows GET loaders only (and the admin's existing read).
- No stub method was added; `ShopActorShape` is unchanged.
- Every legacy title §4 names is present byte for byte (`grep -rn` each).
- `Members` has no uppercase SQL keyword; `add`, `remove`, `find`, `teamIdsOf` are gone or listed in §7 with their remaining caller.
- `socket.spec.ts` no longer reads `__TSR_ROUTER__`.
- The production bundle (`.alchemy/bundles/Backend/`) contains no `IntegRpcs` or `ShopifyFake` string.

## 6. Done when

- §1 holds on the dev stage; every step is green and committed; §7 is filled in; the `CHECKPOINT` line is written.

## 7. Deviations and issues

For the implementer. Append as you go. Keep each entry short, dated and tagged with its step. A deviation is anything built differently from the step that specified it. An issue is anything the plan did not predict. Command results go under their own heading with counts and times.

### Plan review

### Deviations

### Issues

### Command results

### Human steps requested

### Implementation review

## 8. Out of scope

- The pointer half of team delete, the setup guide and `teamWithMemberExists` (E); team names in `MemberAccess` for the work list (F).
- Seats, seat events, the "billed" tile, the plan check in `requireMember` and the gate (G).
- Help links on these screens (I); the admin console and `/admin/members` (H, Q14).
- Live member and team reads, a teams reactivity key (Q18).
- The open items carried from the correction but `socket.spec.ts`: the Alchemy issue, the dev-store live-order check, the first "Sync from Shopify" press on staging, the `embedded/app.spec.ts` hydration timeout.
