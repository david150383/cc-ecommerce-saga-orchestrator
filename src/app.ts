import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import type { Env } from "./config/env.js";
import type { Logger } from "./lib/logger.js";
import { errorHandler, notFoundHandler } from "./middleware/error-handler.js";
import { requestContext } from "./middleware/request-context.js";
import { healthRouter, type ReadinessCheck } from "./routes/health.js";

export interface AppDependencies {
  env: Env;
  logger: Logger;
  readinessChecks?: ReadinessCheck[];
}

// Builds the Express app without starting a server, so tests can drive it
// in-process with Supertest.
export function createApp({ env, logger, readinessChecks = [] }: AppDependencies): Express {
  const app = express();

  app.disable("x-powered-by");
  app.use(helmet());
  app.use(cors({ origin: env.CORS_ALLOWED_ORIGINS, credentials: true }));
  app.use(requestContext);
  app.use(
    pinoHttp({
      logger,
      genReqId: (_req, res) => res.locals.requestId as string,
      customProps: (_req, res) => ({ correlationId: res.locals.correlationId as string }),
      autoLogging: { ignore: (req) => req.url?.startsWith("/health") ?? false },
      // Log only what is useful for tracing; headers can carry credentials and are noisy.
      serializers: {
        req: (req: { id: string; method: string; url: string }) => ({ id: req.id, method: req.method, url: req.url }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
    }),
  );
  app.use(express.json({ limit: "100kb" }));

  app.use(healthRouter(readinessChecks));
  // Versioned API routers (/api/v1/...) are mounted here from Phase 2 onwards.

  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return app;
}
