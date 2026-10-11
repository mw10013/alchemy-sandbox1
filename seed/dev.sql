-- Dev members. Delivery is inline under alchemy dev, so these addresses never receive mail.
INSERT OR IGNORE INTO member (email, role) VALUES
  ('a@a.com',  'admin'),
  ('m1@m.com', 'user'),
  ('m2@m.com', 'user');
