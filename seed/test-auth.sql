-- The test operator: a Better Auth user row with the role admin. `AuthSeed` (src/backend/auth-seed.ts)
-- runs this after Better Auth's migration, so the user table exists. The timestamp is fixed so the
-- file's content, which `AuthSeed` hashes, stays stable.
INSERT OR IGNORE INTO "user" (id, name, email, emailVerified, role, banned, createdAt, updatedAt) VALUES ('user-admin', 'Admin', 'a@a.com', 1, 'admin', 0, '2026-10-14T00:00:00.000Z', '2026-10-14T00:00:00.000Z');
