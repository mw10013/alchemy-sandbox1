-- Test shops, members and a team, the same rows as seed/dev.sql. The test harness stages
-- (test_<user>) and the e2e stages load this file. Tokens are fakes shaped like Shopify's;
-- times are epoch ms, 2100-01-01 for "never expires". The operator (a@a.com) is a Better Auth
-- user row, so it is in seed/test-auth.sql, which `AuthSeed` runs after Better Auth's migration.
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
