# Saga Orchestrator: messages

The saga owns very few schemas. **Commands belong to the service that executes them**, so the
saga sends schemas defined in other repositories.

## Produced events (owned here, SNS `saga-events`)

| Event | Consumers | When |
|---|---|---|
| `CheckoutCompleted` v1 | none yet | Saga reached COMPLETED |
| `CheckoutFailed` v1 | none yet | Saga ended CANCELLED/FAILED after compensation |
| `SagaManualReviewRequired` v1 | Ops alerting | Compensation could not be verified |

## Sent commands (schemas owned by the receiver)

| Command | Queue | Schema lives in |
|---|---|---|
| `InventoryReservationRequested` | `inventory-commands` | ecommerce-inventory-service |
| `InventoryReservationConfirmRequested` | `inventory-commands` | ecommerce-inventory-service |
| `InventoryReservationReleaseRequested` | `inventory-commands` | ecommerce-inventory-service |
| `OrderStatusTransitionRequested` | `order-commands.fifo` (MessageGroupId = orderId) | ecommerce-order-service |
| `RefundRequested` | `payment-commands` | ecommerce-payment-service |
| `NotificationRequested` | `notification-commands` | ecommerce-notification-service |

Idempotency key format: `{sagaId}:{step}`, e.g. `0192…:reserve`, `0192…:order:CONFIRMED`,
`0192…:refund`. **The same key is reused on every retry of that step.** That is
what lets the receiver recognise a retry.

## Consumed events (SQS `saga-inbox`)

`InventoryReserved`, `InventoryReservationFailed`, `InventoryReservationConfirmed`,
`InventoryReservationReleased`, `PaymentSucceeded`, `PaymentFailed`, `RefundSucceeded`,
`RefundFailed`, `OrderConfirmed`, `OrderCancelled`.

Correlation: every message the saga sends carries `sagaId`, and every result event echoes it back (events
without a known sagaId are matched by `payload.orderId`). An event for an unknown or already-terminal saga is acknowledged and logged. A late
`PaymentSucceeded` for a CANCELLED saga triggers `RefundRequested`.
