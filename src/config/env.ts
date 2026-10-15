import { z } from "zod";

const bool = z.enum(["true", "false"]).transform((v) => v === "true");
const seconds = (def: number) => z.coerce.number().int().min(1).default(def);

// Validated once at startup; the process refuses to boot with invalid config.
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4007),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  CORS_ALLOWED_ORIGINS: z
    .string()
    .default("http://localhost:5173")
    .transform((value) =>
      value
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

  DATABASE_URL: z.string().startsWith("postgresql://"),

  // Incoming tokens: customers/admins (shared audience) and service tokens addressed to the saga.
  JWKS_URL: z.url().default("http://localhost:4001/.well-known/jwks.json"),
  JWT_ISSUER: z.string().default("ecommerce-auth-service"),
  JWT_AUDIENCE: z.string().default("ecommerce-api"),
  JWT_SERVICE_AUDIENCE: z.string().default("ecommerce-saga-orchestrator"),

  // Synchronous calls (client-credentials tokens from Auth).
  AUTH_SERVICE_URL: z.url().default("http://localhost:4001"),
  SERVICE_CLIENT_ID: z.string().default("ecommerce-saga-orchestrator"),
  SERVICE_CLIENT_SECRET: z.string().min(1).optional(),
  ORDER_SERVICE_URL: z.url().default("http://localhost:4004"),
  PAYMENT_SERVICE_URL: z.url().default("http://localhost:4005"),
  FRONTEND_BASE_URL: z.url().default("http://localhost:5173"),
  DEPENDENCY_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(5_000),

  // Messaging.
  MESSAGING_ENABLED: bool.default(false),
  AWS_REGION: z.string().default("us-east-1"),
  AWS_ENDPOINT_URL: z.url().optional(),
  SAGA_INBOX_QUEUE_NAME: z.string().default("local-ecommerce-saga-inbox"),
  INVENTORY_COMMANDS_QUEUE_NAME: z.string().default("local-ecommerce-inventory-commands"),
  ORDER_COMMANDS_QUEUE_NAME: z.string().default("local-ecommerce-order-commands.fifo"),
  PAYMENT_COMMANDS_QUEUE_NAME: z.string().default("local-ecommerce-payment-commands"),
  SAGA_EVENTS_TOPIC_ARN: z.string().default("arn:aws:sns:us-east-1:000000000000:local-ecommerce-saga-events"),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(50).default(500),
  CONSUMER_WAIT_TIME_SECONDS: z.coerce.number().int().min(0).max(20).default(20),

  // Saga policy.
  RESERVATION_TIMEOUT_SECONDS: seconds(30),
  PAYMENT_TIMEOUT_SECONDS: seconds(1_800),
  STEP_TIMEOUT_SECONDS: seconds(30),
  MAX_STEP_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  /// How often overdue sagas (timeouts, retries, crash recovery) are picked up. 0 disables (tests drive it).
  TIMER_INTERVAL_MS: z.coerce.number().int().min(0).default(1_000),
  /// At startup, apply saga-inbox events for this long before the timer judges deadlines. Must exceed the
  /// queue's visibility timeout (60 s) so events a killed instance had received are drained too.
  STARTUP_DRAIN_MS: z.coerce.number().int().min(0).default(65_000),
  /// Checkouts a customer may have holding stock before payment (abuse limit: reserving without paying).
  MAX_ACTIVE_CHECKOUTS_PER_CUSTOMER: z.coerce.number().int().min(1).max(50).default(3),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    throw new Error(`Invalid environment configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
