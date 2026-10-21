import { EventEmitter } from "node:events";
import { get } from "node:https";
import { lookup } from "node:dns";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fetchClientMetadata } from "./auth-client.js";
vi.mock("node:https", () => ({ get: vi.fn() }));
vi.mock("node:dns", () => ({ lookup: vi.fn() }));
const id = "https://client.example/metadata.json";
let addresses: { address: string; family: number }[], status: number, contentType: string, body: string, stall: boolean;
let pinned: unknown;
beforeEach(() => {
  addresses = [{ address: "8.8.8.8", family: 4 }]; status = 200; contentType = "application/json"; stall = false; pinned = undefined;
  body = JSON.stringify({ client_id: id, client_name: "Client", redirect_uris: ["https://client.example/callback"], token_endpoint_auth_method: "none" });
  vi.mocked(lookup).mockImplementation((_host: unknown, _options: unknown, callback: Function) => callback(null, addresses) as never);
  vi.mocked(get).mockImplementation((url: URL, options: { lookup: Function }, onResponse: Function) => {
    const request = new EventEmitter() as EventEmitter & { destroy: (error?: Error) => void };
    request.destroy = error => queueMicrotask(() => { if (error) request.emit("error", error); request.emit("close"); });
    queueMicrotask(() => options.lookup(url.hostname, { all: true }, (error: Error | null, selected: unknown) => {
      if (error) { request.destroy(error); return; }
      pinned = selected;
      if (stall) return;
      const response = new EventEmitter() as EventEmitter & { statusCode: number; headers: Record<string, string>; destroy: () => void };
      response.statusCode = status; response.headers = { "content-type": contentType }; response.destroy = () => {};
      onResponse(response);
      if (status !== 200) return;
      response.emit("data", Buffer.from(body)); response.emit("end"); request.emit("close");
    }));
    return request as never;
  });
});
afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); });
it("pins the public DNS result in the HTTPS socket lookup", async () => {
  expect((await fetchClientMetadata(id)).client_id).toBe(id);
  expect(pinned).toEqual([{ address: "8.8.8.8", family: 4 }]);
  expect(lookup).toHaveBeenCalledTimes(1);
});
it("refuses mixed public/private DNS answers before connecting", async () => {
  addresses.push({ address: "127.0.0.1", family: 4 });
  await expect(fetchClientMetadata(id)).rejects.toThrow("Private client_id address");
  expect(pinned).toBeUndefined();
});
it("does not follow redirects and rejects non-JSON metadata", async () => {
  status = 302;
  await expect(fetchClientMetadata(id)).rejects.toThrow("Invalid metadata response");
  expect(get).toHaveBeenCalledTimes(1);
  status = 200; contentType = "text/html";
  await expect(fetchClientMetadata(id)).rejects.toThrow("Invalid metadata response");
});
it("bounds metadata bytes and validates the returned identity", async () => {
  body = "x".repeat(64 * 1024 + 1);
  await expect(fetchClientMetadata(id)).rejects.toThrow("Client metadata too large");
  body = JSON.stringify({ client_id: `${id}?other`, client_name: "Client", redirect_uris: ["https://client.example/callback"] });
  await expect(fetchClientMetadata(id)).rejects.toThrow("Invalid client metadata document");
});
it("times out the whole metadata exchange, including a stalled connection", async () => {
  vi.useFakeTimers(); stall = true;
  const pending = fetchClientMetadata(id);
  const rejected = expect(pending).rejects.toThrow("Client metadata timed out");
  await vi.advanceTimersByTimeAsync(5000);
  await rejected;
});
