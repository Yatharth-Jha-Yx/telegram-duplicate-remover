import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import worker, { handleUpdate, MAX_DOWNLOAD } from "../src/index.js";

const SCHEMA = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");

// D1-shaped wrapper over a real in-memory SQLite database running the real schema.
function d1() {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  return {
    raw: db,
    prepare(sql) {
      const stmt = db.prepare(sql);
      return {
        bind(...args) {
          return {
            async run() {
              return { meta: { changes: Number(stmt.run(...args).changes) } };
            },
            async first() {
              return stmt.get(...args) ?? null;
            },
            async all() {
              return { results: stmt.all(...args) };
            },
          };
        },
      };
    },
  };
}

let calls; // every Telegram API call, as { method, body }
let downloads; // file_ids whose bytes were downloaded
let contents; // file_id -> file bytes served by the fake Telegram
let env;

beforeEach(() => {
  calls = [];
  downloads = [];
  contents = new Map();
  globalThis.fetch = async (url, init) => {
    const fileMatch = url.match(/\/file\/botTOKEN\/f\/(.+)$/);
    if (fileMatch) {
      downloads.push(fileMatch[1]);
      const bytes = contents.get(fileMatch[1]);
      return bytes ? new Response(bytes) : new Response("missing", { status: 404 });
    }
    const method = url.split("/").pop();
    const body = JSON.parse(init.body);
    calls.push({ method, body });
    if (method === "getFile") return Response.json({ ok: true, result: { file_path: `f/${body.file_id}` } });
    return Response.json({ ok: true, result: true });
  };
  env = { DB: d1(), BOT_TOKEN: "TOKEN", WEBHOOK_SECRET: "s3cret", ALLOWED_CHAT_IDS: "" };
});

const GROUP = { id: -1001234567890, type: "supergroup" };
const deletes = () => calls.filter((c) => c.method === "deleteMessage").map((c) => c.body.message_id);

// A document message. `content` (a string) is what the fake Telegram serves for its file_id.
function doc(message_id, unique, { content = `bytes-of-${unique}`, size, chat = GROUP } = {}) {
  const fileId = `fid-${message_id}`;
  contents.set(fileId, Buffer.from(content));
  return {
    message: {
      message_id,
      chat,
      document: { file_unique_id: unique, file_id: fileId, file_size: size ?? Buffer.byteLength(content) },
    },
  };
}

test("forward of the same Telegram file is deleted without downloading", async () => {
  assert.equal((await handleUpdate(doc(10, "AAA"), env)).action, "recorded");
  const r = await handleUpdate(doc(11, "AAA"), env);
  assert.equal(r.action, "deleted");
  assert.equal(r.reason, "same-file");
  assert.equal(r.original, 10);
  assert.deepEqual(deletes(), [11]);
  assert.deepEqual(downloads, []);
});

test("same file uploaded again (new Telegram ID, same bytes) is deleted", async () => {
  await handleUpdate(doc(10, "AAA", { content: "video-bytes" }), env);
  const r = await handleUpdate(doc(11, "BBB", { content: "video-bytes" }), env);
  assert.equal(r.action, "deleted");
  assert.equal(r.reason, "same-content");
  assert.equal(r.original, 10);
  assert.deepEqual(deletes(), [11]);
});

test("same size but different bytes: both kept", async () => {
  await handleUpdate(doc(10, "AAA", { content: "aaaa" }), env);
  const r = await handleUpdate(doc(11, "BBB", { content: "bbbb" }), env);
  assert.equal(r.action, "recorded");
  assert.deepEqual(deletes(), []);
});

test("files with a unique size are never downloaded", async () => {
  await handleUpdate(doc(10, "AAA", { content: "short" }), env);
  await handleUpdate(doc(11, "BBB", { content: "a bit longer" }), env);
  assert.deepEqual(downloads, []);
});

test("an original's hash is computed once and reused", async () => {
  await handleUpdate(doc(10, "AAA", { content: "xxxx" }), env);
  await handleUpdate(doc(11, "BBB", { content: "yyyy" }), env); // downloads 11 and 10
  await handleUpdate(doc(12, "CCC", { content: "zzzz" }), env); // downloads 12 only
  assert.deepEqual(downloads, ["fid-11", "fid-10", "fid-12"]);
  assert.deepEqual(deletes(), []);
});

test("a third copy is deleted and compared with the original, not the deleted copy", async () => {
  await handleUpdate(doc(10, "AAA", { content: "same" }), env);
  await handleUpdate(doc(11, "BBB", { content: "same" }), env);
  const r = await handleUpdate(doc(12, "CCC", { content: "same" }), env);
  assert.equal(r.original, 10);
  assert.deepEqual(deletes(), [11, 12]);
  const rows = env.DB.raw.prepare("SELECT message_id FROM media ORDER BY message_id").all();
  assert.deepEqual(rows.map((x) => x.message_id), [10]);
});

test("files over the 20 MB download limit are only checked by Telegram ID", async () => {
  const big = MAX_DOWNLOAD + 1;
  await handleUpdate(doc(10, "AAA", { size: big }), env);
  const r = await handleUpdate(doc(11, "BBB", { size: big }), env);
  assert.equal(r.contentCheck, "skipped-size");
  assert.deepEqual(downloads, []);
  assert.deepEqual(deletes(), []);
});

test("a failed download keeps the message", async () => {
  await handleUpdate(doc(10, "AAA", { content: "same" }), env);
  const m = doc(11, "BBB", { content: "same" });
  contents.delete("fid-11");
  const r = await handleUpdate(m, env);
  assert.equal(r.contentCheck, "download-failed");
  assert.deepEqual(deletes(), []);
});

test("a retried update for the original is not deleted", async () => {
  await handleUpdate(doc(10, "AAA", { content: "same" }), env);
  await handleUpdate(doc(10, "AAA", { content: "same" }), env);
  assert.deepEqual(deletes(), []);
});

test("same content in a different group is not a repeat", async () => {
  await handleUpdate(doc(10, "AAA", { content: "same" }), env);
  const other = { id: -100999, type: "supergroup" };
  const r = await handleUpdate(doc(11, "BBB", { content: "same", chat: other }), env);
  assert.equal(r.action, "recorded");
  assert.deepEqual(deletes(), []);
});

test("photos use the largest size; videos are covered", async () => {
  contents.set("p-big-1", Buffer.from("photo"));
  contents.set("p-big-2", Buffer.from("photo"));
  const photo = (id) => ({
    message: {
      message_id: id,
      chat: GROUP,
      photo: [
        { file_unique_id: `small-${id}`, file_id: `p-small-${id}`, file_size: 1 },
        { file_unique_id: `big-${id}`, file_id: `p-big-${id}`, file_size: 5 },
      ],
    },
  });
  await handleUpdate(photo(1), env);
  assert.equal((await handleUpdate(photo(2), env)).reason, "same-content");

  const video = (id) => ({
    message: { message_id: id, chat: GROUP, video: { file_unique_id: "VID", file_id: `v${id}`, file_size: 9 } },
  });
  await handleUpdate(video(3), env);
  assert.equal((await handleUpdate(video(4), env)).reason, "same-file");
});

test("stickers, text and private chats are ignored", async () => {
  const sticker = (id) => ({ message: { message_id: id, chat: GROUP, sticker: { file_unique_id: "STK" } } });
  await handleUpdate(sticker(1), env);
  assert.equal((await handleUpdate(sticker(2), env)).action, "no-file");
  assert.equal((await handleUpdate({ message: { message_id: 3, chat: GROUP, text: "hi" } }, env)).action, "no-file");
  const dm = doc(4, "AAA", { chat: { id: 42, type: "private" } });
  assert.equal((await handleUpdate(dm, env)).action, "ignored");
  assert.deepEqual(calls, []);
});

test("ALLOWED_CHAT_IDS limits which groups are touched", async () => {
  env.ALLOWED_CHAT_IDS = "-100555";
  assert.equal((await handleUpdate(doc(10, "AAA"), env)).action, "ignored");
  env.ALLOWED_CHAT_IDS = `-100555, ${GROUP.id}`;
  assert.equal((await handleUpdate(doc(10, "AAA"), env)).action, "recorded");
});

test("a failed delete is reported, not thrown", async () => {
  await handleUpdate(doc(10, "AAA"), env);
  globalThis.fetch = async () => Response.json({ ok: false, description: "Bad Request: message can't be deleted" });
  const r = await handleUpdate(doc(11, "AAA"), env);
  assert.equal(r.action, "delete-failed");
  assert.match(r.error, /can't be deleted/);
});

test("basic group upgraded to supergroup: seeded and seen files follow the new chat ID", async () => {
  const OLD = { id: -222222222, type: "group" };
  const NEW = { id: -1009999999999, type: "supergroup" };
  // A seeded old file (negative ID) and one the bot saw in the basic group (ID 7).
  env.DB.raw.exec(
    `INSERT INTO media (chat_id, message_id, file_id, file_size, sha256) VALUES
       (${OLD.id}, -152470, 'seed', 4, '${"a".repeat(64)}')`
  );
  await handleUpdate(doc(7, "SEEN", { content: "seen", chat: OLD }), env);

  // Telegram's service messages, in both chats; the second must be a no-op.
  const toNew = await handleUpdate({ message: { message_id: 8, chat: OLD, migrate_to_chat_id: NEW.id } }, env);
  assert.equal(toNew.action, "migrated");
  assert.equal(toNew.mediaMoved, 2);
  const again = await handleUpdate({ message: { message_id: 1, chat: NEW, migrate_from_chat_id: OLD.id } }, env);
  assert.equal(again.mediaMoved, 0);

  const rows = env.DB.raw.prepare("SELECT chat_id, message_id FROM media ORDER BY message_id").all();
  assert.deepEqual(rows.map((r) => [r.chat_id, r.message_id]), [[NEW.id, -152470], [NEW.id, -7]]);

  // In the new supergroup message numbers restart; re-uploads still match both originals.
  contents.set("fid-2", Buffer.from("seen"));
  const r1 = await handleUpdate(doc(2, "X1", { content: "seen", chat: NEW }), env);
  assert.equal(r1.action, "deleted");
  assert.equal(r1.original, -7);
  // Telegram ID path moved too: a forward of the file seen in the basic group is caught.
  const r2 = await handleUpdate(doc(3, "SEEN", { content: "seen", chat: NEW }), env);
  assert.equal(r2.reason, "same-file");
  assert.deepEqual(deletes(), [2, 3]);
});

test("after deleting a repeat the bot posts a quiet notice naming the file", async () => {
  const named = (id, unique) => {
    const m = doc(id, unique, { content: "same" });
    m.message.document.file_name = 'clip "1".mp4';
    return m;
  };
  await handleUpdate(named(10, "AAA"), env);
  await handleUpdate(named(11, "BBB"), env);
  const notices = calls.filter((c) => c.method === "sendMessage");
  assert.equal(notices.length, 1);
  assert.equal(notices[0].body.chat_id, GROUP.id);
  assert.equal(notices[0].body.text, '🧹 Removed a duplicate: "clip "1".mp4" was already posted in this group.');
  assert.equal(notices[0].body.disable_notification, true);
  assert.equal(notices[0].body.parse_mode, undefined);
});

test("photos are described as 'a photo'; NOTIFY=false turns notices off", async () => {
  await handleUpdate(doc(10, "AAA"), env);
  await handleUpdate(doc(11, "AAA"), env); // doc() has no file_name, like a photo
  assert.match(calls.find((c) => c.method === "sendMessage").body.text, /Removed a duplicate: a photo was/);

  calls.length = 0;
  env.NOTIFY = "false";
  await handleUpdate(doc(12, "AAA"), env);
  assert.deepEqual(deletes(), [12]);
  assert.equal(calls.filter((c) => c.method === "sendMessage").length, 0);
});

test("a failed notice does not undo or hide the deletion", async () => {
  await handleUpdate(doc(10, "AAA"), env);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) =>
    url.endsWith("/sendMessage")
      ? Response.json({ ok: false, description: "Forbidden: not enough rights to send text messages" })
      : realFetch(url, init);
  const r = await handleUpdate(doc(11, "AAA"), env);
  assert.equal(r.action, "deleted");
  assert.match(r.noticeError, /not enough rights/);
});

test("webhook rejects requests without Telegram's secret header", async () => {
  const body = JSON.stringify(doc(10, "AAA"));
  const bad = await worker.fetch(new Request("https://x.dev/webhook", { method: "POST", body }), env);
  assert.equal(bad.status, 403);
  const good = await worker.fetch(
    new Request("https://x.dev/webhook", {
      method: "POST",
      body,
      headers: { "X-Telegram-Bot-Api-Secret-Token": "s3cret" },
    }),
    env
  );
  assert.equal(good.status, 200);
});

test("setup registers the webhook with the secret and is key-protected", async () => {
  const denied = await worker.fetch(new Request("https://bot.example.workers.dev/setup", { method: "POST" }), env);
  assert.equal(denied.status, 403);
  const ok = await worker.fetch(
    new Request("https://bot.example.workers.dev/setup", { method: "POST", headers: { "X-Setup-Key": "s3cret" } }),
    env
  );
  assert.equal(ok.status, 200);
  assert.equal(calls[0].method, "setWebhook");
  assert.deepEqual(calls[0].body, {
    url: "https://bot.example.workers.dev/webhook",
    secret_token: "s3cret",
    allowed_updates: ["message", "channel_post"],
  });
});
