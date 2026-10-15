import { CreateTopicCommand, SNSClient, SubscribeCommand } from "@aws-sdk/client-sns";
import { CreateQueueCommand, GetQueueAttributesCommand, ReceiveMessageCommand, SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createWorkers } from "../src/messaging/runner.js";
import { auth, buildTestContext, checkoutBody, event, expireDeadlines, newId, resetDatabase, stateOf } from "./helpers.js";
import { deleteTestQueues, deleteTestTopics } from "./test-cleanup.js";

// Runs against the local AWS emulator (Floci), with a private set of queues and a topic per run.
const endpoint = process.env.TEST_AWS_ENDPOINT_URL ?? "http://localhost:4566";
process.env.AWS_ACCESS_KEY_ID ??= "test";
process.env.AWS_SECRET_ACCESS_KEY ??= "test";
const sqs = new SQSClient({ region: "us-east-1", endpoint, useQueueUrlAsEndpoint: false });
const sns = new SNSClient({ region: "us-east-1", endpoint });

const id = newId().slice(-10);
const names = {
  inventory: `t-${id}-inventory-commands`,
  order: `t-${id}-order-commands.fifo`,
  payment: `t-${id}-payment-commands`,
  inbox: `t-${id}-saga-inbox`,
  inboxDlq: `t-${id}-saga-inbox-dlq`,
  probe: `t-${id}-probe`,
};
let topicArn: string;
const url = (name: string) => `${endpoint}/000000000000/${name}`;

async function arn(name: string) {
  return (await sqs.send(new GetQueueAttributesCommand({ QueueUrl: url(name), AttributeNames: ["QueueArn"] }))).Attributes!.QueueArn!;
}

async function drain(name: string, wait = 2) {
  const out: { body: { messageType: string; sagaId: string; payload: Record<string, unknown> }; group?: string }[] = [];
  for (let i = 0; i < 10; i++) {
    const { Messages = [] } = await sqs.send(
      new ReceiveMessageCommand({ QueueUrl: url(name), MaxNumberOfMessages: 10, WaitTimeSeconds: i === 0 ? wait : 1, MessageSystemAttributeNames: ["MessageGroupId"], VisibilityTimeout: 30 }),
    );
    if (Messages.length === 0) break;
    const parse = (b: string) => {
      try {
        return JSON.parse(b);
      } catch {
        return { messageType: "(unparseable)", raw: b }; // e.g. poison messages in a DLQ
      }
    };
    out.push(...Messages.map((m) => ({ body: parse(m.Body!), group: m.Attributes?.MessageGroupId })));
    if (name.endsWith(".fifo")) {
      // FIFO: a group stays locked while its messages are in flight; delete to receive the rest.
      const { DeleteMessageBatchCommand } = await import("@aws-sdk/client-sqs");
      await sqs.send(new DeleteMessageBatchCommand({ QueueUrl: url(name), Entries: Messages.map((m, n) => ({ Id: String(n), ReceiptHandle: m.ReceiptHandle! })) }));
    }
  }
  return out;
}

afterAll(async () => {
  await deleteTestTopics(sns, `t-${id}-`);
  await deleteTestQueues(sqs, `t-${id}-`);
});

beforeAll(async () => {
  await sqs.send(new CreateQueueCommand({ QueueName: names.inventory }));
  await sqs.send(new CreateQueueCommand({ QueueName: names.payment }));
  await sqs.send(new CreateQueueCommand({ QueueName: names.order, Attributes: { FifoQueue: "true" } }));
  await sqs.send(new CreateQueueCommand({ QueueName: names.inboxDlq }));
  await sqs.send(
    new CreateQueueCommand({
      QueueName: names.inbox,
      Attributes: { VisibilityTimeout: "1", RedrivePolicy: JSON.stringify({ deadLetterTargetArn: await arn(names.inboxDlq), maxReceiveCount: 2 }) },
    }),
  );
  await sqs.send(new CreateQueueCommand({ QueueName: names.probe }));
  topicArn = (await sns.send(new CreateTopicCommand({ Name: `t-${id}-saga-events` }))).TopicArn!;
  await sns.send(new SubscribeCommand({ TopicArn: topicArn, Protocol: "sqs", Endpoint: await arn(names.probe), Attributes: { RawMessageDelivery: "true" } }));
});

let ctx: Awaited<ReturnType<typeof buildTestContext>>;
let workers: ReturnType<typeof createWorkers>;

beforeEach(async () => {
  await resetDatabase();
  ctx = await buildTestContext(
    { AWS_ENDPOINT_URL: endpoint, SAGA_INBOX_QUEUE_NAME: names.inbox, CONSUMER_WAIT_TIME_SECONDS: "1" },
    { queues: { inventory: names.inventory, order: names.order, payment: names.payment }, eventsTopicArn: topicArn },
  );
  workers = createWorkers(ctx.env, ctx.db, ctx.engine, ctx.logger); // not started: driven step by step
  for (const n of [names.inventory, names.order, names.payment, names.probe]) await drain(n, 0);
});

async function checkout() {
  const res = await request(ctx.app).post("/api/v1/checkout").set(await auth(["customer"])).set("Idempotency-Key", newId()).send(checkoutBody);
  return res.body as { sagaId: string; orderId: string };
}

describe("outbox relay", () => {
  it("routes commands to their queues: FIFO group = order id, deduplication id = messageId", async () => {
    const s = await checkout();
    expect(await workers.relay.publishPending()).toBe(2);
    const order = await drain(names.order);
    expect(order.map((m) => m.body.payload.toStatus)).toEqual(["INVENTORY_RESERVING"]);
    expect(order[0]!.group).toBe(s.orderId);
    const inventory = await drain(names.inventory);
    expect(inventory.map((m) => m.body.messageType)).toEqual(["InventoryReservationRequested"]);
    expect(inventory[0]!.body.sagaId).toBe(s.sagaId);
  });

  it("two relays racing keep each saga's order-commands in send order", async () => {
    const sagas: { sagaId: string; orderId: string }[] = [];
    for (let i = 0; i < 4; i++) {
      const s = await checkout();
      sagas.push(s);
      // Queue several transitions per saga before anything is published.
      await ctx.engine.handleEvent(event(s.sagaId, "InventoryReserved", { reservationId: newId(), orderId: s.orderId }));
      await ctx.engine.handleEvent(event(s.sagaId, "PaymentSucceeded", { orderId: s.orderId }));
      await ctx.engine.handleEvent(event(s.sagaId, "InventoryReservationConfirmed", { orderId: s.orderId }));
    }
    const second = createWorkers(ctx.env, ctx.db, ctx.engine, ctx.logger);
    await Promise.all([workers.relay.publishPending(), second.relay.publishPending(), workers.relay.publishPending()]);

    const byOrder = new Map<string, string[]>();
    for (const m of await drain(names.order)) byOrder.set(m.group!, [...(byOrder.get(m.group!) ?? []), String(m.body.payload.toStatus)]);
    for (const s of sagas) {
      expect(byOrder.get(s.orderId)).toEqual(["INVENTORY_RESERVING", "INVENTORY_RESERVED", "PAYMENT_PENDING", "PAYMENT_SUCCEEDED", "CONFIRMED"]);
    }
  });

  it("publishes saga events to the SNS topic", async () => {
    ctx.orders.mode = "reject";
    await checkout();
    await workers.relay.publishPending();
    const probe = await drain(names.probe);
    expect(probe.map((m) => m.body.messageType)).toEqual(["CheckoutFailed"]);
  });
});

describe("saga inbox consumer", () => {
  it("applies events delivered over SQS and deletes them", async () => {
    const s = await checkout();
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: url(names.inbox),
        MessageBody: JSON.stringify({ ...event(s.sagaId, "InventoryReserved", { reservationId: newId(), orderId: s.orderId }), messageKind: "event", messageVersion: 1, producer: "ecommerce-inventory-service", occurredAt: new Date().toISOString(), causationId: null, idempotencyKey: null }),
      }),
    );
    expect(await workers.inbox.pollOnce()).toBe(1);
    expect((await stateOf(s.sagaId)).state).toBe("AWAITING_PAYMENT");
  });

  it("malformed events are never deleted: they end up in the DLQ", async () => {
    await sqs.send(new SendMessageCommand({ QueueUrl: url(names.inbox), MessageBody: "{not json" }));
    await sqs.send(new SendMessageCommand({ QueueUrl: url(names.inbox), MessageBody: JSON.stringify({ messageType: "X", payload: {} }) }));
    for (let i = 0; i < 3; i++) {
      expect(await workers.inbox.pollOnce()).toBe(0);
      await new Promise((r) => setTimeout(r, 1_200));
    }
    await workers.inbox.pollOnce();
    expect(await drain(names.inboxDlq, 3)).toHaveLength(2);
  });
});

describe("startup: events that arrived during downtime win over deadlines", () => {
  it("the drain is bounded by wall-clock time even with a long receive wait", async () => {
    const slow = await buildTestContext({ AWS_ENDPOINT_URL: endpoint, SAGA_INBOX_QUEUE_NAME: names.inbox, CONSUMER_WAIT_TIME_SECONDS: "20", MESSAGING_ENABLED: "true" });
    const w = createWorkers(slow.env, slow.db, slow.engine, slow.logger);
    const started = Date.now();
    await w.inbox.drain(1_500); // an empty queue with a 20 s long poll must not hold the drain for 20 s
    expect(Date.now() - started).toBeLessThan(4_000);
    await w.stop();
  });

  async function scenario(drainMs: string) {
    const live = await buildTestContext(
      { AWS_ENDPOINT_URL: endpoint, SAGA_INBOX_QUEUE_NAME: names.inbox, CONSUMER_WAIT_TIME_SECONDS: "1", MESSAGING_ENABLED: "true", TIMER_INTERVAL_MS: "50", STARTUP_DRAIN_MS: drainMs },
      { queues: { inventory: names.inventory, order: names.order, payment: names.payment }, eventsTopicArn: topicArn },
    );
    await drain(names.inbox, 0);
    const s = await checkout();
    await live.engine.handleEvent(event(s.sagaId, "InventoryReserved", { reservationId: newId(), orderId: s.orderId }));
    expect((await stateOf(s.sagaId)).state).toBe("AWAITING_PAYMENT");
    // While the saga was "down": the customer paid in time, and the deadline then passed.
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: url(names.inbox),
        MessageBody: JSON.stringify({ ...event(s.sagaId, "PaymentSucceeded", { orderId: s.orderId, paymentId: newId() }), messageKind: "event", messageVersion: 1, producer: "ecommerce-payment-service", occurredAt: new Date().toISOString(), causationId: null, idempotencyKey: null }),
      }),
    );
    await expireDeadlines();
    const w = createWorkers(live.env, live.db, live.engine, live.logger);
    await w.start(); // restart
    await new Promise((r) => setTimeout(r, 500)); // let the timer tick a few times
    await w.stop();
    return (await stateOf(s.sagaId)).state;
  }

  it("with the startup drain: the waiting payment is applied first, the order is not cancelled", async () => {
    expect(await scenario("2500")).toBe("CONFIRMING_INVENTORY");
  });

  it("without it (STARTUP_DRAIN_MS=0) the timer cancels a checkout paid in time, and the payment is refunded: the bug", async () => {
    expect(["CANCELLING", "CANCELLED", "REFUNDING"]).toContain(await scenario("0"));
  });
});

describe("startup: during the drain, retries progress but deadlines wait", () => {
  it("a failed payment-intent step is retried during the drain; an expired payment deadline is judged only after it", async () => {
    const live = await buildTestContext(
      { AWS_ENDPOINT_URL: endpoint, SAGA_INBOX_QUEUE_NAME: names.inbox, CONSUMER_WAIT_TIME_SECONDS: "1", MESSAGING_ENABLED: "true", TIMER_INTERVAL_MS: "50", STARTUP_DRAIN_MS: "3000" },
      { queues: { inventory: names.inventory, order: names.order, payment: names.payment }, eventsTopicArn: topicArn },
    );
    await drain(names.inbox, 0);
    // A: its payment-intent call failed (the Payment Service was down), retry due.
    live.payments.mode = "down";
    const a = await checkout();
    await live.engine.handleEvent(event(a.sagaId, "InventoryReserved", { reservationId: newId(), orderId: a.orderId }));
    expect((await stateOf(a.sagaId)).state).toBe("INVENTORY_RESERVED");
    // B: waiting for a payment whose deadline has passed.
    live.payments.mode = "ok";
    const b = await checkout();
    await live.engine.handleEvent(event(b.sagaId, "InventoryReserved", { reservationId: newId(), orderId: b.orderId }));
    expect((await stateOf(b.sagaId)).state).toBe("AWAITING_PAYMENT");
    await expireDeadlines();

    const w = createWorkers(live.env, live.db, live.engine, live.logger);
    const startup = w.start();
    await new Promise((r) => setTimeout(r, 1_000)); // inside the 3 s drain
    expect((await stateOf(a.sagaId)).state).toBe("AWAITING_PAYMENT"); // retried: forward progress
    expect((await stateOf(b.sagaId)).state).toBe("AWAITING_PAYMENT"); // deadline NOT judged yet
    await startup;
    await new Promise((r) => setTimeout(r, 500));
    expect((await stateOf(b.sagaId)).state).not.toBe("AWAITING_PAYMENT"); // judged after the drain
    await w.stop();
  });
});
