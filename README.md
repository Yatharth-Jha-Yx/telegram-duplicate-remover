# Telegram duplicate-file remover

Two tools that delete repeated files from a Telegram group and keep the first copy.

| Part | What it does | Runs on |
| --- | --- | --- |
| [`bot/`](bot) | A bot that deletes a repeated file as soon as it is posted, and posts a short notice in the group. | Cloudflare Workers + D1 (free plan) |
| [`telegram_dedupe.py`](telegram_dedupe.py) | One-time cleanup of a group's existing history, run as your own Telegram account. Can also load the fingerprints of the kept files into the bot. | Your PC (Python) |

## How duplicates are found

- **Same Telegram file** (forwards, re-sends): every Telegram file has a
  `file_unique_id`; a second message with the same ID is a repeat.
- **Same file uploaded again from disk** (new Telegram ID, same bytes): files
  with exactly the same size are downloaded and compared by SHA-256. Only files
  whose size matches another file are ever downloaded, and each hash is stored
  and reused.

Covered: documents, videos, photos, GIFs, audio, voice notes, video notes.
Stickers are ignored on purpose.

## Limits

- **The bot cannot read messages posted before it joined.** It has a `/scan`
  command that tries to read old messages by forwarding them, but in testing
  Telegram refused to forward messages the bot never received, so old files are
  not found that way. To handle a group's existing files, run
  `telegram_dedupe.py` once (see below); after that the bot handles new uploads.
- The Bot API can only download files up to 20 MB, so the bot compares larger
  re-uploads only by Telegram ID.
- A photo re-sent from a phone is usually re-compressed, so it has different
  bytes and is not treated as a repeat.
- Basic groups: making the bot an admin can upgrade the group to a supergroup.
  Message numbers restart then, and bots cannot read the old part.

## Bot setup (Cloudflare)

Needs Node.js and a free Cloudflare account. Run from `bot/`.

1. Log in and create the database. Copy the `database_id` it prints into
   `wrangler.toml`:

       npx wrangler login
       npx wrangler d1 create telegram-dedupe
       npx wrangler d1 execute telegram-dedupe --remote --file schema.sql

2. Deploy. Note the `https://....workers.dev` URL it prints:

       npx wrangler deploy

3. Create a bot with @BotFather, then connect it. The script asks for the bot
   token through wrangler, so it is stored only as a Cloudflare secret:

       .\setup-bot.ps1 -Url https://telegram-dedupe-bot.<your-subdomain>.workers.dev

4. Add the bot to your group as an **admin with the "Delete messages" right**.
   Admin bots receive every message, which the bot needs.

5. Optional: in @BotFather, `/setjoingroups` → Disable, so nobody else can add
   your bot to their groups.

Settings in `wrangler.toml`:

- `ALLOWED_CHAT_IDS`: comma-separated group IDs the bot may act in (empty = any group where it is admin).
- `NOTIFY`: `"false"` turns off the "Removed a duplicate" notice.

Free plan: if a daily limit is reached, Cloudflare returns errors until the next
day; it does not charge you. Only the Workers Paid plan is billed.

Live log: `npx wrangler tail`

## One-time cleanup script (PC)

    pip install telethon

Get an `api_id` and `api_hash` at https://my.telegram.org. You type your phone
number and login code when the script asks. You need the right to delete other
members' messages in the group.

Dry run (nothing is deleted; writes `dedupe_report.csv`):

    python telegram_dedupe.py --group "Group name" --api-id 12345 --api-hash abcdef --verify

Delete (asks you to type DELETE):

    python telegram_dedupe.py --group "Group name" --api-id 12345 --api-hash abcdef --verify --delete

Clean up and also teach the bot about the kept files, then post a summary in the group:

    python telegram_dedupe.py --group "Group name" --api-id 12345 --api-hash abcdef --bot-setup --delete

`--bot-setup` = `--verify --seed-sql seed.sql --load-seed --announce`. Loading
needs wrangler logged in to the same Cloudflare account.

The script creates a `.session` file, which is a login to your Telegram account.
Delete it when you are done, and never commit it (`.gitignore` excludes it).

## Tests

    cd bot
    npm test

Needs Node.js 22.5 or newer (uses the built-in `node:sqlite` as a stand-in for D1).
