# doc-lok — Project Status

> Last updated: 2026-06-27

## At a Glance

| Metric | Value |
|--------|-------|
| Version | `0.1.3` |
| Runtime dependencies | **0** (built-in Node.js modules only) |
| Dev dependencies | `typescript`, `@types/node`, `vitest` |
| Source files | 6 modules (`cli.ts`, `index.ts`, `network.ts`, `parser.ts`, `scanner.ts`, `state.ts`) |
| Test coverage | **79 tests** across 10 suites |
| CI/CD | GitHub Actions (Node 20 / 22) |

---

## Capabilities Recap

### What doc-lok Does

`doc-lok` is a **pre-prompt context condenser** for LLM workflows. You give it a Markdown file; it gives you back a version where unchanged external links are replaced with tiny HTML comment markers, shrinking your context window by up to **99.5%** per cached link.

It supports a **full round-trip**: condense → (edit/read) → restore.

### Markdown Link Support

| Syntax | Example | Condensed? | Validated? |
|--------|---------|------------|------------|
| Inline link | `[text](https://example.com)` | ✅ Yes — replaced with marker | ✅ Yes |
| Inline with title | `[text](https://example.com "Title")` | ✅ Yes | ✅ Yes |
| Reference definition | `[ref]: https://example.com` | ❌ No — left intact | ✅ Yes |
| Reference with title | `[ref]: https://example.com "Title"` | ❌ No — left intact | ✅ Yes |
| Reference with angle brackets | `[ref]: <https://example.com>` | ❌ No — left intact | ✅ Yes |
| Non-HTTP(S) | `[text](mailto:a@b.com)` | ❌ No — ignored | ❌ No |

Reference definitions are **not condensed** because they are already token-cheap (just a URL) and removing them would break Markdown renderers that expect `[ref]` usage elsewhere in the document. They are still validated so the lockfile stays current.

Links inside code spans or code blocks (inline backticks, fenced ` ``` ` / `~~~`, and indented blocks) are **ignored** — they are treated as code, not Markdown.

### Network Validation

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

### The Marker Format

Old: `<!-- doc-lok:cached -->` (ambiguous, not restorable)

New: `<!-- doc-lok:cached#abc123 -->` (embeds 6-char SHA-256 hash of the URL)

The hash makes `restoreMarkdown()` unambiguous — even if 10 different URLs were condensed in the same document, each marker knows exactly which URL it represents.

### Interfaces

#### CLI
```bash
# Condense (default)
doc-lok <file.md> [--lockfile <path>] [--quiet] [--json] [--version] [--help]

# Restore / inflate
doc-lok <file.md> --restore [--lockfile <path>] [--quiet] [--json]

# Check URL freshness without modifying the file
doc-lok <file.md> --check [--lockfile <path>] [--json]
```

- Condensed/restored output → `stdout` (pipe-friendly)
- Diagnostics → `stderr`
- With `--json`, a structured JSON object is written to `stdout` instead
- Exit codes: `0` (ok), `1` (fatal), `2` (arg error)

#### Library API
```typescript
import { condenseMarkdown, restoreMarkdown } from "doc-lok";

// Condense
const { output, diagnostics, tokensSaved, lockfilePath } =
  await condenseMarkdown("docs/spec.md");

// Restore
const { output, restoredCount, lockfilePath } =
  await restoreMarkdown("docs/condensed.md");
```

#### Low-level utilities
`validateUrl()`, `readLockfile()`, `writeLockfile()`, `resolveLockfilePath()`, `estimateTokens()`, `updateEntry()`, `hashUrl()`

---

## What's Missing / Next Up

| Priority | Item | Notes |
|----------|------|-------|
| ✅ Done | **npm publish** | Latest `doc-lok@0.1.3` published 2026-07-03. |
| ✅ Done | **Code-block-aware parsing** | `src/scanner.ts` skips links inside inline code, fenced blocks, and indented blocks. |
| ✅ Done | **Agent CLI modes** | `--check` and `--json` flags for non-destructive, machine-readable output. |
| ✅ Done | **Honest token accounting** | `cached` flag in lockfile prevents double-counting savings across runs. |
| 🟡 Medium | **Custom HTTP headers** | `--header "Authorization: Bearer ..."` for private URLs. |
| 🟡 Medium | **Watch mode** | `--watch` flag for iterative prompt development. |
| 🟡 Medium | **Retry logic / rate limiting** | Single attempt only; no exponential backoff. |
| 🟢 Low | **Config file support** | `.doc-lokrc.json` or similar for persistent defaults. |
| 🟢 Low | **Concurrency option** | Currently sequential; opt-in `Promise.allSettled` pool. |
| 🟢 Low | **Restore with original link text** | Currently restores `[url](url)`; storing original `[text](url)` in lockfile would be nicer. |

---

## Known Limitations

1. **HTTP(S) only** — Relative links, `mailto:`, `ftp://`, etc. are left untouched.
2. **Token estimation is approximate** — 4 chars/token heuristic; actual counts vary by tokenizer.
3. **No authentication** — Private URLs return 401/403 and are marked as errors.
4. **No recursive following** — Only validates linked URLs, does not inline their content.
5. **Sequential validation** — One URL at a time; slow for documents with 100+ links.
6. **Restore uses URL as link text** — Markers are restored as `[url](url)` because the original `[text](url)` is not stored in the lockfile.

---

## How to Build & Test

```bash
# Install dev dependencies
npm install

# Compile TypeScript
npm run build

# Run all tests (79 tests across 10 suites)
npm test

# Run tests in watch mode
npm run test:watch

# Run the CLI
node dist/cli.js path/to/file.md

# Restore a condensed file
node dist/cli.js path/to/condensed.md --restore

# Check freshness without modifying the file
node dist/cli.js path/to/file.md --check --json
```

---

## Architecture Decisions (Locked)

- **Zero runtime dependencies** — Eliminates supply-chain risk and `node_modules` bloat.
- **ESM-first** — Aligns with modern Node.js; enables top-level await in consumers.
- **Atomic lockfile writes** — `fs.writeFile(tmp)` → `fs.rename()` prevents corruption.
- **HEAD-before-GET** — Saves bandwidth when ETags are present and match.
- **Streamed hashing** — `crypto.createHash` fed per-chunk; memory stays flat even for multi-MB payloads.
- **Hash-embedded markers** — `<!-- doc-lok:cached#abc123 -->` encodes a 6-char URL hash so restore is unambiguous even when the same marker appears multiple times for different URLs.
- **Reference definitions stay put** — Already compact; removing them breaks Markdown rendering.
- **Code-block-aware scanning** — `src/scanner.ts` tracks Markdown code state so links inside code spans/blocks are never condensed.
- **Honest token accounting** — The lockfile tracks a `cached` flag per URL; savings are only counted the first time a link is successfully cached, preventing inflation across repeated runs.
