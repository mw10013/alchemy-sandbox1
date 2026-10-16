# Seed and fixture: research

How a stage gets its data. One rule decides it: anything about a shop can only be written after that shop is installed, so there are two mechanisms with two names.

- The **seed** gives every stage what it needs before anyone signs in.
- The **fixture** puts one installed shop into a known state, on demand.

This doc also covers porting legacy's showcase data in full as the dev fixture. No code has changed.

Legacy paths are relative to `refs/baton-legacy/`.

---

## 1. Settled in conversation (2026-10-16)

1. **Words.**
   - **Admin** is the person, the role (Better Auth's `role = 'admin'`) and the side (`/admin`).
   - Shopify's admin is always written **Shopify admin**.
   - **Operator** is retired. It becomes the glossary's term to avoid, and its 27 uses, mostly in comments, are renamed.
2. **Seed versus fixture.**

   |           | **Seed**                                                            | **Fixture**                                                            |
   | --------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------- |
   | What      | What every stage starts with                                        | A known state one shop is put into                                     |
   | Target    | The whole stage                                                     | One shop, named in the call                                            |
   | When      | Automatically, at deploy                                            | On demand, any number of times                                         |
   | Behaviour | Idempotent: inserts what is missing                                 | Replace: the shop ends up exactly like the fixture                     |
   | Contents  | The admin user. `test` also gets the integration tests' fake shops. | Members, teams, workflows, orders, and the store's products and orders |
   | Where     | Every environment, production included                              | dev and e2e only                                                       |

3. **The seed is the admin row**, through the existing `Seed` Action (`src/backend/seed.ts`), one file per environment:
   - dev and e2e: `a@a.com`.
   - staging and production: `support@mw10013.com`. The production environment doesn't exist yet. `seedFileFor` is exhaustive, so adding it won't compile until its file is chosen.
   - `staging.sql` drops its fake `seed-shop` row. `dev.sql` drops its fake shops, members and team.
4. **Legacy's `ADMIN_EMAILS` (the role granted on first sign-in) isn't ported.** The seed already gives every stage its admin.
5. **One fixture endpoint, one call.** The shop is named in the call. An uninstalled shop is an error. There is no pre-check and no other route.
6. **Replace scope is one shop.**
   - A stage can have any number of stores installed. That is allowed, so the fixture never touches another shop.
   - Better Auth is left alone. A user isn't shop data: one email can be a member of two shops. Someone dropped from the shop simply loses access, because the gate checks their `Member` row.
7. **Staging gets the seed only.** No fixture endpoint, and no fixture writes to the staging store.
8. **Port all of legacy's showcase data now** (§3), including run progress. Runs are written when reconcile and the task actions are ported (§5.4).
9. `seed/test.sql` and the integration tests pinned to its fake shops stay as they are.

---

## 2. Why two mechanisms: the order of events

```
deploy (Alchemy)                                   after the app is opened in a store
───────────────────────────────────────────        ──────────────────────────────────────────────
D1:     create → migrations/0001_init.sql          embedded load: token exchange inserts
        → Better Auth migrate → Backend up            that shop's ShopSession row
        → Seed Action: d1.exec(seed/<env>.sql)
Actor:  nothing. Its SQLite is private, and only    vp run fixture → POST /api/dev/fixture
        the Backend can call it.                       → D1 rows + the shop's actor
Store:  nothing                                       (and the store half, §5.2)
```

**Why nothing about a shop can be seeded at deploy:**

- **The foreign key.** `Member.shop` and `Team.shop` reference `ShopSession`. A real store's row only exists after its first embedded load.
- **A placeholder `ShopSession` doesn't work.**
  - `authenticateAdmin` skips the token exchange while the stored token looks fresh.
  - An exchange keeps the existing `shopGid`.
  - So a fake token or a fake GID would stick for good.
- **The actor isn't reachable.** The `Seed` Action holds a D1 handle and nothing else.

**Why the admin can't go in the schema:** the `user` table belongs to Better Auth. Its migrate step creates the table after our migration runs, so a deploy Action is the earliest point the admin row can be written.

**Each checkout already gets its own data.** Every checkout runs its own stages, each with its own local D1 and actors. Each stage's `.env` names its stores (`SHOPIFY_DEV_STORE`, `SHOPIFY_E2E_STORE`, written by `worktree:init`).

- Fixtures in main and wt-01 can't collide.
- An e2e run can't touch dev.
- The 409 confines a fixture to the stores actually installed through this stage's own server, because those are the only ones with a `ShopSession` row here.

**How this differs from legacy.** Legacy's `pnpm seed` hit `POST /api/dev/seed` with the same 409 rule. But it shared one server between dev and e2e, so specs' reseeds wiped what you were looking at. Its replace also deleted the members' Better Auth users and every run, real orders' runs included. Baton keeps the shape and drops both side effects.

---

## 3. The dev fixture: legacy's showcase, in full

Sources: `e2e/showcaseFixture.ts` and `e2e/showcaseProducts.ts`.

**What's already ported:** `seed/dev-shop.ts` holds its 8 products and 3 real store orders.

**What's left:** the members, teams, workflows and 42 orders that legacy wrote straight into the actor.

**Members (7):** `ana@`, `ben@`, `carmen@`, `dana@`, `eli@`, `farah@`, `gus@example.com`.

- Ana is the member persona. She is on two teams, so her workflows list shows a Team select.
- Dev shows magic links inline and never sends mail, so `example.com` is safe there.

**Teams (8):**

| Team         | Members          | Purpose                                                               |
| ------------ | ---------------- | --------------------------------------------------------------------- |
| Woodshop     | ben, dana        |                                                                       |
| Engraving    | ana, ben, carmen |                                                                       |
| Leather      | carmen, eli      |                                                                       |
| Jewelry      | farah            |                                                                       |
| Textiles     | dana             |                                                                       |
| Finishing    | ana, eli         |                                                                       |
| Packing      | gus              | The one team the legacy screenshot pass deleted to get "Needs a team" |
| Weekend crew | nobody           | The "No members" and "Team has no members" states                     |

**Workflows (8).**

- A task with no `step` comes right after the previous one.
- Tasks are JSON on the `Workflow` row. Each task's `teamId` is a D1 `Team.id`.

| Workflow              | Tag                    | State    | Tasks (team)                                                                                           |
| --------------------- | ---------------------- | -------- | ------------------------------------------------------------------------------------------------------ |
| Cut, engrave and oil  | engraved-cutting-board | active   | Cut and sand (Woodshop) → Engrave (Engraving) → Oil and inspect (Finishing)                            |
| Stamp and bind        | leather-journal        | active   | Cut cover (Leather) → Stamp initials (Engraving) → Bind (Leather) → Pack (Packing)                     |
| Cast, engrave, polish | signet-ring            | active   | Cast (Jewelry) → Engrave crest (Engraving) → Polish (Jewelry)                                          |
| Embroider and fold    | embroidered-blanket    | active   | Embroider name (Textiles) → Fold and wrap (Finishing). Also a pending draft adding "Sew in care label" |
| Clock assembly        | wall-clock             | active   | Cut face (Woodshop) and Engrave numerals (Engraving) in parallel → Assemble (Finishing)                |
| Frame and glaze       | photo-frame            | inactive | Cut mat (Woodshop) → Glaze and fit (Finishing)                                                         |
| Gift set assembly     | gift-set               | active   | Assemble set (Finishing)                                                                               |
| Weekend engraving     | weekend-engraving      | active   | Engrave (Weekend crew). A "Team has no members" fault, and no product carries the tag.                 |

**Orders (42).**

- Numbered #1201 to #1242, spread over the last ten days, with the newest getting the highest number.
- 47 line items, about 43 runs.
- Two are closed orders: #1201 is fulfilled and #1202 is cancelled. The other 40 are open.
- The orders are interleaved by state, so the index reads like a working week.

| Group             | Count | What it shows                                                                                                                                      |
| ----------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Closed or changed | 4     | Fulfilled after done; cancelled mid-run; an item removed; a quantity resized                                                                       |
| Not started       | 8     | Includes #1241, a gift set the merchant assigned to one workflow                                                                                   |
| Started by Ana    | 5     | Her in-progress cards                                                                                                                              |
| Started by others | 8     | Started by ben, carmen, farah, dana or eli                                                                                                         |
| Between steps     | 6     | Done through step k with nothing started; two journals waiting at Pack                                                                             |
| Blocked           | 2     | One blocked by a member, one by the merchant                                                                                                       |
| Made              | 4     | Every task done                                                                                                                                    |
| Odd ones          | 5     | A gift set two workflows match; a gift card alone; a gift card plus a board; an unpaid board; a three-item order with an order note and a run note |

**What a fixture order carries:**

- A number, its age in days, fulfillment status, paid or unpaid, and a note.
- Line items: title, variant title, SKU, product tags, the properties the customer typed, and an optional `workflow` choice.
- No customer, no prices, and no Shopify product or variant ids. Neither schema stores those ids.

**How work in progress is described:**

- **`progress`** describes work on a run: `done`, `advance: k`, `started`, `blocked: reason`, `byMerchant`, `by: email`, `note`.
- **`after`** is a later change to the order: cancelled, fulfilled, or a changed quantity.
- Legacy applied both through its real code (upsert, reconcile, then the task actions), never by writing `Run` rows directly.

**Fixture orders are fake orders.**

- They are never in Shopify. Legacy marked them with ids `gid://shopify/Order/seed-<n>`; here the prefix is `fixture-`.
- `countedAt = 0`, so usage billing never counts them.
- Webhooks and the bulk sync only ever upsert real Shopify ids, so they never touch these rows.
- Later features must treat the prefix as unsyncable. That applies to an "open in Shopify admin" link and to a one-order sync, neither of which has a real order to point at.

---

## 4. Where the data can go today

| Piece                                | Today                                                          |
| ------------------------------------ | -------------------------------------------------------------- |
| The fixture module, in full          | Yes: plain typed data, `progress` and `after` included         |
| D1 `Member`, `Team`, `TeamMember`    | Yes: the tables exist                                          |
| Actor `Workflow`                     | Yes: the table exists and nothing reads it yet                 |
| Actor `ShopOrder`, `OrderLineItem`   | Yes: the columns match legacy's                                |
| Actor `Run`, `RunTask`               | Not yet. They come from reconcile and the task actions (§5.4). |
| Store products and the 3 real orders | Yes: today's `stores:seed` already writes them                 |

---

## 5. Recommendation

### 5.1 The endpoint

```
POST /api/dev/fixture   { shop: ShopKey, fixture: ShopFixture }
  404  not a dev or e2e stage
  409  no ShopSession for `shop`: open the app in that store first
  400  the body doesn't decode
  200  a one-line summary
```

**What it serves and calls:**

- A Website route forwards the request to the Backend, as `/api/test-control` does today.
- The Backend checks the environment and the shop, then writes D1.
- It then calls one new schemaless actor method, `loadFixture`, through `ShopActors`. That matches the settled two-transport design: the Backend's binding, not a socket.

**What one call does:**

1. **D1:** delete the shop's `Team` and `Member` rows (`TeamMember` cascades), then insert the fixture's.
2. **Actor, in one transaction:**
   - Clear `Workflow`, `Run`, `RunTask`, `ShopOrder`, `OrderLineItem` and `UsageEvent`.
   - Reset `SyncState` and `ShopUsage` to their single starting rows.
   - Write the fixture's workflows and orders.
   - Not `deleteAll`, which would also wipe the actor's record of its own migrations mid-request.
3. **Sockets:** close the sockets of members who were removed (`revoke`).
4. **Untouched:** the `ShopSession` row, every other shop, and Better Auth.

**Ids:** new ids each call, as the product's own writes mint them. Under replace, nothing has to survive a reload. Workflow tasks get the new D1 team ids, because both writes happen in the same Backend call.

### 5.2 `vp run fixture`: one command, store half included

You asked to fold `stores:seed` into it. I recommend doing so: one command, one fixture file, nothing else to remember.

1. **Store half:** today's `seedStore`, through Shopify CLI. It sets products from the fixture, archives the rest, cancels other open orders and creates the 3 real orders.
2. **Then the one POST**, to `SHOPIFY_DEV_STORE` on this checkout's dev port. The response, including the 409's message, is printed as is.

**Why the store half can't move into the endpoint:** the app's scopes are `read_orders,read_products`. Asking every merchant for write scopes so dev can write products would be wrong. So the store half stays a CLI step with its own `shopify store auth`, approved once per store in a browser.

**The two halves run in parallel** (the script is Effect, `Effect.all` with concurrency). They write different systems and neither reads the other. When bulk sync lands, the step that starts a sync to bring back the store's real orders, which the replace has just cleared, runs after both halves finish.

**What it costs:**

- Every reload pays the store half's CLI calls. It reads before it writes, so an unchanged store costs only the reads, but it takes seconds rather than milliseconds.
- If the store auth has lapsed, the command fails at that step with the `shopify store auth` line to run.

**Scope:** dev stores only. `seedStore` already refuses e2e stores. Writing to the staging store goes away (settled point 7), and that store keeps what it has today.

### 5.3 Names and files

**The name.** You were weighing `shop` against plain `fixture`. I recommend not naming the fixture at all in the API.

- The endpoint takes the fixture's data in the body, as legacy did, not a name to look up.
- With one dev fixture, a name has nothing to tell apart.
- The type is **`ShopFixture`**: a fixture for one shop. That keeps your "shop" in the place it reads naturally ("load a shop fixture into a shop"), without a second thing called `shop` beside the `shop` key.
- e2e specs that want their own build a `ShopFixture` inline.

**Files:**

- `seed/<env>.sql`: the seed, admin rows. `test.sql` also keeps the fake shops.
- `fixture.ts` at the root, replacing `seed/dev-shop.ts`: the dev `ShopFixture`, with products, store orders, members, teams, workflows and orders. Kept outside `src/` so the Backend bundle never carries it, as legacy kept its fixtures in `e2e/`.
- `src/contract/fixture.ts`: the `ShopFixture` schema, shared by the script, the route and the Backend.
- `scripts/fixture.ts`: `vp run fixture`. `scripts/stores.ts` keeps `stores:check`, and `stores:seed` goes.

### 5.4 Runs wait for reconcile

The fixture keeps `progress` and `after` now. The runs slice adds one step to `loadFixture`: walk them through the real task actions, as legacy does. Until then, `loadFixture` decodes them and ignores them. Hand-written `Run` rows would be a second copy of reconcile's rules, and the `CHECK` constraints only catch part of those rules.

### 5.5 Knock-on changes

- **The member side needs a real shop list.** `SEED_SHOP` (`src/contract/shop.ts`) is the member side's only link and the default of `shopKeyAtom`. With no `seed-shop` in dev, `/shop` should list `Members.listShopsOf(email)`, and `SEED_SHOP` becomes a test-only name.
- **e2e still runs on `test.sql`'s fake shops.** Moving e2e onto its real store with fixtures is separate work, and this design allows it: setup loads a fixture after the embedded load, once, before the parallel specs start.
- **`docs/orders-slice-research.md`:**
  - §0 is stale on refresh (landed in 73ed016).
  - It proposes checking bulk sync on the staging store's 3 orders. Those orders stay, so that still works.

---

## 6. Decisions (Plannotator, 2026-10-16)

All three recommendations were accepted.

1. **Tunnel guard: environment plus localhost.** The endpoint answers 404 unless the stage is dev or e2e and the request arrived on `localhost`. `vp run fixture` and e2e setup call localhost directly, never the tunnel.
   - **Superseded 2026-10-16, after plan review: environment only.** A hostname check can be forged through the tunnel (Alchemy's dev proxy builds the URL from `X-Forwarded-Host`), and dev already hands the admin's magic link to anyone on the tunnel, so the localhost check protected nothing. The endpoint answers 404 unless the stage is dev, test or e2e.
2. **`vp run fixture` always runs the store half**, with no `--skip-store` flag. The script is Effect and runs both halves in parallel (§5.2).
3. **`ShopFixture`, unnamed.** The request body is the fixture. The dev fixture is the one in `fixture.ts`.
