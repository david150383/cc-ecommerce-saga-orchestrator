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

  return {
    relay,
    inbox,
    start() {
      if (env.MESSAGING_ENABLED) {
        relay.start();
        inbox.start();
      }
      if (env.TIMER_INTERVAL_MS > 0) tick();
      logger.info({ messaging: env.MESSAGING_ENABLED, timerMs: env.TIMER_INTERVAL_MS }, "saga workers started");
    },
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await inbox.stop(); // stop taking events first
      await timerRun;
      await relay.stop();
    },
  };
}
