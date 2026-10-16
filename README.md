# reddit-mcp

[![CI](https://github.com/brettadams0/reddit-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/brettadams0/reddit-mcp/actions/workflows/ci.yml)
[![Surface checked by mcp-surface](https://img.shields.io/badge/surface-mcp--surface-7c3aed.svg)](https://github.com/brettadams0/mcp-surface)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](package.json)

An [MCP](https://modelcontextprotocol.io) server over the Reddit API, backed by a self-owned OAuth2 app. Unlike the
read-only servers in this set, this one **can act as the account** — post, comment,
vote, and send private messages — so it is worth being deliberate about what you
ask it to do.

12 tools. Runs locally over stdio.

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
browser traffic, and account bans follow the account, not the app. Every tool
declares MCP annotations (`readOnlyHint` and friends), so a client can
auto-approve the reads and prompt for the writes.

The exact schemas the model sees are in [`mcp-surface.json`](mcp-surface.json).

## Design notes

### Reddit says "200 OK" when it means no

Posting, commenting and messaging use `api_type=json`, and Reddit reports their
failures — a subreddit that doesn't exist, a rate limit, a locked thread — as
HTTP 200 with the reasons tucked into `json.errors`. Passed straight through,
that body let the model tell you a post was live when nothing had been posted.
Those responses are now turned into errors that name Reddit's reasons.

The same quiet-200 behaviour makes ids dangerous. Reddit addresses things by
*fullname* — a type prefix plus a base36 id (`t1_` comment, `t3_` post, `t4_`
message) — and its write endpoints accept a wrong-typed fullname and do nothing.
Every id is normalised and type-checked before the request: a comment id passed
where a post is required is an error, and a bare id is only accepted where its
type is unambiguous.

### Path segments are validated, not just encoded

Subreddit names, usernames and post ids are interpolated into the request path,
and URL resolution collapses `..` — so a subreddit of `../api/v1/me` used to
resolve to `oauth.reddit.com/api/v1/me/hot`, with the account's bearer token
attached. `encodeURIComponent` doesn't help: it leaves `..` alone. Each segment
is now checked against what Reddit actually allows. The tool arguments are model
output, and a model that has just read a page can be steered by it, so this is
input validation in the ordinary web-server sense.

### Token refresh is single-flight

Clients call tools in parallel. When several calls find the access token
expired at once, they share one refresh rather than racing — harmless for
Reddit, which doesn't rotate refresh tokens, but the same code in
[yahoo-fantasy-mcp](https://github.com/brettadams0/yahoo-fantasy-mcp), where
the race spends a token, is why it exists.

## Auth

OAuth2 with a refresh token, stored in `credentials/token.json` (gitignored).
Reddit does **not** rotate refresh tokens, so the stored one stays valid
indefinitely — access tokens are refreshed automatically ~60s before expiry.

```bash
npm run authorize    # one-time browser consent, writes credentials/token.json
npm run check-auth   # verify the stored token still works
```

The consent flow checks an OAuth `state` and its callback listener binds to
loopback only.

## Setup

Requires Node 20+.

1. Create a **script** app at [reddit.com/prefs/apps](https://www.reddit.com/prefs/apps)
   with redirect URI `http://localhost:53683/callback`.
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
   claude mcp add reddit -e REDDIT_USERNAME=your_reddit_username -- node /absolute/path/to/reddit-mcp/src/index.js
   ```

   Or in Claude Desktop's `claude_desktop_config.json`:

   ```json
   {
     "mcpServers": {
       "reddit": {
         "command": "node",
         "args": ["/absolute/path/to/reddit-mcp/src/index.js"],
         "env": { "REDDIT_USERNAME": "your_reddit_username" }
       }
     }
   }
   ```

## Development

```bash
npm test               # unit tests — no network, no credentials
npm run lint           # ESLint
npm run surface        # start the server and diff its tool surface against mcp-surface.json
npm run surface:update # re-record mcp-surface.json after an intended change
```

The tests cover registration, id and path-segment validation (including the
traversal cases above, asserted at the tool handlers), the `json.errors`
check, single-flight refresh, rate-limit and timeout messages, and the
User-Agent. CI runs them on Node 20, 22 and 24, then starts the server with
[mcp-surface](https://github.com/brettadams0/mcp-surface) and fails if the tool
surface differs from the committed snapshot.

## Layout

```
src/shared.js          version, timeouts, error shaping, tool-result helpers
src/auth.js            token load, single-flight refresh, authenticated fetch
src/reddit.js          id/path validation and all tool registrations
src/index.js           McpServer construction + stdio transport
scripts/authorize.js   one-time OAuth consent flow
scripts/check-token.js token health check
mcp-surface.json       the committed tool surface CI compares against
```

## Notes

- Reddit requires a descriptive, unique `User-Agent`; a generic one gets 429s
  regardless of rate. A 429 is reported with the reset time Reddit sends.
- Every request has a 30-second timeout, and error bodies are trimmed before
  they reach the model — an HTML error page would otherwise land in its context
  whole.

## License

MIT — see [LICENSE](LICENSE). Changes are recorded in [CHANGELOG.md](CHANGELOG.md).
