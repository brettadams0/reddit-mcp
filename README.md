# reddit-mcp

[![CI](https://github.com/brettadams0/reddit-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/brettadams0/reddit-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](package.json)

An MCP server over the Reddit API, backed by a self-owned OAuth2 app. Unlike the
read-only servers in this set, this one **can act as the account** — post, comment,
vote, and send private messages — so it is worth being deliberate about what you
ask it to do.

Runs over stdio, registered in `~/.claude.json` as `reddit`.

## Install

```bash
claude mcp add reddit -- npx -y @brettadams0/reddit-mcp
```

You also need a Reddit OAuth app and one run of `npm run authorize` (see Setup).

Published as [`@brettadams0/reddit-mcp`](https://www.npmjs.com/package/@brettadams0/reddit-mcp).
The scope is there because the unscoped name was already taken on npm by an
unrelated package. Cloning this repo and pointing `claude mcp add` at
`src/index.js` works identically.

## Tools

**Read**

| Tool | Purpose |
|---|---|
| `reddit_get_me` | The authenticated account's own profile |
| `reddit_get_user` | Another user's public profile |
| `reddit_get_user_activity` | A user's recent posts and comments |
| `reddit_get_subreddit_posts` | Listing for a subreddit (hot/new/top/rising) |
| `reddit_get_post` | A single post plus its comment tree |
| `reddit_search` | Search across Reddit or within one subreddit |
| `reddit_get_inbox` | Private messages and inbox replies |

**Write — these have real, public consequences**

| Tool | Purpose |
|---|---|
| `reddit_submit_post` | Create a new post in a subreddit |
| `reddit_submit_comment` | Reply to a post or comment |
| `reddit_vote` | Up/down/clear vote on a post or comment |
| `reddit_send_message` | Send a private message to a user |
| `reddit_mark_read` | Mark inbox items read |

The write tools post under your real account, publicly and attributably. Reddit's
spam and vote-manipulation rules apply to API traffic exactly as they do to
browser traffic, and account bans follow the account, not the app.

## Auth

OAuth2 with a refresh token, stored in `credentials/token.json` (gitignored).
Reddit does **not** rotate refresh tokens, so the stored one stays valid
indefinitely — access tokens are refreshed automatically ~60s before expiry.

```bash
npm run authorize    # one-time browser consent, writes credentials/token.json
npm run check-auth   # verify the stored token still works
```

## Setup

Requires Node 20+.

1. Create a **script** app at [reddit.com/prefs/apps](https://www.reddit.com/prefs/apps).
2. Save its id and secret to `credentials/client_secret.json` — see
   `credentials/client_secret.example.json` for the shape. `credentials/` is
   git-ignored.
3. Identify yourself to Reddit. The default User-Agent contains a placeholder,
   and Reddit throttles generic agents hard, so set one of:

   ```bash
   REDDIT_USERNAME=your_reddit_username        # fills in the /u/ segment
   REDDIT_USER_AGENT="platform:app:v1.0.0 (by /u/you)"   # or replace it wholesale
   ```

4. Authorize and register:

   ```bash
   npm ci
   npm run authorize
   claude mcp add reddit -- node <path>/reddit-mcp/src/index.js
   ```

## Tests

```bash
npm test
```

Registration, the fullname-prefix helper, and User-Agent construction. No
network and no credentials, so it is safe in CI.

## Layout

```
src/auth.js            token load, refresh, caching
src/reddit.js          all tool registrations
src/index.js           McpServer construction + stdio transport
scripts/authorize.js   one-time OAuth consent flow
scripts/check-token.js token health check
```

## Notes

- Reddit requires a descriptive, unique `User-Agent`; a generic one gets 429s
  regardless of rate.
- Fullnames are prefixed type IDs (`t3_` post, `t1_` comment, `t5_` subreddit).
  `reddit_vote` wants the fullname, not the short ID from a URL.
