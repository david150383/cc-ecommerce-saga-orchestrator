import { type Request, Router } from "express";
import type { Pool } from "../db/pool.js";
import { HttpProblem } from "../lib/problem.js";
import { requireRole } from "../middleware/authenticate.js";
import { parse } from "../middleware/validate.js";
import type { SagaEngine } from "../saga/engine.js";
import type { SagaRepository } from "../saga/repository.js";
import type { TokenVerifier } from "../security/token-verifier.js";
import { AdminListQuery, CheckoutRequestSchema, ResolveRequest, SagaIdParam, toAdminSaga, toCheckoutStatus } from "./schemas.js";

function idempotencyKey(req: Request): string {
  const key = req.get("idempotency-key");
  if (!key || !/^[\x21-\x7e]{1,255}$/.test(key)) {
    throw new HttpProblem(400, "IDEMPOTENCY_KEY_REQUIRED", "A valid Idempotency-Key header is required");
  }
  return key;
}

export function sagaRouter(deps: { engine: SagaEngine; repo: SagaRepository; db: Pool; verifier: TokenVerifier }): Router {
  const { engine, repo, db, verifier } = deps;
  const router = Router();
  const customer = requireRole(verifier, "customer", "admin");
  const admin = requireRole(verifier, "admin");

  /**
   * Starts a checkout. 202 Accepted: the work continues asynchronously; the client polls
   * statusUrl until checkoutUrl appears (AWAITING_PAYMENT) or a final status is reached.
   */
  router.post("/checkout", customer, async (req, res) => {
    const body = parse(CheckoutRequestSchema, req.body);
    const { saga, replayed } = await engine.startCheckout(res.locals.principal!.subject, idempotencyKey(req), body);
    if (replayed) res.setHeader("Idempotency-Replayed", "true");
    const view = toCheckoutStatus(saga);
    res.setHeader("Location", view.statusUrl);
    res.status(202).json(view);
  });

  router.get("/checkout/:sagaId", customer, async (req, res) => {
    const { sagaId } = parse(SagaIdParam, req.params);
    const saga = await repo.get(db, sagaId);
    const p = res.locals.principal!;
    if (!saga || (!p.roles.has("admin") && saga.customerId !== p.subject)) throw new HttpProblem(404, "NOT_FOUND", "Checkout not found");
    res.json(toCheckoutStatus(saga));
  });

  router.get("/admin/sagas", admin, async (req, res) => {
    const q = parse(AdminListQuery, req.query);
    const { sagas, nextCursor } = await repo.list(db, q);
    res.json({ data: sagas.map(toAdminSaga), page: { limit: q.limit, nextCursor } });
  });

  router.get("/admin/sagas/:sagaId", admin, async (req, res) => {
    const { sagaId } = parse(SagaIdParam, req.params);
    const saga = await repo.get(db, sagaId);
    if (!saga) throw new HttpProblem(404, "NOT_FOUND", "Saga not found");
    res.json({ saga: toAdminSaga(saga), steps: await repo.steps(db, sagaId) });
  });

  router.post("/admin/sagas/:sagaId/retry", admin, async (req, res) => {
    const { sagaId } = parse(SagaIdParam, req.params);
    res.json({ saga: toAdminSaga(await engine.retryNow(sagaId)) });
  });

  router.post("/admin/sagas/:sagaId/resolve", admin, async (req, res) => {
    const { sagaId } = parse(SagaIdParam, req.params);
    const body = parse(ResolveRequest, req.body);
    res.json({ saga: toAdminSaga(await engine.resolve(sagaId, body.resolution, res.locals.principal!.subject)) });
  });

  return router;
}
