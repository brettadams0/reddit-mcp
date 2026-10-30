# Security

This server holds an OAuth refresh token that can post, comment, vote and send
private messages as the Reddit account that authorized it, and Reddit's refresh
tokens do not expire.

## Threat model

The caller is your own MCP client, but the *arguments* come from a model, and a
model can be steered by text it has read. The server treats every argument as
untrusted input:

- Subreddit names, usernames and ids are validated before they reach a URL
  path, so none of them can redirect a request to another endpoint.
- Ids are type-checked, so a write cannot silently land on the wrong object.
- Writes that Reddit rejects are reported as failures, not passed through.
- Tools that act publicly say so in their descriptions and declare MCP
  annotations, so a client can require confirmation for them.

Credentials live in `credentials/`, which is git-ignored, and CI fails if a
real credential file is ever tracked. To revoke access, remove the app at
[reddit.com/prefs/apps](https://www.reddit.com/prefs/apps).

## Reporting a vulnerability

Please email **adamsbrett00@gmail.com** rather than opening a public issue.
You'll get a reply within a few days.
