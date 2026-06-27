#!/usr/bin/env node
/**
 * cli.ts — Terminal entry point.
 *
 * Usage:
 *   doc-lok <path-to-file.md> [--lockfile <path>] [--quiet] [--version]
 *
 * Prints the condensed Markdown to stdout.  Diagnostics are written to
 * stderr so they never pollute piped output.
 */

import { condenseMarkdown } from "./parser.js";

interface ParsedArgs {
  file: string | null;
  lockfile: string | null;
  quiet: boolean;
  help: boolean;
  version: boolean;
}

const VERSION = "0.1.0";

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  let file: string | null = null;
  let lockfile: string | null = null;
  let quiet = false;
  let help = false;
  let version = false;

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

  return { file, lockfile, quiet, help, version };
}

function printHelp(): void {
  const text = [
    "doc-lok — pre-prompt context condenser",
    "",
    "USAGE",
    "  doc-lok <path-to-file.md> [options]",
    "",
    "OPTIONS",
    "  --lockfile <path>   Path to an explicit doc-lok.json lockfile.",
    "  -q, --quiet         Suppress diagnostic output (stderr).",
    "  -V, --version       Print version and exit.",
    "  -h, --help          Show this help text.",
    "",
    "OUTPUT",
    "  Condensed Markdown is written to stdout.",
    "  Per-link diagnostics are written to stderr.",
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
    const result = await condenseMarkdown(args.file, args.lockfile ?? undefined);

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
      console.error(
        `  Total tokens saved this run: ${result.tokensSaved}`,
      );
      console.error(`  Lockfile: ${result.lockfilePath}`);
      console.error(`─────────────────────────────────────────\n`);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`doc-lok: fatal error: ${msg}`);
    process.exitCode = 1;
  }
}

main();
