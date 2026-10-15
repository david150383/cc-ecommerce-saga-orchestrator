export const SAGA_STATES = [
  "STARTED",
  "RESERVING_INVENTORY",
  "INVENTORY_RESERVED",
  "AWAITING_PAYMENT",
  "CONFIRMING_INVENTORY",
  "CONFIRMING_ORDER",
  "COMPLETED",
  "CANCELLING",
  "REFUNDING",
  "CANCELLED",
  "FAILED",
  "MANUAL_REVIEW",
  "RESOLVED",
] as const;
export type SagaState = (typeof SAGA_STATES)[number];

/** States whose next action is a synchronous HTTP call made by the saga itself. */
export const SYNC_STATES: readonly SagaState[] = ["STARTED", "INVENTORY_RESERVED"];
/** No further automatic action. CANCELLED can still be re-opened by a late payment (refund). */
export const TERMINAL_STATES: readonly SagaState[] = ["COMPLETED", "CANCELLED", "FAILED", "RESOLVED"];

export interface CheckoutRequest {
  items: { sku: string; quantity: number }[];
  currency: string;
  shippingAddress: Record<string, unknown>;
  couponCode?: string | undefined;
}

/** Results the saga is still waiting for while compensating. */
export type Awaited = "InventoryReservationReleased" | "OrderCancelled" | "RefundSucceeded" | "InventoryReturned";

export interface Compensation {
  awaiting: Awaited[];
  /** Cancellation reason sent to the Order Service (must be one of its CANCELLATION_REASONS). */
  orderCancelReason?: string;
  /** Release reason sent to the Inventory Service. */
  releaseReason?: string;
  /** Refund reason sent to the Payment Service. */
  refundReason?: string;
  /** The order is in REFUND_PENDING and must be moved to REFUNDED once the refund succeeds. */
  orderRefundPending?: boolean;
  /** Where to go once everything awaited has arrived. */
  then?: "CANCELLED";
  /**
   * A paid, completed order is being cancelled (OrderCancellationRequested): the checkout itself
   * succeeded, so finishing announces no CheckoutFailed, and a payment event can no longer be "late".
   */
  afterCompletion?: boolean;
  /** Once the refund succeeds, put the confirmed stock back on hand (InventoryReturnRequested). */
  returnStockAfterRefund?: boolean;
}

export interface Saga {
  id: string;
  customerId: string;
  state: SagaState;
  request: CheckoutRequest;
  orderId: string | null;
  totalMinor: bigint | null;
  currency: string | null;
  reservationId: string | null;
  paymentId: string | null;
  checkoutUrl: string | null;
  failureReason: string | null;
  compensation: Compensation;
  stepAttempts: number;
  version: number;
}

export interface IncomingEvent {
  messageId: string;
  messageType: string;
  payload: Record<string, unknown>;
}

export type Input =
  | { kind: "event"; event: IncomingEvent }
  | { kind: "timeout" }
  | { kind: "order-created"; orderId: string; totalMinor: bigint; currency: string }
  | { kind: "order-rejected"; code: string }
  | { kind: "payment-intent-created"; paymentId: string; checkoutUrl: string }
  | { kind: "payment-intent-rejected"; code: string }
  | { kind: "dependency-failed"; detail: string }
  | { kind: "operator-resolved"; resolution: string };

export type CommandTarget = "inventory" | "order" | "payment";

export interface OutgoingCommand {
  target: CommandTarget;
  messageType: string;
  payload: Record<string, unknown>;
  /** Same key on every retry of the same step, so the receiver can recognise the retry. */
  idempotencyKey: string;
}

export interface OutgoingEvent {
  messageType: "CheckoutCompleted" | "CheckoutFailed" | "SagaManualReviewRequired";
  payload: Record<string, unknown>;
}

export interface Decision {
  state: SagaState;
  patch: Partial<Pick<Saga, "orderId" | "totalMinor" | "currency" | "reservationId" | "paymentId" | "checkoutUrl" | "failureReason" | "compensation">>;
  commands: OutgoingCommand[];
  events: OutgoingEvent[];
  /** Next deadline: a timeout for waiting states, the next attempt for synchronous states; null = none. */
  deadline: Date | null;
  stepAttempts: number;
  /** Short label stored in saga_steps. */
  trigger: string;
  /** Set when the input does not apply in the current state (e.g. a duplicate or late event). */
  ignored?: string;
}

/** What customers see: internal states collapse so they can change without breaking clients. */
export function customerStatus(state: SagaState): "PROCESSING" | "AWAITING_PAYMENT" | "COMPLETED" | "CANCELLED" | "FAILED" | "UNDER_REVIEW" {
  switch (state) {
    case "AWAITING_PAYMENT":
      return "AWAITING_PAYMENT";
    case "COMPLETED":
      return "COMPLETED";
    case "CANCELLED":
    case "RESOLVED":
      return "CANCELLED";
    case "FAILED":
      return "FAILED";
    case "MANUAL_REVIEW":
      return "UNDER_REVIEW";
    default:
      return "PROCESSING";
  }
}
