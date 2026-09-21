---
name: slack
description: "Use when the user wants to work in Slack through `slack-cli`: authenticate, read channels and threads, search, send or edit messages, react, or manage files, pins, and canvases. Also use when the user explicitly asks for `slack-cli`. Do NOT use for building or deploying Slack apps (that is Slack's own `slack` CLI), or for unrelated local files."
compatibility: Requires the Slack desktop app signed in (macOS or Linux). Auto-extraction needs node:sqlite (Node 24+, or Node 22-23 with --experimental-sqlite); the SLACK_TOKEN/SLACK_COOKIE env vars and `auth import` work on Node 22+. Run `slack-cli auth login` to authenticate.
disable-model-invocation: true
---

# Slack CLI

## Overview

`slack-cli` drives Slack from the terminal as the signed-in user, reusing the `xoxc` token and `xoxd` cookie the Slack desktop app already holds. There is no Slack app, no OAuth consent, and no admin approval. Output is JSON on stdout, so commands pipe into `jq` and other tools.

## Core Philosophy

**Authenticate from the desktop session.** `slack-cli auth login` extracts and verifies credentials from the local Slack app, so the CLI acts with exactly the user's permissions.

**Start from the link when there is one.** A Slack permalink already carries the channel, the message, and the workspace, so `slack-cli read <url>` answers without resolving anything. Links work anywhere a channel is expected.

**Resolve identifiers before acting.** Slack APIs take IDs, not names. List channels or users first, then use the returned `id` (channels `C…`, DMs `D…`, users `U…`, message timestamps the `ts` string).

**Read before write.** Fetch the message or channel first, then send, edit, react, or delete against the exact `channel` + `ts`.

**Never print tokens.** Treat `~/.config/slack-cli/credentials.json` as secret; never echo token or cookie values into logs or chat.

## Domain Mechanics

1. **Auth.** `slack-cli auth login` extracts from the Slack desktop app (first run triggers a one-time macOS Keychain prompt; click Allow). `auth status` lists authenticated workspaces. For headless use, set `SLACK_TOKEN` (xoxc) and `SLACK_COOKIE` (xoxd), plus optional `SLACK_COOKIE_DS` on Enterprise Grid. Manual import: `auth import --curl '<curl copied from devtools>'` or `auth import --token xoxc-... --cookie xoxd-... [--cookie-ds ...]`. `auth logout` clears stored credentials. On Enterprise Grid / SSO, Slack also sets a `d-s` cookie that extraction and cURL import capture automatically.
2. **Workspaces.** Extraction captures every signed-in workspace. Target one with `--team <name|id|host>` on any command, or set `SLACK_TEAM`. The default is the Enterprise Grid org when there is one, otherwise the first workspace.
3. **Enterprise Grid.** `auth login` stores a token for the org and for each workspace in it, so no command needs special handling. Search and `user list` answer org-wide; `channel list` sweeps every workspace and merges the results, reporting coverage under `teams` and setting `partial: true` when the list is incomplete. In a sweep `--limit` caps the merged result. Narrow a sweep with `--team`, widen it past the org with `--all-teams`, and pass `--team` whenever paging with `--cursor` or running `channel create`. A call that fails with `enterprise_is_restricted` means the store holds only the org-level token: re-run `auth login`.
4. **Links.** `read <slack-url>` returns the thread for a message link and recent history for a channel link. A permalink (`/archives/C…/p…`), a web client URL (`/client/T…/C…`), or a `slack://` deep link is accepted wherever a channel argument goes, and the link's workspace overrides the default without `--team`.
5. **Channels.** `channel list [--types public_channel,private_channel,mpim,im] [--limit N]`, `channel info <C…>`, `channel history <C…> [--limit N] [--oldest ts] [--latest ts]`, `channel members <C…>`, `channel join <C…>`, `channel create <name> [--private]`.
6. **Messages.** `message send <channel> <text> [--thread-ts ts] [--broadcast]`, `message reply <channel> <thread-ts> <text>`, `message update <channel> <ts> <text>`, `message delete <channel> <ts>`. `<channel>` accepts a channel ID, a DM ID, or a user ID (opens the DM).
7. **Threads.** `thread read <channel> <thread-ts>` returns the parent plus replies; with a message link the timestamp is already in the link and can be omitted.
8. **Search.** `search messages <query> [--sort score|timestamp] [--limit N]`, `search files <query>`, `search all <query>`. Query supports Slack search operators (`in:#channel`, `from:@user`, `after:YYYY-MM-DD`).
9. **People & reactions.** `user list`, `user info <U…>`, `user me`. `reaction add <channel> <ts> <emoji>` and `reaction remove <channel> <ts> <emoji>` (emoji name without colons, e.g. `white_check_mark`).
10. **Files, pins, canvases.** `file list [--channel C…]`, `file info <F…>`. `pin list <channel>`, `pin add <channel> <ts>`, `pin remove <channel> <ts>`. `canvas list [--channel C…]`, `canvas get <canvas-id>`.

_Judgment:_ When the target is named but not identified, list first to resolve the ID rather than guessing. For writes, confirm the channel and `ts` from a prior read. Use `slack-cli help` for the full command reference.

## Common Mistakes

- Passing a channel name where a channel ID (`C…`) is required. List first, then use `id`, or paste the Slack link instead.
- Reaching for a workspace-scoped API token (`SLACK_USER_TOKEN`) to read a link from another workspace. That returns `channel_not_found`; `slack-cli read <url>` covers every workspace in the org.
- Re-encoding the `xoxd` cookie. Paste it verbatim on import; it is already percent-encoded.
- Testing in a busy shared channel. Use your own DM (`message send <your-user-id> ...`) and delete afterward.
- Expecting credentials to last forever. Session tokens rotate; re-run `auth login` on `invalid_auth`.
- Treating this as Slack's app-development CLI. Building or deploying apps is a different tool (`slack` from slackapi); this one only reads and writes workspace data.
- Sending message text that starts with a dash without `--`: `slack-cli message send C0123 -- "-1 vs baseline"`.
- On Linux with a keyring-backed (`v11`) cookie store, auto-extraction cannot decrypt; use `auth import`.
- Expecting message scheduling. Slack gates `chat.scheduleMessage` to OAuth tokens, so it is unavailable under session auth.
- Treating an Enterprise Grid sweep as one paged list. `channel list` returns the merged result with a `teams` summary and no cursor; page a single workspace instead (`--team <name> --cursor <cursor>`).
- Reading `channels` without checking `partial` on a Grid sweep. A `partial: true` list is missing workspaces, so "not found" there does not mean the channel does not exist.
