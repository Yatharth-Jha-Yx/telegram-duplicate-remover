// Telegram duplicate-file bot on Cloudflare Workers.
//
// New messages: Telegram sends every group message to POST /webhook. A new
// message is a repeat, and gets deleted, when its file matches one posted
// earlier in the same chat, either:
//   1. by Telegram's file_unique_id (forwards / re-sends of the same file), or
//   2. by content: same size AND same SHA-256 (the same file uploaded again).
// The first (oldest) copy always stays.
//
// Old messages (supergroups only): bots can't read history, but an admin bot can
// forward any message of the group by its number. When the bot is added as admin,
// or an admin sends /scan, the bot walks the group's history from message 1:
// it forwards each message into the admin's private chat with the bot, reads
// the file, deletes the forward, and deletes older repeats in the group. A
// once-a-minute timer (cron) does this in small batches to stay within the
// Cloudflare free plan, then posts a summary in the group.
//
// Secrets (set with `wrangler secret put`):
//   BOT_TOKEN       - token from @BotFather
//   WEBHOOK_SECRET  - random string; Telegram echoes it in a header so only
//                     Telegram can call /webhook. Also guards POST /setup.
// Vars (wrangler.toml):
//   ALLOWED_CHAT_IDS - optional comma-separated chat IDs; empty = any group
//   NOTIFY           - "false" turns off the "Removed a duplicate" group notice

const TELEGRAM = "https://api.telegram.org";
// Bots can only download files up to 20 MB through the Bot API.
export const MAX_DOWNLOAD = 20 * 1024 * 1024;
// The free Workers plan allows 50 outgoing requests per run; keep a margin.
export const SCAN_REQUEST_BUDGET = 40;
// Requests one message of the scan may need (forward, delete forward, delete
// repeat, notice, a couple of downloads), plus the final summary messages.
const SCAN_RESERVE = 8;
const SCAN_PAUSE_MS = 300;
// Telegram's stand-in user for admins posting anonymously.
const ANONYMOUS_ADMIN_ID = 1087968824;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== "POST") return new Response("telegram-dedupe-bot is running");

    if (!env.WEBHOOK_SECRET) return new Response("WEBHOOK_SECRET not set", { status: 500 });

    if (url.pathname === "/setup") {
      if (request.headers.get("X-Setup-Key") !== env.WEBHOOK_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      const result = await telegram(env, "setWebhook", {
        url: `${url.origin}/webhook`,
        secret_token: env.WEBHOOK_SECRET,
        allowed_updates: ["message", "channel_post"],
      });
      return Response.json(result);
    }

    if (url.pathname !== "/webhook") return new Response("not found", { status: 404 });
    if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
      return new Response("forbidden", { status: 403 });
    }

    const update = await request.json();
    const outcome = await handleUpdate(update, env);
    if (outcome.action !== "ignored" && outcome.action !== "no-file") {
      console.log(JSON.stringify(outcome));
    }
    return new Response("ok");
  },

  // Cron trigger (every minute): continue any history scan in progress.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScans(env).then((r) => r.action !== "idle" && console.log(JSON.stringify(r))));
  },
};

export async function handleUpdate(update, env) {
  const msg = update.message || update.channel_post;
  if (!msg || !msg.chat) return { action: "ignored" };
  if (!["group", "supergroup", "channel"].includes(msg.chat.type)) return { action: "ignored" };
  if (!chatAllowed(msg.chat.id, env)) return { action: "ignored" };

  // A basic group upgraded to a supergroup gets a new chat ID (this often happens
  // when a bot is made admin). Telegram posts a service message in both chats;
  // either one moves what we know to the new ID. Running it twice is harmless.
  if (msg.migrate_to_chat_id) return migrateChat(env, msg.chat.id, msg.migrate_to_chat_id);
  if (msg.migrate_from_chat_id) return migrateChat(env, msg.migrate_from_chat_id, msg.chat.id);

  // Check the group's old files: when the bot is added, or when an admin sends /scan.
  if (isScanCommand(msg.text)) return requestScan(env, msg);
  if (msg.new_chat_members?.some((u) => String(u.id) === botId(env))) return requestScan(env, msg);

  const file = fileInfo(msg);
  if (!file) return { action: "no-file" };
  return checkFile(env, msg.chat.id, msg.message_id, file, { notify: env.NOTIFY !== "false" });
}

// Decide whether message `messageId` in `chatId` repeats an earlier file, and
// delete it if so. Used for new messages and, during a scan, for old ones.
async function checkFile(env, chatId, messageId, file, opts = {}) {
  // 1. Same Telegram file (forward / re-send). The primary key makes this atomic.
  const inserted = await env.DB.prepare(
    "INSERT INTO files (chat_id, file_unique_id, message_id) VALUES (?1, ?2, ?3) " +
      "ON CONFLICT (chat_id, file_unique_id) DO NOTHING"
  )
    .bind(chatId, file.uniqueId, messageId)
    .run();

  if (inserted.meta.changes === 0) {
    const original = await env.DB.prepare(
      "SELECT message_id FROM files WHERE chat_id = ?1 AND file_unique_id = ?2"
    )
      .bind(chatId, file.uniqueId)
      .first();
    // Telegram re-sends an update if we failed to answer; never delete the original itself.
    if (original && original.message_id !== messageId) {
      if (original.message_id > messageId) {
        // A scan found an older copy of a file first seen in a newer message:
        // the older one is the original, so the newer one goes.
        const r = await deleteRepeat(env, chatId, original.message_id, messageId, "same-file", file.name, opts);
        if (r.action === "deleted") {
          await env.DB.prepare(
            "UPDATE files SET message_id = ?3 WHERE chat_id = ?1 AND file_unique_id = ?2"
          )
            .bind(chatId, file.uniqueId, messageId)
            .run();
        }
        return r;
      }
      return deleteRepeat(env, chatId, messageId, original.message_id, "same-file", file.name, opts);
    }
  }

  // 2. Same content uploaded again. Only files with a same-size earlier file get downloaded.
  if (!file.size || file.size > MAX_DOWNLOAD) {
    return { action: "recorded", chatId, messageId, contentCheck: "skipped-size" };
  }

  // Negative IDs are older files seeded from the PC script or moved over from a
  // basic group; they always count as earlier. `message_id != -?3` skips a seeded
  // row for this very message (supergroup seeds store the real number, negated).
  const { results: candidates } = await env.DB.prepare(
    "SELECT message_id, file_id, sha256 FROM media " +
      "WHERE chat_id = ?1 AND file_size = ?2 AND message_id < ?3 AND message_id != -?3 " +
      "ORDER BY message_id"
  )
    .bind(chatId, file.size, messageId)
    .all();

  await env.DB.prepare(
    "INSERT INTO media (chat_id, message_id, file_id, file_size) VALUES (?1, ?2, ?3, ?4) " +
      "ON CONFLICT (chat_id, message_id) DO NOTHING"
  )
    .bind(chatId, messageId, file.fileId, file.size)
    .run();

  if (candidates.length === 0) return { action: "recorded", chatId, messageId };

  const hash = await sha256OfTelegramFile(env, file.fileId, opts.budget);
  if (!hash) return { action: "recorded", chatId, messageId, contentCheck: "download-failed" };
  await saveHash(env, chatId, messageId, hash);

  for (const candidate of candidates) {
    let candidateHash = candidate.sha256;
    if (!candidateHash) {
      candidateHash = await sha256OfTelegramFile(env, candidate.file_id, opts.budget);
      if (!candidateHash) continue;
      await saveHash(env, chatId, candidate.message_id, candidateHash);
    }
    if (candidateHash === hash) {
      // Forget the repeat so later uploads are compared with the original only.
      await env.DB.prepare("DELETE FROM media WHERE chat_id = ?1 AND message_id = ?2")
        .bind(chatId, messageId)
        .run();
      return deleteRepeat(env, chatId, messageId, candidate.message_id, "same-content", file.name, opts);
    }
  }
  return { action: "recorded", chatId, messageId };
}

// ---------------------------------------------------------------- history scan

function isScanCommand(text) {
  return typeof text === "string" && /^\/scan(@[A-Za-z0-9_]+)?(\s|$)/.test(text);
}

async function requestScan(env, msg) {
  const chatId = msg.chat.id;
  const say = (text) =>
    telegram(env, "sendMessage", { chat_id: chatId, text, disable_notification: true });

  if (msg.chat.type !== "supergroup") {
    await say(
      "ℹ️ I can't check the old files here: Telegram doesn't let bots read the history of basic groups. " +
        "Every new file posted from now on is still checked."
    );
    return { action: "scan-refused", chatId, why: "not-supergroup" };
  }

  const user = msg.from;
  if (!user || user.id === ANONYMOUS_ADMIN_ID) {
    await say("To check old files, send /scan from your own account (not as an anonymous admin).");
    return { action: "scan-refused", chatId, why: "anonymous" };
  }

  // Only admins: the bot shows old messages to whoever starts the scan.
  const member = await telegram(env, "getChatMember", { chat_id: chatId, user_id: user.id });
  if (!member.ok || !["creator", "administrator"].includes(member.result.status)) {
    await say("Only group admins can start a check of the old files.");
    return { action: "scan-refused", chatId, why: "not-admin" };
  }

  const me = await telegram(env, "getChatMember", { chat_id: chatId, user_id: Number(botId(env)) });
  if (!me.ok || me.result.status !== "administrator" || !me.result.can_delete_messages) {
    await say("Make me an admin with the 'Delete messages' right, then send /scan to check the old files.");
    return { action: "scan-refused", chatId, why: "bot-not-admin" };
  }

  const existing = await env.DB.prepare("SELECT status FROM scans WHERE chat_id = ?1").bind(chatId).first();
  if (existing?.status === "running") {
    await say("I'm already checking this group's old files. I'll post a summary when I'm done.");
    return { action: "scan-refused", chatId, why: "already-running" };
  }

  const title = msg.chat.title || "your group";
  const dm = await telegram(env, "sendMessage", {
    chat_id: user.id,
    text:
      `🔍 Checking the old files of "${title}". To read them I forward each one here and ` +
      "delete it right away, so you may see messages flash by. I'll tell you when I'm done.",
    disable_notification: true,
  });
  if (!dm.ok) {
    await say(
      "To check old files I need a private chat with you: open me in a private chat, press Start, then send /scan here again."
    );
    return { action: "scan-refused", chatId, why: "no-private-chat" };
  }

  const lastId = msg.message_id;
  await env.DB.prepare(
    "INSERT INTO scans (chat_id, title, scratch_chat_id, next_id, last_id) VALUES (?1, ?2, ?3, 1, ?4) " +
      "ON CONFLICT (chat_id) DO UPDATE SET title = excluded.title, scratch_chat_id = excluded.scratch_chat_id, " +
      "next_id = 1, last_id = excluded.last_id, checked = 0, removed = 0, unreadable = 0, " +
      "skipped = 0, last_error = NULL, " +
      "status = 'running', started = datetime('now')"
  )
    .bind(chatId, title, user.id, lastId)
    .run();
  await say(
    `🔍 Checking up to ${lastId} old messages for duplicate files. ` +
      "This takes about a minute per 15 messages; I'll post a summary here when I'm done."
  );
  return { action: "scan-started", chatId, lastId };
}

// Continue the oldest running scan by one batch. Called by the cron trigger.
export async function runScans(env, { pauseMs = SCAN_PAUSE_MS } = {}) {
  const scan = await env.DB.prepare(
    "SELECT * FROM scans WHERE status = 'running' ORDER BY started LIMIT 1"
  ).first();
  if (!scan) return { action: "idle" };

  const budget = { left: SCAN_REQUEST_BUDGET };
  let id = scan.next_id;
  let checked = 0;
  let removed = 0;
  let unreadable = 0;
  let skipped = 0;
  let lastError = null;

  while (id <= scan.last_id && budget.left >= SCAN_RESERVE) {
    // Move the bookmark first: if this message ever crashes the Worker, the next
    // run skips it (the file simply stays) instead of retrying it forever.
    await env.DB.prepare("UPDATE scans SET next_id = ?2 WHERE chat_id = ?1").bind(scan.chat_id, id + 1).run();

    const fwd = await telegram(
      env,
      "forwardMessage",
      { chat_id: scan.scratch_chat_id, from_chat_id: scan.chat_id, message_id: id, disable_notification: true },
      budget
    );
    if (!fwd.ok) {
      if (fwd.error_code === 429) {
        // Telegram says slow down: retry this message on the next run.
        await env.DB.prepare("UPDATE scans SET next_id = ?2 WHERE chat_id = ?1").bind(scan.chat_id, id).run();
        break;
      }
      // Deleted messages ("not found") and service messages like "group upgraded"
      // ("can't be forwarded") are normal; only protected content means the
      // group blocks the bot from reading its files.
      if (/protected/i.test(fwd.description || "")) unreadable++;
      skipped++;
      lastError = fwd.description || `error ${fwd.error_code}`;
      id++;
      continue;
    }

    await telegram(env, "deleteMessage", { chat_id: scan.scratch_chat_id, message_id: fwd.result.message_id }, budget);
    const file = fileInfo(fwd.result);
    if (file) {
      checked++;
      const r = await checkFile(env, scan.chat_id, id, file, { notify: false, budget });
      if (r.action === "deleted") removed++;
    }
    id++;
    if (pauseMs) await new Promise((resolve) => setTimeout(resolve, pauseMs));
  }

  await env.DB.prepare(
    "UPDATE scans SET checked = checked + ?2, removed = removed + ?3, unreadable = unreadable + ?4, " +
      "skipped = skipped + ?5, last_error = COALESCE(?6, last_error) WHERE chat_id = ?1"
  )
    .bind(scan.chat_id, checked, removed, unreadable, skipped, lastError)
    .run();

  if (id <= scan.last_id) {
    return { action: "scan-progress", chatId: scan.chat_id, nextId: id, lastId: scan.last_id };
  }

  const done = await env.DB.prepare("SELECT * FROM scans WHERE chat_id = ?1").bind(scan.chat_id).first();
  await env.DB.prepare("UPDATE scans SET status = 'done' WHERE chat_id = ?1").bind(scan.chat_id).run();
  const plural = done.removed === 1 ? "" : "s";
  let summary =
    `🧹 Old-file check finished: looked at ${done.checked} file${done.checked === 1 ? "" : "s"}, ` +
    `removed ${done.removed} duplicate${plural}. The first copy of each was kept.`;
  if (done.checked === 0 && done.unreadable > 0) {
    summary =
      "⚠️ I couldn't read this group's old messages. If the group restricts saving content " +
      "(no forwarding), turn that off and send /scan again.";
  }
  await telegram(env, "sendMessage", { chat_id: scan.chat_id, text: summary, disable_notification: true }, budget);
  // The admin also sees how many messages could not be read and why (deleted
  // and service messages are normal), to spot a group the bot can't read.
  const detail = done.skipped
    ? ` ${done.skipped} of ${done.last_id} messages couldn't be read (deleted or system messages are normal; last reason: ${done.last_error}).`
    : "";
  await telegram(
    env,
    "sendMessage",
    {
      chat_id: scan.scratch_chat_id,
      text: `✅ Done checking "${done.title}". ${summary}${detail}`,
      disable_notification: true,
    },
    budget
  );
  return { action: "scan-done", chatId: scan.chat_id, checked: done.checked, removed: done.removed };
}

// ---------------------------------------------------------------- helpers

async function migrateChat(env, fromChat, toChat) {
  // Message numbers restart in the new supergroup, so every old row must count as
  // "older" than anything new: store old positive message IDs as negative, the same
  // convention seeded rows use. OR IGNORE skips the (unlikely) rows that would
  // collide; those leftovers are then dropped with the old chat.
  const media = await env.DB.prepare(
    "UPDATE OR IGNORE media SET chat_id = ?2, " +
      "message_id = CASE WHEN message_id > 0 THEN -message_id ELSE message_id END " +
      "WHERE chat_id = ?1"
  )
    .bind(fromChat, toChat)
    .run();
  const files = await env.DB.prepare(
    "UPDATE OR IGNORE files SET chat_id = ?2, " +
      "message_id = CASE WHEN message_id > 0 THEN -message_id ELSE message_id END " +
      "WHERE chat_id = ?1"
  )
    .bind(fromChat, toChat)
    .run();
  await env.DB.prepare("DELETE FROM media WHERE chat_id = ?1").bind(fromChat).run();
  await env.DB.prepare("DELETE FROM files WHERE chat_id = ?1").bind(fromChat).run();
  return {
    action: "migrated",
    from: fromChat,
    to: toChat,
    mediaMoved: media.meta.changes,
    filesMoved: files.meta.changes,
  };
}

async function deleteRepeat(env, chatId, messageId, originalId, reason, fileName, opts = {}) {
  const result = await telegram(env, "deleteMessage", { chat_id: chatId, message_id: messageId }, opts.budget);
  if (!result.ok) {
    return { action: "delete-failed", reason, chatId, messageId, original: originalId, error: result.description };
  }
  const outcome = { action: "deleted", reason, chatId, messageId, original: originalId };
  if (opts.notify) {
    // Plain text (no parse_mode), so odd characters in file names can't break the message.
    const what = fileName ? `"${fileName}"` : "a photo";
    const notice = await telegram(
      env,
      "sendMessage",
      {
        chat_id: chatId,
        text: `🧹 Removed a duplicate: ${what} was already posted in this group.`,
        disable_notification: true,
      },
      opts.budget
    );
    // The repeat is already gone; a failed notice is only logged.
    if (!notice.ok) outcome.noticeError = notice.description;
  }
  return outcome;
}

function saveHash(env, chatId, messageId, hash) {
  return env.DB.prepare("UPDATE media SET sha256 = ?3 WHERE chat_id = ?1 AND message_id = ?2")
    .bind(chatId, messageId, hash)
    .run();
}

// Stickers are skipped on purpose: people reuse the same sticker all the time.
export function fileInfo(msg) {
  for (const kind of ["document", "video", "animation", "audio", "voice", "video_note"]) {
    const f = msg[kind];
    if (f?.file_unique_id) {
      return { uniqueId: f.file_unique_id, fileId: f.file_id, size: f.file_size, name: f.file_name || null };
    }
  }
  if (Array.isArray(msg.photo) && msg.photo.length > 0) {
    const p = msg.photo[msg.photo.length - 1]; // largest size
    return { uniqueId: p.file_unique_id, fileId: p.file_id, size: p.file_size, name: null };
  }
  return null;
}

async function sha256OfTelegramFile(env, fileId, budget) {
  const info = await telegram(env, "getFile", { file_id: fileId }, budget);
  if (!info.ok || !info.result?.file_path) return null;
  if (budget) budget.left--;
  const response = await fetch(`${TELEGRAM}/file/bot${env.BOT_TOKEN}/${info.result.file_path}`);
  if (!response.ok) return null;
  const digest = await crypto.subtle.digest("SHA-256", await response.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function botId(env) {
  return String(env.BOT_TOKEN || "").split(":")[0];
}

function chatAllowed(chatId, env) {
  const list = (env.ALLOWED_CHAT_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return list.length === 0 || list.includes(String(chatId));
}

async function telegram(env, method, body, budget) {
  if (budget) budget.left--;
  const response = await fetch(`${TELEGRAM}/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return response.json();
}
