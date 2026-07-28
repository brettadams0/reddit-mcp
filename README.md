# reddit-mcp

An MCP server over the Reddit API, backed by a self-owned OAuth2 app. Unlike the
read-only servers in this set, this one **can act as the account** — post, comment,
vote, and send private messages — so it is worth being deliberate about what you
ask it to do.

Runs over stdio, registered in `~/.claude.json` as `reddit`.

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
