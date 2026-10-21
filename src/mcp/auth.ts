// Static tokens keep tokens.json's format (other tools may write it too); OAuth state has its own atomic, owner-only file.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import type { HttpBindings } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getCookie, setCookie } from "hono/cookie";
import { cors } from "hono/cors";
import { BRAIN_HOME, BRAND } from "../config.js";
import { SCOPES, type Agent, type Scope } from "./types.js";
import { clientMetadata, fetchClientMetadata, type OAuthClient } from "./auth-client.js";

type StaticToken = { agent: string; sha256: string; scopes: string[]; signer?: string; [key: string]: unknown };
type StaticTable = { tokens: StaticToken[]; [key: string]: unknown };
type Credential = { sha256: string; expiresAt: number };
interface Grant {
  id: string; agent: string; signer: string; client: string; scopes: Scope[]; resource: string;
  access: Credential; refresh: Credential; usedRefresh: string[]; [key: string]: unknown;
}
interface OAuthState { clients: OAuthClient[]; grants: Grant[]; [key: string]: unknown }
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const secret = () => randomBytes(32).toString("base64url");
const matches = (raw: string, digest: string) => {
  const want = Buffer.from(digest, "hex"), got = Buffer.from(hash(raw), "hex");
  return want.length === got.length && timingSafeEqual(got, want);
};
const scopesOf = (values: string[]) => values.filter((value): value is Scope => (SCOPES as readonly string[]).includes(value));
const homePath = () => process.env.MEMORY_MCP_HOME ?? `${BRAIN_HOME}/memory-mcp`;
function atomicJSON(home: string, name: string, data: unknown) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const temp = `${home}/${name}.${process.pid}.${randomBytes(6).toString("hex")}`;
  try { writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: "wx" }); renameSync(temp, `${home}/${name}`); }
  finally { if (existsSync(temp)) unlinkSync(temp); }
}

export class TokenStore {
  constructor(readonly home: string) {}
  staticTable(): StaticTable {
    if (existsSync(`${this.home}/tokens.json`)) return JSON.parse(readFileSync(`${this.home}/tokens.json`, "utf8"));
    if (existsSync(`${this.home}/token.sha256`)) return { tokens: [{ agent: "owner", sha256: readFileSync(`${this.home}/token.sha256`, "utf8").trim(), scopes: [...SCOPES], signer: "owner" }] };
    return { tokens: [] };
  }
  state(): OAuthState {
    return existsSync(`${this.home}/oauth.json`) ? JSON.parse(readFileSync(`${this.home}/oauth.json`, "utf8")) : { clients: [], grants: [] };
  }
  save(state: OAuthState) { atomicJSON(this.home, "oauth.json", state); }
  tokenTable() {
    return this.staticTable().tokens.map(token => ({ sha256: token.sha256, agent: { name: token.agent, scopes: scopesOf(token.scopes), signer: token.signer ?? token.agent } }));
  }
  agentFor(header: string | undefined, resource?: string): Agent | undefined {
    const match = /^Bearer ([A-Za-z0-9._~+/=-]{32,})$/i.exec(header ?? "");
    if (!match) return undefined;
    try {
      let found: Agent | undefined;
      for (const token of this.tokenTable()) if (matches(match[1]!, token.sha256)) found = token.agent;
      if (found) return found;
      if (resource) for (const grant of this.state().grants) if (grant.resource === resource && grant.access.expiresAt > Date.now() && matches(match[1]!, grant.access.sha256)) return { name: grant.agent, scopes: grant.scopes, signer: grant.signer };
    } catch { console.error("memory-mcp: cannot read token table"); }
    return undefined;
  }
}

/** Mint or rotate one static agent without dropping fields other tools keep in tokens.json or printing the credential. */
export async function mintToken(agent: string, scopes: Scope[], signer = agent): Promise<string> {
  if (!agent.trim() || !signer.trim() || !scopes.length || scopes.some(scope => !(SCOPES as readonly string[]).includes(scope))) throw new Error("Agent, signer and valid scopes are required");
  const store = new TokenStore(homePath()), table = store.staticTable(), raw = secret();
  const previous = table.tokens.find(token => token.agent === agent);
  const replacement = { ...previous, agent, scopes: [...new Set(scopes)], signer, sha256: hash(raw) };
  table.tokens = table.tokens.filter(token => token.agent !== agent);
  table.tokens.push(replacement);
  atomicJSON(store.home, "tokens.json", table);
  return raw;
}

/** Local CLI only. An added token is printed once, alone, on stdout. */
export async function tokenCommand(args: string[]): Promise<void> {
  const store = new TokenStore(homePath());
  const usage = "token add <agent> --scopes work,life,archive,write [--signer name] | token list | token revoke <agent|grant-id>";
  if (args[0] === "add") {
    const agent = args[1];
    if (!agent || agent.startsWith("--")) throw new Error(usage);
    let scopes: Scope[] | undefined, signer = agent;
    const seen = new Set<string>();
    for (let i = 2; i < args.length; i += 2) {
      const flag = args[i]!, value = args[i + 1];
      if (!value || seen.has(flag)) throw new Error(usage);
      seen.add(flag);
      if (flag === "--scopes") {
        const values = value.split(",");
        if (!values.length || values.some(scope => !(SCOPES as readonly string[]).includes(scope))) throw new Error("Unknown scope; use work, life, archive, write");
        scopes = [...new Set(values)] as Scope[];
      } else if (flag === "--signer") signer = value;
      else throw new Error(usage);
    }
    if (!scopes) throw new Error(usage);
    const raw = await mintToken(agent, scopes, signer);
    process.stdout.write(`${raw}\n`);
  } else if (args[0] === "list" && args.length === 1) {
    const rows = store.staticTable().tokens.map(token => [token.agent, token.scopes.join(","), "static", "—", "—", "—"]);
    rows.push(...store.state().grants.map(grant => [grant.agent, grant.scopes.join(","), "oauth", grant.client, new Date(grant.refresh.expiresAt).toISOString(), grant.id]));
    process.stdout.write(["AGENT\tSCOPES\tKIND\tCLIENT\tEXPIRES\tGRANT", ...rows.map(row => row.join("\t"))].join("\n") + "\n");
  } else if (args[0] === "revoke" && args.length === 2) {
    const target = args[1], table = store.staticTable(), state = store.state();
    const tokens = table.tokens.filter(token => token.agent !== target);
    const grants = state.grants.filter(grant => grant.agent !== target && grant.id !== target);
    if (tokens.length === table.tokens.length && grants.length === state.grants.length) throw new Error(`No token or grant for ${target}`);
    if (tokens.length !== table.tokens.length) atomicJSON(store.home, "tokens.json", { ...table, tokens });
    if (grants.length !== state.grants.length) store.save({ ...state, grants });
  } else throw new Error(usage);
}

const forwarding = ["x-forwarded-for", "forwarded", "cf-connecting-ip", "tailscale-funnel-request", "tailscale-user-login"];
export const loopback = (peer: string | undefined) => !!peer && (peer === "::1" || /^127(?:\.\d{1,3}){3}$/.test(peer) || /^::ffff:127(?:\.\d{1,3}){3}$/i.test(peer));
export function caller(headers: Headers, peer: string | undefined, publicUrl?: string) {
  const local = loopback(peer) && !forwarding.some(name => headers.has(name));
  const url = publicUrl ? new URL(publicUrl) : undefined;
  // Only Tailscale's loopback proxy is trusted to supply identity. The public listener must never bind off loopback.
  const proxied = loopback(peer) && !headers.has("cf-connecting-ip") && !!headers.get("x-forwarded-for") && headers.get("x-forwarded-proto") === "https" && !!url && headers.get("x-forwarded-host") === url.host;
  const login = proxied && !headers.has("tailscale-funnel-request") ? headers.get("tailscale-user-login") || undefined : undefined;
  return { local, login, label: headers.has("tailscale-funnel-request") ? "funnel" : login ? `tailnet:${login}` : local ? "local" : "remote" };
}
export function requestCaller(c: Context, publicUrl?: string) { return caller(c.req.raw.headers, getConnInfo(c).remote.address, publicUrl); }
class OAuthError extends Error { constructor(readonly code: string, message = code, readonly status: 400 | 401 | 403 = 400) { super(message); } }
function fail(code: string, message?: string): never { throw new OAuthError(code, message); }
function parameters(params: URLSearchParams) {
  const values = new Map<string, string>();
  for (const [name, value] of params) { if (values.has(name)) fail("invalid_request", "Repeated parameter"); values.set(name, value); }
  return values;
}
async function form(c: Context) {
  if (c.req.header("content-type")?.split(";")[0]?.trim() !== "application/x-www-form-urlencoded") fail("invalid_request", "Expected form encoding");
  return parameters(new URLSearchParams(await c.req.text()));
}
function parseScopes(value: string | undefined, fallback: Scope[] = ["work"]): Scope[] {
  if (value === undefined) return [...fallback];
  const values = value.trim().split(/\s+/).filter(Boolean);
  if (values.some(scope => !(SCOPES as readonly string[]).includes(scope))) fail("invalid_scope");
  return [...new Set(values)] as Scope[];
}
const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const ACCESS_MS = 15 * 60_000, REFRESH_MS = 30 * 24 * 60 * 60_000, CONSENT_MS = 10 * 60_000, CODE_MS = 60_000;
interface Authorization { client: OAuthClient; redirect: string; challenge: string; resource: string; scopes: Scope[]; state?: string }
interface Consent extends Authorization { expiresAt: number; cookieHash: string }
interface Code extends Authorization { expiresAt: number; grant?: string }

export interface Authentication {
  routes: Hono<{ Bindings: HttpBindings }>;
  store: TokenStore;
  publicUrl: string | undefined;
  resource: string | undefined;
  challenge: string;
}
export function createAuth(options: { home?: string; publicUrl?: string; ownerLogin?: string } = {}): Authentication {
  const store = new TokenStore(options.home ?? homePath());
  let publicUrl: string | undefined;
  const ownerLogin = options.ownerLogin ?? process.env.OWNER_TAILSCALE_LOGIN;
  const configured = options.publicUrl ?? process.env.PUBLIC_URL;
  if (configured && ownerLogin) {
    const url = new URL(configured);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("PUBLIC_URL must be an HTTPS origin, without a path");
    publicUrl = url.origin;
  }
  const resource = publicUrl ? `${publicUrl}/mcp` : undefined;
  const routes = new Hono<{ Bindings: HttpBindings }>();
  const consents = new Map<string, Consent>(), codes = new Map<string, Code>();
  const prune = () => {
    const now = Date.now();
    for (const [key, value] of consents) if (value.expiresAt <= now) consents.delete(key);
    for (const [key, value] of codes) if (value.expiresAt <= now) codes.delete(key);
  };
  const challenge = publicUrl ? `Bearer resource_metadata="${publicUrl}/.well-known/oauth-protected-resource/mcp", scope="work"` : "Bearer";
  if (!publicUrl || !resource) return { routes, store, publicUrl, resource, challenge };
  const issuer = publicUrl;
  routes.onError((error, c) => {
    if (error instanceof OAuthError) return c.json({ error: error.code, error_description: error.message }, error.status);
    console.error("memory-mcp OAuth: request failed");
    return c.json({ error: "server_error" }, 500);
  });
  routes.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store"); c.header("Pragma", "no-cache"); c.header("Referrer-Policy", "no-referrer"); c.header("X-Content-Type-Options", "nosniff");
    await next();
  });
  for (const path of ["/.well-known/*", "/register", "/token", "/revoke"]) routes.use(path, cors({ origin: "*", allowMethods: ["GET", "POST", "OPTIONS"], allowHeaders: ["Content-Type", "Authorization"] }));
  for (const path of ["/register", "/authorize", "/token", "/revoke"]) routes.use(path, bodyLimit({ maxSize: 16 * 1024, onError: c => c.json({ error: "invalid_request", error_description: "Body too large" }, 413) }));
  const metadata = { resource, resource_name: BRAND, authorization_servers: [issuer], scopes_supported: [...SCOPES], bearer_methods_supported: ["header"] };
  routes.get("/.well-known/oauth-protected-resource", c => c.json(metadata));
  routes.get("/.well-known/oauth-protected-resource/mcp", c => c.json(metadata));
  routes.get("/.well-known/oauth-authorization-server", c => c.json({
    issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, registration_endpoint: `${issuer}/register`, revocation_endpoint: `${issuer}/revoke`,
    response_types_supported: ["code"], response_modes_supported: ["query"], grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"], revocation_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
    scopes_supported: [...SCOPES], code_challenge_methods_supported: ["S256"], client_id_metadata_document_supported: true, authorization_response_iss_parameter_supported: true,
  }));
  routes.post("/register", async c => {
    if (c.req.header("content-type")?.split(";")[0]?.trim() !== "application/json") fail("invalid_client_metadata", "Expected JSON");
    let data: unknown;
    try { data = await c.req.json(); } catch { return c.json({ error: "invalid_client_metadata" }, 400); }
    let client: OAuthClient;
    try { client = clientMetadata(data, secret()); } catch (error) { return c.json({ error: "invalid_client_metadata", error_description: String(error) }, 400); }
    client.client_id_issued_at = Math.floor(Date.now() / 1000);
    const raw = client.token_endpoint_auth_method !== "none" ? secret() : undefined;
    if (raw) client.client_secret_sha256 = hash(raw);
    const state = store.state(); state.clients.push(client);
    const granted = new Set(state.grants.map(grant => grant.client));
    const pending = state.clients.filter(entry => !granted.has(entry.client_id)).slice(-50);
    state.clients = [...state.clients.filter(entry => granted.has(entry.client_id)), ...pending];
    store.save(state);
    const { client_secret_sha256: _, ...shown } = client;
    return c.json({ ...shown, ...(raw ? { client_secret: raw, client_secret_expires_at: 0 } : {}) }, 201);
  });
  async function clientFor(id: string): Promise<OAuthClient> {
    if (id.startsWith("https://")) {
      try { return await fetchClientMetadata(id); } catch { return fail("invalid_client", "Client metadata unavailable or invalid"); }
    }
    return store.state().clients.find(client => client.client_id === id) ?? fail("invalid_client");
  }
  function target(value: string | undefined) {
    let normalized: string;
    try { normalized = new URL(value ?? "").href; } catch { return fail("invalid_target"); }
    if (normalized !== resource) fail("invalid_target");
    return resource!;
  }
  function redirect(auth: Authorization, values: Record<string, string>) {
    const url = new URL(auth.redirect);
    for (const [name, value] of Object.entries({ ...values, iss: issuer, ...(auth.state !== undefined ? { state: auth.state } : {}) })) url.searchParams.set(name, value);
    return url.href;
  }
  const slug = (name: string) => name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "client";
  function reservedName(client: OAuthClient) {
    const names = [client.client_name.toLowerCase(), slug(client.client_name)];
    return store.staticTable().tokens.some(token => [token.agent, token.signer ?? token.agent].some(name => names.includes(name.toLowerCase())));
  }
  function ownerRequest(c: Context) { return requestCaller(c, issuer).login === ownerLogin; }
  routes.get("/authorize", async c => {
    c.header("X-Frame-Options", "DENY");
    if (!ownerRequest(c)) return c.text("Open this on a device signed in to Tailscale.", 403);
    prune();
    if (c.req.url.length > 8192) fail("invalid_request");
    const params = parameters(new URL(c.req.url).searchParams);
    const client = await clientFor(params.get("client_id") ?? "");
    if (reservedName(client)) return c.text("Client name is reserved.", 403);
    const uri = params.get("redirect_uri") ?? (client.redirect_uris.length === 1 ? client.redirect_uris[0]! : "");
    if (!client.redirect_uris.includes(uri)) fail("invalid_request", "redirect_uri mismatch");
    c.header("Referrer-Policy", "same-origin");
    c.header("Content-Security-Policy", `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${new URL(uri).origin}; frame-ancestors 'none'; base-uri 'none'`);
    if (params.get("response_type") !== "code") fail("unsupported_response_type");
    const codeChallenge = params.get("code_challenge") ?? "";
    if (params.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) fail("invalid_request", "PKCE S256 required");
    const askedScopes = parseScopes(params.get("scope"));
    if (!askedScopes.length) fail("invalid_scope");
    const nonce = secret();
    const cookie = getCookie(c, "__Host-nbrain-consent")?.match(/^[A-Za-z0-9_-]{43}$/)?.[0] ?? secret();
    consents.set(nonce, { client, redirect: uri, challenge: codeChallenge, resource: target(params.get("resource")), scopes: askedScopes, state: params.get("state"), expiresAt: Date.now() + CONSENT_MS, cookieHash: hash(cookie) });
    setCookie(c, "__Host-nbrain-consent", cookie, { secure: true, httpOnly: true, sameSite: "Lax", path: "/", maxAge: CONSENT_MS / 1000 });
    return c.html(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(BRAND)} · Access</title><style>html{color-scheme:light dark;font:17px system-ui}body{max-width:28rem;margin:12vh auto;padding:0 1.4rem}h1{font-size:1.6rem;line-height:1.2}dl{margin:2rem 0}dt{font-size:.8rem;opacity:.6;margin-top:1rem}dd{margin:.3rem 0;overflow-wrap:anywhere}label{display:flex;gap:.7rem;padding:.65rem 0}input{width:1.2rem;height:1.2rem}button{font:inherit;padding:.7rem 1.2rem;margin:1.5rem .5rem 0 0;border:1px solid;border-radius:.4rem;cursor:pointer}</style><body><h1>${escape(client.client_name)}</h1><dl><dt>Redirect</dt><dd>${escape(new URL(uri).host)}</dd>${client.client_id.startsWith("https://") ? `<dt>Client</dt><dd>${escape(new URL(client.client_id).host)}</dd>` : ""}<dt>Account</dt><dd>${escape(ownerLogin!)}</dd></dl><form method="post" action="/authorize"><input type="hidden" name="consent" value="${nonce}">${askedScopes.map(scope => `<label><input type="checkbox" name="scope" value="${scope}"${scope === "work" ? " checked" : ""}>${scope}</label>`).join("")}<button name="decision" value="approve">Approve</button><button name="decision" value="deny">Deny</button></form></body></html>`);
  });
  routes.post("/authorize", async c => {
    if (!ownerRequest(c)) return c.text("Open this on a device signed in to Tailscale.", 403);
    if (c.req.header("origin") !== issuer) throw new OAuthError("invalid_request", "Invalid origin", 403);
    if (c.req.header("content-type")?.split(";")[0]?.trim() !== "application/x-www-form-urlencoded") fail("invalid_request");
    const body = new URLSearchParams(await c.req.text());
    if (body.getAll("consent").length !== 1 || body.getAll("decision").length !== 1) fail("invalid_request");
    const nonce = body.get("consent") ?? "", consent = consents.get(nonce);
    const cookie = getCookie(c, "__Host-nbrain-consent") ?? "";
    if (!consent || consent.expiresAt <= Date.now() || !matches(cookie, consent.cookieHash)) throw new OAuthError("invalid_request", "Consent expired or invalid", 403);
    if (reservedName(consent.client)) return c.text("Client name is reserved.", 403);
    if (body.get("decision") === "deny") { consents.delete(nonce); return c.redirect(redirect(consent, { error: "access_denied" }), 303); }
    if (body.get("decision") !== "approve") fail("invalid_request");
    const selected = body.getAll("scope");
    if (!selected.length || selected.some(scope => !consent.scopes.includes(scope as Scope))) fail("invalid_scope");
    const code = secret();
    codes.set(hash(code), { ...consent, scopes: [...new Set(selected)] as Scope[], expiresAt: Date.now() + CODE_MS });
    consents.delete(nonce);
    return c.redirect(redirect(consent, { code }), 303);
  });
  async function authenticateClient(c: Context, params: Map<string, string>) {
    let id = params.get("client_id") ?? "", password = params.get("client_secret"), method = password !== undefined ? "client_secret_post" : "none";
    const authorization = c.req.header("authorization");
    if (authorization) {
      if (!authorization.startsWith("Basic ") || password !== undefined) throw new OAuthError("invalid_client", "Invalid client authentication", 401);
      try {
        const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8"), colon = decoded.indexOf(":");
        if (colon < 0) throw new Error();
        const basicId = decodeURIComponent(decoded.slice(0, colon).replaceAll("+", " "));
        if (id && id !== basicId) throw new Error();
        id = basicId; password = decodeURIComponent(decoded.slice(colon + 1).replaceAll("+", " ")); method = "client_secret_basic";
      } catch { throw new OAuthError("invalid_client", "Invalid client authentication", 401); }
    }
    const client = await clientFor(id);
    if (client.token_endpoint_auth_method !== method || (method !== "none" && (!password || !client.client_secret_sha256 || !matches(password, client.client_secret_sha256)))) {
      c.header("WWW-Authenticate", 'Basic realm="nbrain"');
      throw new OAuthError("invalid_client", "Invalid client authentication", 401);
    }
    return client;
  }
  function issue(grant: Grant) {
    const access = secret(), refresh = secret(), now = Date.now();
    grant.access = { sha256: hash(access), expiresAt: now + ACCESS_MS };
    grant.refresh = { sha256: hash(refresh), expiresAt: now + REFRESH_MS };
    return { access_token: access, refresh_token: refresh, token_type: "Bearer", expires_in: ACCESS_MS / 1000, scope: grant.scopes.join(" ") };
  }
  routes.post("/token", async c => {
    const params = await form(c), client = await authenticateClient(c, params);
    const audience = target(params.get("resource"));
    const state = store.state();
    if (params.get("grant_type") === "authorization_code") {
      const code = codes.get(hash(params.get("code") ?? "")), verifier = params.get("code_verifier") ?? "";
      if (!code || code.expiresAt <= Date.now() || code.client.client_id !== client.client_id || code.resource !== audience || (params.has("redirect_uri") && params.get("redirect_uri") !== code.redirect) || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || createHash("sha256").update(verifier).digest("base64url") !== code.challenge) fail("invalid_grant");
      if (code.grant) { state.grants = state.grants.filter(grant => grant.id !== code.grant); store.save(state); fail("invalid_grant"); }
      const grant: Grant = { id: randomBytes(16).toString("hex"), agent: `oauth-${slug(code.client.client_name)}`, signer: code.client.client_name, client: client.client_id, scopes: code.scopes, resource: audience, access: { sha256: "", expiresAt: 0 }, refresh: { sha256: "", expiresAt: 0 }, usedRefresh: [] };
      const response = issue(grant);
      state.grants.push(grant); store.save(state); code.grant = grant.id; prune();
      return c.json(response);
    }
    if (params.get("grant_type") === "refresh_token") {
      const raw = params.get("refresh_token") ?? "";
      const grant = state.grants.find(grant => matches(raw, grant.refresh.sha256) || grant.usedRefresh.some(digest => matches(raw, digest)));
      if (!grant || grant.client !== client.client_id || grant.resource !== audience || grant.refresh.expiresAt <= Date.now()) fail("invalid_grant");
      if (!matches(raw, grant.refresh.sha256)) { state.grants = state.grants.filter(entry => entry.id !== grant.id); store.save(state); fail("invalid_grant"); }
      const scope = parseScopes(params.get("scope"), grant.scopes);
      if (scope.length !== grant.scopes.length || scope.some(value => !grant.scopes.includes(value))) fail("invalid_scope");
      grant.usedRefresh.push(grant.refresh.sha256);
      const response = issue(grant); store.save(state);
      return c.json(response);
    }
    return c.json({ error: "unsupported_grant_type" }, 400);
  });
  routes.post("/revoke", async c => {
    const params = await form(c), client = await authenticateClient(c, params), raw = params.get("token");
    if (!raw) fail("invalid_request");
    const state = store.state();
    state.grants = state.grants.filter(grant => grant.client !== client.client_id || !(matches(raw, grant.access.sha256) || matches(raw, grant.refresh.sha256) || grant.usedRefresh.some(digest => matches(raw, digest))));
    store.save(state);
    return c.body(null, 200);
  });
  return { routes, store, publicUrl, resource, challenge };
}
