// Contract test between telegram_dedupe.py --seed-sql and the Worker:
// SQL produced by the Python script (passed in via SEED_SQL_FILE) must load into
// the real schema, and the Worker must then delete a re-upload of a seeded file
// without needing to download the seeded original.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { handleUpdate } from "../src/index.js";

const SCHEMA = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const SEED_FILE = process.env.SEED_SQL_FILE;

test("seeded old file: a later re-upload is deleted without downloading the original", { skip: !SEED_FILE }, async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  db.exec(readFileSync(SEED_FILE, "utf8"));
  const rows = db.prepare("SELECT chat_id, message_id, file_size, sha256, file_id FROM media").all();
  assert.ok(rows.length >= 1);
  assert.ok(rows.every((r) => r.file_id === "seed" && r.sha256.length === 64));

  const env = {
    BOT_TOKEN: "TOKEN",
    DB: {
      prepare(sql) {
        const s = db.prepare(sql);
        return {
          bind: (...a) => ({
            run: async () => ({ meta: { changes: Number(s.run(...a).changes) } }),
            first: async () => s.get(...a) ?? null,
            all: async () => ({ results: s.all(...a) }),
          }),
        };
      },
    },
  };

  const downloads = [];
  const deleted = [];
  const content = Buffer.from("old-video-bytes");
  globalThis.fetch = async (url, init) => {
    if (url.includes("/file/bot")) {
      downloads.push(url);
      return new Response(content);
    }
    const method = url.split("/").pop();
    const body = JSON.parse(init.body);
    if (method === "getFile") return Response.json({ ok: true, result: { file_path: `f/${body.file_id}` } });
    if (method === "deleteMessage") deleted.push(body.message_id);
    return Response.json({ ok: true, result: true });
  };

  // The seed's first row is the "old-video-bytes" file (see the Python side of this test).
  const old = rows.find((r) => r.sha256 === createHash("sha256").update(content).digest("hex"));
  assert.ok(old, "seed should contain the hash of old-video-bytes");

  // Seeded rows carry negated message numbers from the user's account.
  assert.ok(old.message_id < 0, "seeded message IDs must be negative");

  // In a basic group the bot's own message numbers are small and unrelated to the
  // user's, so the new upload's ID is far lower than the seeded original's number.
  const reupload = {
    message: {
      message_id: 5,
      chat: { id: old.chat_id, type: "group" },
      document: { file_unique_id: "NEW", file_id: "new-fid", file_size: old.file_size },
    },
  };
  const r = await handleUpdate(reupload, env);
  assert.equal(r.action, "deleted");
  assert.equal(r.reason, "same-content");
  assert.equal(r.original, old.message_id);
  assert.deepEqual(deleted, [5]);
  assert.equal(downloads.length, 1, "only the new upload is downloaded");
});
