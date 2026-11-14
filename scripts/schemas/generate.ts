import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildJsonSchemas } from "../../packages/core/src/schemas/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const schemas = buildJsonSchemas();

for (const [rel, value] of Object.entries(schemas)) {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  const json = JSON.stringify(value, null, 2) + "\n";
  const prev = (() => {
    try {
      return readFileSync(abs, "utf8");
    } catch {
      return null;
    }
  })();
  if (prev !== json) writeFileSync(abs, json);
}
console.log(`generated ${Object.keys(schemas).length} schema files`);
