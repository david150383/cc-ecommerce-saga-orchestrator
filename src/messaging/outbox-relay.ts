import { PublishCommand, type SNSClient } from "@aws-sdk/client-sns";
import { GetQueueUrlCommand, SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { type Pool, transaction } from "../db/pool.js";
import type { Logger } from "../lib/logger.js";

interface OutboxRow {
  seq: bigint;
  id: string;
  destination_kind: "queue" | "topic";
  destination: string;
  group_id: string | null;
  message_type: string;
  envelope: Record<string, unknown>;
}

/**
 * Publishes committed outbox rows: commands to SQS queues, saga events to SNS.
 *
 * Per-saga ORDER is preserved: a row is only eligible when no OLDER row of the same saga is still
 * unpublished. Combined with FOR UPDATE SKIP LOCKED this holds across relay instances (a locked
 * head-of-line row blocks the rest of its saga for everyone), which the FIFO order-commands queue
 * relies on. Different sagas still publish in parallel. At-least-once: a crash after sending but
 * before marking re-sends the row; receivers are idempotent, and FIFO queues additionally dedupe
 * on MessageDeduplicationId (= messageId) for five minutes.
 */
export class OutboxRelay {
  private readonly queueUrls = new Map<string, string>();
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private stopped = false;

  constructor(
    private readonly db: Pool,
    private readonly sqs: SQSClient,
    private readonly sns: SNSClient,
    private readonly intervalMs: number,
    private readonly logger: Logger,
    private readonly batchSize = 50,
  ) {}

  start(): void {
    const tick = () => {
      if (this.stopped) return;
      this.running = this.publishPending()
        .then(() => undefined)
        .catch((err: unknown) => this.logger.error({ err }, "outbox relay tick failed"))
        .finally(() => {
          if (!this.stopped) this.timer = setTimeout(tick, this.intervalMs);
        });
    };
    tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }

  /** Publishes until nothing is eligible (or a send fails). Returns how many rows were published. */
  async publishPending(): Promise<number> {
    let total = 0;
    for (;;) {
      const result = await transaction(this.db, async (c) => {
        const { rows } = await c.query<OutboxRow>(
          `SELECT o.seq, o.id, o.destination_kind, o.destination, o.group_id, o.message_type, o.envelope
             FROM outbox o
            WHERE o.published_at IS NULL
              AND NOT EXISTS (SELECT 1 FROM outbox p WHERE p.saga_id = o.saga_id AND p.published_at IS NULL AND p.seq < o.seq)
            ORDER BY o.seq
            LIMIT $1
              FOR UPDATE SKIP LOCKED`,
          [this.batchSize],
        );
        let ok = 0;
        for (const row of rows) {
          try {
            await this.send(row);
          } catch (err) {
            await c.query(`UPDATE outbox SET attempts = attempts + 1 WHERE seq = $1`, [row.seq]);
            this.logger.warn({ err, messageId: row.id, messageType: row.message_type, destination: row.destination }, "publish failed; will retry");
            return { ok, again: false };
          }
          await c.query(`UPDATE outbox SET published_at = now(), attempts = attempts + 1 WHERE seq = $1`, [row.seq]);
          ok++;
        }
        // Publishing a head-of-line row may have made the next row of the same saga eligible.
        return { ok, again: rows.length > 0 };
      });
      total += result.ok;
      if (!result.again) return total;
    }
  }

  private async send(row: OutboxRow): Promise<void> {
    const body = JSON.stringify(row.envelope);
    const attributes = { messageType: { DataType: "String", StringValue: row.message_type } };
    if (row.destination_kind === "topic") {
      await this.sns.send(new PublishCommand({ TopicArn: row.destination, Message: body, MessageAttributes: attributes }));
      return;
    }
    const fifo = row.destination.endsWith(".fifo");
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: await this.queueUrl(row.destination),
        MessageBody: body,
        MessageAttributes: attributes,
        ...(fifo && { MessageGroupId: row.group_id ?? row.id, MessageDeduplicationId: row.id }),
      }),
    );
  }

  private async queueUrl(name: string): Promise<string> {
    let url = this.queueUrls.get(name);
    if (!url) {
      url = (await this.sqs.send(new GetQueueUrlCommand({ QueueName: name }))).QueueUrl!;
      this.queueUrls.set(name, url);
    }
    return url;
  }
}
