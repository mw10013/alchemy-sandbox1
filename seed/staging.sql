-- The staging environment's one seed: the seed shop and the operator (a Better Auth user with
-- the role admin). The `Seed` Action runs it after Better Auth's migration, so it may fill Baton's
-- tables and Better Auth's alike. Rows are idempotent (INSERT OR IGNORE) and shaped as Better Auth
-- stores them: ISO text dates, 0/1 booleans. Token columns are fakes shaped like Shopify's; shop
-- times are epoch ms, 2100-01-01 for "never expires". The operator's timestamp is fixed so the
-- file's content, which `Seed` hashes, stays stable.
INSERT OR IGNORE INTO ShopSession (shop, shopGid, shopAgentId, scope, accessTokenExpiresAt, accessToken, refreshToken, refreshTokenExpiresAt, planHandle, planHandleExpiresAt, planBoundaryAt) VALUES
  ('seed-shop.myshopify.com', 'gid://shopify/Shop/1', 'seed-shop.myshopify.com', 'read_orders,write_orders', 4102444800000, 'shpat_fake_seed_shop', 'shprt_fake_seed_shop', 4102444800000, 'basic', 4102444800000, NULL);

INSERT OR IGNORE INTO "user" (id, name, email, emailVerified, role, banned, createdAt, updatedAt) VALUES ('user-admin', 'Admin', 'support@mw10013.com', 1, 'admin', 0, '2026-10-14T00:00:00.000Z', '2026-10-14T00:00:00.000Z');
