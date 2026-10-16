-- The staging environment's one seed: its admin (support@mw10013.com, a Better Auth user with the
-- role admin). The `Seed` Action runs it after Better Auth's migration. Rows are idempotent
-- (INSERT OR IGNORE) and shaped as Better Auth stores them: ISO text dates, 0/1 booleans. The
-- timestamp is fixed so the file's content, which `Seed` hashes, stays stable.
INSERT OR IGNORE INTO "user" (id, name, email, emailVerified, role, banned, createdAt, updatedAt) VALUES ('user-admin', 'Admin', 'support@mw10013.com', 1, 'admin', 0, '2026-10-14T00:00:00.000Z', '2026-10-14T00:00:00.000Z');
