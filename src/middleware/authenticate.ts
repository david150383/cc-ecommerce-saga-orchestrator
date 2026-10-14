import type { RequestHandler } from "express";
import { HttpProblem } from "../lib/problem.js";
import type { Principal, TokenVerifier } from "../security/token-verifier.js";

declare module "express-serve-static-core" {
  interface Locals {
    principal?: Principal;
  }
}

export type Role = "customer" | "admin" | "service";

/** Requires a valid Bearer token whose roles include at least one of `roles`. */
export function requireRole(verifier: TokenVerifier, ...roles: Role[]): RequestHandler {
  return async (req, res, next) => {
    const [scheme, token] = (req.get("authorization") ?? "").split(" ");
    if (scheme?.toLowerCase() !== "bearer" || !token) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="ecommerce"');
      throw new HttpProblem(401, "UNAUTHENTICATED", "Authentication required");
    }
    try {
      res.locals.principal = await verifier.verify(token);
    } catch (err) {
      if (err instanceof HttpProblem && err.status === 401) res.setHeader("WWW-Authenticate", 'Bearer realm="ecommerce"');
      throw err;
    }
    if (!roles.some((r) => res.locals.principal!.roles.has(r))) {
      throw new HttpProblem(403, "FORBIDDEN", "Insufficient permissions");
    }
    next();
  };
}
