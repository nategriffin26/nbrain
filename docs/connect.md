# Connecting clients

memory-mcp serves one MCP endpoint, `http://127.0.0.1:8830/mcp` (Streamable HTTP; the port is `MEMORY_MCP_PORT`). Every request carries `Authorization: Bearer <token>`, and the token decides who the caller is and what it may do. A client that can send headers talks to it over HTTP. A client that only starts local commands uses the stdio relay, `bin/nbrain mcp`, which forwards each JSON-RPC message to the HTTP server with the token from `NBRAIN_TOKEN`. Either way the client gets the same tools, scopes and identity.

## What each client gets

| Client | Connects through | The brief |
|---|---|---|
| omp | `nbrain connect omp`: HTTP, plus the `nbrain-brief` extension | Added to each main session on its first prompt, for that prompt and the session's directory |
| Claude Code, Cursor | `nbrain connect claude-code` or `cursor`: HTTP | The server's instructions tell the agent to call `brief` first |
| Codex, Claude Desktop | `nbrain connect codex` or `claude-desktop`: the stdio relay | The same |
| ChatGPT, claude.ai | A custom connector through the [OAuth door](#oauth-for-cloud-chat-apps) | The same; ChatGPT deep research calls `search` and `fetch` |

Every client also gets the skills catalog in the server's instructions, every skill file as a `skill://` resource and the MCP Skills extension. A host that loads MCP prompts gets the brief as the `about-<owner>` prompt too. The omp extension skips subagents and never briefs a resumed session twice; when the brain does not answer, it shows one short notice and adds nothing.

## nbrain connect

```sh
nbrain connect <omp|claude-code|codex|cursor|claude-desktop|json> [--agent name] [--scopes work,life,archive,write] [--remote]
```

| Flag | Default | Meaning |
|---|---|---|
| `--agent` | the client's name | The token's agent: its name in the logs and the name every write is signed with |
| `--scopes` | `work,write` | What the token may read and write (see [Scopes](#scopes)) |
| `--remote` | off | Point the client at `PUBLIC_URL` instead of loopback |

Each run mints a new token for the agent; running it again for the same agent replaces the old token, which stops working. The token goes only into the client's config, never to the terminal. JSON configs are merged under `mcpServers`, the previous file is kept beside it as `<file>.bak-<timestamp>`, and the new one is written with mode 600. The server is named `nbrain` (set `BRAIN_NAME` to change it). Restart the client after connecting.

The examples below show loopback URLs; with `--remote` they carry `PUBLIC_URL` instead. `<repo>` is the absolute path of your checkout.

### omp

Merged into `~/.omp/agent/mcp.json`:

```json
{
  "mcpServers": {
    "nbrain": { "type": "http", "url": "http://127.0.0.1:8830/mcp", "headers": { "Authorization": "Bearer <token>" } }
  }
}
```

`integrations/omp/nbrain-brief.ts` is linked into `~/.omp/agent/extensions/`. It runs `nbrain brief` with the token above.

### Claude Code

Runs, at user scope:

```sh
claude mcp remove --scope user nbrain
claude mcp add --scope user --transport http nbrain http://127.0.0.1:8830/mcp --header "Authorization: Bearer <token>"
```

### Cursor

Merged into `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "nbrain": { "url": "http://127.0.0.1:8830/mcp", "headers": { "Authorization": "Bearer <token>" } }
  }
}
```

### Codex

Codex starts the stdio relay. `nbrain connect codex` runs:

```sh
codex mcp remove nbrain
codex mcp add nbrain --env NBRAIN_URL=http://127.0.0.1:8830/mcp --env NBRAIN_TOKEN=<token> -- <repo>/bin/nbrain mcp
```

which writes to `~/.codex/config.toml`:

```toml
[mcp_servers.nbrain]
command = "<repo>/bin/nbrain"
args = ["mcp"]

[mcp_servers.nbrain.env]
NBRAIN_URL = "http://127.0.0.1:8830/mcp"
NBRAIN_TOKEN = "<token>"
```

### Claude Desktop

Claude Desktop starts the stdio relay. Merged into `~/Library/Application Support/Claude/claude_desktop_config.json` (the macOS path):

```json
{
  "mcpServers": {
    "nbrain": { "command": "<repo>/bin/nbrain", "args": ["mcp"], "env": { "NBRAIN_URL": "http://127.0.0.1:8830/mcp", "NBRAIN_TOKEN": "<token>" } }
  }
}
```

### Any other MCP client

`nbrain connect json --agent <name>` prints two configs on stdout and changes no file: first the HTTP form, then the stdio form. Use whichever your client supports.

```json
{ "mcpServers": { "nbrain": { "type": "http", "url": "http://127.0.0.1:8830/mcp", "headers": { "Authorization": "Bearer <token>" } } } }
{ "mcpServers": { "nbrain": { "command": "<repo>/bin/nbrain", "args": ["mcp"], "env": { "NBRAIN_URL": "http://127.0.0.1:8830/mcp", "NBRAIN_TOKEN": "<token>" } } } }
```

For a client on another machine, run it with `--remote` on the brain's machine and copy the HTTP form; the stdio form's command path exists only on the brain's machine.

## Scopes

| Scope | Grants |
|---|---|
| `work` | `brief`, `search`, `fetch`, `changes`, `library` and `skill_get`, over the work profile files, now's project blocks, X bookmarks, saved pages, research notes, skills and coding sessions |
| `life` | The same tools plus `person`, over `life.md`, now's Life block and every source, including mail, texts, calendar, records, chats and notes, and private items when asked |
| `archive` | `sql` (read-only SQL over schema `memory`) and `fetch` of any item |
| `write` | `save`, `remember`, `correct`, `private`, `library_mark` and `skill_save` |

Give each agent the least it needs:

- Coding agents: `work,write`, the default.
- A personal assistant that answers about your life: `work,life,write`.
- `archive` only for an agent that has to count or sum across everything, such as totals of payments by vendor.
- Read-only agents and scripts: leave out `write`.

Which tool each scope opens, tool by tool, is in [how it works](how-it-works.md#scopes). Tokens are managed on the brain's machine. Changes apply on the next request; no restart is needed.

```sh
nbrain token add <agent> --scopes work,life [--signer <name>]   # prints the token once, on stdout
nbrain token list                                               # static tokens and OAuth grants
nbrain token revoke <agent|grant-id>
```

## Remote access

memory-mcp listens on 127.0.0.1 only. Anything remote reaches it through a proxy on the same machine. A proxied request is never treated as local, so `save` with `file` and `skill_save` with `from` (paths on the brain's machine) are refused for it.

### Your tailnet

[Tailscale Serve](https://tailscale.com/kb/1312/serve) makes memory-mcp reachable from your own devices only:

```sh
tailscale serve --bg --https=8443 http://127.0.0.1:8830
```

Set `PUBLIC_URL=https://<device>.<tailnet>.ts.net:8443` in the env file, then connect clients with `--remote`. Static bearer tokens work as they do on loopback.

### Tailscale Funnel

[Tailscale Funnel](https://tailscale.com/kb/1223/funnel) puts the same endpoint on the public internet over HTTPS, for clients that are not on your tailnet:

```sh
tailscale funnel --bg --https=10000 http://127.0.0.1:8830
```

- Funnel serves only ports 443, 8443 and 10000.
- Funnel exposes every path on its port, so give memory-mcp a port with nothing else on it.
- Your tailnet policy must allow Funnel for the device; `tailscale funnel` says so when it does not.
- Every call without a valid token answers 401. With `PUBLIC_URL` set, `nbrain doctor` checks that the public `/mcp` does.

Your own tailnet devices reach the Funnel port directly over the tailnet, so one port serves both.

### OAuth for cloud chat apps

ChatGPT and claude.ai run in the cloud and sign in to remote MCP servers with OAuth 2.1 rather than a pasted token. claude.ai connects from Anthropic's cloud, so the server must be reachable from Anthropic's IP ranges ([Anthropic](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)); Funnel does that. memory-mcp is its own authorization server: dynamic client registration and client ID metadata documents, PKCE (S256 only), and resource indicators (each token is bound to `PUBLIC_URL/mcp`). The owner is proven by Tailscale identity; there is no password.

1. Put memory-mcp behind Funnel (above) and add to the env file:

   ```sh
   PUBLIC_URL=https://<device>.<tailnet>.ts.net:10000   # an HTTPS origin, no path
   OWNER_TAILSCALE_LOGIN=alex@example.com               # your exact Tailscale login
   ```

   OAuth is on only when both are set. Restart memory-mcp (`bin/restart-memory-mcp.sh` under launchd).
2. In the chat app, add a custom connector with the URL `https://<device>.<tailnet>.ts.net:10000/mcp`. The app gets a 401 pointing at the server's metadata, registers itself, and opens the consent page in your browser.
3. Approve on a device signed in to your tailnet as `OWNER_TAILSCALE_LOGIN` (a phone works with the Tailscale app connected). Opened from anywhere else, the page answers "Open this on a device signed in to Tailscale." It shows the client, its redirect host and the scopes asked for; `work` is checked by default, and you tick any others you grant.

Access tokens last 15 minutes and refresh tokens 30 days. Each refresh rotates the refresh token, and replaying a used one revokes the grant. A client whose name matches an existing token's agent is refused.

Each grant is its own agent, `oauth-<client-name>`, and its writes are signed with the client's name. `nbrain token list` shows grants as kind `oauth` with their client, expiry and grant id. `nbrain token revoke <grant-id>` ends one; `nbrain token revoke oauth-<client-name>` ends every grant of that agent.

ChatGPT deep research works with a server that has two read-only tools, `search` and `fetch` ([OpenAI](https://developers.openai.com/api/docs/mcp)). nbrain's `search` and `fetch` are those tools: `search` takes a `query` and answers `results` with `id`, `title` and `url`, and `fetch` takes an `id` and answers `id`, `title`, `text`, `url` and `metadata`, both also as structured content. A work-scope grant is enough for deep research over bookmarks, saved pages, research notes and the library's items.

### Cloudflare Tunnel

Some clients can reach only port 443. Funnel on 443 serves them if nothing else on the device uses that port. If something does, a [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) can map a hostname of yours on 443 to `http://127.0.0.1:8830`. Requests through it are never local and carry no Tailscale identity, so static bearer tokens work and OAuth consent does not. Connect such a client with `nbrain connect json --agent <name>` and replace the URL with `https://<hostname>/mcp`. As with Funnel, every path on the hostname reaches memory-mcp, and the token is the lock.

## Plain HTTP for scripts and shortcuts

The server is stateless: each POST is a complete JSON-RPC request, and `initialize` is accepted but not needed. There is no session and no standalone event stream: GET and DELETE answer 405. Send `Accept: application/json, text/event-stream` (the transport refuses a request without both) and the answer comes back as one JSON body.

```sh
TOKEN=$(nbrain token add shortcuts --scopes work)

curl -s http://127.0.0.1:8830/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search","arguments":{"query":"contextual retrieval","limit":5}}}'
```

A tool's answer is JSON text in `result.content[0].text`:

```sh
... | jq -r '.result.content[0].text | fromjson | .results[] | "\(.date)  \(.strength)  \(.title)"'
```

`"method":"tools/list"` lists the tools this token may call; tools outside its scopes are not offered at all. A wrong or missing token answers HTTP 401. A call the token's scopes refuse, such as a work token opening a mail item, comes back with `result.isError` set and the reason as its text.
