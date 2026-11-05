import { afterEach, expect, it, vi } from "vitest";
import { redactTexts, redactValue, RedactionError } from "./redact.js";

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

it("preserves empty and multiline parts in their original positions", async () => {
  const input = ["", "ordinary text\nsecond line", "", "終わり"];
  expect(await redactTexts(input)).toEqual(input);
  expect(await redactTexts([])).toEqual([]);
});

it("redacts low-entropy planted provider keys even when the scanner filters examples", async () => {
  const keys = [
    ["anthropic-key", `sk-ant-api03-${"a".repeat(90)}`],
    ["openrouter-key", `sk-or-v1-${"b".repeat(64)}`],
    ["openai-key", `sk-proj-${"c".repeat(80)}`],
    ["github-token", `ghp_${"d".repeat(36)}`],
    ["slack-token", `xoxb-${"1".repeat(12)}-${"2".repeat(12)}-${"e".repeat(24)}`],
    ["aws-access-key", `AKIA${"F".repeat(16)}`],
    ["google-api-key", `AIza${"g".repeat(35)}`],
    ["tailscale-key", `tskey-auth-${"h".repeat(48)}`],
  ];
  const output = await redactTexts(keys.map(([, key]) => `before ${key} after`));
  for (const [index, [type, key]] of keys.entries()) {
    expect(output[index]).not.toContain(key);
    expect(output[index]).toMatch(new RegExp(`\\[REDACTED:${type}:[a-f0-9]{8}\\]`));
    expect(output[index]).toMatch(/^before .* after$/);
  }
});

it("removes entire multiline PEM blocks including CRLF without changing neighboring parts", async () => {
  const pem = "-----BEGIN RSA PRIVATE KEY-----\r\nYWJjZGVmZ2hpamts\r\nbW5vcHFyc3R1dnd4\r\n-----END RSA PRIVATE KEY-----";
  const output = await redactTexts(["left", `heading\n${pem}\nfooter`, "right"]);
  expect(output[0]).toBe("left");
  expect(output[2]).toBe("right");
  expect(output[1]).toMatch(/^heading\n\[REDACTED:private-key:[a-f0-9]{8}\]\nfooter$/);
  expect(output[1]).not.toContain("YWJjZGVm");
});

it("removes URL credentials and quoted assignments but retains their labels", async () => {
  const output = await redactTexts([
    "postgres://reader:synth%40password@localhost:5432/example",
    '"password": "abcdefgh"',
    "Authorization: Bearer abcdefgh",
  ]);
  expect(output[0]).toMatch(/^postgres:\/\/\[REDACTED:credential-url:[a-f0-9]{8}\]@localhost:5432\/example$/);
  expect(output[1]).toBe('"password": "[REDACTED:credential-assignment:9c56cc51]"');
  expect(output[2]).toBe("Authorization: Bearer [REDACTED:authorization:9c56cc51]");
});

it("keeps equal-secret digests stable across parts and repeat redaction", async () => {
  const secret = `ghp_${"q".repeat(36)}`;
  const input = [`first ${secret}`, `second ${secret}`, "[REDACTED:github-token:01234567]"];
  const output = await redactTexts(input);
  expect(output[0]!.slice(6)).toBe(output[1]!.slice(7));
  expect(output[2]).toBe(input[2]);
  expect(await redactTexts(output)).toEqual(output);
});

it("redacts direct and encoded credentials with UTF-8 text before the finding", async () => {
  // A synthetic Stripe key exercises fixed-rule detection through encoded text.
  const key = "sk_live_" + "51AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCd";
  const encoded = Buffer.from(key).toString("base64");
  const output = await redactTexts([`日本語 stripe_api_key = "${key}"`, `日本語 payload = "${encoded}"`]);
  expect(output[0]).not.toContain(key);
  expect(output[1]).not.toContain(encoded);
  for (const text of output) { expect(text).toContain("日本語"); expect(text).toContain("[REDACTED:"); }
});

it("does not honor transcript allow-comments or inherited scanner configuration", async () => {
  vi.stubEnv("BETTERLEAKS_CONFIG_TOML", '[[rules]]\nid="ignore-everything"\nregex="NEVER_MATCH"');
  const key = `ghp_${"r".repeat(36)}`;
  const [output] = await redactTexts([`${key} # gitleaks:allow betterleaks:allow`]);
  expect(output).not.toContain(key);
});

it("keeps positional mapping across both byte and part batch boundaries", async () => {
  const parts = Array.from({ length: 2050 }, (_, index) => `part ${index}`);
  parts[2047] = `part 2047 ghp_${"s".repeat(36)}`;
  parts[2048] = `part 2048 ghp_${"t".repeat(36)}`;
  const output = await redactTexts(parts);
  expect(output).toHaveLength(2050);
  expect(output[2046]).toBe("part 2046");
  expect(output[2047]).toMatch(/^part 2047 ghp_\[REDACTED:/);
  expect(output[2048]).toMatch(/^part 2048 ghp_\[REDACTED:/);
  expect(output[2049]).toBe("part 2049");
  const large = "ordinary text\n".repeat(330_000);
  expect(await redactTexts([large, "after"])).toEqual([large, "after"]);
}, 120_000);

it("fails closed without exposing input when the scanner cannot start", async () => {
  vi.stubEnv("BETTERLEAKS_BIN", "/nonexistent/nbrain-test-scanner");
  // Reload configuration to exercise the missing-binary module-loading boundary.
  const { redactTexts: unavailable, RedactionError } = await import("./redact.js");
  await expect(unavailable(["private input must not escape"])).rejects.toBeInstanceOf(RedactionError);
  await expect(unavailable(["private input must not escape"])).rejects.toThrow("Betterleaks could not start");
});

it("rejects an incompatible scanner rather than silently skipping detection", async () => {
  vi.stubEnv("BETTERLEAKS_BIN", "/usr/bin/true");
  // Reload configuration to exercise the version-check module-loading boundary.
  const { redactTexts: incompatible, RedactionError } = await import("./redact.js");
  await expect(incompatible(["private input must not escape"])).rejects.toBeInstanceOf(RedactionError);
});

it("redacts JSON leaves before serialization while preserving Dates and non-string values", async () => {
  const at = new Date("2026-01-01T00:00:00Z");
  const pem = "-----BEGIN PRIVATE KEY-----\nYWJjZGVmZ2hpamts\n-----END PRIVATE KEY-----";
  const input = { at, data: { body: pem, nested: ["password=abcdefgh", null, 42, false] }, title: "ordinary" };
  const output = await redactValue(input);
  expect(output.at).toBe(at);
  expect(output.data.body).toMatch(/^\[REDACTED:private-key:[a-f0-9]{8}\]$/);
  expect(output.data.nested).toEqual(["password=[REDACTED:credential-assignment:9c56cc51]", null, 42, false]);
  expect(output.title).toBe("ordinary");
  expect(input.data.body).toBe(pem);
  await expect(redactValue(new Map([["body", pem]]))).rejects.toBeInstanceOf(RedactionError);
});

it("applies fixed rules through nested Base64, hex, percent, and Unicode encodings in later parts", async () => {
  const key = `ghp_${"u".repeat(36)}`;
  const base64 = Buffer.from(key).toString("base64");
  const encodings = [
    Buffer.from(base64).toString("base64"),
    Buffer.from(key).toString("hex"),
    [...key].map(character => `%${character.charCodeAt(0).toString(16)}`).join(""),
    [...key].map(character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`).join(""),
  ];
  const output = await redactTexts([...Array<string>(8).fill("ordinary"), ...encodings]);
  expect(output.slice(0, 8)).toEqual(Array<string>(8).fill("ordinary"));
  for (const text of output.slice(8)) {
    expect(text).toMatch(/^ghp_\[REDACTED:github-token:[a-f0-9]{8}\]$/);
    expect(encodings).not.toContain(text);
  }
});

it("accepts dotted v1 rule IDs and preserves their markers on subsequent scans", async () => {
  // The embedded v1 config names this scanner-only rule cartesia-api-key.1.
  const key = "sk_car_" + "7nQ2zV9mK4xR8bT3pH6s";
  const input = `before ${key} after`;
  const expected = "before [REDACTED:cartesia-api-key.1:15297099] after";
  expect(await redactTexts([input])).toEqual([expected]);
  expect(await redactTexts([expected])).toEqual([expected]);
});

it("redacts credentials after serialized whitespace without masking ordinary long task names", async () => {
  const key = `sk-${"v".repeat(40)}`;
  const input = ["\n", "\r", "\t", "\b", "\f", "\v"].map(space => JSON.stringify({ script: `heading${space}${key}\n` }));
  const output = await redactTexts(input);
  for (const value of output) {
    expect(value).not.toContain(key);
    expect(value).toContain("[REDACTED:api-key:");
  }
  const ordinary = `task-${"ordinary-description-".repeat(3)}`;
  expect(await redactTexts([ordinary])).toEqual([ordinary]);
});
