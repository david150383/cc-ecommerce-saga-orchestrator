import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";

// Every message schema this service owns must compile, and every example in
// events/examples must validate against the schema with the same base name.
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
