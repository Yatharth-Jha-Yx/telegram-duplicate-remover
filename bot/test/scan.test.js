// History scan: the bot walks a supergroup's old messages by forwarding each one
// into the requesting admin's private chat, then deletes older repeats.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { handleUpdate, runScans, SCAN_REQUEST_BUDGET } from "../src/index.js";

const SCHEMA = readFileSync(new URL("../schema.sql", import.meta.url), "utf8");
const BOT = 777;
const ADMIN = { id: 1001, first_name: "Admin" };
const MEMBER = { id: 1002, first_name: "Member" };
const GROUP = { id: -1001111111111, type: "supergroup", title: "Test group" };

function d1() {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  return {
    raw: db,
    prepare(sql) {
      const stmt = db.prepare(sql);
      const bound = (...args) => ({
        run: async () => ({ meta: { changes: Number(stmt.run(...args).changes) } }),
        first: async () => stmt.get(...args) ?? null,
        all: async () => ({ results: stmt.all(...args) }),
      });
      return { bind: bound, ...bound() };
    },
  };
}

let env, calls, history, members, blockedDM, contents, protectedChats, rateLimitOnce, fetchesThisRun;

beforeEach(() => {
  env = { DB: d1(), BOT_TOKEN: `${BOT}:TOKEN`, WEBHOOK_SECRET: "s", ALLOWED_CHAT_IDS: "", NOTIFY: "true" };
  calls = [];
  history = new Map(); // message number in GROUP -> message body (without chat/message_id)
  members = new Map([
    [ADMIN.id, { status: "administrator" }],
    [BOT, { status: "administrator", can_delete_messages: true }],
  ]);
  blockedDM = new Set();
  contents = new Map(); // file_id -> bytes
  protectedChats = new Set();
  rateLimitOnce = new Set(); // message numbers whose first forward gets a 429
  fetchesThisRun = 0;
  let nextDmId = 5000;

  globalThis.fetch = async (url, init) => {
    fetchesThisRun++;
    const file = url.match(/\/file\/bot777:TOKEN\/f\/(.+)$/);
    if (file) return new Response(contents.get(file[1]));
    const method = url.split("/").pop();
    const body = JSON.parse(init.body);
    calls.push({ method, body });
    const ok = (result = true) => Response.json({ ok: true, result });
    const fail = (error_code, description) => Response.json({ ok: false, error_code, description });

    switch (method) {
      case "getFile":
        return ok({ file_path: `f/${body.file_id}` });
      case "getChatMember":
        return ok(members.get(body.user_id) ?? { status: "member" });
      case "sendMessage":
        if (blockedDM.has(body.chat_id)) return fail(403, "Forbidden: bot can't initiate conversation with a user");
        return ok({ message_id: nextDmId++ });
      case "forwardMessage": {
        if (protectedChats.has(body.from_chat_id)) return fail(400, "Bad Request: message has protected content and can't be forwarded");
        if (rateLimitOnce.delete(body.message_id)) return fail(429, "Too Many Requests: retry after 3");
        const m = history.get(body.message_id);
        if (!m) return fail(400, "Bad Request: message to forward not found");
        return ok({ ...m, message_id: nextDmId++, chat: { id: body.chat_id, type: "private" } });
      }
      default:
        return ok();
    }
  };
});

const docBody = (unique, content, name) => {
  const fileId = `fid-${unique}-${content}`;
  contents.set(fileId, Buffer.from(content));
  return { document: { file_unique_id: unique, file_id: fileId, file_size: Buffer.byteLength(content), file_name: name } };
};
const scanCmd = (message_id, from = ADMIN, chat = GROUP) => ({ message: { message_id, chat, from, text: "/scan" } });
const sent = (chatId) => calls.filter((c) => c.method === "sendMessage" && c.body.chat_id === chatId).map((c) => c.body.text);
const deletedIn = (chatId) =>
  calls.filter((c) => c.method === "deleteMessage" && c.body.chat_id === chatId).map((c) => c.body.message_id);
const scanRow = () => env.DB.raw.prepare("SELECT * FROM scans WHERE chat_id = ?").get(GROUP.id);

async function scanToEnd() {
  for (let i = 0; i < 100; i++) {
    fetchesThisRun = 0;
    const r = await runScans(env, { pauseMs: 0 });
    assert.ok(fetchesThisRun <= 50, `a run made ${fetchesThisRun} requests; the free plan allows 50`);
    if (r.action === "scan-done" || r.action === "idle") return r;
  }
  throw new Error("scan never finished");
}

test("full scan deletes older repeats, keeps originals, cleans up and summarises", async () => {
  history.set(1, { text: "hello" });
  history.set(2, docBody("A", "aaaa", "a.mp4"));
  // 3: deleted message (not in history)
  history.set(4, docBody("A", "aaaa", "a.mp4")); // forward of 2 -> same file
  history.set(5, docBody("B", "xxxx", "b.mp4"));
  history.set(6, docBody("C", "xxxx", "b copy.mp4")); // re-upload of 5 -> same content
  history.set(7, { photo: [{ file_unique_id: "P", file_id: "fid-P", file_size: 9 }] });
  history.set(8, { sticker: { file_unique_id: "S", file_id: "fid-S" } });
  history.set(9, docBody("D", "dddddd", "d.pdf"));

  const start = await handleUpdate(scanCmd(10), env);
  assert.equal(start.action, "scan-started");
  assert.equal(start.lastId, 10);
  assert.match(sent(GROUP.id)[0], /Checking up to 10 old messages/);
  assert.match(sent(ADMIN.id)[0], /Checking the old files of "Test group"/);

  const done = await scanToEnd();
  assert.equal(done.action, "scan-done");
  assert.deepEqual(deletedIn(GROUP.id), [4, 6]);
  // every forward into the admin's chat was deleted again (7 readable messages: 1,2,4,5,6,7,8,9 minus none)
  const forwards = calls.filter((c) => c.method === "forwardMessage").length;
  assert.equal(forwards, 10);
  assert.equal(deletedIn(ADMIN.id).length, 8); // 1,2,4,5,6,7,8,9 were readable
  const groupTexts = sent(GROUP.id);
  assert.equal(
    groupTexts.at(-1),
    "🧹 Old-file check finished: looked at 6 files, removed 2 duplicates. The first copy of each was kept."
  );
  assert.equal(groupTexts.filter((t) => t.startsWith("🧹 Removed a duplicate")).length, 0, "no per-file notices during a scan");
  assert.match(sent(ADMIN.id).at(-1), /^✅ Done checking "Test group"/);
  // message 3 (deleted) and 10 (the /scan, not in this fake history) couldn't be forwarded
  assert.match(sent(ADMIN.id).at(-1), /2 of 10 messages couldn't be read .*last reason: Bad Request: message to forward not found/);
  assert.equal(scanRow().skipped, 2);
  assert.equal(scanRow().status, "done");

  // After the scan, new uploads of old files are caught as usual.
  const live = await handleUpdate({ message: { message_id: 11, chat: GROUP, from: MEMBER, ...docBody("Z", "dddddd", "again.pdf") } }, env);
  assert.equal(live.action, "deleted");
  assert.equal(live.original, 9);
});

test("big histories are done in batches that stay within the free plan", async () => {
  for (let i = 1; i <= 60; i++) history.set(i, docBody(`U${i}`, `content-${i}`, `f${i}.bin`));
  await handleUpdate(scanCmd(61), env);
  fetchesThisRun = 0;
  const first = await runScans(env, { pauseMs: 0 });
  assert.equal(first.action, "scan-progress");
  assert.ok(first.nextId > 1 && first.nextId < 61);
  assert.ok(fetchesThisRun <= SCAN_REQUEST_BUDGET + 2);
  const done = await scanToEnd();
  assert.equal(done.checked, 60);
  assert.equal(done.removed, 0);
});

test("a 'too many requests' answer retries the same message next run", async () => {
  history.set(1, docBody("A", "aaaa"));
  history.set(2, docBody("A", "aaaa"));
  rateLimitOnce.add(2);
  await handleUpdate(scanCmd(3), env);
  const first = await runScans(env, { pauseMs: 0 });
  assert.equal(first.action, "scan-progress");
  assert.equal(scanRow().next_id, 2);
  await scanToEnd();
  assert.deepEqual(deletedIn(GROUP.id), [2]);
});

test("a newer copy seen live before the scan reaches the original: the newer one goes", async () => {
  // Message 20 arrives live first (bot records it), then the scan finds message 2.
  await handleUpdate({ message: { message_id: 20, chat: GROUP, from: MEMBER, ...docBody("A", "aaaa", "a.mp4") } }, env);
  history.set(2, docBody("A", "aaaa", "a.mp4"));
  await handleUpdate(scanCmd(21), env);
  await scanToEnd();
  assert.deepEqual(deletedIn(GROUP.id), [20]);
  const row = env.DB.raw.prepare("SELECT message_id FROM files WHERE file_unique_id = 'A'").get();
  assert.equal(row.message_id, 2);
});

test("a file seeded by the PC script is not deleted when the scan reaches it", async () => {
  history.set(5, docBody("B", "seeded", "s.mp4"));
  const sha = createHash("sha256").update("seeded").digest("hex");
  env.DB.raw.exec(
    `INSERT INTO media (chat_id, message_id, file_id, file_size, sha256) VALUES (${GROUP.id}, -5, 'seed', 6, '${sha}')`
  );
  history.set(7, docBody("C", "seeded", "s copy.mp4")); // a real repeat of it
  await handleUpdate(scanCmd(8), env);
  await scanToEnd();
  assert.deepEqual(deletedIn(GROUP.id), [7]);
});

test("adding the bot as admin starts the scan by itself", async () => {
  history.set(1, docBody("A", "aaaa"));
  history.set(2, docBody("A", "aaaa"));
  const r = await handleUpdate(
    { message: { message_id: 3, chat: GROUP, from: ADMIN, new_chat_members: [{ id: BOT, is_bot: true }] } },
    env
  );
  assert.equal(r.action, "scan-started");
  await scanToEnd();
  assert.deepEqual(deletedIn(GROUP.id), [2]);
});

test("refusals: member, basic group, bot not admin, no private chat, already running", async () => {
  assert.equal((await handleUpdate(scanCmd(5, MEMBER), env)).why, "not-admin");
  assert.match(sent(GROUP.id).at(-1), /Only group admins/);

  const basic = { id: -222222222, type: "group", title: "Basic" };
  assert.equal((await handleUpdate(scanCmd(5, ADMIN, basic), env)).why, "not-supergroup");
  assert.match(sent(basic.id).at(-1), /basic groups/);

  members.set(BOT, { status: "administrator", can_delete_messages: false });
  assert.equal((await handleUpdate(scanCmd(5), env)).why, "bot-not-admin");
  members.set(BOT, { status: "administrator", can_delete_messages: true });

  blockedDM.add(ADMIN.id);
  assert.equal((await handleUpdate(scanCmd(5), env)).why, "no-private-chat");
  assert.match(sent(GROUP.id).at(-1), /press Start/);
  blockedDM.delete(ADMIN.id);

  assert.equal((await handleUpdate(scanCmd(5), env)).action, "scan-started");
  assert.equal((await handleUpdate(scanCmd(6), env)).why, "already-running");
  assert.equal(scanRow().last_id, 5);
});

test("a group that blocks forwarding gets a clear warning instead of a summary", async () => {
  history.set(1, docBody("A", "aaaa"));
  protectedChats.add(GROUP.id);
  await handleUpdate(scanCmd(2), env);
  await scanToEnd();
  assert.match(sent(GROUP.id).at(-1), /couldn't read this group's old messages/);
  assert.deepEqual(deletedIn(GROUP.id), []);
});

test("service messages (like 'group upgraded') don't trigger the blocked-forwarding warning", async () => {
  // Telegram answers forwards of service messages with "message can't be forwarded".
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (url.endsWith("/forwardMessage") && JSON.parse(init.body).message_id === 1) {
      return Response.json({ ok: false, error_code: 400, description: "Bad Request: message can't be forwarded" });
    }
    return realFetch(url, init);
  };
  await handleUpdate(scanCmd(2), env);
  await scanToEnd();
  assert.equal(
    sent(GROUP.id).at(-1),
    "🧹 Old-file check finished: looked at 0 files, removed 0 duplicates. The first copy of each was kept."
  );
});

test("nothing to do: the timer run is idle", async () => {
  assert.equal((await runScans(env, { pauseMs: 0 })).action, "idle");
});
