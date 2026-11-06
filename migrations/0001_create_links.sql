-- Short links. `code` is the primary key so uniqueness is enforced by D1,
-- not by application-level checks.
CREATE TABLE links (
	code TEXT PRIMARY KEY,
	url TEXT NOT NULL,
	clicks INTEGER NOT NULL DEFAULT 0 CHECK (clicks >= 0),
	created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;
