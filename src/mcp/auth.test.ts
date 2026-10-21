import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { HttpBindings } from "@hono/node-server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { caller, createAuth, mintToken, tokenCommand, TokenStore, type Authentication } from "./auth.js";

const issuer = "https://brain.example:10000", resource = `${issuer}/mcp`, login = "owner@example.com", redirect = "https://client.example/callback?keep=yes";
const proxy = { "x-forwarded-for": "100.100.100.10", "x-forwarded-host": "brain.example:10000", "x-forwarded-proto": "https", "tailscale-user-login": login };
const binding = (address = "127.0.0.1") => ({ incoming: { socket: { remoteAddress: address, remoteFamily: "IPv4", remotePort: 50000 } } }) as HttpBindings;
let home: string, auth: Authentication;
beforeEach(() => { home = mkdtempSync(`${tmpdir()}/nbrain-auth-`); auth = createAuth({ home, publicUrl: issuer, ownerLogin: login }); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); rmSync(home, { recursive: true, force: true }); });
const request = (path: string, init?: RequestInit, peer?: string) => auth.routes.request(`${issuer}${path}`, init, binding(peer));
async function register(method = "none") {
  const response = await request("/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Test Client", redirect_uris: [redirect], token_endpoint_auth_method: method, grant_types: ["authorization_code", "refresh_token"] }) });
  expect(response.status).toBe(201);
  return response.json() as Promise<{ client_id: string; client_secret?: string }>;
}
async function consent(clientId: string, overrides: Record<string, string> = {}, headers = proxy) {
  const verifier = randomBytes(32).toString("base64url");
  const params = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: redirect, resource, scope: "work life archive write", state: "original-state", code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url"), ...overrides });
  const response = await request(`/authorize?${params}`, { headers });
  const text = await response.text();
  return { response, text, verifier, nonce: /name="consent" value="([^"]+)"/.exec(text)?.[1] ?? "", cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "" };
}
async function approve(clientId: string, selected = ["work"]) {
  const page = await consent(clientId);
  expect(page.response.status).toBe(200);
  const body = new URLSearchParams({ consent: page.nonce, decision: "approve" });
  for (const scope of selected) body.append("scope", scope);
  const response = await request("/authorize", { method: "POST", headers: { ...proxy, origin: issuer, cookie: page.cookie, "content-type": "application/x-www-form-urlencoded" }, body });
  expect(response.status).toBe(303);
  const url = new URL(response.headers.get("location")!);
  expect(url.searchParams.get("state")).toBe("original-state");
  expect(url.searchParams.get("iss")).toBe(issuer);
  expect(url.searchParams.get("keep")).toBe("yes");
  return { code: url.searchParams.get("code")!, verifier: page.verifier };
}
function token(params: Record<string, string>, headers: Record<string, string> = {}) {
  return request("/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams({ resource, ...params }) });
}
async function grant() {
  const client = await register(), approval = await approve(client.client_id);
  const response = await token({ grant_type: "authorization_code", client_id: client.client_id, code: approval.code, code_verifier: approval.verifier, redirect_uri: redirect });
  expect(response.status).toBe(200);
  return { client, approval, tokens: await response.json() as { access_token: string; refresh_token: string; expires_in: number; scope: string } };
}

it("separates TCP loopback from every forwarded caller, even empty headers", () => {
  expect(caller(new Headers(), "127.0.0.1").local).toBe(true);
  expect(caller(new Headers(), "::1").local).toBe(true);
  expect(caller(new Headers(), "::ffff:127.0.0.1").local).toBe(true);
  expect(caller(new Headers(), "192.168.1.2").local).toBe(false);
  expect(caller(new Headers(), undefined).local).toBe(false);
  for (const name of ["x-forwarded-for", "forwarded", "cf-connecting-ip", "tailscale-funnel-request", "tailscale-user-login"]) expect(caller(new Headers({ [name]: "" }), "127.0.0.1").local).toBe(false);
  expect(caller(new Headers({ ...proxy, "tailscale-funnel-request": "?1" }), "127.0.0.1", issuer)).toMatchObject({ local: false, login: undefined, label: "funnel" });
  expect(caller(new Headers(proxy), "127.0.0.1", issuer)).toMatchObject({ local: false, login, label: `tailnet:${login}` });
});

it("does not trust a spoofed identity on direct or non-loopback requests", async () => {
  const client = await register();
  const direct = await consent(client.client_id, {}, { "tailscale-user-login": login } as typeof proxy);
  expect(direct.response.status).toBe(403);
  expect(direct.text).not.toContain("<form");
  expect(direct.text).toBe("Open this on a device signed in to Tailscale.");
  const page = await request(`/authorize?client_id=${client.client_id}`, { headers: proxy }, "100.100.100.10");
  expect(page.status).toBe(403);
  for (const changed of [{ "tailscale-funnel-request": "?1" }, { "tailscale-user-login": "someone@example.com" }, { "x-forwarded-host": "attacker.example" }]) {
    expect((await consent(client.client_id, {}, { ...proxy, ...changed })).response.status).toBe(403);
  }
});

it("advertises path and root protected metadata, S256, CIMD and issuer responses", async () => {
  for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) expect(await (await request(path)).json()).toMatchObject({ resource, authorization_servers: [issuer], bearer_methods_supported: ["header"] });
  expect(await (await request("/.well-known/oauth-authorization-server")).json()).toMatchObject({ issuer, code_challenge_methods_supported: ["S256"], client_id_metadata_document_supported: true, authorization_response_iss_parameter_supported: true });
  expect(auth.challenge).toContain(`resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp"`);
  vi.stubEnv("PUBLIC_URL", ""); vi.stubEnv("OWNER_TAILSCALE_LOGIN", "");
  const disabled = createAuth({ home });
  expect((await disabled.routes.request("https://brain.example/authorize")).status).toBe(404);
  expect(disabled.challenge).toBe("Bearer");
});

it("defaults only work, escapes client data and secures the consent page", async () => {
  const client = await register(), page = await consent(client.client_id);
  expect(page.text).toContain('value="work" checked');
  for (const scope of ["life", "archive", "write"]) expect(page.text).not.toContain(`value="${scope}" checked`);
  expect(page.text).toContain("client.example");
  expect(page.text).toContain(login);
  expect(page.response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  expect(page.response.headers.get("content-security-policy")).toContain("form-action 'self' https://client.example");
  expect(page.response.headers.get("referrer-policy")).toBe("same-origin");
  expect(page.response.headers.get("set-cookie")).toContain("HttpOnly");
  expect(page.response.headers.get("set-cookie")).toContain("Secure");
});

it("requires browser-bound CSRF, owner identity and exact POST origin", async () => {
  const client = await register(), page = await consent(client.client_id);
  const body = new URLSearchParams({ consent: page.nonce, decision: "approve", scope: "work" });
  for (const extra of [{ cookie: "" }, { origin: "https://attacker.example" }, { "tailscale-user-login": "attacker@example.com" }]) {
    const response = await request("/authorize", { method: "POST", headers: { ...proxy, origin: issuer, cookie: page.cookie, "content-type": "application/x-www-form-urlencoded", ...extra }, body });
    expect(response.status).toBe(403);
  }
  const denied = await request("/authorize", { method: "POST", headers: { ...proxy, origin: issuer, cookie: page.cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ consent: page.nonce, decision: "deny" }) });
  expect(new URL(denied.headers.get("location")!).searchParams.get("error")).toBe("access_denied");
  expect(new URL(denied.headers.get("location")!).searchParams.get("iss")).toBe(issuer);
});

it("rejects redirect changes, wrong resources, missing PKCE and duplicate parameters", async () => {
  const client = await register();
  for (const overrides of [{ redirect_uri: "https://attacker.example/" }, { resource: "https://other.example/mcp" }, { resource: `${resource}#fragment` }, { code_challenge_method: "plain" }, { code_challenge: "short" }]) expect((await consent(client.client_id, overrides)).response.status).toBe(400);
  const approval = await approve(client.client_id);
  const params = { grant_type: "authorization_code", client_id: client.client_id, code: approval.code, code_verifier: approval.verifier, redirect_uri: redirect };
  expect((await token({ ...params, resource: "https://other.example/mcp" })).status).toBe(400);
  expect((await token({ ...params, redirect_uri: `${redirect}&extra=1` })).status).toBe(400);
  expect((await token({ ...params, code_verifier: randomBytes(32).toString("base64url") })).status).toBe(400);
  const repeated = await request("/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `client_id=${client.client_id}&client_id=other` });
  expect(repeated.status).toBe(400);
  expect((await token(params)).status).toBe(200);
});

it("binds opaque tokens to the grant's resource, consented scopes and signer", async () => {
  const { tokens } = await grant();
  expect(tokens.scope).toBe("work");
  expect(auth.store.agentFor(`Bearer ${tokens.access_token}`, resource)).toEqual({ name: "oauth-test-client", scopes: ["work"], signer: "Test Client" });
  expect(auth.store.agentFor(`Bearer ${tokens.access_token}`, "https://other.example/mcp")).toBeUndefined();
  const saved = readFileSync(`${home}/oauth.json`, "utf8");
  expect(saved).not.toContain(tokens.access_token);
  expect(saved).not.toContain(tokens.refresh_token);
  expect(statSync(`${home}/oauth.json`).mode & 0o777).toBe(0o600);
});

it("rotates refresh tokens and revokes the grant on old refresh reuse", async () => {
  const { client, tokens } = await grant();
  const params = { grant_type: "refresh_token", client_id: client.client_id, refresh_token: tokens.refresh_token };
  const refreshed = await token(params);
  expect(refreshed.status).toBe(200);
  const fresh = await refreshed.json() as { access_token: string; refresh_token: string };
  expect(fresh.refresh_token).not.toBe(tokens.refresh_token);
  expect(auth.store.agentFor(`Bearer ${fresh.access_token}`, resource)).toBeDefined();
  expect((await token(params)).status).toBe(400);
  expect(auth.store.agentFor(`Bearer ${fresh.access_token}`, resource)).toBeUndefined();
  expect((await token({ ...params, refresh_token: fresh.refresh_token })).status).toBe(400);
});

it("rejects expired access, refresh, codes and consent", async () => {
  const { client, tokens } = await grant();
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + 16 * 60_000);
  expect(auth.store.agentFor(`Bearer ${tokens.access_token}`, resource)).toBeUndefined();
  vi.mocked(Date.now).mockReturnValue(now + 31 * 24 * 60 * 60_000);
  expect((await token({ grant_type: "refresh_token", client_id: client.client_id, refresh_token: tokens.refresh_token })).status).toBe(400);
  vi.mocked(Date.now).mockReturnValue(now);
  const approval = await approve(client.client_id), page = await consent(client.client_id);
  vi.mocked(Date.now).mockReturnValue(now + 11 * 60_000);
  expect((await token({ grant_type: "authorization_code", client_id: client.client_id, code: approval.code, code_verifier: approval.verifier })).status).toBe(400);
  expect((await request("/authorize", { method: "POST", headers: { ...proxy, origin: issuer, cookie: page.cookie, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ consent: page.nonce, decision: "approve", scope: "work" }) })).status).toBe(403);
});

it("revokes code replay only after valid PKCE and client checks", async () => {
  const { client, approval, tokens } = await grant();
  const params = { grant_type: "authorization_code", client_id: client.client_id, code: approval.code, code_verifier: approval.verifier };
  expect((await token({ ...params, code_verifier: "x".repeat(43) })).status).toBe(400);
  expect(auth.store.agentFor(`Bearer ${tokens.access_token}`, resource)).toBeDefined();
  expect((await token(params)).status).toBe(400);
  expect(auth.store.agentFor(`Bearer ${tokens.access_token}`, resource)).toBeUndefined();
});

it("authenticates confidential clients and never exposes their stored secret hash", async () => {
  for (const method of ["client_secret_basic", "client_secret_post"]) {
    const client = await register(method), approval = await approve(client.client_id);
    const params = { grant_type: "authorization_code", client_id: client.client_id, code: approval.code, code_verifier: approval.verifier };
    expect((await token(params)).status).toBe(401);
    const response = method === "client_secret_basic" ? await token(params, { authorization: `Basic ${Buffer.from(`${client.client_id}:${client.client_secret}`).toString("base64")}` }) : await token({ ...params, client_secret: client.client_secret! });
    expect(response.status).toBe(200);
    expect(client).not.toHaveProperty("client_secret_sha256");
    expect(readFileSync(`${home}/oauth.json`, "utf8")).not.toContain(client.client_secret!);
  }
});

it("revokes all tokens in a grant, but not another client's tokens", async () => {
  const { client, tokens } = await grant(), other = await register();
  const revoke = (id: string) => request("/revoke", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: id, token: tokens.refresh_token }) });
  expect((await revoke(other.client_id)).status).toBe(200);
  expect(auth.store.agentFor(`Bearer ${tokens.access_token}`, resource)).toBeDefined();
  expect((await revoke(client.client_id)).status).toBe(200);
  expect(auth.store.agentFor(`Bearer ${tokens.access_token}`, resource)).toBeUndefined();
});

it("limits and parses new request bodies without falling through to server errors", async () => {
  expect((await request("/register", { method: "POST", headers: { "content-type": "application/json" }, body: "{" })).status).toBe(400);
  expect((await request("/register", { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(17 * 1024) })).status).toBe(413);
  expect((await request("/token", { method: "POST", body: "client_id=foo" })).status).toBe(400);
});

it("preserves Helm fields and legacy tokens, rotates static tokens, lists no hashes", async () => {
  vi.stubEnv("MEMORY_MCP_HOME", home);
  const legacy = randomBytes(32).toString("hex"), digest = createHash("sha256").update(legacy).digest("hex");
  writeFileSync(`${home}/token.sha256`, digest);
  expect(new TokenStore(home).agentFor(`Bearer ${legacy}`)?.scopes).toEqual(["work", "life", "archive", "write"]);
  writeFileSync(`${home}/tokens.json`, JSON.stringify({ extra: { keep: true }, tokens: [{ agent: "helm", scopes: ["work"], sha256: digest, signer: "Helm", custom: 42 }] }));
  const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const first = await mintToken("helm", ["work"], "Helm");
  expect(output).not.toHaveBeenCalled();
  const second = await mintToken("helm", ["life"], "Helm");
  const store = new TokenStore(home);
  expect(store.agentFor(`Bearer ${first}`)).toBeUndefined();
  expect(store.agentFor(`Bearer ${second}`)).toEqual({ name: "helm", scopes: ["life"], signer: "Helm" });
  expect(JSON.parse(readFileSync(`${home}/tokens.json`, "utf8"))).toMatchObject({ extra: { keep: true }, tokens: [{ custom: 42 }] });
  await tokenCommand(["add", "test", "--scopes", "work,write", "--signer", "Test"]);
  const raw = String(output.mock.calls.at(-1)![0]).trim();
  expect(store.agentFor(`Bearer ${raw}`)).toMatchObject({ name: "test", signer: "Test" });
  await tokenCommand(["list"]);
  const listed = String(output.mock.calls.at(-1)![0]);
  expect(listed).toContain("static");
  expect(listed).not.toContain(raw);
  expect(listed).not.toContain(digest);
  await tokenCommand(["revoke", "helm"]);
  expect(store.agentFor(`Bearer ${second}`)).toBeUndefined();
  expect(JSON.parse(readFileSync(`${home}/tokens.json`, "utf8")).extra).toEqual({ keep: true });
});

it("lists OAuth expiry and revokes by grant id without losing unknown OAuth fields", async () => {
  vi.stubEnv("MEMORY_MCP_HOME", home);
  const { tokens } = await grant(), state = auth.store.state();
  state.extra = "keep"; state.grants[0]!.custom = 42; auth.store.save(state);
  const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  await tokenCommand(["list"]);
  expect(String(output.mock.calls[0]![0])).toContain("oauth");
  expect(String(output.mock.calls[0]![0])).toContain(state.grants[0]!.id);
  expect(String(output.mock.calls[0]![0])).not.toContain(state.grants[0]!.access.sha256);
  await tokenCommand(["revoke", state.grants[0]!.id]);
  expect(auth.store.agentFor(`Bearer ${tokens.access_token}`, resource)).toBeUndefined();
  expect(auth.store.state().extra).toBe("keep");
});

it("keeps the newest 50 unbound registrations without evicting a granted client", async () => {
  const { client, tokens } = await grant(), first = await register();
  let latest = first;
  for (let i = 0; i < 51; i++) latest = await register();
  const clients = auth.store.state().clients;
  expect(clients).toHaveLength(51);
  expect(clients.some(entry => entry.client_id === client.client_id)).toBe(true);
  expect(clients.some(entry => entry.client_id === first.client_id)).toBe(false);
  expect(clients.some(entry => entry.client_id === latest.client_id)).toBe(true);
  expect(auth.store.agentFor(`Bearer ${tokens.access_token}`, resource)).toBeDefined();
});

it("refuses client names or slugs matching a static agent or signer, case-insensitively", async () => {
  const client = await register();
  for (const token of [{ agent: "TEST CLIENT", signer: "someone" }, { agent: "other", signer: "TEST-CLIENT" }]) {
    writeFileSync(`${home}/tokens.json`, JSON.stringify({ tokens: [{ ...token, scopes: ["work"], sha256: "0".repeat(64) }] }));
    const page = await consent(client.client_id);
    expect(page.response.status).toBe(403);
    expect(page.text).toBe("Client name is reserved.");
  }
  expect(caller(new Headers({ ...proxy, "cf-connecting-ip": "203.0.113.1" }), "127.0.0.1", issuer).login).toBeUndefined();
});
