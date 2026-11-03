import { afterEach, describe, expect, it, vi } from "vitest";
import { ROLE_SEEDS, roleChoice } from "./models.js";

describe("roleChoice", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("bug: memory-mcp holds no DATABASE_URL, so the role lookup failed and every brief went out unpicked; it takes MODEL_<ROLE> or the seed", async () => {
    vi.stubEnv("DATABASE_URL", undefined);
    vi.stubEnv("MODEL_BRIEF", "");
    await expect(roleChoice("brief")).resolves.toEqual(ROLE_SEEDS.brief);
    vi.stubEnv("MODEL_BRIEF", "openai/gpt-test@low");
    await expect(roleChoice("brief")).resolves.toEqual({ model: "openai/gpt-test", thinking: "low" });
  });
});
