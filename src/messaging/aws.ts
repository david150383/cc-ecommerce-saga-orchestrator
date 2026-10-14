import { SNSClient } from "@aws-sdk/client-sns";
import { SQSClient } from "@aws-sdk/client-sqs";
import type { Env } from "../config/env.js";

export function createSqs(env: Env): SQSClient {
  return new SQSClient({
    region: env.AWS_REGION,
    ...(env.AWS_ENDPOINT_URL && { endpoint: env.AWS_ENDPOINT_URL }),
    // Always use the configured endpoint, never the host inside a QueueUrl
    // (locally the emulator returns http://floci:4566/..., which only resolves inside Docker).
    useQueueUrlAsEndpoint: false,
  });
}

export function createSns(env: Env): SNSClient {
  return new SNSClient({ region: env.AWS_REGION, ...(env.AWS_ENDPOINT_URL && { endpoint: env.AWS_ENDPOINT_URL }) });
}
