import { DeleteMessageCommand, GetQueueUrlCommand, type Message, ReceiveMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { z } from "zod";
import type { Logger } from "../lib/logger.js";
import type { InboundEvent, SagaEngine } from "../saga/engine.js";

/**
 * Tolerant reader: the saga validates only the envelope fields it uses. The event schemas belong
 * to their producers; unknown extra fields are ignored so producers can evolve additively.
 */
export const EventEnvelope = z.object({
  messageId: z.uuid(),
  messageKind: z.literal("event"),
  messageType: z.string().min(1),
  correlationId: z.string().min(1),
  sagaId: z.uuid().nullable().optional(),
  payload: z.record(z.string(), z.unknown()),
});

/** Long-polls the saga inbox. Delete-after-success; malformed messages are left for the DLQ. */
export class InboxConsumer {
  private readonly abort = new AbortController();
  private loop: Promise<void> | undefined;
  private queueUrl: string | undefined;

  constructor(
    private readonly sqs: SQSClient,
    private readonly queueName: string,
    private readonly engine: SagaEngine,
    private readonly logger: Logger,
    private readonly waitTimeSeconds = 20,
  ) {}

  start(): void {
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.abort.abort();
    await this.loop;
  }

  async pollOnce(): Promise<number> {
    this.queueUrl ??= (await this.sqs.send(new GetQueueUrlCommand({ QueueName: this.queueName }))).QueueUrl!;
    const { Messages = [] } = await this.sqs.send(
      new ReceiveMessageCommand({ QueueUrl: this.queueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: this.waitTimeSeconds }),
      { abortSignal: this.abort.signal },
    );
    let ok = 0;
    for (const m of Messages) if (await this.process(m)) ok++;
    return ok;
  }

  /**
   * Receives and applies events for `ms` milliseconds (used at startup, before the timer runs).
   * Events that arrived while the service was down must be applied BEFORE deadlines are judged: a
   * payment made in time must not lose to a timeout just because the saga was restarting. `ms` should
   * exceed the queue's visibility timeout, so that a message an instance received just before it was
   * killed (invisible until the timeout expires) is drained too. Returns the number of events applied.
   */
  async drain(ms: number): Promise<number> {
    const until = Date.now() + ms;
    let applied = 0;
    while (!this.abort.signal.aborted && Date.now() < until) {
      try {
        applied += await this.pollOnce();
      } catch (err) {
        if (this.abort.signal.aborted) break;
        this.logger.error({ err, queue: this.queueName }, "receive failed during startup drain; backing off");
        await new Promise((r) => setTimeout(r, 2_000));
      }
    }
    return applied;
  }

  private async run(): Promise<void> {
    while (!this.abort.signal.aborted) {
      try {
        await this.pollOnce();
      } catch (err) {
        if (this.abort.signal.aborted) return;
        this.logger.error({ err, queue: this.queueName }, "receive failed; backing off");
        await new Promise((r) => setTimeout(r, 2_000));
      }
    }
  }

  private async process(message: Message): Promise<boolean> {
    let event: InboundEvent;
    try {
      const parsed = EventEnvelope.parse(JSON.parse(message.Body ?? ""));
      event = { ...parsed, sagaId: parsed.sagaId ?? null };
    } catch (err) {
      this.logger.error({ err, sqsMessageId: message.MessageId }, "malformed event; leaving it for the DLQ");
      return false;
    }
    try {
      await this.engine.handleEvent(event);
    } catch (err) {
      this.logger.warn({ err, messageId: event.messageId, messageType: event.messageType }, "event handling failed; will retry");
      return false;
    }
    await this.sqs.send(new DeleteMessageCommand({ QueueUrl: this.queueUrl!, ReceiptHandle: message.ReceiptHandle! }));
    return true;
  }
}
