#!/usr/bin/env node
/**
 * e2e-test.ts — End-to-end runner for your own Markdown files.
 *
 * Usage:
 *   npx tsx scripts/e2e-test.ts /path/to/your/file.md
 *
 * This script runs doc-lok against a real file in three modes:
 *   1. Check — validates URLs without modifying the file
 *   2. Condense — replaces unchanged links with markers
 *   3. Restore — inflates markers back to links
 *
 * It prints a summary and exits with a non-zero code if any
 * links are broken.
 */

import { condenseMarkdown, checkMarkdown, restoreMarkdown } from "../src/parser.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";

const filePath = process.argv[2];

if (!filePath) {
  console.error("Usage: npx tsx scripts/e2e-test.ts <path-to-file.md>");
  process.exit(2);
}

async function main() {
  const absolute = path.resolve(filePath);
  const stats = await fs.stat(absolute).catch(() => null);
  if (!stats) {
    console.error(`File not found: ${absolute}`);
    process.exit(1);
  }

  console.log(`\n📄 doc-lok e2e test for: ${absolute}\n`);

  // ── Phase 1: Check (non-destructive) ────────────────────────────
  console.log("── Phase 1: Check URL freshness ──────────────────────────");
  const check = await checkMarkdown(absolute);

  const cached = check.diagnostics.filter((d) => d.status === "cached");
  const updated = check.diagnostics.filter((d) => d.status === "updated");
  const errors = check.diagnostics.filter((d) => d.status === "error");

  for (const d of check.diagnostics) {
    const icon = d.status === "cached" ? "✅" : d.status === "updated" ? "🔄" : "❌";
    const msg = d.message ? `  (${d.message})` : "";
    console.log(`  ${icon} ${d.url}  [${d.status}]  saved ${d.tokensSaved} tok${msg}`);
  }

  console.log(`\n  Cached:   ${cached.length}`);
  console.log(`  Updated:  ${updated.length}`);
  console.log(`  Errors:   ${errors.length}`);
  console.log(`  Potential tokens saved: ${check.tokensSaved}`);
  console.log(`  Lockfile: ${check.lockfilePath}`);

  // ── Phase 2: Condense ──────────────────────────────────────────
  console.log("\n── Phase 2: Condense ─────────────────────────────────────");
  const condensed = await condenseMarkdown(absolute);

  const condensedOut = absolute.replace(/\.md$/, ".condensed.md");
  await fs.writeFile(condensedOut, condensed.output, "utf8");
  console.log(`  Written: ${condensedOut}`);
  console.log(`  Tokens saved this run: ${condensed.tokensSaved}`);

  // ── Phase 3: Restore ─────────────────────────────────────────────
  console.log("\n── Phase 3: Restore ──────────────────────────────────────");
  const restored = await restoreMarkdown(condensedOut);

  const restoredOut = absolute.replace(/\.md$/, ".restored.md");
  await fs.writeFile(restoredOut, restored.output, "utf8");
  console.log(`  Written: ${restoredOut}`);
  console.log(`  Links restored: ${restored.restoredCount}`);

  // ── Summary ──────────────────────────────────────────────────────
  console.log("\n─────────────────────────────────────────────────────────");
  console.log(`  Total links found:    ${check.diagnostics.length}`);
  console.log(`  Broken links:         ${errors.length}`);
  console.log(`  Round-trip fidelity:  ${restored.restoredCount} markers restored`);

  if (errors.length > 0) {
    console.log("\n  ⚠️  Some links failed validation. Review diagnostics above.");
    process.exitCode = 1;
  } else {
    console.log("\n  ✅ All links healthy.");
  }
}

main().catch((err) => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
