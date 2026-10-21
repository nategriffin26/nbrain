// HTTPS client metadata is untrusted: pin a public DNS result, never follow redirects.
import { lookup } from "node:dns";
import { get } from "node:https";
import { BlockList, isIP } from "node:net";

export interface OAuthClient {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  token_endpoint_auth_method: "none" | "client_secret_basic" | "client_secret_post";
  client_secret_sha256?: string;
  client_id_issued_at?: number;
  [key: string]: unknown;
}
const blocked = new BlockList();
for (const [address, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3]] as const) blocked.addSubnet(address, prefix, "ipv4");
blocked.addSubnet("2001::", 23, "ipv6");
blocked.addSubnet("2001:db8::", 32, "ipv6");
blocked.addSubnet("2002::", 16, "ipv6");
export function publicAddress(address: string) {
  const family = isIP(address);
  return family === 4 ? !blocked.check(address, "ipv4") : family === 6 && /^[23]/i.test(address) && !blocked.check(address, "ipv6");
}

export function clientMetadata(value: unknown, id: string, document = false): OAuthClient {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid client metadata");
  const data = value as Record<string, unknown>;
  if (document && (data.client_id !== id || typeof data.client_name !== "string" || "client_secret" in data || "client_secret_expires_at" in data)) throw new Error("Invalid client metadata document");
  const redirects = data.redirect_uris;
  if (!Array.isArray(redirects) || !redirects.length || redirects.length > 20 || !redirects.every(uri => {
    if (typeof uri !== "string" || uri.length > 2048) return false;
    try {
      const url = new URL(uri);
      return !url.hash && !url.username && !url.password && (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)));
    } catch { return false; }
  })) throw new Error("Invalid redirect_uris");
  const method = data.token_endpoint_auth_method ?? (document ? "none" : "client_secret_basic");
  if (!(document ? ["none"] : ["none", "client_secret_basic", "client_secret_post"]).includes(String(method))) throw new Error("Unsupported token_endpoint_auth_method");
  if (data.grant_types !== undefined && (!Array.isArray(data.grant_types) || !data.grant_types.length || !data.grant_types.every(type => ["authorization_code", "refresh_token"].includes(type)))) throw new Error("Unsupported grant_types");
  if (data.response_types !== undefined && (!Array.isArray(data.response_types) || data.response_types.length !== 1 || data.response_types[0] !== "code")) throw new Error("Unsupported response_types");
  const name = data.client_name ?? new URL(redirects[0]!).hostname;
  if (typeof name !== "string" || !name.trim() || name.length > 160) throw new Error("Invalid client_name");
  return { client_id: id, client_name: name.trim(), redirect_uris: redirects, token_endpoint_auth_method: method as OAuthClient["token_endpoint_auth_method"], grant_types: data.grant_types ?? ["authorization_code"], response_types: ["code"] };
}

export async function fetchClientMetadata(id: string): Promise<OAuthClient> {
  if (id.length > 2048) throw new Error("Invalid client_id");
  const url = new URL(id);
  const path = /^https:\/\/[^/]+(\/[^?#]*)/.exec(id)?.[1];
  if (url.protocol !== "https:" || url.username || url.password || url.hash || !path || path.split("/").some(part => [".", ".."].includes(decodeURIComponent(part)))) throw new Error("Invalid client_id URL");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && !publicAddress(host)) throw new Error("Private client_id address");
  const { promise, resolve, reject } = Promise.withResolvers<OAuthClient>();
  const request = get(url, {
    agent: false,
    headers: { accept: "application/json" },
    lookup: (hostname, options, callback) => {
      lookup(hostname, { all: true }, (error, addresses) => {
        if (error) return callback(error, []);
        if (!addresses.length || addresses.some(entry => !publicAddress(entry.address))) return callback(new Error("Private client_id address"), []);
        const address = addresses[0]!;
        if (options.all) callback(null, [address]); else callback(null, address.address, address.family);
      });
    },
  }, response => {
    if (response.statusCode !== 200 || !/^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/i.test(response.headers["content-type"] ?? "")) { response.destroy(); request.destroy(new Error("Invalid metadata response")); return; }
    let size = 0;
    const chunks: Buffer[] = [];
    response.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        const error = new Error("Client metadata too large");
        reject(error); request.destroy(error);
      } else chunks.push(chunk);
    });
    response.on("error", reject);
    response.on("end", () => {
      try { resolve(clientMetadata(JSON.parse(Buffer.concat(chunks).toString("utf8")), id, true)); } catch (error) { reject(error); }
    });
  });
  const timer = setTimeout(() => request.destroy(new Error("Client metadata timed out")), 5000);
  request.on("error", reject);
  request.on("close", () => clearTimeout(timer));
  return promise;
}
