-- Fast path: Telegram's own ID for a file. Catches forwards and re-sends.
CREATE TABLE IF NOT EXISTS files (
  chat_id INTEGER NOT NULL,
  file_unique_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  first_seen TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (chat_id, file_unique_id)
);

-- Content path: catches the same file uploaded again from disk (new Telegram ID,
-- same bytes). Files are only downloaded and hashed when another file in the
-- chat has exactly the same size; sha256 is filled in lazily and then reused.
-- Rows with a NEGATIVE message_id were seeded from the group's history by
-- telegram_dedupe.py --seed-sql (the poster's message number, negated); they
-- always count as older than any new message.
CREATE TABLE IF NOT EXISTS media (
  chat_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  file_id TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  sha256 TEXT,
  first_seen TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (chat_id, message_id)
);

CREATE INDEX IF NOT EXISTS media_by_size ON media (chat_id, file_size);

-- History scans (supergroups): the bot walks message numbers next_id..last_id,
-- forwarding each into the requesting admin's private chat (scratch_chat_id)
-- to read it. One row per group; a once-a-minute cron continues running scans.
CREATE TABLE IF NOT EXISTS scans (
  chat_id INTEGER PRIMARY KEY,
  title TEXT,
  scratch_chat_id INTEGER NOT NULL,
  next_id INTEGER NOT NULL,
  last_id INTEGER NOT NULL,
  checked INTEGER NOT NULL DEFAULT 0,
  removed INTEGER NOT NULL DEFAULT 0,
  unreadable INTEGER NOT NULL DEFAULT 0,
  skipped INTEGER NOT NULL DEFAULT 0,  -- messages Telegram wouldn't forward (any reason)
  last_error TEXT,                     -- Telegram's last reason, for diagnosis
  status TEXT NOT NULL DEFAULT 'running',
  started TEXT NOT NULL DEFAULT (datetime('now'))
);
