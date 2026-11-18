"""
One-time duplicate-file cleanup for a Telegram group, run as YOUR OWN user account.

  1. Reads the full history of the group.
  2. Groups file messages that have the same file name and size.
  3. Optional (--verify): downloads each candidate and compares SHA-256, so only
     byte-identical files count as duplicates.
  4. Keeps the OLDEST copy of each set and deletes the rest.

Default is a DRY RUN. Nothing is deleted unless you pass --delete AND type DELETE.

Setup (once):
    pip install telethon
    Get api_id and api_hash at https://my.telegram.org (log in with your phone number).

Run a dry run first:
    python telegram_dedupe.py --group "@yourgroup" --api-id 12345 --api-hash abcdef --verify

Then delete:
    python telegram_dedupe.py --group "@yourgroup" --api-id 12345 --api-hash abcdef --verify --delete

Teach the bot about the files already in the group (--seed-sql):
    Writes a SQL file with the size and SHA-256 of every file that is kept, so the
    bot also deletes later re-uploads of OLD files. --load-seed loads it into the
    bot's database (needs wrangler logged in); --announce posts a summary in the group.

New group, one command (run it BEFORE adding the bot to the group):
    python telegram_dedupe.py --group "Group name" --api-id 12345 --api-hash abcdef --session me --bot-setup --delete
    --bot-setup = --verify --seed-sql seed.sql --load-seed --announce
    Without --delete it is a dry run: nothing deleted, loaded or posted.
"""

import argparse
import asyncio
import csv
import hashlib
import json
import os
import subprocess
from collections import defaultdict

from telethon import TelegramClient, utils
from telethon.errors import ChatAdminRequiredError, FloodWaitError
from telethon.tl.types import Channel, Chat


async def resolve_group(client, value):
    """Accept a numeric ID, an @username / t.me link, or the group's exact display name."""
    if value.lstrip("-").isdigit():
        return await client.get_entity(int(value))
    if value.startswith("@") or "t.me/" in value:
        return await client.get_entity(value)
    matches = [d.entity async for d in client.iter_dialogs()
               if (d.is_group or d.is_channel) and d.name == value]
    if not matches:
        raise SystemExit(f"No group named '{value}' found in your chats. Check the exact spelling.")
    if len(matches) > 1:
        ids = ", ".join(str(m.id) for m in matches)
        raise SystemExit(f"Several groups are named '{value}' (IDs: {ids}). Pass one ID with --group.")
    return matches[0]


async def collect_files(client, chat):
    """Return every message in the chat that carries a file/document."""
    files = []
    scanned = 0
    async for msg in client.iter_messages(chat, limit=None):
        scanned += 1
        if scanned % 1000 == 0:
            print(f"  scanned {scanned} messages...")
        if msg.document or msg.photo:
            files.append(msg)
    print(f"Scanned {scanned} messages, {len(files)} contain files or photos.")
    return files


def group_candidates(files, verify):
    """Sets of possible duplicates, oldest first.

    With --verify, files are grouped by size only (copies often have different
    names) and the SHA-256 check decides. Without it, name AND size must match.
    """
    buckets = defaultdict(list)
    for m in files:
        key = m.file.size if verify else (m.file.name or "", m.file.size)
        buckets[key].append(m)
    return [sorted(v, key=lambda m: m.id) for v in buckets.values() if len(v) > 1]


# The bot (Bot API) can only download files up to 20 MB, so it never compares larger ones.
BOT_MAX_DOWNLOAD = 20 * 1024 * 1024

# Telethon already retries each download 6 times internally, so a file that fails
# twice here is almost always one Telegram cannot serve at all.
DOWNLOAD_ATTEMPTS = 2


class HashStore:
    """SHA-256 per message. With a path, it is saved after every file, so an
    interrupted run continues where it stopped instead of downloading again."""

    def __init__(self, path=None, chat_id=0):
        self.path, self.chat_id, self.data = path, chat_id, {}
        if path:
            try:
                with open(path, encoding="utf-8") as f:
                    self.data = json.load(f)
            except (FileNotFoundError, json.JSONDecodeError):
                self.data = {}

    def _key(self, msg):
        # Size is part of the key so a message whose media was replaced is hashed again.
        return f"{self.chat_id}:{msg.id}:{msg.file.size}"

    def get(self, msg):
        return self.data.get(self._key(msg))

    def put(self, msg, digest):
        self.data[self._key(msg)] = digest
        if self.path:
            tmp = self.path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self.data, f)
            os.replace(tmp, self.path)


store = HashStore()  # replaced in main() with one saved to disk


async def sha256_of(client, msg):
    """Return the file's SHA-256, or None if Telegram keeps failing to serve it."""
    cached = store.get(msg)
    if cached:
        return cached
    for attempt in range(1, DOWNLOAD_ATTEMPTS + 1):
        try:
            data = await client.download_media(msg, file=bytes)
            if data is None:
                raise ValueError("message has no downloadable media")
            digest = hashlib.sha256(data).hexdigest()
            store.put(msg, digest)
            return digest
        except FloodWaitError as e:
            print(f"  Telegram asked to wait {e.seconds}s; waiting...")
            await asyncio.sleep(e.seconds + 1)
        except Exception as e:  # timeouts, Telegram internal errors, dropped connections
            if attempt == DOWNLOAD_ATTEMPTS:
                print(f"  skipping message {msg.id}: download failed {attempt} times ({type(e).__name__})")
                return None
            wait = 10 * attempt
            print(f"  message {msg.id}: download failed ({type(e).__name__}), retrying in {wait}s...")
            await asyncio.sleep(wait)
    return None


def seed_statement(chat_id, message_id, size, sha256):
    """One row for the bot's `media` table. All values are ints or hex, so no quoting issues.

    The row's message_id is stored NEGATED. In basic groups every member's account
    numbers messages separately, so your message numbers mean nothing to the bot and
    could even collide with its own. Negative IDs never collide, and the bot treats
    every negative row as an older original it can compare new uploads against.
    """
    assert isinstance(chat_id, int) and isinstance(message_id, int) and isinstance(size, int)
    assert message_id > 0
    assert all(c in "0123456789abcdef" for c in sha256) and len(sha256) == 64
    return (
        "INSERT INTO media (chat_id, message_id, file_id, file_size, sha256) "
        f"VALUES ({chat_id}, {-message_id}, 'seed', {size}, '{sha256}') "
        "ON CONFLICT (chat_id, message_id) DO UPDATE SET sha256 = excluded.sha256;"
    )


BOT_DATABASE = "telegram-dedupe"  # the bot's Cloudflare D1 database
AVG_CERT = r"C:\ProgramData\AVG\Antivirus\wscert.pem"


def load_seed_into_bot(path):
    """Run wrangler to load the seed SQL into the bot's database. Returns True on success."""
    npx = "npx.cmd" if os.name == "nt" else "npx"
    env = os.environ.copy()
    # AVG's HTTPS scanning re-signs traffic; tell Node (wrangler) to trust its certificate.
    if not env.get("NODE_EXTRA_CA_CERTS") and os.path.exists(AVG_CERT):
        env["NODE_EXTRA_CA_CERTS"] = AVG_CERT
    cmd = [npx, "wrangler", "d1", "execute", BOT_DATABASE, "--remote", "--file", os.path.abspath(path), "-y"]
    print("Loading the fingerprints into the bot's database...")
    try:
        r = subprocess.run(cmd, env=env, capture_output=True, text=True, encoding="utf-8", errors="replace")
    except FileNotFoundError:
        print("  Could not run npx. Is Node.js installed?")
        return False
    if r.returncode == 0 and '"success": true' in r.stdout:
        print("  Bot database updated.")
        return True
    tail = (r.stdout + r.stderr).strip().splitlines()[-8:]
    print("  Loading failed:\n    " + "\n    ".join(tail))
    print(f"  Run it again by hand with:\n    npx wrangler d1 execute {BOT_DATABASE} --remote --file \"{path}\"")
    return False


async def announce(client, chat, deleted):
    plural = "file" if deleted == 1 else "files"
    text = (f"🧹 Duplicate cleanup: removed {deleted} duplicate {plural} from this group. "
            "The first copy of each was kept.")
    await client.send_message(chat, text, silent=True)
    print("Posted the summary in the group.")


async def write_seed_sql(client, chat, files, skip_ids, path):
    """Hash every kept file the bot could compare against and write them as SQL."""
    chat_id = utils.get_peer_id(chat)  # same -100... ID the Bot API uses
    keep = [m for m in sorted(files, key=lambda m: m.id)
            if m.id not in skip_ids and m.file.size and m.file.size <= BOT_MAX_DOWNLOAD]
    print(f"Hashing {len(keep)} kept files for the bot (each is downloaded once)...")
    lines, failed = [], []
    for n, m in enumerate(keep, 1):
        digest = await sha256_of(client, m)
        if digest:
            lines.append(seed_statement(chat_id, m.id, m.file.size, digest))
        else:
            failed.append(m.id)
        if n % 20 == 0:
            print(f"  hashed {n}/{len(keep)}")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print(f"Bot seed written to {path} ({len(lines)} files, chat {chat_id}).")
    if failed:
        print(f"{len(failed)} file(s) could not be downloaded and are not in the seed "
              f"(messages {', '.join(map(str, failed))}). Run the same command again later to add them; "
              "files already done are not downloaded again.")


async def pick_duplicates(client, sets, verify):
    """Return a list of (keep_message, delete_message) pairs."""
    pairs = []
    for same in sets:
        if not verify:
            keep = same[0]
            pairs += [(keep, m) for m in same[1:]]
            continue
        by_hash = defaultdict(list)
        for m in same:
            digest = await sha256_of(client, m)
            if digest:  # a file that could not be downloaded is never treated as a repeat
                by_hash[digest].append(m)
        for group in by_hash.values():
            if len(group) > 1:
                pairs += [(group[0], m) for m in group[1:]]
    return pairs


async def main():
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--group", required=True, help="group @username, invite link, or numeric id")
    ap.add_argument("--api-id", type=int, required=True)
    ap.add_argument("--api-hash", required=True)
    ap.add_argument("--verify", action="store_true",
                    help="download candidates and compare SHA-256 (exact, slower)")
    ap.add_argument("--delete", action="store_true",
                    help="really delete (asks for a typed confirmation)")
    ap.add_argument("--session", default="dedupe_session",
                    help="session file name; it is effectively a login, keep it private")
    ap.add_argument("--report", default="dedupe_report.csv")
    ap.add_argument("--seed-sql", metavar="PATH",
                    help="also write the kept files' fingerprints as SQL for the bot")
    ap.add_argument("--hash-cache", default="hash_cache.json",
                    help="where file fingerprints are saved so a rerun skips files already done")
    ap.add_argument("--load-seed", action="store_true",
                    help="after a --delete run, load the --seed-sql file into the bot's database")
    ap.add_argument("--announce", action="store_true",
                    help="after a --delete run, post how many duplicates were removed in the group")
    ap.add_argument("--bot-setup", action="store_true",
                    help="shortcut for --verify --seed-sql seed.sql --load-seed --announce")
    args = ap.parse_args()
    if args.bot_setup:
        args.verify, args.load_seed, args.announce = True, True, True
        args.seed_sql = args.seed_sql or "seed.sql"
    if args.load_seed and not args.seed_sql:
        ap.error("--load-seed needs --seed-sql")

    # On the first run Telethon asks for your phone number and the login code Telegram sends you.
    async with TelegramClient(args.session, args.api_id, args.api_hash) as client:
        me = await client.get_me()
        if me.bot:
            raise SystemExit(
                f"This session is logged in as a bot. Delete {args.session}.session, run again, "
                "and enter your own phone number (not a bot token)."
            )
        chat = await resolve_group(client, args.group)
        if not isinstance(chat, (Channel, Chat)):
            raise SystemExit(
                f"'{args.group}' resolved to a user account, not a group. "
                "Use the group's name, @username, or numeric ID."
            )
        global store
        store = HashStore(args.hash_cache, utils.get_peer_id(chat))
        perms = await client.get_permissions(chat, me)
        can_delete = perms.is_creator or perms.delete_messages
        print(f"Group: {chat.title}")

        if args.delete and not can_delete:
            raise SystemExit("Your account lacks the 'Delete messages' admin right here. Nothing deleted.")

        files = await collect_files(client, chat)
        sets = group_candidates(files, args.verify)
        print(f"Found {len(sets)} sets of candidate duplicates.")
        if args.verify:
            print("Verifying content with SHA-256 (this downloads the candidate files)...")
        pairs = await pick_duplicates(client, sets, args.verify)
        print(f"Duplicates to delete: {len(pairs)} (the oldest copy of each set is kept).")

        with open(args.report, "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(["action", "message_id", "kept_message_id", "file_name", "size", "date"])
            for keep, dup in pairs:
                w.writerow(["delete", dup.id, keep.id, dup.file.name, dup.file.size, dup.date.isoformat()])
        print(f"Report written to {args.report}")

        if args.seed_sql:
            # Repeats are left out: they are (or are about to be) deleted, so the bot
            # should only remember the originals.
            await write_seed_sql(client, chat, files, {dup.id for _, dup in pairs}, args.seed_sql)

        if not args.delete:
            print("DRY RUN: nothing deleted. Re-run with --delete to delete.")
            if args.load_seed or args.announce:
                print("(Nothing was loaded into the bot or posted in the group either.)")
            return

        deleted = 0
        if not pairs:
            print("No duplicates found. Nothing to delete.")
        else:
            if input(f"Type DELETE to permanently delete {len(pairs)} messages: ").strip() != "DELETE":
                print("Cancelled. Nothing deleted, loaded or posted.")
                return
            ids = [dup.id for _, dup in pairs]
            try:
                for i in range(0, len(ids), 100):
                    batch = ids[i:i + 100]
                    await client.delete_messages(chat, batch, revoke=True)
                    print(f"  deleted {min(i + 100, len(ids))}/{len(ids)}")
            except ChatAdminRequiredError:
                raise SystemExit("Telegram refused: this account is not allowed to delete these messages.")
            deleted = len(ids)

        if args.load_seed:
            load_seed_into_bot(args.seed_sql)
        if args.announce and deleted:
            await announce(client, chat, deleted)
        print("Done.")


if __name__ == "__main__":
    asyncio.run(main())
