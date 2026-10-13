import { pino } from "pino";

export const SERVICE_NAME = "ecommerce-saga-orchestrator";

// Secrets must never reach the logs, so redaction happens here at the logger
// level instead of relying on every call site to remember.
const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'res.headers["set-cookie"]',
  "*.password",
  "*.newPassword",
  "*.token",
  "*.accessToken",
  "*.refreshToken",
  "*.resetToken",
  "*.secret",
  "*.cardNumber",
  "*.cvv",
];

export function createLogger(level: string) {
  return pino({
    level,
    base: { service: SERVICE_NAME },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
  });
}

export type Logger = ReturnType<typeof createLogger>;
