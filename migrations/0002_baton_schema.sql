-- The invite list goes: who may sign in is now a Member row of some shop.
DROP TABLE member;

-- Baton's shop and membership tables, copied unchanged from Baton's
-- migrations/0001_init.sql (refs/baton), comments included; the D1_TABLES and
-- EpochMillis rules they name are Baton's. Until the Shopify slice, the
-- ShopSession token and plan columns hold seed values, never real tokens.
-- Better Auth's tables are not copied: @alchemy.run/better-auth migrates them.

-- shopAgentId is set once; upsertShopSession never rewrites it. Rules on D1_TABLES.
create table if not exists ShopSession (
  shop text primary key,
  shopGid text not null,
  shopAgentId text not null unique,
  scope text,
  accessTokenExpiresAt integer,
  accessToken text,
  refreshToken text,
  refreshTokenExpiresAt integer,
  planHandle text,
  planHandleExpiresAt integer,
  planBoundaryAt integer
);

-- No soft delete: uniqueness is among existing rows only, so re-adding an
-- email mints a new id.
-- The rules are on D1_TABLES (src/lib/D1Schema.ts).
-- Times are epoch-ms integers: the rule on EpochMillis (src/lib/domain/Platform.ts).
create table if not exists Member (
  id text primary key,
  shop text not null references ShopSession (shop) on delete cascade,
  email text not null check (email = lower(trim(email)) and length(email) <= 254),
  createdAt integer not null,
  unique (shop, email)
);

-- Every read of a shop's members is in email order (the members index pages
-- by email, the team page's members and candidates too), which the unique
-- (shop, email) index answers; no second index.

-- Teams are shop-scoped groupings of Member rows: identity, not workflow data,
-- so they live in D1 beside Member rather than in the ShopAgent's SQLite. That
-- buys real referential integrity in both directions (deleting a shop or a
-- member cleans up its edges) at the cost of a hard FK from Durable Object rows
-- to a team, which is deliberately left as an opaque id.
-- The rules, including what a team delete does to the object, are on
-- D1_TABLES (src/lib/D1Schema.ts).
create table if not exists Team (
  id text primary key,
  shop text not null references ShopSession (shop) on delete cascade,
  name text not null check (name = trim(name) and length(name) > 0),
  createdAt integer not null,
  unique (shop, name)
);

-- Edges point at Member.id, not at an email, so both cascades (member removed,
-- team removed) come free. The two foreign keys give each side one shop but
-- nothing here compares them: setTeamMember does, which is the app half of
-- the team row on D1_TABLES (src/lib/D1Schema.ts).
create table if not exists TeamMember (
  teamId text not null references Team (id) on delete cascade,
  memberId text not null references Member (id) on delete cascade,
  createdAt integer not null,
  primary key (teamId, memberId)
);

-- Serves the member-area guard's memberId -> teamIds join; the primary key
-- already covers the teamId -> members direction.
create index if not exists TeamMember_memberId_idx on TeamMember (memberId);
