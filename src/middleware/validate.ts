import type { z } from "zod";
import { HttpProblem } from "../lib/problem.js";

/** Parses untrusted input; on failure throws a 400 listing every invalid field. */
export function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input ?? {});
  if (result.success) return result.data;
  throw new HttpProblem(
    400,
    "VALIDATION_FAILED",
    "Request validation failed",
    "One or more fields are invalid.",
    result.error.issues.map((issue) => ({ path: issue.path.join(".") || "(root)", message: issue.message })),
  );
}
