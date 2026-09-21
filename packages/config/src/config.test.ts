import { describe, expect, it } from "vitest";

import { loadRuntimeConfig } from "./index.js";

describe("runtime config", () => {
  it("is mock-only and loopback by default", () => {
    const config = loadRuntimeConfig({});
    expect(config.API_HOST).toBe("127.0.0.1");
    expect(config.PROVIDER_MODE).toBe("mock");
    expect(config.PROVIDER_EGRESS_ENABLED).toBe(false);
  });

  it("allows the mock path even if a deployment preauthorizes egress", () => {
    expect(loadRuntimeConfig({ PROVIDER_EGRESS_ENABLED: "true" }).PROVIDER_MODE).toBe("mock");
  });

  it("fails closed unless cloud egress, credentials, explicit model, and budget are set", () => {
    expect(() => loadRuntimeConfig({ PROVIDER_MODE: "openai" })).toThrow(
      "Invalid IntentTrace configuration",
    );
    expect(() =>
      loadRuntimeConfig({ PROVIDER_MODE: "deepseek", PROVIDER_EGRESS_ENABLED: "true" }),
    ).toThrow("Invalid IntentTrace configuration");
  });

  it("accepts an explicitly gated cloud provider configuration", () => {
    const config = loadRuntimeConfig({
      PROVIDER_MODE: "openai",
      PROVIDER_EGRESS_ENABLED: "true",
      PROVIDER_DAILY_BUDGET_USD: "1",
      OPENAI_API_KEY: "test-only",
      OPENAI_MODEL: "gpt-5.6-sol",
    });
    expect(config.PROVIDER_MODE).toBe("openai");
  });
});
