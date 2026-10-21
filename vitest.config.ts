import { defineConfig } from "vitest/config";

// Tests run as a made-up owner in a fixed zone, whatever machine they run on.
export default defineConfig({ test: { env: { TZ: "America/Chicago", OWNER_NAME: "Alex", OWNER_PRONOUNS: "they/them/their" } } });
