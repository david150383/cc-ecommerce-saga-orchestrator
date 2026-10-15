import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";

// Every message schema vendored from ecommerce-contracts (owned, sent or received) must compile,
// and every example in events/examples must validate against the schema with the same base name.
const schemasDir = join(import.meta.dirname, "..", "events", "schemas");
const examplesDir = join(import.meta.dirname, "..", "events", "examples");

const ajv = new Ajv2020({ strict: true, strictTypes: false, allErrors: true });
addFormats.default(ajv);
ajv.addVocabulary(["x-producer", "x-consumers", "x-channel", "x-message-kind"]);

const schemaFiles = readdirSync(schemasDir).filter((f) => f.endsWith(".schema.json"));
for (const file of schemaFiles) {
  ajv.addSchema(JSON.parse(readFileSync(join(schemasDir, file), "utf8")));
}

const idFor = (file: string) => (JSON.parse(readFileSync(join(schemasDir, file), "utf8")) as { $id: string }).$id;
const messageSchemas = schemaFiles.filter((f) => !f.startsWith("envelope."));

describe("event and command schemas", () => {
  it("has at least the envelope schema", () => {
    expect(schemaFiles).toContain("envelope.v1.schema.json");
  });

  it.each(messageSchemas)("%s has a valid example", (file) => {
    const validate = ajv.getSchema(idFor(file));
    expect(validate, `schema ${file} failed to compile`).toBeDefined();
    const example = JSON.parse(readFileSync(join(examplesDir, file.replace(".schema.json", ".json")), "utf8"));
    const valid = validate!(example);
    expect(validate!.errors ?? [], `example for ${file} is invalid`).toEqual([]);
    expect(valid).toBe(true);
  });

  it.each(messageSchemas)("%s rejects an envelope without a messageId", (file) => {
    const validate = ajv.getSchema(idFor(file))!;
    const example = JSON.parse(readFileSync(join(examplesDir, file.replace(".schema.json", ".json")), "utf8"));
    delete example.messageId;
    expect(validate(example)).toBe(false);
  });
});

describe("pinned contracts (ecommerce-contracts)", () => {
  it("vendored schemas and examples match contracts.lock.json (no hand edits)", () => {
    expect(() => execFileSync(process.execPath, [join(import.meta.dirname, "..", "scripts", "verify-contracts.mjs"), join(import.meta.dirname, "..")], { stdio: "pipe" })).not.toThrow();
  });
});

/**
 * Consumer-driven expectations: the payload fields the saga RELIES ON, per event it receives. Each must
 * be REQUIRED by the producer's published schema (a producer may drop an optional field at any time),
 * and the producer's own example must get through the saga's inbox parser. Bumping the contracts pin to
 * a release that breaks this fails here, before anything is deployed.
 */
const RELIES_ON: Record<string, string[]> = {
  InventoryReserved: ["orderId", "reservationId"],
  InventoryReservationFailed: ["orderId", "reason"],
  InventoryReservationConfirmed: ["orderId"],
  InventoryReservationReleased: ["orderId"],
  PaymentSucceeded: ["orderId", "paymentId"],
  PaymentFailed: ["orderId"],
  RefundSucceeded: ["orderId"],
  RefundFailed: ["orderId"],
  OrderConfirmed: ["orderId"],
  OrderCancelled: ["orderId"],
};

describe("events the saga consumes (consumer contract)", () => {
  const consumed = messageSchemas
    .map((f) => ({ file: f, schema: JSON.parse(readFileSync(join(schemasDir, f), "utf8")) }))
    .filter(({ schema }) => schema["x-message-kind"] === "event" && (schema["x-consumers"] ?? []).includes("ecommerce-saga-orchestrator"));

  it("covers exactly the events the saga declares it relies on", () => {
    expect(consumed.map((c) => c.schema.properties.messageType.const).sort()).toEqual(Object.keys(RELIES_ON).sort());
  });

  it.each(consumed.map((c) => [c.schema.properties.messageType.const, c]))("%s: relied-on fields are guaranteed, and the example parses", async (type, { file, schema }) => {
    const required: string[] = schema.properties.payload.required ?? [];
    for (const field of RELIES_ON[type as string]!) expect(required, `${type}.payload.${field} must be required by the producer`).toContain(field);
    const { EventEnvelope } = await import("../src/messaging/inbox-consumer.js");
    const example = JSON.parse(readFileSync(join(examplesDir, file.replace(".schema.json", ".json")), "utf8"));
    expect(() => EventEnvelope.parse(example)).not.toThrow();
  });
});
