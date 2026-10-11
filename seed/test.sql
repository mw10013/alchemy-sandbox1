-- Test members, the same accounts as dev. The test harness stages (test_<user>) load this file.
INSERT OR IGNORE INTO member (email, role) VALUES
  ('a@a.com',  'admin'),
  ('m1@m.com', 'user'),
  ('m2@m.com', 'user');
