import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { auth, buildTestContext, checkoutBody, event, expireDeadlines, newId, outbox, resetDatabase, stateOf } from "./helpers.js";

type Ctx = Awaited<ReturnType<typeof buildTestContext>>;
let ctx: Ctx;
const customerId = newId();

beforeEach(async () => {
  await resetDatabase();
  ctx = await buildTestContext();
});

async function start(key = newId(), sub = customerId) {
  const res = await request(ctx.app).post("/api/v1/checkout").set(await auth(["customer"], sub)).set("Idempotency-Key", key).send(checkoutBody);
  expect(res.status).toBe(202);
  return res.body as { sagaId: string; orderId: string | null; status: string; statusUrl: string };
}

/** Drives a saga to AWAITING_PAYMENT and returns its ids. */
async function toAwaitingPayment() {
  const s = await start();
  const reservationId = newId();
  await ctx.engine.handleEvent(event(s.sagaId, "InventoryReserved", { reservationId, orderId: s.orderId }));
  return { ...s, reservationId };
}

const status = async (sagaId: string, sub = customerId) =>
  (await request(ctx.app).get(`/api/v1/checkout/${sagaId}`).set(await auth(["customer"], sub))).body;

describe("happy path", () => {
  it("checkout → reserve → pay → confirm stock → confirm order → COMPLETED", async () => {
    const s = await start();
    expect(s).toMatchObject({ status: "PROCESSING", statusUrl: `/api/v1/checkout/${s.sagaId}` });
    expect(s.orderId).toBe(ctx.orders.created.get(s.sagaId)!.orderId); // order created inline
    expect((await stateOf(s.sagaId)).state).toBe("RESERVING_INVENTORY");

    let msgs = await outbox(s.sagaId);
    expect(msgs.map((m) => [m.kind, m.destination, m.type])).toEqual([
      ["queue", "test-order-commands.fifo", "OrderStatusTransitionRequested"],
      ["queue", "test-inventory-commands", "InventoryReservationRequested"],
    ]);
    expect(msgs[0]!.groupId).toBe(s.orderId); // FIFO group = order
    expect(msgs[1]!.envelope).toMatchObject({ idempotencyKey: `${s.sagaId}:reserve`, payload: { orderId: s.orderId, lines: [{ sku: "TEE-1", quantity: 2 }] } });

    const reservationId = newId();
    await ctx.engine.handleEvent(event(s.sagaId, "InventoryReserved", { reservationId, orderId: s.orderId }));
    // The payment intent was created right away (synchronous step), and the customer can pay.
    const awaiting = await status(s.sagaId);
    expect(awaiting).toMatchObject({ status: "AWAITING_PAYMENT", checkoutUrl: `https://pay.example/checkout/${s.orderId}` });

    await ctx.engine.handleEvent(event(s.sagaId, "PaymentSucceeded", { orderId: s.orderId, paymentId: newId() }));
    await ctx.engine.handleEvent(event(s.sagaId, "InventoryReservationConfirmed", { reservationId, orderId: s.orderId }));
    await ctx.engine.handleEvent(event(s.sagaId, "OrderConfirmed", { orderId: s.orderId }));
    expect(await status(s.sagaId)).toMatchObject({ status: "COMPLETED", orderId: s.orderId, checkoutUrl: null });

    msgs = await outbox(s.sagaId);
    expect(msgs.map((m) => `${m.type}${m.envelope.payload.toStatus ? `:${m.envelope.payload.toStatus}` : ""}`)).toEqual([
      "OrderStatusTransitionRequested:INVENTORY_RESERVING",
      "InventoryReservationRequested",
      "OrderStatusTransitionRequested:INVENTORY_RESERVED",
      "OrderStatusTransitionRequested:PAYMENT_PENDING",
      "OrderStatusTransitionRequested:PAYMENT_SUCCEEDED",
      "InventoryReservationConfirmRequested",
      "OrderStatusTransitionRequested:CONFIRMED",
      "CheckoutCompleted",
    ]);
    expect(msgs.at(-1)!.kind).toBe("topic");

    const detail = await request(ctx.app).get(`/api/v1/admin/sagas/${s.sagaId}`).set(await auth(["admin"]));
    expect(detail.body.steps.map((x: { to: string }) => x.to)).toEqual([
      "STARTED", "RESERVING_INVENTORY", "INVENTORY_RESERVED", "AWAITING_PAYMENT", "CONFIRMING_INVENTORY", "CONFIRMING_ORDER", "COMPLETED",
    ]);
    expect(detail.body.saga).toMatchObject({ state: "COMPLETED", total: { amountMinor: 117_764, currency: "INR" }, reservationId });
  });
});

describe("checkout API", () => {
  it("is idempotent per customer and key; a key reused for a different cart is rejected", async () => {
    const key = newId();
    const a = await start(key);
    const b = await request(ctx.app).post("/api/v1/checkout").set(await auth(["customer"], customerId)).set("Idempotency-Key", key).send(checkoutBody);
    expect(b.status).toBe(202);
    expect(b.headers["idempotency-replayed"]).toBe("true");
    expect(b.body.sagaId).toBe(a.sagaId);
    expect(ctx.orders.calls).toBe(1);

    const other = await request(ctx.app).post("/api/v1/checkout").set(await auth(["customer"], customerId)).set("Idempotency-Key", key)
      .send({ ...checkoutBody, items: [{ sku: "TEE-1", quantity: 3 }] });
    expect(other.status).toBe(422);
    // The same key from ANOTHER customer is a different checkout.
    expect((await start(key, newId())).sagaId).not.toBe(a.sagaId);
  });

  it("only the owner (or an admin) can see a checkout; prices are never accepted", async () => {
    const s = await start();
    expect((await request(ctx.app).get(`/api/v1/checkout/${s.sagaId}`).set(await auth(["customer"]))).status).toBe(404);
    expect((await request(ctx.app).get(`/api/v1/checkout/${s.sagaId}`).set(await auth(["admin"]))).status).toBe(200);
    const priced = await request(ctx.app).post("/api/v1/checkout").set(await auth(["customer"])).set("Idempotency-Key", newId())
      .send({ ...checkoutBody, items: [{ sku: "TEE-1", quantity: 1, unitPrice: 1 }] });
    expect(priced.status).toBe(400);
    expect((await request(ctx.app).post("/api/v1/checkout").send(checkoutBody)).status).toBe(401);
  });
});

describe("failure paths", () => {
  it("order rejected (e.g. product unavailable) → FAILED, nothing to compensate", async () => {
    ctx.orders.mode = "reject";
    const s = await start();
    expect(await status(s.sagaId)).toMatchObject({ status: "FAILED", failureReason: "PRODUCT_UNAVAILABLE", orderId: null });
    expect((await outbox(s.sagaId)).map((m) => m.type)).toEqual(["CheckoutFailed"]);
  });

  it("out of stock → order cancelled → CANCELLED", async () => {
    const s = await start();
    await ctx.engine.handleEvent(event(s.sagaId, "InventoryReservationFailed", { orderId: s.orderId, reason: "INSUFFICIENT_STOCK" }));
    expect((await stateOf(s.sagaId)).state).toBe("CANCELLING");
    await ctx.engine.handleEvent(event(s.sagaId, "OrderCancelled", { orderId: s.orderId }));
    expect(await status(s.sagaId)).toMatchObject({ status: "CANCELLED", failureReason: "INSUFFICIENT_STOCK" });
    expect((await outbox(s.sagaId)).map((m) => m.type).slice(-2)).toEqual(["OrderStatusTransitionRequested", "CheckoutFailed"]);
  });

  it("payment failed → stock released and order cancelled; CANCELLED only after BOTH are confirmed", async () => {
    const s = await toAwaitingPayment();
    await ctx.engine.handleEvent(event(s.sagaId, "PaymentFailed", { orderId: s.orderId }));
    const comp = (await outbox(s.sagaId)).slice(-2);
    expect(comp.map((m) => m.type)).toEqual(["InventoryReservationReleaseRequested", "OrderStatusTransitionRequested"]);
    expect(comp[0]!.envelope.payload).toMatchObject({ reservationId: s.reservationId, reason: "PAYMENT_FAILED" });

    await ctx.engine.handleEvent(event(s.sagaId, "InventoryReservationReleased", { orderId: s.orderId }));
    expect((await stateOf(s.sagaId)).state).toBe("CANCELLING");
    await ctx.engine.handleEvent(event(s.sagaId, "OrderCancelled", { orderId: s.orderId }));
    expect((await stateOf(s.sagaId)).state).toBe("CANCELLED");
  });

  it("payment never arrives → timeout → compensation", async () => {
    const s = await toAwaitingPayment();
    await expireDeadlines();
    expect(await ctx.engine.processDue()).toBe(1);
    const st = await stateOf(s.sagaId);
    expect(st).toMatchObject({ state: "CANCELLING", failure_reason: "PAYMENT_TIMEOUT" });
    expect(st.compensation.awaiting).toEqual(["InventoryReservationReleased", "OrderCancelled"]);
  });

  it("lost reservation answer → the SAME command is re-sent, then the saga gives up and releases by order", async () => {
    const s = await start();
    for (let i = 0; i < 2; i++) {
      await expireDeadlines();
      await ctx.engine.processDue();
    }
    const resends = (await outbox(s.sagaId)).filter((m) => m.type === "InventoryReservationRequested");
    expect(resends).toHaveLength(3);
    expect(new Set(resends.map((m) => m.envelope.idempotencyKey))).toEqual(new Set([`${s.sagaId}:reserve`]));

    await expireDeadlines();
    await ctx.engine.processDue();
    expect((await stateOf(s.sagaId)).state).toBe("CANCELLING");
    const release = (await outbox(s.sagaId)).find((m) => m.type === "InventoryReservationReleaseRequested")!;
    expect(release.envelope.payload).toMatchObject({ reservationId: null, reason: "RESERVATION_TIMEOUT" });
  });

  it("a payment arriving after cancellation is refunded", async () => {
    const s = await toAwaitingPayment();
    await ctx.engine.handleEvent(event(s.sagaId, "PaymentFailed", { orderId: s.orderId }));
    await ctx.engine.handleEvent(event(s.sagaId, "InventoryReservationReleased", {}));
    await ctx.engine.handleEvent(event(s.sagaId, "OrderCancelled", {}));
    await ctx.engine.handleEvent(event(s.sagaId, "PaymentSucceeded", { orderId: s.orderId, paymentId: newId() }));
    expect((await stateOf(s.sagaId)).state).toBe("REFUNDING");
    const refund = (await outbox(s.sagaId)).at(-1)!;
    expect(refund).toMatchObject({ destination: "test-payment-commands", type: "RefundRequested" });
    expect(refund.envelope.payload).toMatchObject({ amount: { amountMinor: 117_764, currency: "INR" }, reason: "LATE_PAYMENT_AFTER_CANCELLATION" });
    await ctx.engine.handleEvent(event(s.sagaId, "RefundSucceeded", {}));
    expect((await stateOf(s.sagaId)).state).toBe("CANCELLED");
  });

  it("refund failure → MANUAL_REVIEW; an operator resolves it", async () => {
    const s = await toAwaitingPayment();
    await ctx.engine.handleEvent(event(s.sagaId, "PaymentSucceeded", { orderId: s.orderId }));
    await ctx.engine.handleEvent(event(s.sagaId, "InventoryReservationFailed", { orderId: s.orderId, reason: "RESERVATION_EXPIRED" }));
    expect((await stateOf(s.sagaId)).state).toBe("REFUNDING");
    await ctx.engine.handleEvent(event(s.sagaId, "RefundFailed", {}));
    expect(await status(s.sagaId)).toMatchObject({ status: "UNDER_REVIEW" });
    expect((await outbox(s.sagaId)).at(-1)!.type).toBe("SagaManualReviewRequired");

    const admin = await auth(["admin"]);
    const list = await request(ctx.app).get("/api/v1/admin/sagas?state=MANUAL_REVIEW").set(admin);
    expect(list.body.data.map((x: { id: string }) => x.id)).toEqual([s.sagaId]);
    const resolved = await request(ctx.app).post(`/api/v1/admin/sagas/${s.sagaId}/resolve`).set(admin).send({ resolution: "refunded by bank transfer" });
    expect(resolved.body.saga.state).toBe("RESOLVED");
    expect((await request(ctx.app).post(`/api/v1/admin/sagas/${s.sagaId}/resolve`).set(admin).send({ resolution: "again" })).status).toBe(409);
    expect((await request(ctx.app).get("/api/v1/admin/sagas").set(await auth(["customer"]))).status).toBe(403);
  });
});

describe("at-least-once delivery and concurrency", () => {
  it("a redelivered event (same messageId) is dropped before it reaches the state machine", async () => {
    const s = await start();
    const e = event(s.sagaId, "InventoryReserved", { reservationId: newId(), orderId: s.orderId });
    await ctx.engine.handleEvent(e);
    const outboxBefore = (await outbox(s.sagaId)).length;
    const stepsBefore = (await ctx.repo.steps(ctx.db, s.sagaId)).length;
    await ctx.engine.handleEvent(e);
    expect((await outbox(s.sagaId)).length).toBe(outboxBefore);
    expect(ctx.payments.calls).toBe(1);
    // Deduplicated by messageId: not even an "ignored" history entry (the state machine never sees it).
    expect((await ctx.repo.steps(ctx.db, s.sagaId)).length).toBe(stepsBefore);
    const processed = await ctx.db.query(`SELECT count(*)::int AS n FROM processed_messages WHERE message_id = $1`, [e.messageId]);
    expect(processed.rows[0].n).toBe(1);
  });

  it("customer cancels WHILE the payment intent is being created: the late intent result is discarded", async () => {
    const s = await start();
    ctx.payments.during = async () => {
      ctx.payments.during = undefined;
      await ctx.engine.handleEvent(event(s.sagaId, "OrderCancelled", { orderId: s.orderId }));
    };
    await ctx.engine.handleEvent(event(s.sagaId, "InventoryReserved", { reservationId: newId(), orderId: s.orderId }));
    expect((await stateOf(s.sagaId)).state).toBe("CANCELLING");
    const types = (await outbox(s.sagaId)).map((m) => `${m.type}:${m.envelope.payload.toStatus ?? ""}`);
    expect(types).not.toContain("OrderStatusTransitionRequested:PAYMENT_PENDING");
    expect(types.at(-1)).toBe("InventoryReservationReleaseRequested:");
  });

  it("a duplicate answer with a NEW messageId (re-emitted by the service) is ignored by state", async () => {
    const s = await toAwaitingPayment();
    await ctx.engine.handleEvent(event(s.sagaId, "InventoryReserved", { reservationId: s.reservationId, orderId: s.orderId }));
    expect((await stateOf(s.sagaId)).state).toBe("AWAITING_PAYMENT");
    const steps = await ctx.repo.steps(ctx.db, s.sagaId);
    expect(steps.at(-1)).toMatchObject({ trigger: "event:InventoryReserved", detail: { ignored: expect.any(String) } });
  });

  it("events without a sagaId are matched by order id", async () => {
    const s = await toAwaitingPayment();
    await ctx.engine.handleEvent(event(null, "PaymentSucceeded", { orderId: s.orderId }));
    expect((await stateOf(s.sagaId)).state).toBe("CONFIRMING_INVENTORY");
  });

  it("concurrent conflicting events for one saga are serialized: one wins, state stays consistent", async () => {
    const s = await toAwaitingPayment();
    await Promise.all([
      ctx.engine.handleEvent(event(s.sagaId, "PaymentSucceeded", { orderId: s.orderId })),
      ctx.engine.handleEvent(event(s.sagaId, "PaymentFailed", { orderId: s.orderId })),
    ]);
    const st = (await stateOf(s.sagaId)).state;
    expect(["CONFIRMING_INVENTORY", "CANCELLING"]).toContain(st);
    const steps = await ctx.repo.steps(ctx.db, s.sagaId);
    expect(steps.filter((x: { detail: unknown }) => !x.detail).map((x: { to: string }) => x.to).slice(-1)).toEqual([st]);
  });
});

describe("crash recovery", () => {
  it("Order Service down: STARTED retries with backoff and continues once it is back", async () => {
    ctx.orders.mode = "down";
    const s = await start();
    expect(await stateOf(s.sagaId)).toMatchObject({ state: "STARTED", step_attempts: 1 });
    ctx.orders.mode = "ok";
    await expireDeadlines();
    await ctx.engine.processDue();
    expect((await stateOf(s.sagaId)).state).toBe("RESERVING_INVENTORY");
  });

  it("…and gives up after max attempts with FAILED", async () => {
    ctx.orders.mode = "down";
    const s = await start();
    for (let i = 0; i < 3; i++) {
      await expireDeadlines();
      await ctx.engine.processDue();
    }
    expect(await stateOf(s.sagaId)).toMatchObject({ state: "FAILED", failure_reason: "ORDER_SERVICE_UNAVAILABLE" });
  });

  it("instance died after creating the order but before recording it: a NEW instance resumes with the SAME order", async () => {
    const s = await start();
    const orderId = s.orderId;
    // Simulate the crash: roll the saga back to STARTED as if the result was never recorded.
    await ctx.db.query(`UPDATE saga_instances SET state = 'STARTED', order_id = NULL, deadline_at = now() - interval '1 s' WHERE id = $1`, [s.sagaId]);
    await ctx.db.query(`DELETE FROM outbox WHERE saga_id = $1`, [s.sagaId]);

    const restarted = await buildTestContext(); // a fresh process
    restarted.orders.created.set(s.sagaId, ctx.orders.created.get(s.sagaId)!); // the Order Service remembers (idempotency key)
    await restarted.engine.processDue();
    const st = await ctx.repo.get(ctx.db, s.sagaId);
    expect(st).toMatchObject({ state: "RESERVING_INVENTORY", orderId });
  });

  it("instance died while holding the payment-intent lease: after the lease expires the step is resumed", async () => {
    const s = await start();
    await ctx.engine.handleEvent(event(s.sagaId, "InventoryReserved", { reservationId: newId(), orderId: s.orderId }));
    await ctx.db.query(`UPDATE saga_instances SET state = 'INVENTORY_RESERVED', checkout_url = NULL, lease_until = now() + interval '1 hour', deadline_at = now() - interval '1 s' WHERE id = $1`, [s.sagaId]);
    expect(await ctx.engine.processDue()).toBe(0); // leased by the "dead" instance: not touched yet
    await ctx.db.query(`UPDATE saga_instances SET lease_until = now() - interval '1 s' WHERE id = $1`, [s.sagaId]);
    await ctx.engine.processDue();
    expect((await stateOf(s.sagaId)).state).toBe("AWAITING_PAYMENT");
  });

  it("two instances processing the same overdue sagas never double-apply a timeout", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await toAwaitingPayment()).sagaId);
    await expireDeadlines();
    const other = await buildTestContext();
    const [a, b] = await Promise.all([ctx.engine.processDue(), other.engine.processDue()]);
    expect(a + b).toBe(5);
    for (const id of ids) expect((await outbox(id)).filter((m) => m.type === "InventoryReservationReleaseRequested")).toHaveLength(1);
  });

  it("operator retry makes the current step due now", async () => {
    const s = await toAwaitingPayment();
    const res = await request(ctx.app).post(`/api/v1/admin/sagas/${s.sagaId}/retry`).set(await auth(["admin"]));
    expect(res.status).toBe(200);
    expect(await ctx.engine.processDue()).toBe(1);
  });
});

describe("saga events match this service's published schemas", () => {
  it("CheckoutCompleted / CheckoutFailed / SagaManualReviewRequired validate", async () => {
    const schemasDir = join(import.meta.dirname, "..", "events", "schemas");
    const ajv = new Ajv2020({ strict: true, strictTypes: false, allErrors: true });
    addFormats.default(ajv);
    ajv.addVocabulary(["x-producer", "x-consumers", "x-channel", "x-message-kind"]);
    for (const f of readdirSync(schemasDir)) ajv.addSchema(JSON.parse(readFileSync(join(schemasDir, f), "utf8")));

    const ok = await toAwaitingPayment();
    await ctx.engine.handleEvent(event(ok.sagaId, "PaymentSucceeded", {}));
    await ctx.engine.handleEvent(event(ok.sagaId, "InventoryReservationConfirmed", {}));
    await ctx.engine.handleEvent(event(ok.sagaId, "OrderConfirmed", {}));
    ctx.orders.mode = "reject";
    await start();
    ctx.orders.mode = "ok";
    const review = await toAwaitingPayment();
    await ctx.engine.handleEvent(event(review.sagaId, "PaymentSucceeded", {}));
    await ctx.engine.handleEvent(event(review.sagaId, "InventoryReservationFailed", { reason: "RESERVATION_EXPIRED" }));
    await ctx.engine.handleEvent(event(review.sagaId, "RefundFailed", {}));

    const events = (await outbox()).filter((m) => m.kind === "topic");
    expect(events.map((e) => e.type).sort()).toEqual(["CheckoutCompleted", "CheckoutFailed", "SagaManualReviewRequired"]);
    for (const e of events) {
      const id = `https://schemas.ecommerce.local/saga-orchestrator/${e.type.replace(/(?<!^)([A-Z])/g, "-$1").toLowerCase()}.v1.schema.json`;
      const validate = ajv.getSchema(id)!;
      validate(e.envelope);
      expect({ type: e.type, errors: validate.errors ?? [] }).toEqual({ type: e.type, errors: [] });
    }
  });
});

describe("commands the saga sends match their receivers' published schemas", () => {
  it("every command type, from real flows, validates against the vendored (receiver-owned) schema", async () => {
    const schemasDir = join(import.meta.dirname, "..", "events", "schemas");
    const ajv = new Ajv2020({ strict: true, strictTypes: false, allErrors: true });
    addFormats.default(ajv);
    ajv.addVocabulary(["x-producer", "x-consumers", "x-channel", "x-message-kind"]);
    const byType = new Map<string, string>();
    for (const f of readdirSync(schemasDir)) {
      const schema = JSON.parse(readFileSync(join(schemasDir, f), "utf8"));
      ajv.addSchema(schema);
      if (schema["x-message-kind"] === "command") byType.set(schema.properties.messageType.const, schema.$id);
    }

    // Happy path: reserve → order transitions → confirm.
    const ok = await toAwaitingPayment();
    await ctx.engine.handleEvent(event(ok.sagaId, "PaymentSucceeded", {}));
    await ctx.engine.handleEvent(event(ok.sagaId, "InventoryReservationConfirmed", {}));
    // Declined payment: release the stock, cancel the order.
    const declined = await toAwaitingPayment();
    await ctx.engine.handleEvent(event(declined.sagaId, "PaymentFailed", { failureCode: "DECLINED" }));
    // Paid, then the reservation is lost: refund.
    const lost = await toAwaitingPayment();
    await ctx.engine.handleEvent(event(lost.sagaId, "PaymentSucceeded", {}));
    await ctx.engine.handleEvent(event(lost.sagaId, "InventoryReservationFailed", { reason: "RESERVATION_EXPIRED" }));

    const commands = (await outbox()).filter((m) => m.kind !== "topic");
    expect(new Set(commands.map((c) => c.type))).toEqual(new Set(["InventoryReservationRequested", "OrderStatusTransitionRequested", "InventoryReservationConfirmRequested", "InventoryReservationReleaseRequested", "RefundRequested"]));
    for (const c of commands) {
      const id = byType.get(c.type);
      expect(id, `no published schema for ${c.type}`).toBeDefined();
      const validate = ajv.getSchema(id!)!;
      validate(c.envelope);
      expect({ type: c.type, errors: validate.errors ?? [] }).toEqual({ type: c.type, errors: [] });
    }
  });
});
