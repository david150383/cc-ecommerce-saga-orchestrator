import { OpenApiGeneratorV31, OpenAPIRegistry, type RouteConfig } from "@asteasolutions/zod-to-openapi";
import { AdminListQuery, AdminSaga, CheckoutRequestSchema, CheckoutStatus, ResolveRequest } from "../api/schemas.js";
import { z } from "../lib/zod.js";

// Built from the SAME zod schemas that validate requests; a test compares it with openapi/openapi.json.

const Problem = z
  .object({ type: z.string(), title: z.string(), status: z.number().int(), code: z.string(), instance: z.string() })
  .catchall(z.unknown())
  .openapi("Problem");
const json = <T extends z.ZodType>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const problem = (description: string) => ({ description, content: { "application/problem+json": { schema: Problem } } });
const SagaIdParams = z.object({ sagaId: z.uuid() });

export function buildOpenApiDocument() {
  const registry = new OpenAPIRegistry();
  const bearer = registry.registerComponent("securitySchemes", "bearerAuth", { type: "http", scheme: "bearer", bearerFormat: "JWT" });
  const secured = [{ [bearer.name]: [] }];
  const paths: RouteConfig[] = [
    {
      method: "post", path: "/api/v1/checkout", tags: ["checkout"], security: secured,
      summary: "Start a checkout (202: continues asynchronously; poll statusUrl)",
      request: { body: { content: { "application/json": { schema: CheckoutRequestSchema } } }, headers: z.object({ "idempotency-key": z.string().min(1).max(255) }) },
      responses: {
        202: json(CheckoutStatus, "Accepted (Idempotency-Replayed: true for a repeated key)"),
        400: problem("VALIDATION_FAILED / IDEMPOTENCY_KEY_REQUIRED"), 401: problem("UNAUTHENTICATED"),
        422: problem("IDEMPOTENCY_KEY_REUSED"),
      },
    },
    {
      method: "get", path: "/api/v1/checkout/{sagaId}", tags: ["checkout"], security: secured,
      summary: "Checkout progress (owner or admin)", request: { params: SagaIdParams },
      responses: { 200: json(CheckoutStatus, "Status"), 404: problem("NOT_FOUND") },
    },
    {
      method: "get", path: "/api/v1/admin/sagas", tags: ["admin"], security: secured, summary: "List sagas, e.g. ?state=MANUAL_REVIEW",
      request: { query: AdminListQuery },
      responses: { 200: json(z.object({ data: z.array(AdminSaga), page: z.object({ limit: z.number().int(), nextCursor: z.string().nullable() }) }), "Sagas") },
    },
    {
      method: "get", path: "/api/v1/admin/sagas/{sagaId}", tags: ["admin"], security: secured, summary: "Saga with its full step history",
      request: { params: SagaIdParams }, responses: { 200: json(z.object({ saga: AdminSaga, steps: z.array(z.record(z.string(), z.unknown())) }), "Saga"), 404: problem("NOT_FOUND") },
    },
    {
      method: "post", path: "/api/v1/admin/sagas/{sagaId}/retry", tags: ["admin"], security: secured, summary: "Make the current step due now",
      request: { params: SagaIdParams }, responses: { 200: json(z.object({ saga: AdminSaga }), "Scheduled"), 409: problem("NOT_RETRYABLE") },
    },
    {
      method: "post", path: "/api/v1/admin/sagas/{sagaId}/resolve", tags: ["admin"], security: secured, summary: "Close a MANUAL_REVIEW saga",
      request: { params: SagaIdParams, body: { content: { "application/json": { schema: ResolveRequest } } } },
      responses: { 200: json(z.object({ saga: AdminSaga }), "Resolved"), 409: problem("NOT_IN_MANUAL_REVIEW") },
    },
  ];
  paths.forEach((p) => registry.registerPath(p));
  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: "3.1.0",
    info: { title: "Saga Orchestrator", version: "1.0.0", description: "Checkout saga. Workflow: docs/saga.md" },
    servers: [{ url: "http://localhost:4007" }],
  });
}
