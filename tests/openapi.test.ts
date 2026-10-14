import { readFileSync } from "node:fs";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { buildOpenApiDocument } from "../src/openapi/document.js";
import { buildTestContext } from "./helpers.js";

describe("OpenAPI", () => {
  it("the committed openapi/openapi.json matches the code (run `npm run openapi:export`)", () => {
    expect(JSON.parse(readFileSync("openapi/openapi.json", "utf8"))).toEqual(JSON.parse(JSON.stringify(buildOpenApiDocument())));
  });

  it("serves the spec and Swagger UI", async () => {
    const { app } = await buildTestContext();
    expect(Object.keys((await request(app).get("/openapi.json")).body.paths)).toContain("/api/v1/checkout/{sagaId}");
    expect((await request(app).get("/docs/")).status).toBe(200);
  });
});
