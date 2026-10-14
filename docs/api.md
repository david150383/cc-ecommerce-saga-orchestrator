# Saga Orchestrator API (v1)

Base URL (local): `http://localhost:4007`. Conventions: `ecommerce-infrastructure/docs/architecture/conventions.md`.
Workflow design: `ecommerce-infrastructure/docs/architecture/checkout-saga.md`.
Status: **implemented** (Phase 3). Implementation notes: [saga.md](saga.md). Machine-readable spec:
[`openapi/openapi.json`](../openapi/openapi.json), served at `/openapi.json`, Swagger UI at `/docs`.

## Endpoints

| Method | Path | Auth | Idempotency | Purpose |
|---|---|---|---|---|
| POST | `/api/v1/checkout` | customer | `Idempotency-Key` **required** | Start a checkout saga |
| GET | `/api/v1/checkout/{sagaId}` | owner | n/a | Poll checkout progress (and get `checkoutUrl`) |
| GET | `/api/v1/admin/sagas` | admin | n/a | List sagas, filter by state (e.g. `MANUAL_REVIEW`) |
| GET | `/api/v1/admin/sagas/{sagaId}` | admin | n/a | Full step history |
| POST | `/api/v1/admin/sagas/{sagaId}/retry` | admin | idempotent | Re-run the current step |
| POST | `/api/v1/admin/sagas/{sagaId}/resolve` | admin | idempotent | Close a MANUAL_REVIEW saga with a recorded resolution |

## POST /api/v1/checkout

```json
// request: prices and totals are NOT accepted from the browser
{ "items": [{ "sku": "TSHIRT-BLK-M", "quantity": 2 }],
  "currency": "INR",
  "shippingAddress": { "name": "Asha Rao", "line1": "12 MG Road", "city": "Bengaluru",
                       "postalCode": "560001", "country": "IN", "phone": "+919800000000" } }
// 202 Accepted
{ "sagaId": "uuid", "orderId": "uuid", "status": "PROCESSING",
  "statusUrl": "/api/v1/checkout/{sagaId}" }
```
`202` because the work continues asynchronously. The client polls `statusUrl` (every 1–2s,
with backoff) until `checkoutUrl` appears or a terminal state is reached.

## GET /api/v1/checkout/{sagaId}

```json
{ "sagaId": "uuid", "orderId": "uuid",
  "status": "AWAITING_PAYMENT",              // PROCESSING | AWAITING_PAYMENT | COMPLETED | CANCELLED | FAILED
  "checkoutUrl": "https://...",              // present only in AWAITING_PAYMENT
  "failureReason": null }                    // e.g. "OUT_OF_STOCK", "PAYMENT_FAILED"
```
Customer-facing statuses deliberately collapse internal saga states (`RESERVING_INVENTORY`,
`CONFIRMING_ORDER`, ...) so internals can change without breaking the frontend: `PROCESSING`,
`AWAITING_PAYMENT`, `COMPLETED`, `CANCELLED`, `FAILED`, and `UNDER_REVIEW` (manual review).
Other customers' checkouts return 404. Prices and totals in the request are rejected (unknown fields).
