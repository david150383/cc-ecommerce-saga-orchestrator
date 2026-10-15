import { DeleteTopicCommand, ListSubscriptionsByTopicCommand, ListTopicsCommand, type SNSClient, UnsubscribeCommand } from "@aws-sdk/client-sns";
import { DeleteQueueCommand, ListQueuesCommand, type SQSClient } from "@aws-sdk/client-sqs";

/**
 * Deletes what one test run created in the emulator, by the run's unique prefix (e.g. "t-ab12cd34ef-"),
 * so runs do not pile up queues and topics. Refuses any prefix that is not a per-run test prefix.
 */
function assertTestPrefix(prefix: string): void {
  if (!/^(t|test)-[a-z0-9-]{6,}-$/.test(prefix)) throw new Error(`refusing to delete resources for prefix ${prefix}`);
}

export async function deleteTestQueues(sqs: SQSClient, prefix: string): Promise<void> {
  assertTestPrefix(prefix);
  const { QueueUrls = [] } = await sqs.send(new ListQueuesCommand({ QueueNamePrefix: prefix }));
  for (const url of QueueUrls) {
    if (url.slice(url.lastIndexOf("/") + 1).startsWith(prefix)) await sqs.send(new DeleteQueueCommand({ QueueUrl: url }));
  }
}

export async function deleteTestTopics(sns: SNSClient, prefix: string): Promise<void> {
  assertTestPrefix(prefix);
  let next: string | undefined;
  do {
    const page = await sns.send(new ListTopicsCommand({ NextToken: next }));
    for (const { TopicArn } of page.Topics ?? []) {
      if (!TopicArn || !TopicArn.slice(TopicArn.lastIndexOf(":") + 1).startsWith(prefix)) continue;
      const { Subscriptions = [] } = await sns.send(new ListSubscriptionsByTopicCommand({ TopicArn }));
      for (const s of Subscriptions) if (s.SubscriptionArn?.startsWith("arn:")) await sns.send(new UnsubscribeCommand({ SubscriptionArn: s.SubscriptionArn }));
      await sns.send(new DeleteTopicCommand({ TopicArn }));
    }
    next = page.NextToken;
  } while (next);
}
