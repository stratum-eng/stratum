-- Magic-link tokens moved from KV (eventually-consistent get-then-delete, which
-- allowed a single link to be redeemed more than once under a race) to D1, where
-- consumption is a single atomic conditional UPDATE. The token is stored hashed
-- so a DB read can't replay a live link.
CREATE TABLE IF NOT EXISTS magic_links (
  token_hash TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_magic_links_expires ON magic_links(expires_at);
