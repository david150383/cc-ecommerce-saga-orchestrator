import request from "supertest";
import { describe, expect, it } from "vitest";
import { buildTestApp } from "./helpers.js";

describe("health endpoints", () => {
  it("GET /health/live returns 200", async () => {
    const res = await request(buildTestApp()).get("/health/live");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("GET /health/ready returns 200 when all checks pass", async () => {
    const app = buildTestApp([{ name: "database", check: async () => {} }]);
    const res = await request(app).get("/health/ready");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ready", checks: { database: "ok" } });
  });

  it("GET /health/ready returns 503 when a check fails", async () => {
    const app = buildTestApp([
      { name: "database", check: async () => {} },
      { name: "broker", check: () => Promise.reject(new Error("down")) },
    ]);
    const res = await request(app).get("/health/ready");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: "not_ready", checks: { database: "ok", broker: "failed" } });
  });
});

describe("request context", () => {
  it("echoes a valid incoming correlation ID", async () => {
    const res = await request(buildTestApp()).get("/health/live").set("X-Correlation-Id", "test-correlation-123");
    expect(res.headers["x-correlation-id"]).toBe("test-correlation-123");
    expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("replaces a missing or unsafe correlation ID with a generated UUID", async () => {
    const res = await request(buildTestApp()).get("/health/live").set("X-Correlation-Id", "<script>");
    expect(res.headers["x-correlation-id"]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
  });
});

describe("errors use RFC 9457 problem details", () => {
  it("unknown routes return 404 problem+json", async () => {
    const res = await request(buildTestApp()).get("/api/v1/does-not-exist");
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toMatch(/^application\/problem\+json/);
    expect(res.body).toMatchObject({ status: 404, code: "NOT_FOUND", instance: "/api/v1/does-not-exist" });
    expect(res.body.correlationId).toBe(res.headers["x-correlation-id"]);
  });

  it("malformed JSON returns 400 without leaking parser internals", async () => {
    const res = await request(buildTestApp())
      .post("/api/v1/anything")
      .set("Content-Type", "application/json")
      .send('{"broken":');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: "MALFORMED_JSON" });
    expect(JSON.stringify(res.body)).not.toMatch(/at JSON\.parse|node_modules/);
  });
});

describe("security headers", () => {
  it("sets helmet headers and hides the framework", async () => {
    const res = await request(buildTestApp()).get("/health/live");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it("allows only configured CORS origins", async () => {
    const app = buildTestApp();
    const allowed = await request(app).get("/health/live").set("Origin", "http://localhost:5173");
    expect(allowed.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    const denied = await request(app).get("/health/live").set("Origin", "https://evil.example");
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
