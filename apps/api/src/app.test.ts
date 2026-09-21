import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";

const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

describe("local MVP API", () => {
  it("reports liveness and completed construction gate", async () => {
    const app = buildApp();
    apps.push(app);
    const response = await app.inject({ method: "GET", url: "/healthz" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ service: "api", status: "ok", gate: 5 });
  });

  it("reports healthy readiness with HTTP 200 when no probe is configured", async () => {
    const app = buildApp();
    apps.push(app);
    const response = await app.inject({ method: "GET", url: "/readyz" });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("ready");
    expect(response.json().dependencies).toEqual({ postgres: "skipped" });
  });

  it("reports degraded readiness with HTTP 503", async () => {
    const app = buildApp({
      readiness: async () => ({ ready: false, postgres: "error" }),
    });
    apps.push(app);
    const response = await app.inject({ method: "GET", url: "/readyz" });
    expect(response.statusCode).toBe(503);
    expect(response.json().status).toBe("degraded");
    expect(response.json().dependencies).toEqual({ postgres: "error" });
  });
});
