/**
 * The checkout saga's rules as ONE pure function: (saga, input, now) -> decision.
 *
 * No I/O happens here. The engine persists the decision (new state, step history, outbox rows
 * for commands and events) in a single transaction, and only then are messages published. This
 * keeps every rule unit-testable and makes "persist state before acting" structural.
 *
 * Inputs are events from other services, timeouts, results of the saga's own synchronous calls
 * (create order, create payment intent), and operator actions. Anything that does not apply in
 * the current state is IGNORED (recorded, never an error): with at-least-once delivery, late and
 * duplicate events are normal.
 */
import type { Compensation, Decision, Input, OutgoingCommand, OutgoingEvent, Saga, SagaState } from "./types.js";

export interface SagaPolicy {
  reservationTimeoutMs: number;
  paymentTimeoutMs: number;
  /** Timeout for confirm / order / compensation steps. */
  stepTimeoutMs: number;
  /** Attempts per step (re-sends of a command, or retries of a synchronous call) before giving up. */
  maxStepAttempts: number;
}

const at = (now: Date, ms: number) => new Date(now.getTime() + ms);
/** Exponential backoff for retrying synchronous calls: 1 s, 2 s, 4 s … capped at 30 s. */
const backoff = (attempt: number) => Math.min(30_000, 1_000 * 2 ** attempt);

export function decide(saga: Saga, input: Input, now: Date, policy: SagaPolicy): Decision {
  const d = new Decider(saga, now, policy);
  if (input.kind === "operator-resolved") return d.resolve(input.resolution);
  // A late payment must be refunded whatever happened to the checkout in the meantime.
  if (input.kind === "event" && input.event.messageType === "PaymentSucceeded" && isAfterCancellation(saga.state) && !saga.compensation.afterCompletion) {
    return d.latePayment(input.event.messageId, input.event.payload);
  }
  switch (saga.state) {
    case "STARTED":
      return d.started(input);
    case "RESERVING_INVENTORY":
      return d.reservingInventory(input);
    case "INVENTORY_RESERVED":
      return d.inventoryReserved(input);
    case "AWAITING_PAYMENT":
      return d.awaitingPayment(input);
    case "CONFIRMING_INVENTORY":
      return d.confirmingInventory(input);
    case "CONFIRMING_ORDER":
      return d.confirmingOrder(input);
    case "COMPLETED":
      return d.completed(input);
    case "CANCELLING":
    case "REFUNDING":
      return d.compensating(input);
    default:
      return d.ignore(input, `no transitions from ${saga.state}`);
  }
}

function isAfterCancellation(state: SagaState): boolean {
  return state === "CANCELLING" || state === "CANCELLED";
}

function label(input: Input): string {
  if (input.kind === "event") return `event:${input.event.messageType}`;
  if (input.kind === "timeout") return "timeout";
  return `sync:${input.kind}`;
}

class Decider {
  constructor(
    private readonly saga: Saga,
    private readonly now: Date,
    private readonly policy: SagaPolicy,
  ) {}

  // ------------------------------------------------------------------ states

  started(input: Input): Decision {
    switch (input.kind) {
      case "order-created":
        return this.to("RESERVING_INVENTORY", input, {
          patch: { orderId: input.orderId, totalMinor: input.totalMinor, currency: input.currency },
          commands: [
            this.orderTransition("INVENTORY_RESERVING", input.orderId),
            this.reserveInventory(input.orderId),
          ],
          deadline: at(this.now, this.policy.reservationTimeoutMs),
        });
      case "order-rejected":
        // Nothing exists yet that would need compensating.
        return this.fail(input, input.code);
      case "dependency-failed":
        return this.retrySync(input, "ORDER_SERVICE_UNAVAILABLE");
      default:
        return this.ignore(input, "waiting for the order to be created");
    }
  }

  reservingInventory(input: Input): Decision {
    if (input.kind === "timeout") {
      // The command or its answer may have been lost: re-send (same idempotency key = no double reservation).
      if (this.saga.stepAttempts + 1 < this.policy.maxStepAttempts) {
        return this.stay(input, [this.reserveInventory(this.saga.orderId!)], at(this.now, this.policy.reservationTimeoutMs));
      }
      // Give up. A reservation might exist without us knowing its id: release by order.
      return this.cancel(input, "RESERVATION_TIMEOUT", {
        release: true,
        releaseReason: "RESERVATION_TIMEOUT",
        cancelOrder: true,
        orderCancelReason: "SYSTEM",
      });
    }
    if (input.kind !== "event") return this.ignore(input, "waiting for the reservation result");
    const { messageType, payload } = input.event;
    if (messageType === "InventoryReserved") {
      return this.to("INVENTORY_RESERVED", input, {
        patch: { reservationId: String(payload.reservationId) },
        commands: [this.orderTransition("INVENTORY_RESERVED")],
        deadline: this.now, // run the payment-intent step right away
      });
    }
    if (messageType === "InventoryReservationFailed") {
      const reason = String(payload.reason ?? "INSUFFICIENT_STOCK");
      // Nothing was reserved (all-or-nothing): only the order must be cancelled.
      return this.cancel(input, reason, { release: false, cancelOrder: true, orderCancelReason: "OUT_OF_STOCK" });
    }
    if (messageType === "OrderCancelled") return this.customerCancelled(input);
    return this.ignore(input, `unexpected ${messageType}`);
  }

  inventoryReserved(input: Input): Decision {
    switch (input.kind) {
      case "payment-intent-created":
        return this.to("AWAITING_PAYMENT", input, {
          patch: { paymentId: input.paymentId, checkoutUrl: input.checkoutUrl },
          commands: [this.orderTransition("PAYMENT_PENDING")],
          deadline: at(this.now, this.policy.paymentTimeoutMs),
        });
      case "payment-intent-rejected":
        return this.cancel(input, `PAYMENT_INTENT_REJECTED:${input.code}`, { release: true, cancelOrder: true, orderCancelReason: "SYSTEM" });
      case "dependency-failed":
        if (this.saga.stepAttempts + 1 >= this.policy.maxStepAttempts) {
          return this.cancel(input, "PAYMENT_SERVICE_UNAVAILABLE", { release: true, cancelOrder: true, orderCancelReason: "SYSTEM" });
        }
        return this.retrySync(input, "PAYMENT_SERVICE_UNAVAILABLE");
      case "event":
        if (input.event.messageType === "OrderCancelled") return this.customerCancelled(input);
        return this.ignore(input, `unexpected ${input.event.messageType}`);
      default:
        return this.ignore(input, "waiting for the payment intent");
    }
  }

  awaitingPayment(input: Input): Decision {
    if (input.kind === "timeout") {
      // The customer never paid. (Phase 4: also expire the provider's checkout session.)
      return this.cancel(input, "PAYMENT_TIMEOUT", {
        release: true,
        releaseReason: "PAYMENT_TIMEOUT",
        cancelOrder: true,
        orderCancelReason: "PAYMENT_TIMEOUT",
      });
    }
    if (input.kind !== "event") return this.ignore(input, "waiting for the payment");
    const { messageType } = input.event;
    if (messageType === "PaymentSucceeded") {
      return this.to("CONFIRMING_INVENTORY", input, {
        commands: [this.orderTransition("PAYMENT_SUCCEEDED"), this.confirmInventory()],
        deadline: at(this.now, this.policy.stepTimeoutMs),
      });
    }
    if (messageType === "PaymentFailed") {
      return this.cancel(input, "PAYMENT_FAILED", {
        release: true,
        releaseReason: "PAYMENT_FAILED",
        cancelOrder: true,
        orderCancelReason: "PAYMENT_FAILED",
      });
    }
    if (messageType === "OrderCancelled") return this.customerCancelled(input);
    return this.ignore(input, `unexpected ${messageType}`);
  }

  confirmingInventory(input: Input): Decision {
    if (input.kind === "timeout") {
      if (this.saga.stepAttempts + 1 < this.policy.maxStepAttempts) {
        return this.stay(input, [this.confirmInventory()], at(this.now, this.policy.stepTimeoutMs));
      }
      // Money was taken and we cannot tell whether stock is committed: a human must look.
      return this.manualReview(input, "inventory confirmation unanswered after payment");
    }
    if (input.kind !== "event") return this.ignore(input, "waiting for the inventory confirmation");
    const { messageType, payload } = input.event;
    if (messageType === "InventoryReservationConfirmed") {
      return this.to("CONFIRMING_ORDER", input, {
        commands: [this.orderTransition("CONFIRMED")],
        deadline: at(this.now, this.policy.stepTimeoutMs),
      });
    }
    if (messageType === "InventoryReservationFailed") {
      // Paid, but the reservation expired (e.g. a very slow payment) and stock is gone: refund.
      return this.to("REFUNDING", input, {
        patch: {
          failureReason: String(payload.reason ?? "RESERVATION_EXPIRED"),
          compensation: {
            awaiting: ["RefundSucceeded"],
            refundReason: "OUT_OF_STOCK_AFTER_PAYMENT",
            orderRefundPending: true,
            then: "CANCELLED",
          },
        },
        commands: [this.orderTransition("REFUND_PENDING"), this.refund("OUT_OF_STOCK_AFTER_PAYMENT")],
        deadline: at(this.now, this.policy.stepTimeoutMs),
      });
    }
    return this.ignore(input, `unexpected ${messageType}`);
  }

  confirmingOrder(input: Input): Decision {
    if (input.kind === "timeout") {
      if (this.saga.stepAttempts + 1 < this.policy.maxStepAttempts) {
        return this.stay(input, [this.orderTransition("CONFIRMED")], at(this.now, this.policy.stepTimeoutMs));
      }
      return this.manualReview(input, "order confirmation unanswered after payment and stock commit");
    }
    if (input.kind === "event" && input.event.messageType === "OrderConfirmed") {
      return this.to("COMPLETED", input, {
        events: [this.checkoutCompleted()],
        deadline: null,
      });
    }
    if (input.kind === "event" && input.event.messageType === "OrderCancellationRequested") {
      // Only a CONFIRMED order can be cancelled this way, so OrderConfirmed is merely still in flight
      // (events are not ordered): the checkout DID complete. Announce it, then cancel.
      const cancel = this.cancelPaidOrder(input);
      return { ...cancel, events: [this.checkoutCompleted(), ...cancel.events] };
    }
    return this.ignore(input, "waiting for OrderConfirmed");
  }

  completed(input: Input): Decision {
    if (input.kind === "event" && input.event.messageType === "OrderCancellationRequested") return this.cancelPaidOrder(input);
    return this.ignore(input, "checkout completed");
  }

  /**
   * The customer (or an admin) cancelled a paid order before it shipped. The Order Service has put it in
   * CANCELLATION_PENDING. Refund first; only once the money is back is the stock returned, so that a
   * refund that fails (manual review) leaves a human every option, including shipping after all.
   */
  private cancelPaidOrder(input: Input): Decision {
    const payload = input.kind === "event" ? input.event.payload : {};
    const refundReason = payload.reason === "ADMIN" ? "ADMIN" : "CUSTOMER_REQUESTED";
    const compensation: Compensation = {
      awaiting: ["RefundSucceeded"],
      refundReason,
      orderRefundPending: true,
      returnStockAfterRefund: true,
      afterCompletion: true,
      then: "CANCELLED",
    };
    return this.to("REFUNDING", input, {
      patch: { failureReason: `ORDER_CANCELLED:${refundReason}`, compensation },
      commands: [this.orderTransition("REFUND_PENDING"), this.refund(refundReason)],
      deadline: at(this.now, this.policy.stepTimeoutMs),
    });
  }

  /** CANCELLING and REFUNDING: tick off awaited results; finish when none are left. */
  compensating(input: Input): Decision {
    const comp = this.saga.compensation;
    if (input.kind === "timeout") {
      if (this.saga.stepAttempts + 1 < this.policy.maxStepAttempts) {
        return this.stay(input, this.compensationCommands(comp), at(this.now, this.policy.stepTimeoutMs));
      }
      return this.manualReview(input, `compensation unconfirmed: still waiting for ${comp.awaiting.join(", ")}`);
    }
    if (input.kind !== "event") return this.ignore(input, "compensating");
    const type = input.event.messageType;
    if (type === "RefundFailed") return this.manualReview(input, "refund failed");
    if (!(comp.awaiting as string[]).includes(type)) return this.ignore(input, `not awaiting ${type}`);

    let next: Compensation = { ...comp, awaiting: comp.awaiting.filter((a) => a !== type) };
    const commands: OutgoingCommand[] = [];
    if (type === "RefundSucceeded" && comp.orderRefundPending) commands.push(this.orderTransition("REFUNDED"));
    if (type === "RefundSucceeded" && comp.returnStockAfterRefund) {
      next = { ...next, awaiting: [...next.awaiting, "InventoryReturned"], returnStockAfterRefund: false };
      commands.push(this.returnInventory());
    }
    const awaiting = next.awaiting;
    if (awaiting.length > 0) {
      return this.to(this.saga.state, input, {
        patch: { compensation: next },
        commands,
        deadline: at(this.now, this.policy.stepTimeoutMs),
        keepAttempts: true,
      });
    }
    return this.to("CANCELLED", input, {
      patch: { compensation: next },
      commands,
      // A cancelled paid order: the checkout had succeeded (CheckoutCompleted was announced).
      events: comp.afterCompletion ? [] : [this.checkoutFailed("CANCELLED")],
      deadline: null,
    });
  }

  latePayment(messageId: string, payload: Record<string, unknown>): Decision {
    // Payment captured after we gave up on the checkout: the money must go back.
    const comp = this.saga.compensation;
    const input: Input = { kind: "event", event: { messageId, messageType: "PaymentSucceeded", payload } };
    // The saga may have given up before learning the payment id; the event carries it.
    const paymentId = this.saga.paymentId ?? (typeof payload.paymentId === "string" ? payload.paymentId : null);
    const self = new Decider({ ...this.saga, paymentId }, this.now, this.policy);
    return self.to("REFUNDING", input, {
      patch: {
        paymentId,
        compensation: {
          ...comp,
          awaiting: [...comp.awaiting.filter((a) => a !== "RefundSucceeded"), "RefundSucceeded"],
          refundReason: "LATE_PAYMENT_AFTER_CANCELLATION",
          then: "CANCELLED",
        },
      },
      commands: [self.refund("LATE_PAYMENT_AFTER_CANCELLATION")],
      deadline: at(this.now, this.policy.stepTimeoutMs),
    });
  }

  resolve(resolution: string): Decision {
    if (this.saga.state !== "MANUAL_REVIEW") return this.ignore({ kind: "operator-resolved", resolution }, "only MANUAL_REVIEW sagas can be resolved");
    return { state: "RESOLVED", patch: {}, commands: [], events: [], deadline: null, stepAttempts: 0, trigger: `operator:${resolution}`.slice(0, 80) };
  }

  // ------------------------------------------------------------------ building blocks

  private customerCancelled(input: Input): Decision {
    // The customer cancelled the order themselves (before paying). Release whatever is reserved.
    return this.cancel(input, "CUSTOMER_CANCELLED", { release: true, releaseReason: "ORDER_CANCELLED", cancelOrder: false });
  }

  private cancel(
    input: Input,
    reason: string,
    opts: { release: boolean; releaseReason?: string; cancelOrder: boolean; orderCancelReason?: string },
  ): Decision {
    const compensation: Compensation = {
      awaiting: [
        ...(opts.release ? (["InventoryReservationReleased"] as const) : []),
        ...(opts.cancelOrder ? (["OrderCancelled"] as const) : []),
      ],
      releaseReason: opts.releaseReason ?? "SAGA_COMPENSATION",
      ...(opts.orderCancelReason && { orderCancelReason: opts.orderCancelReason }),
      then: "CANCELLED",
    };
    return this.to("CANCELLING", input, {
      patch: { failureReason: reason, compensation },
      commands: this.compensationCommands(compensation),
      deadline: at(this.now, this.policy.stepTimeoutMs),
    });
  }

  private compensationCommands(comp: Compensation): OutgoingCommand[] {
    const commands: OutgoingCommand[] = [];
    if (comp.awaiting.includes("InventoryReservationReleased")) commands.push(this.releaseInventory(comp.releaseReason ?? "SAGA_COMPENSATION"));
    if (comp.awaiting.includes("OrderCancelled")) commands.push(this.orderTransition("CANCELLED", undefined, comp.orderCancelReason ?? "SYSTEM"));
    if (comp.awaiting.includes("RefundSucceeded")) commands.push(this.refund(comp.refundReason ?? "OUT_OF_STOCK_AFTER_PAYMENT"));
    if (comp.awaiting.includes("InventoryReturned")) commands.push(this.returnInventory());
    return commands;
  }

  private fail(input: Input, reason: string): Decision {
    return this.to("FAILED", input, { patch: { failureReason: reason }, events: [this.checkoutFailed("FAILED", reason)], deadline: null });
  }

  private manualReview(input: Input, reason: string): Decision {
    return this.to("MANUAL_REVIEW", input, {
      patch: { failureReason: reason.slice(0, 100) },
      // Every way into review involves a payment, so the customer may have been charged: tell them a person
      // is on it (the alert alone reaches only the operators). Only the order id travels, never the reason.
      commands: this.saga.orderId ? [this.notifyCustomer("order.under-review")] : [],
      events: [
        {
          messageType: "SagaManualReviewRequired",
          payload: { orderId: this.saga.orderId, stateBeforeReview: this.saga.state, reason: reason.slice(0, 500) },
        },
      ],
      deadline: null,
    });
  }

  private retrySync(input: Input, reason: string): Decision {
    const attempts = this.saga.stepAttempts + 1;
    if (attempts >= this.policy.maxStepAttempts) return this.fail(input, reason);
    return {
      state: this.saga.state,
      patch: {},
      commands: [],
      events: [],
      deadline: at(this.now, backoff(attempts)),
      stepAttempts: attempts,
      trigger: label(input),
    };
  }

  /** Same state, re-sent commands, one more attempt used. */
  private stay(input: Input, commands: OutgoingCommand[], deadline: Date): Decision {
    return { state: this.saga.state, patch: {}, commands, events: [], deadline, stepAttempts: this.saga.stepAttempts + 1, trigger: label(input) };
  }

  to(
    state: SagaState,
    input: Input,
    o: { patch?: Decision["patch"]; commands?: OutgoingCommand[]; events?: OutgoingEvent[]; deadline: Date | null; keepAttempts?: boolean },
  ): Decision {
    return {
      state,
      patch: o.patch ?? {},
      commands: o.commands ?? [],
      events: o.events ?? [],
      deadline: o.deadline,
      stepAttempts: o.keepAttempts ? this.saga.stepAttempts : 0,
      trigger: label(input),
    };
  }

  ignore(input: Input, why: string): Decision {
    return {
      state: this.saga.state,
      patch: {},
      commands: [],
      events: [],
      deadline: null,
      stepAttempts: this.saga.stepAttempts,
      trigger: label(input),
      ignored: why,
    };
  }

  private checkoutCompleted(): OutgoingEvent {
    return { messageType: "CheckoutCompleted", payload: { orderId: this.saga.orderId, customerId: this.saga.customerId } };
  }

  private checkoutFailed(finalState: "CANCELLED" | "FAILED", reason = this.saga.failureReason ?? "UNKNOWN"): OutgoingEvent {
    return {
      messageType: "CheckoutFailed",
      payload: { orderId: this.saga.orderId, customerId: this.saga.customerId, finalState, reason: reason.slice(0, 200) },
    };
  }

  // ------------------------------------------------------------------ commands (schemas owned by the receivers)

  private orderTransition(toStatus: string, orderId = this.saga.orderId!, cancellationReason?: string): OutgoingCommand {
    return {
      target: "order",
      messageType: "OrderStatusTransitionRequested",
      // For CANCELLED, `reason` carries the cancellation reason the Order Service records.
      payload: { orderId, toStatus, reason: cancellationReason ?? `checkout saga ${this.saga.id}` },
      idempotencyKey: `${this.saga.id}:order:${toStatus}`,
    };
  }

  private reserveInventory(orderId: string): OutgoingCommand {
    return {
      target: "inventory",
      messageType: "InventoryReservationRequested",
      payload: { orderId, lines: this.saga.request.items.map((i) => ({ sku: i.sku, quantity: i.quantity })) },
      idempotencyKey: `${this.saga.id}:reserve`,
    };
  }

  private confirmInventory(): OutgoingCommand {
    return {
      target: "inventory",
      messageType: "InventoryReservationConfirmRequested",
      payload: { reservationId: this.saga.reservationId, orderId: this.saga.orderId },
      idempotencyKey: `${this.saga.id}:confirm`,
    };
  }

  private releaseInventory(reason: string): OutgoingCommand {
    return {
      target: "inventory",
      messageType: "InventoryReservationReleaseRequested",
      // reservationId may be unknown (timeout before the answer): the Inventory Service then releases by order.
      payload: { orderId: this.saga.orderId, reservationId: this.saga.reservationId, reason },
      idempotencyKey: `${this.saga.id}:release`,
    };
  }

  private notifyCustomer(templateKey: string): OutgoingCommand {
    return {
      target: "notification",
      messageType: "NotificationRequested",
      payload: { recipientUserId: this.saga.customerId, channel: "email", templateKey, data: { orderId: this.saga.orderId } },
      idempotencyKey: `${this.saga.id}:notify:${templateKey}`,
    };
  }

  private returnInventory(): OutgoingCommand {
    return {
      target: "inventory",
      messageType: "InventoryReturnRequested",
      payload: { orderId: this.saga.orderId, reservationId: this.saga.reservationId, reason: "ORDER_CANCELLED" },
      idempotencyKey: `${this.saga.id}:return`,
    };
  }

  private refund(reason: string): OutgoingCommand {
    return {
      target: "payment",
      messageType: "RefundRequested",
      payload: {
        paymentId: this.saga.paymentId,
        orderId: this.saga.orderId,
        amount: { amountMinor: Number(this.saga.totalMinor ?? 0n), currency: this.saga.currency },
        reason,
      },
      idempotencyKey: `${this.saga.id}:refund`,
    };
  }
}
