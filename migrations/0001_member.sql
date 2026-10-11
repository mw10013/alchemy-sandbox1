CREATE TABLE member (
  email      text PRIMARY KEY,
  role       text NOT NULL CHECK (role IN ('admin', 'user')),
  created_at integer NOT NULL DEFAULT (unixepoch())
);
