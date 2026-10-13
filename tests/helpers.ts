import { createApp } from "../src/app.js";
import { loadEnv } from "../src/config/env.js";
import { createLogger } from "../src/lib/logger.js";
import type { ReadinessCheck } from "../src/routes/health.js";

export function buildTestApp(readinessChecks: ReadinessCheck[] = []) {
  const env = loadEnv({ NODE_ENV: "test", LOG_LEVEL: "silent" });
  return createApp({ env, logger: createLogger(env.LOG_LEVEL), readinessChecks });
}
