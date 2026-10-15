import { Writable } from "node:stream";
import { type CryptoKey, exportJWK, generateKeyPair, type JSONWebKeySet, SignJWT } from "jose";
import { pino } from "pino";
import { v7 as uuidv7 } from "uuid";
import { createApp } from "../src/app.js";
import type { CallResult, OrderGateway, PaymentGateway } from "../src/clients/order-client.js";
import { loadEnv } from "../src/config/env.js";
import { createPool, type Pool } from "../src/db/pool.js";
import type { ReadinessCheck } from "../src/routes/health.js";
import { SagaEngine } from "../src/saga/engine.js";
import { type Destinations, SagaRepository } from "../src/saga/repository.js";
import type { CheckoutRequest } from "../src/saga/types.js";
import { TokenVerifier } from "../src/security/token-verifier.js";
import { TEST_DATABASE_URL } from "./global-setup.js";

type Mode = "ok" | "reject" | "down";

/** Stands in for the Order Service. Idempotent per saga, like the real one. */
export class FakeOrders implements OrderGateway {
  mode: Mode = "ok";
  calls = 0;
  readonly created = new Map<string, { orderId: string; totalMinor: bigint; currency: string }>();

  async createOrder({ sagaId }: { sagaId: string; customerId: string; request: CheckoutRequest }): Promise<CallResult<{ orderId: string; totalMinor: bigint; currency: string }>> {
    this.calls++;
    if (this.mode === "down") return { ok: false, kind: "unavailable", detail: "HTTP 503" };
    if (this.mode === "reject") return { ok: false, kind: "rejected", code: "PRODUCT_UNAVAILABLE" };
    let order = this.created.get(sagaId);
    if (!order) {
      order = { orderId: uuidv7(), totalMinor: 117_764n, currency: "INR" };
      this.created.set(sagaId, order);
    }
    return { ok: true, value: order };
  }
}

/** Stands in for the Payment Service (built in Phase 4). */
export class FakePayments implements PaymentGateway {
  mode: Mode = "ok";
  calls = 0;
  /** Runs while the intent is "being created" (to simulate events racing a slow call). */
  during: (() => Promise<void>) | undefined;

  async createIntent({ orderId }: { sagaId: string; orderId: string; returnUrl: string }): Promise<CallResult<{ paymentId: string; checkoutUrl: string }>> {
    this.calls++;
    if (this.during) await this.during();
    if (this.mode === "down") return { ok: false, kind: "unavailable", detail: "HTTP 503" };
    if (this.mode === "reject") return { ok: false, kind: "rejected", code: "ORDER_NOT_PAYABLE" };
    return { ok: true, value: { paymentId: uuidv7(), checkoutUrl: `https://pay.example/checkout/${orderId}` } };
  }
}

let keys: Promise<{ privateKey: CryptoKey; jwks: JSONWebKeySet }> | undefined;
function testKeys() {
  keys ??= generateKeyPair("RS256").then(async ({ privateKey, publicKey }) => ({
    privateKey,
    jwks: { keys: [{ ...(await exportJWK(publicKey)), kid: "test-key", alg: "RS256", use: "sig" }] },
  }));
  return keys;
}

export async function auth(roles: string[], sub = uuidv7()) {
  const { privateKey } = await testKeys();
  const token = await new SignJWT({ roles })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer("ecommerce-auth-service")
    .setAudience("ecommerce-api")
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(privateKey);
  return { Authorization: `Bearer ${token}` };
}

let pool: Pool | undefined;
export function testPool(): Pool {
  pool ??= createPool(TEST_DATABASE_URL, 20);
  return pool;
}

export async function resetDatabase(): Promise<void> {
  await testPool().query("TRUNCATE saga_instances, saga_steps, outbox, processed_messages CASCADE");
}

export const defaultDestinations: Destinations = {
  queues: { inventory: "test-inventory-commands", order: "test-order-commands.fifo", payment: "test-payment-commands", notification: "test-notification-commands" },
  eventsTopicArn: "arn:aws:sns:us-east-1:000000000000:test-saga-events",
};

export async function buildTestContext(overrides: Record<string, string> = {}, destinations = defaultDestinations, readinessChecks: ReadinessCheck[] = []) {
  const env = loadEnv({ NODE_ENV: "test", LOG_LEVEL: "silent", DATABASE_URL: TEST_DATABASE_URL, TIMER_INTERVAL_MS: "0", ...overrides });
  const logger = pino(
    { level: env.LOG_LEVEL },
    new Writable({
      write(_c, _e, cb) {
        cb();
      },
    }),
  );
  const orders = new FakeOrders();
  const payments = new FakePayments();
  const repo = new SagaRepository(destinations);
  const policy = { reservationTimeoutMs: 30_000, paymentTimeoutMs: 1_800_000, stepTimeoutMs: 30_000, maxStepAttempts: 3 };
  // The abuse limit applies only when a test asks for it (other tests start many checkouts per customer).
  const maxActiveCheckouts = overrides.MAX_ACTIVE_CHECKOUTS_PER_CUSTOMER ? env.MAX_ACTIVE_CHECKOUTS_PER_CUSTOMER : undefined;
  const engine = new SagaEngine(testPool(), repo, orders, payments, policy, { frontendBaseUrl: "http://localhost:5173", maxActiveCheckouts }, logger);
  const verifier = new TokenVerifier(
    { jwksUrl: "http://unused.invalid/jwks", issuer: "ecommerce-auth-service", audiences: ["ecommerce-api", "ecommerce-saga-orchestrator"] },
    (await testKeys()).jwks,
  );
  const app = createApp({ env, logger, db: testPool(), engine, repo, verifier, readinessChecks });
  return { app, engine, repo, orders, payments, env, logger, db: testPool() };
}

export const newId = () => uuidv7();

export const checkoutBody = {
  items: [{ sku: "TEE-1", quantity: 2 }],
  currency: "INR",
  shippingAddress: { name: "Asha Rao", line1: "12 MG Road", city: "Bengaluru", postalCode: "560001", country: "IN", phone: "+919800000000" },
};

/** Incoming event as the saga inbox would deliver it. */
export const event = (sagaId: string | null, messageType: string, payload: Record<string, unknown> = {}) => ({
  messageId: uuidv7(),
  messageType,
  correlationId: sagaId ?? uuidv7(),
  sagaId,
  payload,
});

export async function stateOf(id: string) {
  const r = await testPool().query(`SELECT state, failure_reason, step_attempts, compensation FROM saga_instances WHERE id = $1`, [id]);
  return r.rows[0] as { state: string; failure_reason: string | null; step_attempts: number; compensation: { awaiting: string[] } };
}

export async function outbox(sagaId?: string) {
  const r = await testPool().query(
    `SELECT destination_kind AS kind, destination, group_id AS "groupId", message_type AS type, envelope
       FROM outbox ${sagaId ? "WHERE saga_id = $1" : ""} ORDER BY seq`,
    sagaId ? [sagaId] : [],
  );
  return r.rows as { kind: string; destination: string; groupId: string | null; type: string; envelope: { idempotencyKey: string | null; payload: Record<string, unknown>; causationId: string | null } }[];
}

/** Makes every waiting saga overdue (instead of sleeping through real timeouts). */
export async function expireDeadlines(): Promise<void> {
  await testPool().query(`UPDATE saga_instances SET deadline_at = now() - interval '1 second', lease_until = NULL WHERE deadline_at IS NOT NULL`);
}
