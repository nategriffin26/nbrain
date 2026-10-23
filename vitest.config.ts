import { defineConfig } from "vitest/config";

// Tests run as a made-up owner in a fixed zone, whatever machine they run on, and never reach the owner's Ollama or
// Workers AI account: a test that needs a model fakes it (src/testai.ts).
export default defineConfig({ test: { env: { TZ: "America/Chicago", OWNER_NAME: "Alex", OWNER_PRONOUNS: "they/them/their", OLLAMA_URL: "http://127.0.0.1:1", CLOUDFLARE_ACCOUNT_ID: "", CLOUDFLARE_API_TOKEN: "" } } });
