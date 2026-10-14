-- Staging: the sandbox shop only. Its token columns are fakes shaped like Shopify's; times are
-- epoch ms, 2100-01-01 for "never expires". The operator is a Better Auth user row, so it is in
-- seed/staging-auth.sql, which `AuthSeed` runs after Better Auth's migration.
INSERT OR IGNORE INTO ShopSession (shop, shopGid, shopAgentId, scope, accessTokenExpiresAt, accessToken, refreshToken, refreshTokenExpiresAt, planHandle, planHandleExpiresAt, planBoundaryAt) VALUES
  ('alchemy-sandbox1.myshopify.com', 'gid://shopify/Shop/1', 'alchemy-sandbox1.myshopify.com', 'read_orders,write_orders', 4102444800000, 'shpat_fake_alchemy_sandbox1', 'shprt_fake_alchemy_sandbox1', 4102444800000, 'basic', 4102444800000, NULL);
