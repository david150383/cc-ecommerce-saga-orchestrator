import { v7 as uuidv7 } from "uuid";
import type { Client, Pool } from "../db/pool.js";
import { SERVICE_NAME } from "../lib/logger.js";
import type { CheckoutRequest, CommandTarget, Compensation, Decision, Saga, SagaState } from "./types.js";

interface Row {
  id: string;
  customer_id: string;
  state: SagaState;
  request: CheckoutRequest;
  order_id: string | null;
  total_minor: bigint | null;
  currency: string | null;
  reservation_id: string | null;
  payment_id: string | null;
  checkout_url: string | null;
  failure_reason: string | null;
  compensation: Compensation;
  step_attempts: number;
  version: number;
  request_hash: string;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
  deadline_at: Date | null;
}

export interface SagaRecord extends Saga {
  requestHash: string;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  deadlineAt: Date | null;
}

const toSaga = (r: Row): SagaRecord => ({
  id: r.id,
  customerId: r.customer_id,
  state: r.state,
  request: r.request,
  orderId: r.order_id,
  totalMinor: r.total_minor,
  currency: r.currency,
  reservationId: r.reservation_id,
  paymentId: r.payment_id,
  checkoutUrl: r.checkout_url,
  failureReason: r.failure_reason,
  compensation: r.compensation,
  stepAttempts: r.step_attempts,
  version: r.version,
  requestHash: r.request_hash,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  completedAt: r.completed_at,
  deadlineAt: r.deadline_at,
});

export interface Destinations {
  queues: Record<CommandTarget, string>;
  eventsTopicArn: string;
}

const TERMINAL: SagaState[] = ["COMPLETED", "CANCELLED", "FAILED", "RESOLVED"];

export class SagaRepository {
  constructor(private readonly destinations: Destinations) {}

  /** Inserts a new STARTED saga, or returns the existing one for (customer, idempotency key). */
  async insertStarted(
    db: Client,
    s: { id: string; customerId: string; idempotencyKey: string; requestHash: string; request: CheckoutRequest },
  ): Promise<{ saga: SagaRecord; created: boolean }> {
    const inserted = await db.query<Row>(
      `INSERT INTO saga_instances (id, customer_id, idempotency_key, request_hash, request, state, deadline_at)
       VALUES ($1, $2, $3, $4, $5, 'STARTED', now())
       ON CONFLICT ON CONSTRAINT uq_saga_customer_idempotency_key DO NOTHING
       RETURNING *`,
      [s.id, s.customerId, s.idempotencyKey, s.requestHash, JSON.stringify(s.request)],
    );
    if (inserted.rows[0]) {
      await this.step(db, s.id, null, "STARTED", "http:checkout", null, null);
      return { saga: toSaga(inserted.rows[0]), created: true };
    }
    const existing = await db.query<Row>(`SELECT * FROM saga_instances WHERE customer_id = $1 AND idempotency_key = $2`, [
      s.customerId,
      s.idempotencyKey,
    ]);
    return { saga: toSaga(existing.rows[0]!), created: false };
  }

  async get(db: Pool | Client, id: string): Promise<SagaRecord | null> {
    const r = await db.query<Row>(`SELECT * FROM saga_instances WHERE id = $1`, [id]);
    return r.rows[0] ? toSaga(r.rows[0]) : null;
  }

  /** Row lock: every change to one saga is serialized. */
  async lock(db: Client, id: string): Promise<SagaRecord | null> {
    const r = await db.query<Row>(`SELECT * FROM saga_instances WHERE id = $1 FOR UPDATE`, [id]);
    return r.rows[0] ? toSaga(r.rows[0]) : null;
  }

  /** Events that carry no sagaId (or an unknown one) are matched by order id. */
  async lockByOrder(db: Client, orderId: string): Promise<SagaRecord | null> {
    const r = await db.query<Row>(`SELECT * FROM saga_instances WHERE order_id = $1 FOR UPDATE`, [orderId]);
    return r.rows[0] ? toSaga(r.rows[0]) : null;
  }

  /** Records an incoming message; false when it was already processed (duplicate delivery). */
  async markProcessed(db: Client, messageId: string, messageType: string, sagaId: string | null): Promise<boolean> {
    const r = await db.query(
      `INSERT INTO processed_messages (message_id, saga_id, message_type) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [messageId, sagaId, messageType],
    );
    return r.rowCount === 1;
  }

  /**
   * Persists a decision in the CALLER's transaction: new state, history row, and outbox rows for
   * every command and event. Nothing is sent here; the relay publishes only committed rows.
   */
  async apply(db: Client, saga: Saga, d: Decision, meta: { correlationId: string; causationId: string | null }): Promise<void> {
    if (d.ignored) {
      await this.step(db, saga.id, saga.state, saga.state, d.trigger, meta.causationId, { ignored: d.ignored });
      return;
    }
    const p = d.patch;
    await db.query(
      `UPDATE saga_instances SET
         state = $2,
         order_id = COALESCE($3, order_id),
         total_minor = COALESCE($4, total_minor),
         currency = COALESCE($5, currency),
         reservation_id = COALESCE($6, reservation_id),
         payment_id = COALESCE($7, payment_id),
         checkout_url = COALESCE($8, checkout_url),
         failure_reason = COALESCE($9, failure_reason),
         compensation = COALESCE($10, compensation),
         step_attempts = $11,
         deadline_at = $12,
         lease_until = NULL,
         version = version + 1,
         updated_at = now(),
         completed_at = CASE WHEN $13 THEN now() ELSE NULL END
       WHERE id = $1`,
      [
        saga.id,
        d.state,
        p.orderId ?? null,
        p.totalMinor ?? null,
        p.currency ?? null,
        p.reservationId ?? null,
        p.paymentId ?? null,
        p.checkoutUrl ?? null,
        p.failureReason ?? null,
        p.compensation ? JSON.stringify(p.compensation) : null,
        d.stepAttempts,
        d.deadline,
        TERMINAL.includes(d.state),
      ],
    );
    await this.step(db, saga.id, saga.state, d.state, d.trigger, meta.causationId, null);

    const orderId = p.orderId ?? saga.orderId;
    for (const c of d.commands) {
      const envelope = this.envelope("command", c.messageType, c.payload, saga.id, meta, c.idempotencyKey);
      await this.outbox(db, saga.id, "queue", this.destinations.queues[c.target], c.target === "order" ? orderId : null, envelope);
    }
    for (const e of d.events) {
      const envelope = this.envelope("event", e.messageType, e.payload, saga.id, meta, null);
      await this.outbox(db, saga.id, "topic", this.destinations.eventsTopicArn, null, envelope);
    }
  }

  /** Overdue sagas (timeouts, sync retries, crash recovery), claimed so instances do not collide. */
  async claimDue(db: Client, limit: number): Promise<string[]> {
    const r = await db.query<{ id: string }>(
      `SELECT id FROM saga_instances
        WHERE deadline_at <= now() AND (lease_until IS NULL OR lease_until < now())
        ORDER BY deadline_at
        LIMIT $1
          FOR UPDATE SKIP LOCKED`,
      [limit],
    );
    return r.rows.map((x) => x.id);
  }

  /** Lease for a synchronous step, so only one instance calls the dependency. */
  async lease(db: Pool, id: string, states: readonly SagaState[], ms: number): Promise<SagaRecord | null> {
    const r = await db.query<Row>(
      `UPDATE saga_instances SET lease_until = now() + make_interval(secs => $3::double precision / 1000)
        WHERE id = $1 AND state = ANY($2::saga_state[]) AND (lease_until IS NULL OR lease_until < now())
        RETURNING *`,
      [id, states, ms],
    );
    return r.rows[0] ? toSaga(r.rows[0]) : null;
  }

  async releaseLease(db: Pool, id: string): Promise<void> {
    await db.query(`UPDATE saga_instances SET lease_until = NULL WHERE id = $1`, [id]);
  }

  async steps(db: Pool, id: string) {
    const r = await db.query(
      `SELECT from_state AS "from", to_state AS "to", trigger, message_id AS "messageId", detail, at FROM saga_steps WHERE saga_id = $1 ORDER BY id`,
      [id],
    );
    return r.rows;
  }

  async list(db: Pool, filter: { state?: SagaState | undefined; limit: number; cursor?: string | undefined }) {
    const r = await db.query<Row>(
      `SELECT * FROM saga_instances
        WHERE ($1::saga_state IS NULL OR state = $1) AND ($2::uuid IS NULL OR id < $2)
        ORDER BY id DESC LIMIT $3`,
      [filter.state ?? null, filter.cursor ?? null, filter.limit + 1],
    );
    const rows = r.rows.map(toSaga);
    const more = rows.length > filter.limit;
    const page = more ? rows.slice(0, filter.limit) : rows;
    return { sagas: page, nextCursor: more ? page[page.length - 1]!.id : null };
  }

  private async step(db: Client, sagaId: string, from: SagaState | null, to: SagaState, trigger: string, messageId: string | null, detail: object | null) {
    await db.query(`INSERT INTO saga_steps (saga_id, from_state, to_state, trigger, message_id, detail) VALUES ($1, $2, $3, $4, $5, $6)`, [
      sagaId,
      from,
      to,
      trigger.slice(0, 80),
      messageId,
      detail ? JSON.stringify(detail) : null,
    ]);
  }

  private async outbox(db: Client, sagaId: string, kind: "queue" | "topic", destination: string, groupId: string | null, envelope: Envelope) {
    await db.query(
      `INSERT INTO outbox (id, saga_id, destination_kind, destination, group_id, message_type, envelope) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [envelope.messageId, sagaId, kind, destination, groupId, envelope.messageType, JSON.stringify(envelope)],
    );
  }

  private envelope(
    kind: "command" | "event",
    messageType: string,
    payload: Record<string, unknown>,
    sagaId: string,
    meta: { correlationId: string; causationId: string | null },
    idempotencyKey: string | null,
  ): Envelope {
    return {
      messageId: uuidv7(),
      messageKind: kind,
      messageType,
      messageVersion: 1,
      producer: SERVICE_NAME,
      occurredAt: new Date().toISOString(),
      correlationId: meta.correlationId,
      causationId: meta.causationId,
      sagaId,
      idempotencyKey,
      payload,
    };
  }
}

export interface Envelope {
  messageId: string;
  messageKind: "command" | "event";
  messageType: string;
  messageVersion: number;
  producer: string;
  occurredAt: string;
  correlationId: string;
  causationId: string | null;
  sagaId: string;
  idempotencyKey: string | null;
  payload: Record<string, unknown>;
}
