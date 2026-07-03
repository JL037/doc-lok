#!/usr/bin/env node
/**
 * cli.ts — Terminal entry point.
 *
 * Usage:
 *   doc-lok <path-to-file.md> [mode] [options]
 *
 * Modes:
 *   (default)             Condense — replace unchanged links with markers.
 *   --restore             Inflate — replace markers back with original links.
 *
 * Prints the resulting Markdown to stdout.  Diagnostics are written to
 * stderr so they never pollute piped output.
 */

import { condenseMarkdown, restoreMarkdown, checkMarkdown } from "./parser.js";
import { readLockfile } from "./state.js";

interface ParsedArgs {
  file: string | null;
  lockfile: string | null;
  quiet: boolean;
  json: boolean;
  check: boolean;
  help: boolean;
  version: boolean;
  restore: boolean;
}

const VERSION = "0.1.3";

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  let file: string | null = null;
  let lockfile: string | null = null;
  let quiet = false;
  let json = false;
  let check = false;
  let help = false;
  let version = false;
  let restore = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case "-h":
      case "--help":
        help = true;
        break;
      case "-V":
      case "--version":
        version = true;
        break;
      case "-q":
      case "--quiet":
        quiet = true;
        break;
      case "--restore":
        restore = true;
        break;
      case "--json":
        json = true;
        break;
      case "--check":
        check = true;
        break;
      case "--lockfile":
        lockfile = args[++i] ?? null;
        break;
      default:
        if (!a.startsWith("-") && file === null) {
          file = a;
        } else {
          console.error(`Unknown argument: ${a}`);
          process.exitCode = 2;
        }
    }
  }

  return { file, lockfile, quiet, json, check, help, version, restore };
}

function printHelp(): void {
  const text = [
    "doc-lok — pre-prompt context condenser",
    "",
    "USAGE",
    "  doc-lok <path-to-file.md> [mode] [options]",
    "",
    "MODES",
    "  (default)             Condense — replace unchanged links with markers.",
    "  --restore             Inflate — replace markers back with links.",
    "",
    "OPTIONS",
    "  --lockfile <path>   Path to an explicit doc-lok.json lockfile.",
    "  -q, --quiet         Suppress diagnostic output (stderr).",
    "  --json              Output structured JSON to stdout (machine-readable).",
    "  --check             Check URL freshness only — do not modify the file.",
    "  -V, --version       Print version and exit.",
    "  -h, --help          Show this help text.",
    "",
    "OUTPUT",
    "  Resulting Markdown is written to stdout.",
    "  Per-link diagnostics are written to stderr.",
    "  With --json, a structured JSON object is written to stdout instead.",
  ].join("\n");
  console.error(text);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  if (args.help) {
    printHelp();
    return;
  }
  if (args.version) {
    console.log(`doc-lok v${VERSION}`);
    return;
  }
  if (!args.file) {
    console.error("Error: no input file specified.\n");
    printHelp();
    process.exitCode = 2;
    return;
  }

  try {
    if (args.check) {
      const result = await checkMarkdown(
        args.file,
        args.lockfile ?? undefined,
      );

      if (args.json) {
        process.stdout.write(
          JSON.stringify({
            mode: "check",
            diagnostics: result.diagnostics,
            tokensSaved: result.tokensSaved,
            lockfilePath: result.lockfilePath,
            lockfile: result.lockfile,
          }, null, 2) + "\n",
        );
      } else {
        process.stderr.write(`\n─ doc-lok check ────────────────────────\n`);
        for (const d of result.diagnostics) {
          const icon =
            d.status === "cached" ? "✓" : d.status === "updated" ? "↻" : "✗";
          const detail = d.message ? `  (${d.message})` : "";
          process.stderr.write(
            `  ${icon} ${d.url}  [${d.status}]  ${detail}\n`,
          );
        }
        process.stderr.write(`  Lockfile: ${result.lockfilePath}\n`);
        process.stderr.write(`─────────────────────────────────────────\n\n`);
      }
    } else if (args.restore) {
      const result = await restoreMarkdown(
        args.file,
        args.lockfile ?? undefined,
      );

      if (args.json) {
        const lockfile = await readLockfile(result.lockfilePath);
        process.stdout.write(
          JSON.stringify({
            mode: "restore",
            output: result.output,
            restoredCount: result.restoredCount,
            lockfilePath: result.lockfilePath,
            lockfile,
          }, null, 2) + "\n",
        );
      } else {
        process.stdout.write(result.output);

        if (!args.quiet) {
          console.error(`\n─ doc-lok restore ──────────────────────`);
          console.error(`  Restored ${result.restoredCount} link(s)`);
          console.error(`  Lockfile: ${result.lockfilePath}`);
          console.error(`─────────────────────────────────────────\n`);
        }
      }
    } else {
      const result = await condenseMarkdown(
        args.file,
        args.lockfile ?? undefined,
      );

      if (args.json) {
        process.stdout.write(
          JSON.stringify({
            mode: "condense",
            output: result.output,
            diagnostics: result.diagnostics,
            tokensSaved: result.tokensSaved,
            lockfilePath: result.lockfilePath,
            lockfile: result.lockfile,
          }, null, 2) + "\n",
        );
      } else {
        // Condensed Markdown → stdout (pipe-friendly).
        process.stdout.write(result.output);

        if (!args.quiet) {
          console.error(`\n─ doc-lok ──────────────────────────────`);
          for (const d of result.diagnostics) {
            const icon =
              d.status === "cached" ? "✓" : d.status === "updated" ? "↻" : "✗";
            const detail = d.message ? `  (${d.message})` : "";
            console.error(
              `  ${icon} ${d.url}  [${d.status}]  saved ${d.tokensSaved} tok${detail}`,
            );
          }
          console.error(`  Total tokens saved this run: ${result.tokensSaved}`);
          console.error(`  Lockfile: ${result.lockfilePath}`);
          console.error(`─────────────────────────────────────────\n`);
        }
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (args.json) {
      process.stdout.write(
        JSON.stringify({ error: msg }, null, 2) + "\n",
      );
    } else {
      console.error(`doc-lok: fatal error: ${msg}`);
    }
    process.exitCode = 1;
  }
}

main();
