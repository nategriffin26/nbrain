import { afterEach, expect, it, vi } from "vitest";
import { clientMetadata, fetchClientMetadata, publicAddress } from "./auth-client.js";

afterEach(() => vi.restoreAllMocks());
it("rejects non-HTTPS, credentials, fragments, dot paths, private and mapped addresses before fetching", async () => {
  for (const id of ["http://example.com/client.json", "https://127.0.0.1/client.json", "https://10.0.0.1/client.json", "https://100.95.198.66/client.json", "https://169.254.169.254/client.json", "https://[::1]/client.json", "https://[::ffff:127.0.0.1]/client.json", "https://[fd7a:115c:a1e0::1]/client.json", "https://user:pass@example.com/client.json", "https://example.com/client.json#fragment", "https://example.com", "https://example.com/../client.json", "https://example.com/%2e%2e/client.json"]) await expect(fetchClientMetadata(id)).rejects.toThrow();
});
it("allows only globally routable metadata addresses, not DNS answers on the LAN or tailnet", () => {
  for (const address of ["127.0.0.1", "10.10.0.2", "100.64.0.1", "172.16.0.1", "192.168.0.1", "198.18.0.1", "224.0.0.1", "::1", "fc00::1", "fe80::1", "::ffff:8.8.8.8", "2001:db8::1"]) expect(publicAddress(address), address).toBe(false);
  for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) expect(publicAddress(address), address).toBe(true);
});
it("requires exact document client_id and safe exact redirect URIs", () => {
  const id = "https://client.example/client.json", metadata = { client_id: id, client_name: "Client", redirect_uris: ["https://client.example/callback"], token_endpoint_auth_method: "none" };
  expect(clientMetadata(metadata, id, true)).toMatchObject(metadata);
  expect(() => clientMetadata(metadata, `${id}?other`, true)).toThrow();
  for (const changes of [{ client_name: "" }, { client_name: undefined }, { redirect_uris: ["http://client.example/callback"] }, { redirect_uris: ["https://client.example/callback#fragment"] }, { redirect_uris: ["https://user:pass@client.example/callback"] }, { redirect_uris: [] }, { token_endpoint_auth_method: "client_secret_basic" }, { client_secret: "secret" }]) expect(() => clientMetadata({ ...metadata, ...changes }, id, true)).toThrow();
  expect(clientMetadata({ ...metadata, redirect_uris: ["http://127.0.0.1:1234/callback"] }, id, true).redirect_uris).toEqual(["http://127.0.0.1:1234/callback"]);
});
