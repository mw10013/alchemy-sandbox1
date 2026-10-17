-- The e2e environment's one seed: its admin (a@a.com, a Better Auth user with the role admin).
-- Shop data never comes from here: the e2e specs run on the real e2e store, whose rows can only be
-- written after its first embedded load installs it, so they come from the e2e fixture, which
-- Playwright's install setup loads. The `Seed` Action runs this after Better Auth's migration.
-- Rows are idempotent (INSERT OR IGNORE) and shaped as Better Auth stores them: ISO text dates,
-- 0/1 booleans. The timestamp is fixed so the file's content, which `Seed` hashes, stays stable.
INSERT OR IGNORE INTO "user" (id, name, email, emailVerified, role, banned, createdAt, updatedAt) VALUES ('user-admin', 'Admin', 'a@a.com', 1, 'admin', 0, '2026-10-14T00:00:00.000Z', '2026-10-14T00:00:00.000Z');
