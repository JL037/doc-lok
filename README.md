# doc-lok

> **Pre-prompt context condenser for LLM workflows.**
> Read a Markdown file, fetch external hyperlinks, cache them with SHA-256 lockfiles, and replace unchanged links with a tiny HTML comment marker — shrinking context windows by up to 99.5%.
>
> Supports **inline links** `[text](url)`, **reference definitions** `[ref]: url`, and a **round-trip restore** command to inflate markers back into links.

---

## Table of Contents

- [Overview](#overview)
- [Why doc-lok?](#why-doc-lok)
- [Installation](#installation)
- [Quick Start](#quick-start)
  - [CLI Usage](#cli-usage)
  - [Library Usage](#library-usage)
  - [Agent Integration](#agent-integration)
- [How It Works](#how-it-works)
  - [The Lockfile](#the-lockfile)
  - [Network Validation Strategy](#network-validation-strategy)
  - [Token Savings Calculation](#token-savings-calculation)
- [Configuration](#configuration)
  - [Lockfile Resolution](#lockfile-resolution)
  - [Environment Variables](#environment-variables)
- [API Reference](#api-reference)
  - [`checkMarkdown(filePath, lockfilePath?)`](#checkmarkdownfilepath-lockfilepath)
  - [`condenseMarkdown(filePath, lockfilePath?)`](#condensemarkdownfilepath-lockfilepath)
  - [`restoreMarkdown(filePath, lockfilePath?)`](#restoremarkdownfilepath-lockfilepath)
  - [`validateUrl(url, options)`](#validateurlurl-options)
  - [`readLockfile(path)` / `writeLockfile(path, data)`](#readlockfilepath--writelockfilepath-data)
  - [Types](#types)
- [CLI Reference](#cli-reference)
- [Project Structure](#project-structure)
- [Architecture Decisions](#architecture-decisions)
- [Development](#development)
  - [Building](#building)
  - [Scripts](#scripts)
- [Integration Examples](#integration-examples)
  - [Mastra Agent](#mastra-agent)
  - [Shell Pipeline (Python / Go / Rust)](#shell-pipeline-python--go--rust)
  - [GitHub Actions](#github-actions)
- [Limitations & Caveats](#limitations--caveats)
- [Contributing](#contributing)
- [License](#license)

---

## Overview

`doc-lok` is a universal standalone package written in TypeScript that acts as
a **middleware layer between your Markdown documents and your LLM prompts**.

When you feed a Markdown file to an LLM, any `[text](https://...)` links are
included as raw text. If those remote resources haven't changed since the last
run, you're paying for tokens that carry zero new information. `doc-lok`
eliminates that waste:

1. It parses every external `http(s)` hyperlink in the document — both **inline**
   links `[text](url)` and **reference-style** definitions `[ref]: url`.
2. It checks whether the remote content has changed since the last run using
   a local `doc-lok.json` lockfile keyed on **SHA-256 hashes** and **ETags**.
3. Unchanged inline links are replaced with a compact HTML comment marker:
   `<!-- doc-lok:cached#abc123 -->` (the hash makes restore unambiguous).
4. Reference definitions are validated but left intact — they're already cheap
   and removing them would break Markdown rendering.
5. Changed or new links are left intact so the LLM can see them.
6. A **restore** command reverses the operation, turning markers back into links.

This reduces context window consumption by up to **99.5%** per cached link,
dramatically lowering API costs and improving prompt latency.

---

## Why doc-lok?

| Problem | Solution |
|---|---|
| LLM prompts include stale URLs that waste tokens | SHA-256 lockfile detects unchanged content; marker replaces stale links |
| Fetching every URL on every run is slow | HEAD request with `If-None-Match` ETag fast-path skips body transfer entirely |
| Large remote payloads blow up memory | Response body is streamed through an incremental hasher — O(1) memory regardless of payload size |
| Broken links crash the whole pipeline | Each URL is validated in isolation; errors are reported as diagnostics, never fatal |
| Non-JS developers need to use it | CLI binary writes condensed Markdown to stdout — pipe-friendly for Python, Go, Rust, etc. |
| JS/TS developers want to embed it | Clean async `condenseMarkdown()` API with full type definitions |

---

## Installation

### From npm (when published)

```bash
npm install doc-lok
```

### From source

```bash
git clone https://github.com/<your-org>/doc-lok.git
cd doc-lok
npm install
npm run build
```

The compiled output is emitted to `dist/`. The CLI binary is
`dist/cli.js` and the library entry point is `dist/index.js`.

### Prerequisites

- **Node.js ≥ 18** (runtime — uses native `node:https`, `node:crypto`, `structuredClone`)
- **Node.js ≥ 20.19** (development — vitest 4.x with rolldown requires `node:util.styleText`)
- **TypeScript ≥ 5.4** (dev only, for building from source)

No runtime dependencies. `doc-lok` ships with zero `dependencies` in
`package.json` — it relies exclusively on Node.js built-in modules.

---

## Quick Start

### CLI Usage

```bash
# Basic — condensed Markdown to stdout, diagnostics to stderr
doc-lok README.md

# Quiet mode — stdout only, no diagnostic chatter
doc-lok README.md --quiet

# Explicit lockfile location
doc-lok README.md --lockfile /tmp/my-lock.json

# Pipe into another tool
doc-lok README.md --quiet | python3 my-llm-prompter.py

# Restore a previously condensed file back to full links
doc-lok README.md --restore
```

**Example output (condense):**

```
$ doc-lok README.md
# My Project

This is a project. See the docs <!-- doc-lok:cached#100680 --> for details.

─ doc-lok ──────────────────────────────
  ✓ https://example.com/docs  [cached]  saved 342 tok
  ↻ https://example.com/changelog  [updated]  saved 0 tok
  ✗ https://example.com/broken  [error]  saved 0 tok  (GET https://example.com/broken → HTTP 503)
  Total tokens saved this run: 342
  Lockfile: /home/user/project/doc-lok.json
─────────────────────────────────────────
```

**Example output (restore):**

```
$ doc-lok README.md --restore
# My Project

This is a project. See the docs [https://example.com/docs](https://example.com/docs) for details.

─ doc-lok restore ──────────────────────
  Restored 1 link(s)
  Lockfile: /home/user/project/doc-lok.json
─────────────────────────────────────────
```

### Agent Integration

`doc-lok` provides two CLI flags designed for LLM agents and automated workflows:

```bash
# Check URL freshness without modifying the file (non-destructive)
doc-lok README.md --check --json

# Condense with structured JSON output (machine-readable)
doc-lok README.md --json

# Restore with structured JSON output
doc-lok README.md --restore --json
```

**`--check` mode** validates all URLs, updates the lockfile, but does **not**
rewrite the Markdown file. Returns diagnostics + full lockfile state so the
agent can inspect SHAs and decide whether to condense.

**`--json` flag** outputs a structured JSON object to stdout instead of raw
Markdown + human-readable diagnostics. The schema:

```json
{
  "mode": "check | condense | restore",
  "output": "...",
  "diagnostics": [{ "url": "...", "status": "cached|updated|error", "tokensSaved": 0, "message": "..." }],
  "tokensSaved": 342,
  "lockfilePath": "/path/to/doc-lok.json",
  "lockfile": { "version": 1, "global_tokens_saved": 0, "urls": { ... } }
}
```

On fatal errors with `--json`, the output is `{ "error": "message" }` with
exit code 1.

A **skill file** is included at `.windsurf/workflows/doc-lok.md` that teaches
agents how to detect and use doc-lok automatically. See the full agent
decision tree in that file.

### Library Usage

```typescript
import { condenseMarkdown, restoreMarkdown, checkMarkdown } from "doc-lok";

// Check URL freshness without modifying the file
const check = await checkMarkdown("./README.md");
for (const diag of check.diagnostics) {
  console.log(`${diag.url}: ${diag.status}`);
}
console.log(check.lockfile);        // full lockfile state with SHAs

// Condense
const result = await condenseMarkdown("./README.md");
console.log(result.output);         // condensed Markdown string
console.log(result.tokensSaved);    // total tokens saved this run
console.log(result.lockfilePath);   // path to the lockfile used
console.log(result.lockfile);       // full lockfile state after run

for (const diag of result.diagnostics) {
  console.log(`${diag.url}: ${diag.status} (${diag.tokensSaved} tok saved)`);
}

// Restore
const restored = await restoreMarkdown("./condensed.md");
console.log(restored.output);       // Markdown with links restored
console.log(restored.restoredCount); // number of markers replaced
```

---

## How It Works

### The Lockfile

`doc-lok` maintains a JSON lockfile named `doc-lok.json` that persists
cryptographic metadata for every URL it has seen. The structure:

```json
{
  "version": 1,
  "global_tokens_saved": 18432,
  "urls": {
    "https://example.com/docs": {
      "last_known_sha256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      "etag": "\"abc123\"",
      "token_cost_raw": 357,
      "token_cost_compressed": 15,
      "last_checked": "2026-06-27T08:36:00.000Z"
    }
  }
}
```

| Field | Description |
|---|---|
| `version` | Schema version for forward compatibility (currently `1`). |
| `global_tokens_saved` | Running total of tokens saved across all runs. Never resets. |
| `urls` | Map of URL → metadata entry. |
| `urls[*].last_known_sha256` | SHA-256 hex digest of the response body. |
| `urls[*].etag` | HTTP `ETag` header value, or `null` if the server didn't provide one. |
| `urls[*].token_cost_raw` | Estimated token cost of the raw content. |
| `urls[*].token_cost_compressed` | Token cost after condensing (always `18` — the hash-embedded marker size). |
| `urls[*].last_checked` | ISO-8601 timestamp of the last successful validation. |

The lockfile is written **atomically** (write-temp-then-rename) to prevent
corruption from concurrent processes or crashes.

### Network Validation Strategy

`doc-lok` uses a two-phase strategy to minimise network overhead:

```
┌─────────────────────────────────────────────────────────┐
│  Phase 1: HEAD request (fast path)                      │
│                                                         │
│  • Send HTTP HEAD with no body transfer                 │
│  • Extract ETag header                                  │
│  • If ETag matches lockfile → UNCHANGED, skip to result │
│                                                         │
├─────────────────────────────────────────────────────────┤
│  Phase 2: Streamed GET (fallback)                       │
│                                                         │
│  • Issue HTTP GET                                       │
│  • Stream response body through incremental SHA-256     │
│  • Each chunk is hashed then dropped — O(1) memory      │
│  • Compare final digest to lockfile's last_known_sha256 │
│  • Match → UNCHANGED | Mismatch → UPDATED               │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

**Why streaming?** A 100 MB remote resource would crash a naive
`Buffer.concat()` approach. By feeding each chunk into
`crypto.createHash('sha256')` and discarding it immediately, `doc-lok`
maintains constant memory regardless of payload size.

**Why HEAD first?** Many servers (CDNs, GitHub, S3) return reliable ETags.
A matching ETag means the body hasn't changed — no need to download it at
all. This turns a multi-megabyte transfer into a few hundred bytes of
headers.

### Token Savings Calculation

Token estimation uses the heuristic **≈4 characters per token** (standard
for English text and code in modern tokenisers like tiktoken/cl100k_base).

```
token_cost_raw       = ceil(byteLength / 4)     // or ceil(url.length / 4) for HEAD-only
token_cost_compressed = 18                       // fixed: "<!-- doc-lok:cached#hash -->"
tokens_saved          = token_cost_raw - token_cost_compressed
```

The `global_tokens_saved` field in the lockfile accumulates savings across
all runs, giving you a running ROI metric.

---

## Configuration

### Lockfile Resolution

`doc-lok` resolves the lockfile path in the following order (first match
wins):

| Priority | Source | Example |
|---|---|---|
| 1 | Explicit `lockfilePath` argument | `condenseMarkdown("file.md", "/tmp/lock.json")` |
| 2 | `DOC_LOK_LOCKFILE` environment variable | `DOC_LOK_LOCKFILE=/tmp/lock.json doc-lok file.md` |
| 3 | `doc-lok.json` in the Markdown file's directory | `/path/to/file.md` → `/path/to/doc-lok.json` |
| 4 | `doc-lok.json` in `process.cwd()` | Fallback default |

### Environment Variables

| Variable | Description | Default |
|---|---|---|
| `DOC_LOK_LOCKFILE` | Override lockfile path | (see resolution order above) |

---

## API Reference

### `checkMarkdown(filePath, lockfilePath?)`

Validates all http(s) URLs in a Markdown file and updates the lockfile, but
does **not** modify the Markdown file itself. Designed for agents and tools
that need to check freshness before deciding whether to condense.

```typescript
import { checkMarkdown } from "doc-lok";

const result = await checkMarkdown("./README.md");
console.log(result.diagnostics);    // per-URL freshness status
console.log(result.lockfile);       // full lockfile with SHAs + ETags
```

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `filePath` | `string` | Yes | Path to the Markdown file. |
| `lockfilePath` | `string` | No | Explicit lockfile path. |

**Returns:** `Promise<CheckResult>`

### `condenseMarkdown(filePath, lockfilePath?)`

Condenses a Markdown file by replacing unchanged remote **inline** links with an
HTML comment marker. Reference-style definitions are validated but left intact.

```typescript
import { condenseMarkdown } from "doc-lok";

const result = await condenseMarkdown("./README.md", "/custom/lock.json");
```

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `filePath` | `string` | Yes | Path to the Markdown file. |
| `lockfilePath` | `string` | No | Explicit lockfile path. Overrides env var and auto-resolution. |

**Returns:** `Promise<CondenseResult>`

### `restoreMarkdown(filePath, lockfilePath?)`

Restores a previously condensed Markdown file by replacing
`<!-- doc-lok:cached#hash -->` markers back with `[url](url)` links using the
lockfile as a lookup table.

```typescript
import { restoreMarkdown } from "doc-lok";

const result = await restoreMarkdown("./condensed.md");
console.log(result.restoredCount); // 5
```

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `filePath` | `string` | Yes | Path to the condensed Markdown file. |
| `lockfilePath` | `string` | No | Explicit lockfile path. |

**Returns:** `Promise<{ output: string; restoredCount: number; lockfilePath: string }>`

### `validateUrl(url, options)`

Validates a single URL using the HEAD-then-streamed-GET strategy.

```typescript
import { validateUrl } from "doc-lok";

const result = await validateUrl("https://example.com", {
  knownEtag: "\"abc123\"",
  knownSha256: "9f86d0...",
  timeoutMs: 10_000,
});
```

**Parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `url` | `string` | Yes | The HTTP(S) URL to validate. |
| `options.knownEtag` | `string \| null` | No | Previously known ETag for fast-path comparison. |
| `options.knownSha256` | `string \| null` | No | Previously known SHA-256 for content comparison. |
| `options.timeoutMs` | `number` | No | Per-request timeout. Default: `15000`. |
| `options.signal` | `AbortSignal` | No | Abort signal to cancel in-flight requests. |

**Returns:** `Promise<ValidationResult>`

### `readLockfile(path)` / `writeLockfile(path, data)`

Read or write the `doc-lok.json` lockfile directly.

```typescript
import { readLockfile, writeLockfile } from "doc-lok";

const lockfile = await readLockfile("./doc-lok.json");
lockfile.global_tokens_saved += 100;
await writeLockfile("./doc-lok.json", lockfile);
```

### Types

```typescript
interface CondenseResult {
  output: string;              // condensed Markdown
  diagnostics: LinkDiagnostic[];
  tokensSaved: number;         // total saved this run
  lockfilePath: string;        // lockfile path used
  lockfile: Lockfile;          // full lockfile state after run
}

interface CheckResult {
  diagnostics: LinkDiagnostic[];
  tokensSaved: number;         // potential savings if condensed
  lockfilePath: string;        // lockfile path used
  lockfile: Lockfile;          // full lockfile state
}

interface LinkDiagnostic {
  url: string;
  status: "cached" | "updated" | "error";
  tokensSaved: number;
  message?: string;            // present only on error
}

interface Lockfile {
  version: number;
  global_tokens_saved: number;
  urls: Record<string, UrlEntry>;
}

interface UrlEntry {
  last_known_sha256: string;
  etag: string | null;
  token_cost_raw: number;
  token_cost_compressed: number;
  last_checked: string;        // ISO-8601
}

interface ValidationResult {
  unchanged: boolean;
  sha256: string;
  etag: string | null;
  byteLength: number;
  tokenCost: number;
}
```

---

## CLI Reference

```
doc-lok — pre-prompt context condenser

USAGE
  doc-lok <path-to-file.md> [mode] [options]

MODES
  (default)             Condense — replace unchanged links with markers.
  --restore             Inflate — replace markers back with links.

OPTIONS
  --lockfile <path>   Path to an explicit doc-lok.json lockfile.
  -q, --quiet         Suppress diagnostic output (stderr).
  --json              Output structured JSON to stdout (machine-readable).
  --check             Check URL freshness only — do not modify the file.
  -V, --version       Print version and exit.
  -h, --help          Show this help text.

OUTPUT
  Resulting Markdown is written to stdout.
  Per-link diagnostics are written to stderr.
  With --json, a structured JSON object is written to stdout instead.

EXIT CODES
  0   Success (all links processed, some may have errors).
  1   Fatal error (file not found, unreadable, etc.).
  2   Argument parsing error.
```

**Stdout / stderr separation:** The condensed Markdown is written
exclusively to `stdout` and all diagnostics to `stderr`, so the tool is
safe to pipe:

```bash
doc-lok README.md --quiet | llm-prompter
```

**Agent-friendly JSON output:**

```bash
# Check freshness without modifying the file
doc-lok README.md --check --json

# Condense with structured JSON output
doc-lok README.md --json
```

---

## Project Structure

```
doc-lok/
├── package.json          # Dual-purpose: "main"/"types" (library) + "bin" (CLI)
├── tsconfig.json         # Strict TS → ES2022 ESM, emits to dist/
├── vitest.config.ts      # Test runner configuration
├── .gitignore            # Ignores node_modules, dist, lockfiles, env, editor files
├── LICENSE               # MIT
├── README.md             # You are here
├── src/
│   ├── index.ts          # Public API re-exports for library consumers
│   ├── cli.ts            # Terminal entry point (process.argv parser → stdout)
│   ├── parser.ts         # Link extraction, validation orchestration, restore, check
│   ├── network.ts        # HEAD-first ETag fast-path → streamed SHA-256 GET
│   └── state.ts          # Lockfile read/write, per-URL metadata, token estimation
├── test/
│   ├── state.test.ts     # Lockfile I/O, tokens, entry updates (15 tests)
│   ├── network.test.ts   # ETag, SHA-256, errors, timeout (9 tests)
│   ├── parser.test.ts    # Inline link condensing (9 tests)
│   ├── parser-refs.test.ts  # Reference defs + restore (11 tests)
│   ├── cli.test.ts       # CLI flags, exit codes (8 tests)
│   ├── cli-restore.test.ts  # Restore CLI (3 tests)
│   ├── cli-json.test.ts     # --json + --check CLI (8 tests)
│   ├── checkMarkdown.test.ts  # checkMarkdown library API (6 tests)
│   └── hashUrl.test.ts   # URL hashing (4 tests)
├── .github/workflows/
│   └── ci.yml            # GitHub Actions: build + test on Node 18/20/22
└── docs/
    ├── status.md         # Feature matrix, roadmap, build instructions
    └── worklog.md        # Chronological development log
```

### Module Responsibilities

| Module | Responsibility |
|---|---|
| `state.ts` | Manages `doc-lok.json` lifecycle: read, normalise, update entries, atomic write. Tracks `last_known_sha256`, `etag`, `token_cost_raw`, `token_cost_compressed`, `global_tokens_saved`. |
| `network.ts` | HTTP validation engine. Phase 1: `HEAD` request to compare ETags (zero body transfer). Phase 2: streamed `GET` with incremental `crypto.createHash('sha256')` — chunks hashed and dropped, O(1) memory. |
| `parser.ts` | Orchestrates the full pipeline: regex-scan for inline `[text](url)` and reference `[ref]: url` patterns, validate each unique URL via `network.ts`, update lockfile via `state.ts`, replace unchanged inline links with `<!-- doc-lok:cached#hash -->`. Also provides `restoreMarkdown()` to reverse the operation and `checkMarkdown()` for non-destructive freshness checks. |
| `cli.ts` | `process.argv` parser (no external CLI library). Routes condensed Markdown to `stdout`, diagnostics to `stderr`. Supports `--json` for structured agent-readable output and `--check` for non-destructive freshness checks. Exit codes: 0 (ok), 1 (fatal), 2 (arg error). |
| `index.ts` | Barrel file re-exporting the public API surface for `import { condenseMarkdown, checkMarkdown } from "doc-lok"`. |

---

## Architecture Decisions

### Zero runtime dependencies

`doc-lok` uses only Node.js built-in modules (`node:crypto`, `node:http`,
`node:https`, `node:fs`, `node:path`). This eliminates supply-chain risk,
reduces install time, and ensures the package works in any Node ≥ 18
environment without `node_modules` conflicts.

### ESM-first

The package uses `"type": "module"` and emits ES2022 ESM. This aligns with
modern Node.js conventions and enables top-level await in consumers.

### Sequential URL validation

URLs are validated sequentially rather than concurrently. This:
- Keeps memory usage predictable (one in-flight response at a time).
- Avoids overwhelming a single host with parallel requests.
- Prevents connection pool exhaustion on documents with many links.

If you need concurrency, call `validateUrl()` directly with your own
`Promise.allSettled()` pool.

### Error isolation

Each URL validation is wrapped in its own try/catch. A 503, DNS failure,
or timeout on one link produces a `✗` diagnostic but never aborts the
entire run. The condensed output still includes all other successfully
validated links.

### Atomic lockfile writes

The lockfile is written via temp-file-then-rename (`fs.rename`), which is
atomic on POSIX filesystems. This prevents corruption if the process is
killed mid-write or if two `doc-lok` instances run concurrently on the
same project.

---

## Development

### Building

```bash
npm install          # install dev dependencies (typescript, @types/node)
npm run build        # compile src/ → dist/ (tsc)
npm run clean        # remove dist/
```

### Scripts

| Script | Command | Description |
|---|---|---|
| `build` | `tsc` | Compile TypeScript to `dist/` with declarations + source maps. |
| `test` | `vitest run` | Run the full test suite (73 tests, 9 files). |
| `test:watch` | `vitest` | Run tests in watch mode during development. |
| `start` | `node dist/cli.js` | Run the CLI directly (after build). |
| `clean` | `rm -rf dist` | Remove build output. |

---

## Integration Examples

### Mastra Agent

```typescript
import { condenseMarkdown } from "doc-lok";
import { Agent } from "@mastra/core/agent";

const agent = new Agent({ /* ... */ });

async function prepareContext(mdPath: string) {
  const { output, tokensSaved } = await condenseMarkdown(mdPath);
  console.log(`Saved ${tokensSaved} tokens before prompting.`);
  return agent.generate(output);
}
```

### Shell Pipeline (Python / Go / Rust)

```bash
# Python
doc-lok docs/spec.md --quiet | python3 prompt.py

# Go (reading from stdin)
doc-lok docs/spec.md --quiet | ./my-go-binary

# Rust
doc-lok docs/spec.md --quiet | cargo run --bin prompter
```

### GitHub Actions

```yaml
- name: Condense docs before LLM step
  run: |
    npm install -g doc-lok
    doc-lok docs/context.md --quiet > docs/condensed.md
- name: Send to LLM
  run: ./scripts/prompt-llm.sh docs/condensed.md
```

---

## Limitations & Caveats

- **HTTP(S) only:** Only `http://` and `https://` URLs are processed. Relative links, `mailto:`, and other schemes are left untouched.
- **Token estimation is approximate:** The 4-chars-per-token heuristic is an average. Actual token counts vary by tokeniser and content language. Use `token_cost_raw` as a rough guide, not an exact billing figure.
- **ETag reliability varies:** Not all servers return ETags. When absent, `doc-lok` falls back to a full streamed GET + SHA-256 comparison. This is still efficient (O(1) memory) but transfers the full body.
- **No recursive link following:** `doc-lok` condenses links *in the Markdown text* — it does not fetch and inline the content of linked pages. It only checks whether the remote resource has changed.
- **Sequential validation:** URLs are fetched one at a time. For documents with hundreds of links, this may be slow. Use the library API with `validateUrl()` directly if you need concurrent fetching.
- **Lockfile is per-project:** Each project directory gets its own `doc-lok.json`. There is no global cache. Use `--lockfile` or `DOC_LOK_LOCKFILE` to share a lockfile across projects.
- **No authentication:** `doc-lok` does not send auth headers. Private/authenticated URLs will return 401/403 and be marked as errors.
- **Restore uses URL as link text:** Markers are restored as `[url](url)` because the original `[text](url)` is not stored in the lockfile.
- **`--check` still updates the lockfile:** While the Markdown file is not modified in check mode, the lockfile is still written with current SHA-256 / ETag metadata. This is intentional — the lockfile should always reflect the latest known state of remote resources.

---

## Contributing

1. Fork the repository.
2. Create a feature branch: `git checkout -b feat/my-feature`.
3. Build and test: `npm run build`.
4. Commit with conventional commits: `feat: ...`, `fix: ...`, `docs: ...`.
5. Open a pull request.

### Guidelines

- Keep zero runtime dependencies — use only Node.js built-ins.
- Maintain strict TypeScript (`strict: true`, `noUnusedLocals`, `noUnusedParameters`).
- All public API changes must be reflected in `src/index.ts` re-exports.
- Update this README when adding CLI flags, API changes, or new modules.

---

## License

[MIT](./LICENSE)
