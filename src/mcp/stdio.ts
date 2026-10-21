// `nbrain mcp`: memory-mcp for clients that only start local stdio servers (Claude Desktop, Codex, Zed, …). It relays
// each JSON-RPC message between stdin/stdout and the HTTP server, so every client gets the same tools, scopes and
// identity as an HTTP client: the token in NBRAIN_TOKEN decides who it is. NBRAIN_URL defaults to the local server.
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

export async function mcpCommand(): Promise<void> {
  const token = process.env.NBRAIN_TOKEN;
  if (!token) throw new Error("NBRAIN_TOKEN is not set (nbrain connect writes it into the client's config)");
  const url = new URL(process.env.NBRAIN_URL ?? `http://127.0.0.1:${process.env.MEMORY_MCP_PORT ?? "8830"}/mcp`);
  const remote = new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${token}` } } });
  const local = new StdioServerTransport();
  // a request the server never got still needs an answer, or the client waits forever
  local.onmessage = message => void remote.send(message).catch(error => {
    console.error("nbrain mcp:", String(error));
    if ("id" in message && "method" in message) void local.send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: `brain unreachable: ${String(error)}` } });
  });
  remote.onmessage = message => void local.send(message);
  remote.onerror = error => console.error("nbrain mcp:", String(error));
  local.onclose = () => void remote.close();
  remote.onclose = () => void local.close();
  await remote.start();
  await local.start();
}
