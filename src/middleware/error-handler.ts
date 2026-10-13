import type { ErrorRequestHandler, RequestHandler } from "express";
import type { Logger } from "../lib/logger.js";
import { HttpProblem, toProblemBody } from "../lib/problem.js";

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new HttpProblem(404, "NOT_FOUND", "Resource not found", `No route for ${req.method} ${req.path}`));
};

function isBodyParserError(err: unknown): err is { type: string; status: number } {
  return typeof err === "object" && err !== null && "type" in err && "status" in err;
}

export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (err, req, res, next) => {
    if (res.headersSent) {
      next(err);
      return;
    }

    let problem: HttpProblem;
    if (err instanceof HttpProblem) {
      problem = err;
    } else if (isBodyParserError(err) && err.type === "entity.parse.failed") {
      problem = new HttpProblem(400, "MALFORMED_JSON", "Malformed JSON body");
    } else if (isBodyParserError(err) && err.type === "entity.too.large") {
      problem = new HttpProblem(413, "PAYLOAD_TOO_LARGE", "Request body too large");
    } else {
      // Unexpected: log the real cause, return a generic message. No stack traces to clients.
      logger.error({ err, correlationId: res.locals.correlationId }, "unhandled error");
      problem = new HttpProblem(500, "INTERNAL_ERROR", "Internal server error", "An unexpected error occurred.");
    }

    res
      .status(problem.status)
      .type("application/problem+json")
      .json(toProblemBody(problem, req.originalUrl, res.locals.correlationId as string | undefined));
  };
}
