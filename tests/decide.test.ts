import { describe, expect, it } from "vitest";
import { decide, type SagaPolicy } from "../src/saga/decide.js";
import type { Input, Saga, SagaState } from "../src/saga/types.js";

const policy: SagaPolicy = { reservationTimeoutMs: 30_000, paymentTimeoutMs: 1_800_000, stepTimeoutMs: 30_000, maxStepAttempts: 3 };
const now = new Date("2026-10-14T10:00:00.000Z");
const plus = (ms: number) => new Date(now.getTime() + ms);

function saga(state: SagaState, over: Partial<Saga> = {}): Saga {
  return {
    id: "saga-1",
    customerId: "cust-1",
    state,
    request: { items: [{ sku: "TEE-1", quantity: 2 }], currency: "INR", shippingAddress: {} },
    orderId: state === "STARTED" ? null : "order-1",
    totalMinor: state === "STARTED" ? null : 117_764n,
    currency: state === "STARTED" ? null : "INR",
    reservationId: ["STARTED", "RESERVING_INVENTORY"].includes(state) ? null : "res-1",
    paymentId: ["AWAITING_PAYMENT", "CONFIRMING_INVENTORY", "CONFIRMING_ORDER"].includes(state) ? "pay-1" : null,
    checkoutUrl: null,
    failureReason: null,
    compensation: { awaiting: [] },
    stepAttempts: 0,
    version: 1,
    ...over,
  };
}
const ev = (messageType: string, payload: Record<string, unknown> = {}): Input => ({ kind: "event", event: { messageId: "m-1", messageType, payload } });
const run = (s: Saga, input: Input) => decide(s, input, now, policy);
const cmds = (d: ReturnType<typeof run>) => d.commands.map((c) => `${c.target}:${c.messageType}${c.payload.toStatus ? `:${c.payload.toStatus}` : ""}`);

describe("happy path", () => {
  it("STARTED + order created → RESERVING_INVENTORY: order moves on and stock is requested", () => {
    const d = run(saga("STARTED"), { kind: "order-created", orderId: "order-1", totalMinor: 117_764n, currency: "INR" });
    expect(d.state).toBe("RESERVING_INVENTORY");
    expect(d.patch).toMatchObject({ orderId: "order-1", totalMinor: 117_764n });
    expect(cmds(d)).toEqual(["order:OrderStatusTransitionRequested:INVENTORY_RESERVING", "inventory:InventoryReservationRequested"]);
    expect(d.commands[1]).toMatchObject({ idempotencyKey: "saga-1:reserve", payload: { orderId: "order-1", lines: [{ sku: "TEE-1", quantity: 2 }] } });
    expect(d.deadline).toEqual(plus(30_000));
  });

  it("InventoryReserved → INVENTORY_RESERVED, due immediately (payment intent is the next sync step)", () => {
    const d = run(saga("RESERVING_INVENTORY"), ev("InventoryReserved", { reservationId: "res-9" }));
    expect(d.state).toBe("INVENTORY_RESERVED");
    expect(d.patch.reservationId).toBe("res-9");
    expect(d.deadline).toEqual(now);
  });

  it("payment intent created → AWAITING_PAYMENT with the payment timeout", () => {
    const d = run(saga("INVENTORY_RESERVED"), { kind: "payment-intent-created", paymentId: "pay-1", checkoutUrl: "https://pay/x" });
    expect(d.state).toBe("AWAITING_PAYMENT");
    expect(d.patch).toMatchObject({ paymentId: "pay-1", checkoutUrl: "https://pay/x" });
    expect(d.deadline).toEqual(plus(1_800_000));
  });

  it("PaymentSucceeded → CONFIRMING_INVENTORY → CONFIRMING_ORDER → COMPLETED", () => {
    const a = run(saga("AWAITING_PAYMENT"), ev("PaymentSucceeded"));
    expect(a.state).toBe("CONFIRMING_INVENTORY");
    expect(cmds(a)).toEqual(["order:OrderStatusTransitionRequested:PAYMENT_SUCCEEDED", "inventory:InventoryReservationConfirmRequested"]);
    const b = run(saga("CONFIRMING_INVENTORY"), ev("InventoryReservationConfirmed"));
    expect(b.state).toBe("CONFIRMING_ORDER");
    expect(cmds(b)).toEqual(["order:OrderStatusTransitionRequested:CONFIRMED"]);
    const c = run(saga("CONFIRMING_ORDER"), ev("OrderConfirmed"));
    expect(c.state).toBe("COMPLETED");
    expect(c.events).toEqual([{ messageType: "CheckoutCompleted", payload: { orderId: "order-1", customerId: "cust-1" } }]);
    expect(c.deadline).toBeNull();
  });
});

describe("failures and compensation", () => {
  it("order rejected → FAILED with CheckoutFailed; nothing to compensate", () => {
    const d = run(saga("STARTED"), { kind: "order-rejected", code: "PRODUCT_UNAVAILABLE" });
    expect(d).toMatchObject({ state: "FAILED", patch: { failureReason: "PRODUCT_UNAVAILABLE" }, commands: [] });
    expect(d.events[0]).toMatchObject({ messageType: "CheckoutFailed", payload: { finalState: "FAILED", reason: "PRODUCT_UNAVAILABLE", orderId: null } });
  });

  it("out of stock → CANCELLING: only the order is cancelled (nothing was reserved)", () => {
    const d = run(saga("RESERVING_INVENTORY"), ev("InventoryReservationFailed", { reason: "INSUFFICIENT_STOCK" }));
    expect(d.state).toBe("CANCELLING");
    expect(cmds(d)).toEqual(["order:OrderStatusTransitionRequested:CANCELLED"]);
    expect(d.commands[0]!.payload.reason).toBe("OUT_OF_STOCK");
    expect(d.patch.compensation!.awaiting).toEqual(["OrderCancelled"]);
  });

  it("payment failed → release stock AND cancel the order, then CANCELLED once both are confirmed", () => {
    const d = run(saga("AWAITING_PAYMENT"), ev("PaymentFailed"));
    expect(cmds(d)).toEqual(["inventory:InventoryReservationReleaseRequested", "order:OrderStatusTransitionRequested:CANCELLED"]);
    expect(d.commands[0]!.payload).toMatchObject({ reservationId: "res-1", reason: "PAYMENT_FAILED" });

    const cancelling = saga("CANCELLING", { failureReason: "PAYMENT_FAILED", compensation: d.patch.compensation! });
    const one = run(cancelling, ev("OrderCancelled"));
    expect(one.state).toBe("CANCELLING");
    expect(one.patch.compensation!.awaiting).toEqual(["InventoryReservationReleased"]);
    const done = run({ ...cancelling, compensation: one.patch.compensation! }, ev("InventoryReservationReleased"));
    expect(done.state).toBe("CANCELLED");
    expect(done.events[0]).toMatchObject({ messageType: "CheckoutFailed", payload: { finalState: "CANCELLED", reason: "PAYMENT_FAILED" } });
  });

  it("payment timeout → compensation with PAYMENT_TIMEOUT reasons", () => {
    const d = run(saga("AWAITING_PAYMENT"), { kind: "timeout" });
    expect(d.state).toBe("CANCELLING");
    expect(d.commands.map((c) => c.payload.reason)).toEqual(["PAYMENT_TIMEOUT", "PAYMENT_TIMEOUT"]);
  });

  it("reservation timeout: re-send the SAME command, then give up and release BY ORDER", () => {
    const first = run(saga("RESERVING_INVENTORY"), { kind: "timeout" });
    expect(first.state).toBe("RESERVING_INVENTORY");
    expect(first.stepAttempts).toBe(1);
    expect(first.commands[0]!.idempotencyKey).toBe("saga-1:reserve");

    const last = run(saga("RESERVING_INVENTORY", { stepAttempts: 2 }), { kind: "timeout" });
    expect(last.state).toBe("CANCELLING");
    expect(last.commands[0]!.payload).toMatchObject({ reservationId: null, reason: "RESERVATION_TIMEOUT" });
  });

  it("the customer cancelling before payment releases the stock (the order is already cancelled)", () => {
    const d = run(saga("AWAITING_PAYMENT"), ev("OrderCancelled"));
    expect(d.state).toBe("CANCELLING");
    expect(cmds(d)).toEqual(["inventory:InventoryReservationReleaseRequested"]);
    expect(d.patch.failureReason).toBe("CUSTOMER_CANCELLED");
  });

  it("paid but the reservation expired → REFUNDING; RefundSucceeded moves the order to REFUNDED and ends CANCELLED", () => {
    const d = run(saga("CONFIRMING_INVENTORY"), ev("InventoryReservationFailed", { reason: "RESERVATION_EXPIRED" }));
    expect(d.state).toBe("REFUNDING");
    expect(cmds(d)).toEqual(["order:OrderStatusTransitionRequested:REFUND_PENDING", "payment:RefundRequested"]);
    expect(d.commands[1]!.payload).toEqual({
      paymentId: "pay-1",
      orderId: "order-1",
      amount: { amountMinor: 117_764, currency: "INR" },
      reason: "OUT_OF_STOCK_AFTER_PAYMENT",
    });
    const done = run(saga("REFUNDING", { compensation: d.patch.compensation! }), ev("RefundSucceeded"));
    expect(done.state).toBe("CANCELLED");
    expect(cmds(done)).toEqual(["order:OrderStatusTransitionRequested:REFUNDED"]);
  });

  it("a payment arriving AFTER cancellation is refunded (money is never kept)", () => {
    const d = run(saga("CANCELLED", { paymentId: null }), ev("PaymentSucceeded", { paymentId: "pay-late" }));
    expect(d.state).toBe("REFUNDING");
    expect(d.commands[0]).toMatchObject({ messageType: "RefundRequested", payload: { paymentId: "pay-late", reason: "LATE_PAYMENT_AFTER_CANCELLATION" } });
    expect(d.patch.paymentId).toBe("pay-late");
  });

  it("a failed refund, or compensation that never confirms, goes to MANUAL_REVIEW with an alert event", () => {
    const refund = run(saga("REFUNDING", { compensation: { awaiting: ["RefundSucceeded"] } }), ev("RefundFailed"));
    expect(refund.state).toBe("MANUAL_REVIEW");
    expect(refund.events[0]!.messageType).toBe("SagaManualReviewRequired");

    const stuck = run(saga("CANCELLING", { stepAttempts: 2, compensation: { awaiting: ["InventoryReservationReleased"] } }), { kind: "timeout" });
    expect(stuck.state).toBe("MANUAL_REVIEW");
    expect(stuck.events[0]!.payload).toMatchObject({ stateBeforeReview: "CANCELLING" });
  });

  it("paid but confirmation never answers: retries, then MANUAL_REVIEW (never silently cancels a paid order)", () => {
    expect(run(saga("CONFIRMING_INVENTORY"), { kind: "timeout" })).toMatchObject({ state: "CONFIRMING_INVENTORY", stepAttempts: 1 });
    expect(run(saga("CONFIRMING_INVENTORY", { stepAttempts: 2 }), { kind: "timeout" }).state).toBe("MANUAL_REVIEW");
    expect(run(saga("CONFIRMING_ORDER", { stepAttempts: 2 }), { kind: "timeout" }).state).toBe("MANUAL_REVIEW");
  });

  it("synchronous step failures back off exponentially, then give up", () => {
    const a = run(saga("STARTED"), { kind: "dependency-failed", detail: "503" });
    expect(a).toMatchObject({ state: "STARTED", stepAttempts: 1, deadline: plus(2_000) });
    const b = run(saga("STARTED", { stepAttempts: 1 }), { kind: "dependency-failed", detail: "503" });
    expect(b.deadline).toEqual(plus(4_000));
    expect(run(saga("STARTED", { stepAttempts: 2 }), { kind: "dependency-failed", detail: "503" }).state).toBe("FAILED");
    expect(run(saga("INVENTORY_RESERVED", { stepAttempts: 2 }), { kind: "dependency-failed", detail: "503" }).state).toBe("CANCELLING");
  });
});

describe("cancelling a paid order (OrderCancellationRequested)", () => {
  const paid = (state: SagaState, over: Partial<Saga> = {}) => saga(state, { paymentId: "pay-1", ...over });
  const cancelRequested = (reason = "CUSTOMER_REQUESTED") => ev("OrderCancellationRequested", { orderId: "order-1", previousStatus: "CONFIRMED", reason });

  it("COMPLETED → REFUNDING: the order moves to REFUND_PENDING and the FULL total is refunded", () => {
    const d = run(paid("COMPLETED"), cancelRequested());
    expect(d.state).toBe("REFUNDING");
    expect(cmds(d)).toEqual(["order:OrderStatusTransitionRequested:REFUND_PENDING", "payment:RefundRequested"]);
    expect(d.commands[1]).toMatchObject({
      idempotencyKey: "saga-1:refund",
      payload: { paymentId: "pay-1", orderId: "order-1", amount: { amountMinor: 117_764, currency: "INR" }, reason: "CUSTOMER_REQUESTED" },
    });
    expect(d.patch.compensation).toMatchObject({ awaiting: ["RefundSucceeded"], afterCompletion: true, returnStockAfterRefund: true });
    expect(d.events).toEqual([]);
    expect(d.deadline).toEqual(plus(30_000));
  });

  it("an admin's cancellation is refunded with reason ADMIN", () => {
    expect(run(paid("COMPLETED"), cancelRequested("ADMIN")).commands[1]!.payload.reason).toBe("ADMIN");
  });

  it("RefundSucceeded → order REFUNDED and the stock is returned; InventoryReturned ends CANCELLED without CheckoutFailed", () => {
    const refunding = run(paid("COMPLETED"), cancelRequested());
    const s1 = paid("REFUNDING", { compensation: refunding.patch.compensation! });
    const a = run(s1, ev("RefundSucceeded"));
    expect(a.state).toBe("REFUNDING");
    expect(cmds(a)).toEqual(["order:OrderStatusTransitionRequested:REFUNDED", "inventory:InventoryReturnRequested"]);
    expect(a.commands[1]).toMatchObject({ idempotencyKey: "saga-1:return", payload: { orderId: "order-1", reservationId: "res-1", reason: "ORDER_CANCELLED" } });
    expect(a.patch.compensation).toMatchObject({ awaiting: ["InventoryReturned"], returnStockAfterRefund: false });

    const s2 = paid("REFUNDING", { compensation: a.patch.compensation! });
    expect(run(s2, ev("RefundSucceeded")).ignored).toBeDefined(); // duplicate: no second return
    const b = run(s2, ev("InventoryReturned", { outcome: "RETURNED" }));
    expect(b.state).toBe("CANCELLED");
    expect(b.commands).toEqual([]);
    expect(b.events).toEqual([]); // the checkout did succeed: no CheckoutFailed
  });

  it("stock is NOT returned while the refund is unconfirmed; RefundFailed goes to MANUAL_REVIEW (order stays REFUND_PENDING)", () => {
    const s1 = paid("REFUNDING", { compensation: run(paid("COMPLETED"), cancelRequested()).patch.compensation! });
    const d = run(s1, ev("RefundFailed", { failureCode: "PROVIDER_REJECTED" }));
    expect(d.state).toBe("MANUAL_REVIEW");
    expect(d.commands).toEqual([]);
    expect(d.events.map((e) => e.messageType)).toEqual(["SagaManualReviewRequired"]);
  });

  it("timeouts re-send the step that is unconfirmed (refund, then return) with the same keys, then escalate", () => {
    const comp = run(paid("COMPLETED"), cancelRequested()).patch.compensation!;
    expect(cmds(run(paid("REFUNDING", { compensation: comp }), { kind: "timeout" }))).toEqual(["payment:RefundRequested"]);
    const returning = { ...comp, awaiting: ["InventoryReturned" as const], returnStockAfterRefund: false };
    const t = run(paid("REFUNDING", { compensation: returning }), { kind: "timeout" });
    expect(t.commands.map((c) => c.idempotencyKey)).toEqual(["saga-1:return"]);
    expect(run(paid("REFUNDING", { compensation: returning, stepAttempts: 2 }), { kind: "timeout" }).state).toBe("MANUAL_REVIEW");
  });

  it("OrderCancellationRequested overtaking OrderConfirmed: announce CheckoutCompleted, then cancel", () => {
    const d = run(paid("CONFIRMING_ORDER"), cancelRequested());
    expect(d.state).toBe("REFUNDING");
    expect(d.events.map((e) => e.messageType)).toEqual(["CheckoutCompleted"]);
    expect(cmds(d)).toEqual(["order:OrderStatusTransitionRequested:REFUND_PENDING", "payment:RefundRequested"]);
    // The late OrderConfirmed is then ignored.
    expect(run(paid("REFUNDING", { compensation: d.patch.compensation! }), ev("OrderConfirmed")).ignored).toBeDefined();
  });

  it("a PaymentSucceeded redelivered after the cancellation is NOT a late payment (no second refund)", () => {
    const comp = run(paid("COMPLETED"), cancelRequested()).patch.compensation!;
    expect(run(paid("REFUNDING", { compensation: comp }), ev("PaymentSucceeded", { paymentId: "pay-1" })).ignored).toBeDefined();
    expect(run(paid("CANCELLED", { compensation: { ...comp, awaiting: [] } }), ev("PaymentSucceeded", { paymentId: "pay-1" })).ignored).toBeDefined();
  });

  it("states where no paid order can be cancelling ignore it", () => {
    for (const state of ["AWAITING_PAYMENT", "CANCELLED", "MANUAL_REVIEW"] as const) {
      expect(run(paid(state), cancelRequested()).ignored).toBeDefined();
    }
  });
});

describe("duplicates, late events and operator actions", () => {
  it.each<[SagaState, string]>([
    ["INVENTORY_RESERVED", "InventoryReserved"],
    ["CONFIRMING_INVENTORY", "PaymentSucceeded"],
    ["COMPLETED", "PaymentSucceeded"],
    ["COMPLETED", "OrderConfirmed"],
    ["CANCELLED", "InventoryReservationReleased"],
    ["MANUAL_REVIEW", "RefundSucceeded"],
  ])("%s ignores %s (duplicate or late): no state change, no commands", (state, type) => {
    const d = run(saga(state), ev(type));
    expect(d.ignored).toBeDefined();
    expect(d.state).toBe(state);
    expect(d.commands).toEqual([]);
  });

  it("only MANUAL_REVIEW sagas can be resolved by an operator", () => {
    expect(run(saga("MANUAL_REVIEW"), { kind: "operator-resolved", resolution: "refunded manually" }).state).toBe("RESOLVED");
    expect(run(saga("COMPLETED"), { kind: "operator-resolved", resolution: "x" }).ignored).toBeDefined();
  });

  it("every command carries a step-stable idempotency key", () => {
    const keys = [
      run(saga("STARTED"), { kind: "order-created", orderId: "order-1", totalMinor: 1n, currency: "INR" }),
      run(saga("AWAITING_PAYMENT"), ev("PaymentSucceeded")),
      run(saga("AWAITING_PAYMENT"), ev("PaymentFailed")),
    ].flatMap((d) => d.commands.map((c) => c.idempotencyKey));
    expect(keys).toEqual([
      "saga-1:order:INVENTORY_RESERVING",
      "saga-1:reserve",
      "saga-1:order:PAYMENT_SUCCEEDED",
      "saga-1:confirm",
      "saga-1:release",
      "saga-1:order:CANCELLED",
    ]);
  });
});
