// Writes openapi/openapi.json. A test fails if the committed file is stale.
import { mkdir, writeFile } from "node:fs/promises";
import { buildOpenApiDocument } from "../openapi/document.js";

await mkdir("openapi", { recursive: true });
await writeFile("openapi/openapi.json", `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`);
console.log("wrote openapi/openapi.json");
