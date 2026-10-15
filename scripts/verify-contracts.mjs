// Vendored from ecommerce-contracts. Do not edit: re-vendor instead.
//
// Fails if a vendored contract file differs from what contracts.lock.json pinned (a hand edit, or a
// file added or removed outside `vendor.mjs`). Contracts change in ecommerce-contracts, through a
// release; this service then pins the new release deliberately.
import console from "node:console";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import process from "node:process";

const root = process.argv[2] ?? process.cwd();
const lock = JSON.parse(readFileSync(join(root, "contracts.lock.json"), "utf8"));
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const walk = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));

const problems = [];
for (const [file, hash] of Object.entries(lock.files)) {
  try {
    if (sha(join(root, file)) !== hash) problems.push(`modified: ${file}`);
  } catch {
    problems.push(`missing: ${file}`);
  }
}
for (const dir of lock.directories) {
  for (const f of walk(join(root, dir))) {
    const rel = relative(root, f);
    if (!(rel in lock.files)) problems.push(`not from the contracts release: ${rel}`);
  }
}
if (problems.length) {
  console.error(`✗ Vendored contracts do not match ${lock.source}@${lock.version} (${lock.commit.slice(0, 12)}):`);
  for (const p of problems) console.error(`  ${p}`);
  console.error("Change contracts in ecommerce-contracts, release, then re-vendor (see its VERSIONING.md).");
  process.exit(1);
}
console.log(`✓ ${Object.keys(lock.files).length} contract files match ${lock.source}@${lock.version}`);
