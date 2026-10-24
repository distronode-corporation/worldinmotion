// Writes the test vectors (SPEC section 16) into packages/protocol/vectors/.
import { mkdirSync, writeFileSync } from "node:fs";
import { buildVectors } from "./vectors.ts";

const dir = new URL("../vectors/", import.meta.url);
mkdirSync(dir, { recursive: true });
for (const [name, text] of Object.entries(buildVectors())) {
  writeFileSync(new URL(name, dir), text);
  console.log(`wrote vectors/${name} (${text.length} bytes)`);
}
