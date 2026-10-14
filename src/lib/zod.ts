import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

// Adds .openapi(...) so the same schema validates requests AND generates the OpenAPI document.
extendZodWithOpenApi(z);

export { z };
