import { Router } from "express";

// Liveness: "is the process alive?" A failure means the orchestrator restarts the container.
// Readiness: "can it serve traffic right now?" A failure means it is taken out of the
// load balancer without a restart (e.g. database unreachable, or shutting down).
export interface ReadinessCheck {
  name: string;
  check: () => Promise<void>;
}

const CHECK_TIMEOUT_MS = 2_000;

function withTimeout(promise: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

export function healthRouter(checks: ReadinessCheck[]): Router {
  const router = Router();

  router.get("/health/live", (_req, res) => {
    res.json({ status: "ok" });
  });

  router.get("/health/ready", async (_req, res) => {
    const results = await Promise.allSettled(checks.map((c) => withTimeout(c.check(), CHECK_TIMEOUT_MS)));
    const report: Record<string, "ok" | "failed"> = {};
    checks.forEach((c, i) => {
      report[c.name] = results[i]?.status === "fulfilled" ? "ok" : "failed";
    });
    const ready = Object.values(report).every((s) => s === "ok");
    res.status(ready ? 200 : 503).json({ status: ready ? "ready" : "not_ready", checks: report });
  });

  return router;
}
