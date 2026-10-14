-- Up Migration

-- Every state of the checkout saga. See docs/saga.md for the state machine.
CREATE TYPE saga_state AS ENUM (
  'STARTED',               -- persisted; next: create the order (synchronous call)
  'RESERVING_INVENTORY',   -- waiting for InventoryReserved / InventoryReservationFailed
  'INVENTORY_RESERVED',    -- next: create the payment intent (synchronous call)
  'AWAITING_PAYMENT',      -- waiting for PaymentSucceeded / PaymentFailed / timeout
  'CONFIRMING_INVENTORY',  -- paid; waiting for InventoryReservationConfirmed
  'CONFIRMING_ORDER',      -- waiting for OrderConfirmed
  'COMPLETED',             -- terminal
  'CANCELLING',            -- compensating; waiting for the results listed in compensation.awaiting
  'REFUNDING',             -- money must go back; waiting for RefundSucceeded
  'CANCELLED',             -- terminal (re-opened only by a late payment that must be refunded)
  'FAILED',                -- terminal: rejected before anything was reserved or paid
  'MANUAL_REVIEW',         -- automatic compensation could not be verified; a human decides
  'RESOLVED'               -- terminal: closed by an operator after manual review
);

CREATE TABLE saga_instances (
  id               uuid PRIMARY KEY,
  customer_id      uuid NOT NULL,
  idempotency_key  varchar(255) NOT NULL,
  request_hash     char(64) NOT NULL,
  request          jsonb NOT NULL,                 -- the checkout request (items, currency, address, coupon)
  state            saga_state NOT NULL,
  order_id         uuid,
  total_minor      bigint CHECK (total_minor >= 0),
  currency         char(3),
  reservation_id   uuid,
  payment_id       uuid,
  checkout_url     text,
  failure_reason   varchar(100),
  -- Compensation bookkeeping: which result events are still expected, and refund details.
  compensation     jsonb NOT NULL DEFAULT '{"awaiting": []}',
  step_attempts    integer NOT NULL DEFAULT 0,     -- retries of the CURRENT step
  deadline_at      timestamptz,                    -- timeout (waiting states) or next attempt (synchronous steps)
  lease_until      timestamptz,                    -- set while one instance runs a synchronous step
  version          integer NOT NULL DEFAULT 1,     -- optimistic locking
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,
  CONSTRAINT uq_saga_customer_idempotency_key UNIQUE (customer_id, idempotency_key)
);

-- The timer loop: sagas whose deadline has passed.
CREATE INDEX ix_saga_deadline ON saga_instances (deadline_at) WHERE deadline_at IS NOT NULL;
-- Events from services that only know the order id.
CREATE INDEX ix_saga_order ON saga_instances (order_id);
-- Admin views (e.g. everything in MANUAL_REVIEW).
CREATE INDEX ix_saga_state ON saga_instances (state, created_at);

-- Append-only history of every transition: the saga's audit trail.
CREATE TABLE saga_steps (
  id          bigserial PRIMARY KEY,
  saga_id     uuid NOT NULL REFERENCES saga_instances (id) ON DELETE CASCADE,
  from_state  saga_state,
  to_state    saga_state NOT NULL,
  trigger     varchar(80) NOT NULL,                -- e.g. event:InventoryReserved, timeout, sync:order-created
  message_id  uuid,                                -- the event that caused it, when there was one
  detail      jsonb,
  at          timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX ix_saga_steps_saga ON saga_steps (saga_id, id);

-- Transactional outbox for commands (to SQS queues) and saga events (to the SNS topic).
-- seq gives a strict per-saga publication order (needed by the FIFO order-commands queue).
CREATE TABLE outbox (
  seq               bigserial PRIMARY KEY,
  id                uuid NOT NULL UNIQUE,          -- = envelope.messageId
  saga_id           uuid NOT NULL,
  destination_kind  varchar(5) NOT NULL CHECK (destination_kind IN ('queue', 'topic')),
  destination       varchar(255) NOT NULL,          -- queue name or topic ARN
  group_id          varchar(128),                   -- MessageGroupId for FIFO queues
  message_type      varchar(100) NOT NULL,
  envelope          jsonb NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_at      timestamptz,
  attempts          integer NOT NULL DEFAULT 0
);
CREATE INDEX ix_outbox_pending ON outbox (saga_id, seq) WHERE published_at IS NULL;

-- Incoming events already applied (SQS delivers at least once).
CREATE TABLE processed_messages (
  message_id    uuid PRIMARY KEY,
  saga_id       uuid,
  message_type  varchar(100) NOT NULL,
  processed_at  timestamptz NOT NULL DEFAULT now()
);

-- Down Migration

DROP TABLE processed_messages;
DROP TABLE outbox;
DROP TABLE saga_steps;
DROP TABLE saga_instances;
DROP TYPE saga_state;
