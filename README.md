# ecommerce-saga-orchestrator

Coordinates checkout across Order, Inventory and Payment. It persists every saga transition and outgoing command in one transaction (outbox), waits for result events, enforces timeouts, runs compensation, recovers after crashes, and escalates to manual review. Workflow: `ecommerce-infrastructure/docs/architecture/checkout-saga.md`.

| | |
|---|---|
| Stack | Node.js 24, Express 5, TypeScript 5.9, PostgreSQL 17 (`pg`, node-pg-migrate SQL migrations), AWS SDK v3 (SNS/SQS), jose 6, Zod 4 |
| Port | 4007 |
| Database | `saga_db` (PostgreSQL), owned exclusively by this service |
| API docs | [docs/api.md](docs/api.md) |
| Messages | [docs/events.md](docs/events.md), [events/schemas](events/schemas) |

## Status

| Phase | Done |
|---|---|
| 1: skeleton | ✅ app factory, zod-validated config, pino logging with secret redaction, correlation IDs, RFC 9457 errors, health/readiness, graceful shutdown, Dockerfile, CI, message schemas with validated examples |
| 3: features | ✅ Durable checkout saga: pure state machine, transactional outbox, inbox consumer with dedupe, timeouts/retries/compensation, crash recovery, manual review, admin API. See [docs/saga.md](docs/saga.md) |

## Run locally

```bash
cp .env.example .env
npm install
npm run dev            # http://localhost:4007/health/live
npm test
```

Dependencies: `docker compose up -d` here (standalone Postgres on 5447), or in `ecommerce-infrastructure`
(whole platform, Postgres on 5432 + Floci on 4566). `npm run db:migrate` applies the SQL migrations in
`migrations/`. `npm test` needs Postgres and Floci.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Watch mode with `.env` |
| `npm test` | Vitest + Supertest (in-process) and message-schema validation |
| `npm run lint` / `npm run typecheck` | ESLint / `tsc --noEmit` |
| `npm run build && npm start` | Compile to `dist/` and run |
| `docker build -t ecommerce-saga-orchestrator .` | Production image (non-root, multi-stage) |

## Layout

```
src/app.ts            createApp(): Express app without listen(), used by tests
src/server.ts         entry point: listen + graceful shutdown on SIGTERM/SIGINT
src/config/env.ts     validated environment
src/lib/              logger (redaction), RFC 9457 problem details
src/middleware/       correlation/request IDs, error handling
src/routes/health.ts  /health/live, /health/ready
events/schemas        JSON Schemas for messages this service owns
events/examples       one valid example per schema
```
