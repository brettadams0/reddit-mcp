# Changelog

Notable changes to this server. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The version is the
server's, as reported to clients in `initialize`; the tool surface itself is
recorded in [`mcp-surface.json`](mcp-surface.json).

## [1.1.0] — 2026-10-16

### Security

- Subreddit names, usernames and post ids are validated before being put in
  the request path. A subreddit of `../api/v1/me` used to resolve to another
  endpoint with the account's bearer token attached.
- The `authorize` callback listener binds to loopback only, and
  `credentials/token.json` is set to owner-only (0600) on every write,
  including one left world-readable by 1.0.0.
- Dependencies raised to clear every open `npm audit` advisory, including a
  critical one in `proxy-addr` and a high one in the MCP SDK's OAuth client.

### Fixed

- `reddit_submit_post`, `reddit_submit_comment` and `reddit_send_message`
  report a failure when Reddit rejects the request. Reddit returns those
  rejections as HTTP 200 with `json.errors`, which was passed through as if
  the post had been made.
- `reddit_mark_read` rewrote comment-reply ids (`t1_…`) into `t4_t1_…`, which
  Reddit silently ignores; replies and mentions can now be marked read.
- `reddit_vote` and `reddit_submit_comment` refuse an id of the wrong type or
  an ambiguous bare id, instead of sending one Reddit ignores.
- Parallel tool calls that find the token expired share one refresh. A
  refresh answered with an error body but HTTP 200 is now an error; it was
  saved as a token of `undefined` that never expired.
- Subreddit and username arguments accept profile subreddits (`u_name`),
  `all-name` exclusions, `/user/name` and pasted reddit.com links.
- The User-Agent reports the real platform and version instead of a fixed
  `windows:…:v1.0.0`.

### Changed

- Every request has a 30-second timeout; error bodies are trimmed, and a 429
  says when to retry.
- Tool results are compact JSON rather than indented.
- The server reports the version from `package.json`.

### Added

- `mcp-surface.json` and a CI step that fails when the tool surface drifts
  from it. ESLint, Dependabot, Node 24 in the CI matrix.

## [1.0.0] — 2026-07-28

First public release: 12 tools, offline tests and CI.

[1.1.0]: https://github.com/brettadams0/reddit-mcp/compare/b0184fb...HEAD
[1.0.0]: https://github.com/brettadams0/reddit-mcp/tree/b0184fb
