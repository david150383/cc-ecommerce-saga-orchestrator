import type { RequestHandler } from "express";
import { v7 as uuidv7 } from "uuid";

// Accept a caller-supplied correlation ID only if it looks like an ID, so
// arbitrary strings cannot be injected into logs or downstream headers.
const SAFE_ID = /^[A-Za-z0-9-]{8,128}$/;

export const requestContext: RequestHandler = (req, res, next) => {
  const incoming = req.get("x-correlation-id");
  const correlationId = incoming && SAFE_ID.test(incoming) ? incoming : uuidv7();
  const requestId = uuidv7();

  res.locals.correlationId = correlationId;
  res.locals.requestId = requestId;
  res.setHeader("X-Correlation-Id", correlationId);
  res.setHeader("X-Request-Id", requestId);
  next();
};
