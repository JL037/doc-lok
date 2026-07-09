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

import { condenseMarkdown, restoreMarkdown, checkMarkdown, inlineMarkdown } from "./parser.js";
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
  allowPrivate: boolean;
  inline: boolean;
  maxBytes: number | null;
  cacheDir: string | null;
  sections: string[];
  converter: "minimal" | "turndown" | null;
}

const VERSION = "0.2.2";

/** Parse a positive integer or exit with code 2. Used by `--max-bytes`. */
function parsePositiveInt(raw: string | undefined, flag: string): number {
  if (raw === undefined) {
    console.error(`Error: ${flag} requires a value.`);
    process.exit(2);
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`Error: ${flag} must be a positive integer (got "${raw}").`);
    process.exit(2);
  }
  return n;
}

/** Parse the `--converter` flag value or exit with code 2. */
function parseConverter(raw: string | undefined): "minimal" | "turndown" {
  if (raw === undefined || (raw !== "minimal" && raw !== "turndown")) {
    console.error(`Error: --converter must be "minimal" or "turndown" (got "${raw ?? ""}").`);
    process.exit(2);
  }
  return raw;
}

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
  let allowPrivate = false;
  let inline = false;
  let maxBytes: number | null = null;
  let cacheDir: string | null = null;
  const sections: string[] = [];
  let converter: "minimal" | "turndown" | null = null;

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
      case "--allow-private":
        allowPrivate = true;
        break;
      case "--inline":
        inline = true;
        break;
      case "--max-bytes":
        maxBytes = parsePositiveInt(args[++i], "--max-bytes");
        break;
      case "--cache-dir":
        cacheDir = args[++i] ?? null;
        break;
      case "--section":
        sections.push(args[++i] ?? "");
        break;
      case "--converter":
        converter = parseConverter(args[++i]);
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

  return {
    file, lockfile, quiet, json, check, help, version, restore,
    allowPrivate, inline, maxBytes, cacheDir, sections, converter,
  };
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
    "  --inline              Inline — fetch linked page bodies, convert to",
    "                        Markdown, inject a block under each link. Default",
    "                        injects the table of contents only; use",
    "                        --section to choose what to inline.",
    "",
    "OPTIONS",
    "  --lockfile <path>     Path to an explicit .doc-lok/lock.json lockfile.",
    "  -q, --quiet           Suppress diagnostic output (stderr).",
    "  --json                Output structured JSON to stdout (machine-readable).",
    "  --check               Check URL freshness only — do not modify the file.",
    "  --allow-private       Allow URLs that resolve to private / loopback /",
    "                        link-local ranges. Off by default (SSRF guard).",
    "  --inline              Inline mode (see MODES above).",
    "  --section <name>      Inline only the named section(s) from the linked page.",
    "                        Repeatable: --section auth --section api.",
    "                        Special: --section all (full body),",
    "                        --section toc (index only).",
    "                        Default (no --section): inline the table of contents.",
    "  --converter <mode>    HTML to Markdown converter: \"minimal\" (default)",
    "                        or \"turndown\" (requires the turndown peer dep).",
    "  --max-bytes <n>       Refuse --inline bodies larger than <n> bytes.",
    "                        Default 1,048,576 (1 MB).",
    "  --cache-dir <path>    Override the .doc-lok/cache/ directory used by",
    "                        --inline to store cached bodies.",
    "  -V, --version         Print version and exit.",
    "  -h, --help            Show this help text.",
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
        { allowPrivate: args.allowPrivate },
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
    } else if (args.inline) {
      const result = await inlineMarkdown(
        args.file,
        args.lockfile ?? undefined,
        {
          allowPrivate: args.allowPrivate,
          maxBytes: args.maxBytes ?? undefined,
          cacheDir: args.cacheDir ?? undefined,
          sections: args.sections.length > 0 ? args.sections : undefined,
          converter: args.converter ?? undefined,
        },
      );

      if (args.json) {
        process.stdout.write(
          JSON.stringify({
            mode: "inline",
            output: result.output,
            diagnostics: result.diagnostics,
            tokensSaved: result.tokensSaved,
            lockfilePath: result.lockfilePath,
            lockfile: result.lockfile,
            cacheDir: result.cacheDir,
            inlinedCount: result.inlinedCount,
          }, null, 2) + "\n",
        );
      } else {
        // Inlined Markdown → stdout (pipe-friendly).
        process.stdout.write(result.output);

        if (!args.quiet) {
          console.error(`\n─ doc-lok inline ──────────────────────`);
          for (const d of result.diagnostics) {
            const icon =
              d.status === "cached" ? "✓" : d.status === "updated" ? "↻" : "✗";
            const detail = d.message ? `  (${d.message})` : "";
            console.error(
              `  ${icon} ${d.url}  [${d.status}]${detail}`,
            );
          }
          console.error(`  Inlined ${result.inlinedCount} link(s)`);
          console.error(`  Cache: ${result.cacheDir}`);
          console.error(`  Lockfile: ${result.lockfilePath}`);
          console.error(`─────────────────────────────────────────\n`);
        }
      }
    } else {
      const result = await condenseMarkdown(
        args.file,
        args.lockfile ?? undefined,
        { allowPrivate: args.allowPrivate },
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
              `  ${icon} ${d.url}  [${d.status}]  saved ~${d.tokensSaved} tok${detail}`,
            );
          }
          console.error(`  Total est. tokens saved this run: ${result.tokensSaved}`);
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
