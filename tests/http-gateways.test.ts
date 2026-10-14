import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HttpPaymentGateway } from "../src/clients/order-client.js";
import type { ServiceTokenProvider } from "../src/clients/service-token-provider.js";

// A real HTTP server stands in for the Payment Service, to check what goes over the wire.
let server: Server;
let base: string;
let reply: { status: number; body: unknown };
let seen: { headers: IncomingMessage["headers"]; body: Record<string, unknown> }[];

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.push({ headers: req.headers, body: JSON.parse(raw) });
      res.writeHead(reply.status, { "content-type": "application/json" }).end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  seen = [];
  reply = { status: 201, body: { payment: { id: "p1", checkoutUrl: "http://pay/x" } } };
});

const invalidated: string[] = [];
const tokens = { token: async (aud: string) => `token-for-${aud}`, invalidate: (aud: string) => invalidated.push(aud) } as unknown as ServiceTokenProvider;
const gateway = () => new HttpPaymentGateway(base, tokens, 2_000);
const input = { sagaId: "s-1", orderId: "o-1", returnUrl: "http://localhost:5173/checkout/result?saga=s-1" };

describe("HttpPaymentGateway", () => {
  it("sends orderId, returnUrl and sagaId (never an amount) with a saga-derived idempotency key", async () => {
    expect(await gateway().createIntent(input)).toEqual({ ok: true, value: { paymentId: "p1", checkoutUrl: "http://pay/x" } });
    expect(seen[0]!.body).toEqual({ orderId: "o-1", returnUrl: input.returnUrl, sagaId: "s-1" });
    expect(seen[0]!.headers).toMatchObject({ "idempotency-key": "s-1:payment-intent", authorization: "Bearer token-for-ecommerce-payment-service" });
  });

  it("classifies answers: 422 rejected; 409 and 5xx retryable; 401 also drops the cached token", async () => {
    reply = { status: 422, body: { code: "ORDER_NOT_FOUND" } };
    expect(await gateway().createIntent(input)).toEqual({ ok: false, kind: "rejected", code: "ORDER_NOT_FOUND" });
    for (const status of [409, 503, 401]) {
      reply = { status, body: {} };
      expect(await gateway().createIntent(input)).toMatchObject({ ok: false, kind: "unavailable" });
    }
    expect(invalidated).toEqual(["ecommerce-payment-service"]);
  });
});
