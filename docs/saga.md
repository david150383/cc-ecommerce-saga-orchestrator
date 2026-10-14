# Checkout saga: how it works

Platform view and rationale: `ecommerce-infrastructure/docs/architecture/checkout-saga.md`.
This page describes the implementation.

## The pieces

```
              ┌──────────── HTTP ─────────────┐
 POST /checkout│                               │ GET /checkout/{id}
               ▼                               │
          SagaEngine ──── decide(saga, input, now) ──► Decision   (pure: all the rules, unit-tested)
               │                                          │
               │ ONE transaction per change:              │
               │   saga_instances (state, version, deadline)
               │   saga_steps     (history)               │
               │   outbox         (commands + events) ◄───┘
               │   processed_messages (dedupe)
               ▼
  ┌────────────┴─────────────┬────────────────────────────┐
  OutboxRelay                InboxConsumer                 Timer (processDue)
  outbox → SQS / SNS         saga-inbox → handleEvent      overdue → timeout / retry / recovery
```

- **`decide()` (src/saga/decide.ts)** contains every rule and does no I/O. Inputs: events, timeouts,
  results of the saga's own HTTP calls, operator actions. Output: new state, commands, events, next deadline.
- **Persist before acting.** A decision's state change, history row and outgoing messages commit together.
  Nothing is sent from a request or an event handler: the relay publishes committed outbox rows.
- **Synchronous steps** (create the order, create the payment intent) run outside any transaction under a
  60 s lease, so one instance at a time calls the dependency. The result is applied in a new transaction
  only if the saga has not moved on meanwhile (version check); otherwise `decide()` ignores it as well.

## States

| State | Waiting for | On timeout |
|---|---|---|
| STARTED | sync: create order (`{sagaId}:create-order`) | retry with backoff (1 s, 2 s, 4 s … 30 s), then FAILED |
| RESERVING_INVENTORY | InventoryReserved / InventoryReservationFailed / OrderCancelled | re-send the SAME reserve command, then compensate (release **by order**) |
| INVENTORY_RESERVED | sync: create payment intent (`{sagaId}:payment-intent`) | retry with backoff, then compensate |
| AWAITING_PAYMENT | PaymentSucceeded / PaymentFailed / OrderCancelled | compensate (PAYMENT_TIMEOUT) |
| CONFIRMING_INVENTORY | InventoryReservationConfirmed / InventoryReservationFailed (expired → refund) | re-send, then MANUAL_REVIEW (money taken) |
| CONFIRMING_ORDER | OrderConfirmed | re-send, then MANUAL_REVIEW |
| CANCELLING / REFUNDING | everything in `compensation.awaiting` | re-send what is still awaited, then MANUAL_REVIEW |
| COMPLETED, CANCELLED, FAILED, RESOLVED | terminal (a late PaymentSucceeded re-opens CANCELLED to REFUNDING) | n/a |
| MANUAL_REVIEW | an operator (`POST /api/v1/admin/sagas/{id}/resolve`) | n/a |

## Guarantees and how they are achieved

| Guarantee | Mechanism | Test |
|---|---|---|
| A retried checkout request creates one saga | `UNIQUE (customer_id, idempotency_key)` + request hash | `checkout API › idempotent` |
| A crash never orphans an order | the saga row is written BEFORE the order is created; the order's idempotency key is derived from the saga id | `crash recovery › instance died after creating the order…` |
| Duplicate events are applied once | `processed_messages` in the same transaction; and `decide()` ignores events that no longer apply | `redelivered event…`, `duplicate answer with a NEW messageId…` |
| Two events for one saga cannot interleave | `SELECT … FOR UPDATE` on the saga row | `concurrent conflicting events…` |
| Lost commands or answers are recovered | every waiting state has a deadline; timeouts re-send with the SAME idempotency key | `lost reservation answer…` |
| Several instances never double-process a timeout | claim with `SKIP LOCKED`, then RE-CHECK due-ness under the row lock | `two instances … never double-apply` |
| Per-order command order on the FIFO queue | relay publishes a saga's row only when no older row of that saga is unpublished | `two relays racing keep each saga's order-commands in send order` |
| Money is never kept for a cancelled checkout | late PaymentSucceeded → RefundRequested; RefundFailed → MANUAL_REVIEW | `payment arriving after cancellation…` |

A bug worth remembering: the claim's `SKIP LOCKED` only lasts for the claiming transaction. Processing
happens later in another transaction, so a second instance could claim the same saga in between. The fix is
the re-check under the row lock. The test caught it once the timing lined up.

## Phase 3 limits

- The Payment Service arrives in Phase 4. Until then the payment-intent call fails in a real deployment
  (the saga retries, then compensates). Tests and the local end-to-end check use a stand-in.
- Customer notifications (`NotificationRequested`) are added with the Notification Service in Phase 4.
