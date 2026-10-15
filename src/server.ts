import { createApp } from "./app.js";
import { HttpOrderGateway, HttpPaymentGateway } from "./clients/order-client.js";
import { ServiceTokenProvider } from "./clients/service-token-provider.js";
import { loadEnv } from "./config/env.js";
import { createPool } from "./db/pool.js";
import { createLogger } from "./lib/logger.js";
import { createWorkers } from "./messaging/runner.js";
import { SagaEngine } from "./saga/engine.js";
import { SagaRepository } from "./saga/repository.js";
import { TokenVerifier } from "./security/token-verifier.js";

const env = loadEnv();
const logger = createLogger(env.LOG_LEVEL);
const db = createPool(env.DATABASE_URL);

const tokens = new ServiceTokenProvider({
  authUrl: env.AUTH_SERVICE_URL,
  clientId: env.SERVICE_CLIENT_ID,
  clientSecret: env.SERVICE_CLIENT_SECRET,
  timeoutMs: env.DEPENDENCY_TIMEOUT_MS,
});
if (!env.SERVICE_CLIENT_SECRET) logger.warn("SERVICE_CLIENT_SECRET is not set: order and payment calls will fail and checkouts will not progress");

const repo = new SagaRepository({
  queues: { inventory: env.INVENTORY_COMMANDS_QUEUE_NAME, order: env.ORDER_COMMANDS_QUEUE_NAME, payment: env.PAYMENT_COMMANDS_QUEUE_NAME, notification: env.NOTIFICATION_COMMANDS_QUEUE_NAME },
  eventsTopicArn: env.SAGA_EVENTS_TOPIC_ARN,
});
const engine = new SagaEngine(
  db,
  repo,
  new HttpOrderGateway(env.ORDER_SERVICE_URL, tokens, env.DEPENDENCY_TIMEOUT_MS),
  new HttpPaymentGateway(env.PAYMENT_SERVICE_URL, tokens, env.DEPENDENCY_TIMEOUT_MS),
  {
    reservationTimeoutMs: env.RESERVATION_TIMEOUT_SECONDS * 1000,
    paymentTimeoutMs: env.PAYMENT_TIMEOUT_SECONDS * 1000,
    stepTimeoutMs: env.STEP_TIMEOUT_SECONDS * 1000,
    maxStepAttempts: env.MAX_STEP_ATTEMPTS,
  },
  { frontendBaseUrl: env.FRONTEND_BASE_URL, maxActiveCheckouts: env.MAX_ACTIVE_CHECKOUTS_PER_CUSTOMER },
  logger,
);
const workers = createWorkers(env, db, engine, logger);

let shuttingDown = false;

const app = createApp({
  env,
  logger,
  db,
  engine,
  repo,
  verifier: new TokenVerifier({ jwksUrl: env.JWKS_URL, issuer: env.JWT_ISSUER, audiences: [env.JWT_AUDIENCE, env.JWT_SERVICE_AUDIENCE] }),
  readinessChecks: [
    {
      // Report "not ready" as soon as shutdown starts, so the load balancer
      // stops sending new requests while in-flight ones finish.
      name: "accepting-traffic",
      check: async () => {
        if (shuttingDown) throw new Error("shutting down");
      },
    },
    { name: "database", check: async () => void (await db.query("SELECT 1")) },
  ],
});

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, "server listening");
  // Recovery is automatic: whatever was overdue when the previous instance stopped is picked up now.
  void workers.start(); // drains saga-inbox, then starts the timer; HTTP serves meanwhile
});

function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutdown started");

  server.close((err) => {
    // Stop the background loops (finishing in-flight work) before closing the pool they use.
    void workers
      .stop()
      .then(() => db.end())
      .finally(() => {
        if (err) {
          logger.error({ err }, "error while closing server");
          process.exit(1);
        }
        logger.info("shutdown complete");
        process.exit(0);
      });
  });
  server.closeIdleConnections();

  setTimeout(() => {
    logger.error({ timeoutMs: env.SHUTDOWN_TIMEOUT_MS }, "forced shutdown after timeout");
    process.exit(1);
  }, env.SHUTDOWN_TIMEOUT_MS).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
