import { createHash } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import type { OrderGateway, PaymentGateway } from "../clients/order-client.js";
import { type Pool, transaction } from "../db/pool.js";
import type { Logger } from "../lib/logger.js";
import { HttpProblem } from "../lib/problem.js";
import { decide, type SagaPolicy } from "./decide.js";
import { type SagaRecord, type SagaRepository, TooManyActiveCheckouts } from "./repository.js";
import { type CheckoutRequest, type Input, SYNC_STATES, TERMINAL_STATES } from "./types.js";

export interface InboundEvent {
  messageId: string;
  messageType: string;
  correlationId: string;
  sagaId: string | null;
  payload: Record<string, unknown>;
}

/** How long one instance may hold a synchronous step before another may take over. */
const SYNC_LEASE_MS = 60_000;

/** JSON with keys sorted at every level: equal requests hash equally. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Drives the checkout saga. Every state change goes through `decide` (pure) and is persisted
 * together with its outgoing messages in ONE transaction; publishing happens later from the
 * outbox. Synchronous calls never run inside a transaction.
 */
export class SagaEngine {
  constructor(
    private readonly db: Pool,
    private readonly repo: SagaRepository,
    private readonly orders: OrderGateway,
    private readonly payments: PaymentGateway,
    private readonly policy: SagaPolicy,
    private readonly config: { frontendBaseUrl: string; maxActiveCheckouts?: number },
    private readonly logger: Logger,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  // =================================================================== start

  /**
   * Persists a STARTED saga FIRST (so a crash can never leave an order without a saga), then
   * tries the first step inline so the response usually already carries the order id.
   */
  async startCheckout(customerId: string, idempotencyKey: string, request: CheckoutRequest): Promise<{ saga: SagaRecord; replayed: boolean }> {
    const requestHash = createHash("sha256").update(canonicalJson(request)).digest("hex");
    let saga: SagaRecord;
    let created: boolean;
    try {
      ({ saga, created } = await transaction(this.db, (c) =>
        this.repo.insertStarted(c, { id: uuidv7(), customerId, idempotencyKey, requestHash, request }, this.config.maxActiveCheckouts),
      ));
    } catch (err) {
      if (err instanceof TooManyActiveCheckouts) {
        throw new HttpProblem(429, "TOO_MANY_ACTIVE_CHECKOUTS", "Finish or cancel an open checkout before starting another", undefined, undefined, {
          extra: { active: err.active },
        });
      }
      throw err;
    }
    if (!created) {
      if (saga.requestHash !== requestHash) {
        throw new HttpProblem(422, "IDEMPOTENCY_KEY_REUSED", "This idempotency key was used for a different checkout");
      }
      return { saga, replayed: true };
    }
    await this.runSyncStep(saga.id);
    return { saga: (await this.repo.get(this.db, saga.id))!, replayed: false };
  }

  // =================================================================== events

  /**
   * Applies one event from the saga inbox. Dedupe, lock, decide and persist happen in a single
   * transaction: a redelivered event is a no-op, and two events for one saga are serialized.
   */
  async handleEvent(event: InboundEvent): Promise<void> {
    const sagaId = await transaction(this.db, async (c) => {
      let saga = event.sagaId ? await this.repo.lock(c, event.sagaId) : null;
      if (!saga && typeof event.payload.orderId === "string") saga = await this.repo.lockByOrder(c, event.payload.orderId);
      const fresh = await this.repo.markProcessed(c, event.messageId, event.messageType, saga?.id ?? null);
      if (!fresh) {
        this.logger.debug({ messageId: event.messageId }, "duplicate event ignored");
        return null;
      }
      if (!saga) {
        this.logger.warn({ messageId: event.messageId, messageType: event.messageType, sagaId: event.sagaId }, "event for unknown saga ignored");
        return null;
      }
      const input: Input = { kind: "event", event: { messageId: event.messageId, messageType: event.messageType, payload: event.payload } };
      const decision = decide(saga, input, this.clock(), this.policy);
      await this.repo.apply(c, saga, decision, { correlationId: event.correlationId, causationId: event.messageId });
      if (decision.ignored) this.logger.info({ sagaId: saga.id, state: saga.state, messageType: event.messageType, why: decision.ignored }, "event ignored");
      return SYNC_STATES.includes(decision.state) && !decision.ignored ? saga.id : null;
    });
    // E.g. InventoryReserved -> INVENTORY_RESERVED: create the payment intent right away.
    if (sagaId) await this.runSyncStep(sagaId);
  }

  // =================================================================== synchronous steps

  /**
   * Runs the synchronous call of STARTED (create order) or INVENTORY_RESERVED (create payment
   * intent). A lease ensures one instance at a time; the HTTP call happens OUTSIDE any
   * transaction; the result is applied only if the saga has not moved on meanwhile.
   */
  async runSyncStep(sagaId: string): Promise<void> {
    const saga = await this.repo.lease(this.db, sagaId, SYNC_STATES, SYNC_LEASE_MS);
    if (!saga) return; // another instance is on it, or the saga is no longer in a sync state

    let input: Input;
    try {
      input = saga.state === "STARTED" ? await this.createOrder(saga) : await this.createPaymentIntent(saga);
    } catch (err) {
      this.logger.error({ err, sagaId }, "synchronous step crashed");
      input = { kind: "dependency-failed", detail: (err as Error).message };
    }

    await transaction(this.db, async (c) => {
      const current = await this.repo.lock(c, sagaId);
      if (!current || current.version !== saga.version) return; // moved on (e.g. cancelled meanwhile)
      const decision = decide(current, input, this.clock(), this.policy);
      await this.repo.apply(c, current, decision, { correlationId: saga.id, causationId: null });
    });
  }

  private async createOrder(saga: SagaRecord): Promise<Input> {
    const r = await this.orders.createOrder({ sagaId: saga.id, customerId: saga.customerId, request: saga.request });
    if (r.ok) return { kind: "order-created", ...r.value };
    return r.kind === "rejected" ? { kind: "order-rejected", code: r.code } : { kind: "dependency-failed", detail: r.detail };
  }

  private async createPaymentIntent(saga: SagaRecord): Promise<Input> {
    const r = await this.payments.createIntent({
      sagaId: saga.id,
      orderId: saga.orderId!,
      returnUrl: `${this.config.frontendBaseUrl}/checkout/result?saga=${saga.id}`,
    });
    if (r.ok) return { kind: "payment-intent-created", ...r.value };
    return r.kind === "rejected" ? { kind: "payment-intent-rejected", code: r.code } : { kind: "dependency-failed", detail: r.detail };
  }

  // =================================================================== timers and recovery

  /**
   * Processes overdue sagas: timeouts of waiting states (re-send, compensate, or escalate) and
   * due retries of synchronous steps. Because EVERY non-terminal state has a deadline, this is
   * also crash recovery: whatever an instance was doing when it died becomes due and is resumed.
   */
  async processDue(limit = 20): Promise<number> {
    // The claim is only a cheap filter: its locks end when this short transaction commits, so
    // another instance may claim the same ids right after. processOne re-checks under the row lock.
    const due = await transaction(this.db, (c) => this.repo.claimDue(c, limit));
    let processed = 0;
    for (const id of due) {
      try {
        if (await this.processOne(id)) processed++;
      } catch (err) {
        this.logger.error({ err, sagaId: id }, "processing an overdue saga failed");
      }
    }
    return processed;
  }

  /** Returns false when the saga was no longer due (another instance handled it first). */
  private async processOne(id: string): Promise<boolean> {
    const outcome = await transaction(this.db, async (c) => {
      const saga = await this.repo.lock(c, id);
      // Re-check under the row lock: the deadline may have moved since the claim.
      if (!saga || TERMINAL_STATES.includes(saga.state) || !saga.deadlineAt || saga.deadlineAt > this.clock()) return "skip";
      if (SYNC_STATES.includes(saga.state)) return "sync";
      const decision = decide(saga, { kind: "timeout" }, this.clock(), this.policy);
      await this.repo.apply(c, saga, decision, { correlationId: saga.id, causationId: null });
      return "done";
    });
    if (outcome === "sync") await this.runSyncStep(id);
    return outcome !== "skip";
  }

  // =================================================================== operator

  async resolve(sagaId: string, resolution: string, actor: string): Promise<SagaRecord> {
    await transaction(this.db, async (c) => {
      const saga = await this.repo.lock(c, sagaId);
      if (!saga) throw new HttpProblem(404, "NOT_FOUND", "Saga not found");
      const decision = decide(saga, { kind: "operator-resolved", resolution: `${actor}: ${resolution}` }, this.clock(), this.policy);
      if (decision.ignored) throw new HttpProblem(409, "NOT_IN_MANUAL_REVIEW", "Only sagas in MANUAL_REVIEW can be resolved");
      await this.repo.apply(c, saga, decision, { correlationId: saga.id, causationId: null });
    });
    return (await this.repo.get(this.db, sagaId))!;
  }

  /** Makes the current step due now (operator "retry"); the timer loop picks it up. */
  async retryNow(sagaId: string): Promise<SagaRecord> {
    const r = await this.db.query(
      `UPDATE saga_instances SET deadline_at = now(), lease_until = NULL
        WHERE id = $1 AND state NOT IN ('COMPLETED', 'CANCELLED', 'FAILED', 'RESOLVED', 'MANUAL_REVIEW') RETURNING id`,
      [sagaId],
    );
    if (r.rowCount === 0) throw new HttpProblem(409, "NOT_RETRYABLE", "The saga is finished or awaiting manual review");
    return (await this.repo.get(this.db, sagaId))!;
  }
}
