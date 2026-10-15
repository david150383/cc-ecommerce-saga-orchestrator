import type { Env } from "../config/env.js";
import type { Pool } from "../db/pool.js";
import type { Logger } from "../lib/logger.js";
import type { SagaEngine } from "../saga/engine.js";
import { createSns, createSqs } from "./aws.js";
import { InboxConsumer } from "./inbox-consumer.js";
import { OutboxRelay } from "./outbox-relay.js";

/** Background loops: outbox relay, saga-inbox consumer, and the timer (timeouts, retries, recovery). */
export function createWorkers(env: Env, db: Pool, engine: SagaEngine, logger: Logger) {
  const relay = new OutboxRelay(db, createSqs(env), createSns(env), env.OUTBOX_POLL_INTERVAL_MS, logger);
  const inbox = new InboxConsumer(createSqs(env), env.SAGA_INBOX_QUEUE_NAME, engine, logger, env.CONSUMER_WAIT_TIME_SECONDS);
  let timer: NodeJS.Timeout | undefined;
  let timerRun: Promise<unknown> | undefined;
  let stopped = false;

  const tick = () => {
    if (stopped) return;
    timerRun = engine
      .processDue()
      .catch((err: unknown) => logger.error({ err }, "timer tick failed"))
      .finally(() => {
        if (!stopped) timer = setTimeout(tick, env.TIMER_INTERVAL_MS);
      });
  };

  let startup: Promise<void> | undefined;

  return {
    relay,
    inbox,
    /** Resolves once the startup drain is over and the inbox loop and timer are running. */
    start(): Promise<void> {
      if (env.MESSAGING_ENABLED) relay.start();
      startup = (async () => {
        // Apply what arrived during downtime BEFORE judging any deadline (see InboxConsumer.drain).
        if (env.MESSAGING_ENABLED && env.STARTUP_DRAIN_MS > 0) {
          logger.info({ drainMs: env.STARTUP_DRAIN_MS }, "draining saga-inbox before the timer starts");
          const started = Date.now();
          const applied = await inbox.drain(env.STARTUP_DRAIN_MS);
          logger.info({ applied, elapsedMs: Date.now() - started }, "startup drain done");
        }
        if (stopped) return;
        if (env.MESSAGING_ENABLED) inbox.start();
        if (env.TIMER_INTERVAL_MS > 0) tick();
        logger.info({ messaging: env.MESSAGING_ENABLED, timerMs: env.TIMER_INTERVAL_MS }, "saga workers started");
      })();
      return startup;
    },
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await inbox.stop(); // stop taking events first (also ends a startup drain)
      await startup;
      await timerRun;
      await relay.stop();
    },
  };
}
