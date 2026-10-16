-- The dev environment's one seed: its admin (a@a.com, a Better Auth user with the role admin).
-- Shop data never comes from here: a shop's rows can only be written after the shop is installed,
-- so they come from the fixture (`vp run fixture`). The `Seed` Action runs this after Better
-- Auth's migration. Rows are idempotent (INSERT OR IGNORE) and shaped as Better Auth stores them:
-- ISO text dates, 0/1 booleans. The timestamp is fixed so the file's content, which `Seed`
-- hashes, stays stable.
INSERT OR IGNORE INTO "user" (id, name, email, emailVerified, role, banned, createdAt, updatedAt) VALUES ('user-admin', 'Admin', 'a@a.com', 1, 'admin', 0, '2026-10-14T00:00:00.000Z', '2026-10-14T00:00:00.000Z');
