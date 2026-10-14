-- The test and e2e environments' one seed: shops, members, a team and the operator (a@a.com, a
-- Better Auth user with the role admin), the same rows as seed/dev.sql. The `Seed` Action runs it
-- after Better Auth's migration, so it may fill Baton's tables and Better Auth's alike. Rows are
-- idempotent (INSERT OR IGNORE) and shaped as Better Auth stores them: ISO text dates, 0/1
-- booleans. Tests read these rows and never change them. Tokens are fakes shaped like Shopify's;
-- shop times are epoch ms, 2100-01-01 for "never expires". The operator's timestamp is fixed so
-- the file's content, which `Seed` hashes, stays stable.
INSERT OR IGNORE INTO ShopSession (shop, shopGid, shopAgentId, scope, accessTokenExpiresAt, accessToken, refreshToken, refreshTokenExpiresAt, planHandle, planHandleExpiresAt, planBoundaryAt) VALUES
  ('alchemy-sandbox1.myshopify.com', 'gid://shopify/Shop/1', 'alchemy-sandbox1.myshopify.com', 'read_orders,write_orders', 4102444800000, 'shpat_fake_alchemy_sandbox1', 'shprt_fake_alchemy_sandbox1', 4102444800000, 'basic', 4102444800000, NULL),
  ('other-shop.myshopify.com', 'gid://shopify/Shop/2', 'other-shop.myshopify.com', 'read_orders,write_orders', 4102444800000, 'shpat_fake_other_shop', 'shprt_fake_other_shop', 4102444800000, 'basic', 4102444800000, NULL);

INSERT OR IGNORE INTO Member (id, shop, email, createdAt) VALUES
  ('mem-1', 'alchemy-sandbox1.myshopify.com', 'm1@m.com', 1760227200000),
  ('mem-2', 'alchemy-sandbox1.myshopify.com', 'm2@m.com', 1760227200000),
  ('mem-3', 'other-shop.myshopify.com', 'm1@m.com', 1760227200000);

INSERT OR IGNORE INTO Team (id, shop, name, createdAt) VALUES
  ('team-1', 'alchemy-sandbox1.myshopify.com', 'ops', 1760227200000);

INSERT OR IGNORE INTO TeamMember (teamId, memberId, createdAt) VALUES
  ('team-1', 'mem-1', 1760227200000);

INSERT OR IGNORE INTO "user" (id, name, email, emailVerified, role, banned, createdAt, updatedAt) VALUES ('user-admin', 'Admin', 'a@a.com', 1, 'admin', 0, '2026-10-14T00:00:00.000Z', '2026-10-14T00:00:00.000Z');
