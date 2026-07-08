# doc-lok — CLI Reference

> Complete, detailed guide to using the `doc-lok` command-line tool.
>
> For the high-level project overview, see the [README](../README.md).
> For current capabilities and roadmap, see [docs/status.md](./status.md).

---

## Table of Contents

- [What `doc-lok` Does](#what-doc-lok-does)
- [Installation](#installation)
- [System Requirements](#system-requirements)
- [Quick Start](#quick-start)
- [The Three Modes](#the-three-modes)
  - [Condense (default)](#1-condense-default)
  - [Restore (`--restore`)](#2-restore---restore)
  - [Check (`--check`)](#3-check---check)
- [Flags Reference](#flags-reference)
- [Output Channels](#output-channels-stdout--stderr)
- [JSON Output Schema](#json-output-schema)
- [Exit Codes](#exit-codes)
- [The Lockfile](#the-lockfile)
- [The Marker Format](#the-marker-format)
- [Network Behavior](#network-behavior)
- [Code-Block Awareness](#code-block-awareness)
- [Markdown Syntax Coverage](#markdown-syntax-coverage)
- [Workflows](#workflows)
  - [Piping into another tool](#1-piping-into-another-tool)
  - [Agent / LLM integration](#2-agent--llm-integration)
  - [GitHub Actions](#3-github-actions)
  - [Condense → edit → restore round-trip](#4-condense--edit--restore-round-trip)
- [Condense vs. Check: When to Use Which](#condense-vs-check-when-to-use-which)
- [Environment Variables](#environment-variables)
- [Troubleshooting](#troubleshooting)
- [Limitations & Known Caveats](#limitations--known-caveats)

---

## What `doc-lok` Does

`doc-lok` is a **pre-prompt context condenser** for LLM workflows. You give it a Markdown file. It:

1. Scans the file for external `http(s)` links (inline `[text](url)` and reference `[ref]: url`).
2. Validates each link against the remote server (using a SHA-256 + ETag lockfile to detect change).
3. Replaces **unchanged inline links** with a tiny HTML comment marker — shrinking the prompt.
4. Leaves **changed or new links** intact so the LLM can see them.
5. (Optional) Reverses the operation with `--restore`, inflating markers back into links.

It does **not** fetch and inline remote page *content* — only link text. See [Limitations](#limitations--known-caveats).

---

## Installation

### Option A — As a global CLI

```bash
npm install -g doc-lok
doc-lok --version
```

### Option B — As a local project dependency

```bash
npm install doc-lok
npx doc-lok README.md
```

### Option C — From source

```bash
git clone https://github.com/<your-org>/doc-lok.git
cd doc-lok
npm install
npm run build            # emits dist/
node dist/cli.js --version
```

The compiled CLI binary lives at `dist/cli.js` after `npm run build`.

---

## System Requirements

- **Node.js ≥ 18** at runtime (uses native `node:https`, `node:crypto`, `structuredClone`).
- **Node.js ≥ 20.19** for development (vitest 4.x requires `node:util.styleText`).
- **No runtime dependencies** — only Node.js built-in modules are used.

---

## Quick Start

```bash
# 1. Condense — replaces unchanged links with markers
doc-lok README.md

# 2. Output goes to stdout; diagnostics go to stderr
doc-lok README.md > condensed.md

# 3. Pipe-friendly mode (no stderr noise)
doc-lok README.md --quiet | llm-prompter

# 4. Reverse the condense operation
doc-lok condensed.md --restore

# 5. Check link freshness without rewriting the file
doc-lok README.md --check

# 6. Structured JSON output for agents
doc-lok README.md --check --json
```

---

## The Three Modes

### 1. Condense (default)

**What it does:** Reads the markdown, validates every `http(s)` URL, replaces **unchanged inline** links with a marker, leaves changed/new inline links and all reference definitions intact. Writes condensed markdown to stdout. Updates the lockfile on disk.

```bash
doc-lok README.md
```

**Behavior per link type:**

| Link type | Unchanged | Changed / new | Error |
|---|---|---|---|
| Inline `[text](url)` | Replaced with `<!-- doc-lok:cached#hash -->` | Left intact | Left intact, error reported in diagnostics |
| Reference `[ref]: url` | Left intact | Left intact | Left intact, error reported |
| Code-block links | Never touched | Never touched | Never validated |

**On first run:** No URL has been seen, so there's nothing cached yet. Every URL is fetched, every inline link is left intact (changed), and the lockfile is populated so the *next* run can condense them. The first run is essentially a warmed-up cache.

**On subsequent runs:** A link whose SHA-256 / ETag matches the lockfile is considered unchanged and replaced with a marker. A link whose content changed is left intact.

---

### 2. Restore (`--restore`)

**What it does:** Reverses condensing. Scans the markdown for `<!-- doc-lok:cached#hash -->` markers, looks up the original URL (and anchor text) in the lockfile, and inflates the marker back to `[text](url)`.

```bash
doc-lok condensed.md --restore
```

**Output:** The restored markdown on stdout, plus a small report on stderr:

```
─ doc-lok restore ──────────────────────
  Restored 3 link(s)
  Lockfile: /path/to/doc-lok.json
─────────────────────────────────────────
```

**Note:** Restore does **not** perform any network requests. It only consults the lockfile. If a marker's hash has no matching lockfile entry (e.g., lockfile deleted), the marker is left intact so you can investigate.

---

### 3. Check (`--check`)

**What it does:** Validates every URL and updates the lockfile, but **does not modify the markdown file**. The output is purely diagnostic. Designed for agents and tools that want to inspect freshness before deciding whether to condense.

```bash
doc-lok README.md --check
```

**Important:** `--check` **still writes the lockfile** with the latest SHA-256 / ETag / `last_checked` metadata. Only the Markdown file itself is left untouched. See [Condense vs. Check](#condense-vs-check-when-to-use-which).

---

## Flags Reference

### Synopsis

```
doc-lok <path-to-file.md> [mode] [options]
```

Order does not matter, but the first non-flag argument is treated as the markdown file path.

### Flags

| Flag | Short | Type | Description |
|------|-------|------|-------------|
| `--restore` | — | mode | Restore markers back into links. Mutually exclusive with `--check`. |
| `--check` | — | mode | Check freshness only; don't rewrite the file. Mutually exclusive with `--restore`. |
| `--lockfile <path>` | — | string | Path to an explicit `doc-lok.json` lockfile. Overrides env var and auto-resolution. |
| `--quiet` | `-q` | bool | Suppress human-readable diagnostics on stderr. Condensed markdown still goes to stdout. |
| `--json` | — | bool | Emit structured JSON on stdout instead of raw markdown + diagnostics. See [JSON Output Schema](#json-output-schema). |
| `--version` | `-V` | bool | Print version (`doc-lok v0.2.0`) and exit. |
| `--help` | `-h` | bool | Print help text and exit. |

### Mode interaction

- If both `--restore` and `--check` are passed, behaviour is determined by parse order — `--check` is checked first in the CLI's `if/else` chain, so `--check` wins. Don't rely on this; pass only one mode.
- `--json` is independent of mode — it works with condense, restore, and check.

### `--lockfile` details

If you pass `--lockfile` with **no following argument**, the parser silently defaults to auto-resolution. (Currently a bug — see [Troubleshooting](#troubleshooting).) Always pass an explicit path after `--lockfile`.

```bash
# Correct
doc-lok README.md --lockfile /tmp/my-lock.json

# Bug: silently falls back to default
doc-lok README.md --lockfile
```

### `--quiet` details

`-q` suppresses only stderr diagnostic output. Stdout (the condensed/restored markdown, or the JSON object) is **never** suppressed. Safe to use even when piping.

```bash
# Quiet + JSON together: machine-readable only
doc-lok README.md --quiet --json
```

---

## Output Channels (stdout / stderr)

`doc-lok` is designed for safe piping. Two channels are strictly separated:

| Channel | Contents |
|---------|----------|
| `stdout` | The condensed / restored markdown (raw text). With `--json`, a structured JSON object instead. |
| `stderr` | Human-readable diagnostics: per-link status, totals, lockfile path. Suppressed by `--quiet`. |

This means you can always pipe stdout into another tool without contamination:

```bash
# Safe: stderr can't pollute the pipe
doc-lok README.md --quiet | python3 prompt.py
```

Or capture diagnostics separately:

```bash
doc-lok README.md > condensed.md 2> diagnostics.log
```

---

## JSON Output Schema

With `--json`, `doc-lok` writes a single JSON object to stdout. The shape depends on the mode.

### Common envelope

All success responses share these top-level keys:

```jsonc
{
  "mode": "condense | restore | check",
  "output": "... the rewritten markdown ...",
  "lockfilePath": "/path/to/doc-lok.json",
  "lockfile": { /* full lockfile state, see Lockfile section */ }
}
```

### Condense

```jsonc
{
  "mode": "condense",
  "output": "# My Project\n\nSee <!-- doc-lok:cached#abc123 --> for details.\n",
  "diagnostics": [
    { "url": "https://example.com/docs", "status": "cached", "tokensSaved": 342 },
    { "url": "https://example.com/changelog", "status": "updated", "tokensSaved": 0 },
    { "url": "https://example.com/broken", "status": "error", "tokensSaved": 0, "message": "..." }
  ],
  "tokensSaved": 342,
  "lockfilePath": "/home/user/project/doc-lok.json",
  "lockfile": { /* ... */ }
}
```

### Restore

```jsonc
{
  "mode": "restore",
  "output": "# My Project\n\nSee [Documentation](https://example.com/docs) for details.\n",
  "restoredCount": 1,
  "lockfilePath": "/home/user/project/doc-lok.json",
  "lockfile": { /* ... */ }
}
```

### Check

```jsonc
{
  "mode": "check",
  "diagnostics": [
    { "url": "https://example.com/docs", "status": "cached", "tokensSaved": 342 },
    ...
  ],
  "tokensSaved": 342,
  "lockfilePath": "/home/user/project/doc-lok.json",
  "lockfile": { /* ... */ }
}
```

Note: `--check --json` does **not** include an `output` key (the markdown file is not rewritten).

### Fatal error response (`--json` mode)

On a fatal error (file not found, unreadable, lockfile write failure, etc.), `--json` emits:

```json
{
  "error": "ENOENT: no such file or directory, open 'missing.md'"
}
```

…with exit code `1`. Per-URL errors are **not** fatal — they appear inside `diagnostics` with `status: "error"`.

### `diagnostics[*]` shape

```typescript
interface LinkDiagnostic {
  url: string;                            // the URL that was checked
  status: "cached" | "updated" | "error"; // result of validation
  tokensSaved: number;                    // tokens saved THIS run for THIS URL
  message?: string;                       // present only when status === "error"
}
```

### `lockfile` shape

See [The Lockfile](#the-lockfile) section below for the full structure. The same object is included verbatim in the JSON output.

---

## Exit Codes

| Code | Meaning | When |
|------|---------|------|
| `0`  | Success | All URLs processed (some may have per-link errors). |
| `1`  | Fatal error | File not found, unreadable, lockfile write failure, etc. |
| `2`  | Argument error | Unknown flag, or no input file specified. |

**Important:** Per-URL network errors (503, DNS failure, timeout, 404) are **not** fatal. They appear in diagnostics with `status: "error"` but the run still exits `0`. The condensed output still contains all other successfully validated links.

If you want the CLI to fail on any URL error, parse the JSON output and check `diagnostics[].status` yourself.

---

## The Lockfile

`doc-lok` maintains a JSON lockfile (`doc-lok.json`) that persists SHA-256 digests, ETags, and token-savings metadata for every URL it has seen.

### Schema

```json
{
  "version": 2,
  "global_tokens_saved": 18432,
  "urls": {
    "https://example.com/docs": {
      "last_known_sha256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      "etag": "\"abc123\"",
      "token_cost_raw": 357,
      "token_cost_compressed": 18,
      "last_checked": "2026-06-27T08:36:00.000Z",
      "cached": true,
      "original_text": "read the docs"
    }
  }
}
```

### Field reference

| Field | Description |
|---|---|
| `version` | Schema version for forward compatibility (currently `2`). |
| `global_tokens_saved` | Running total of tokens saved across all runs. |
| `urls` | Map of URL → metadata entry. |
| `urls[*].last_known_sha256` | SHA-256 hex digest of the response body. |
| `urls[*].etag` | HTTP `ETag` header value, or `null` if the server didn't provide one. |
| `urls[*].token_cost_raw` | Estimated token cost of the raw content. |
| `urls[*].token_cost_compressed` | Token cost after condensing (always `18` — the marker size). |
| `urls[*].last_checked` | ISO-8601 timestamp of the last successful validation. |
| `urls[*].cached` | `true` once this URL has been successfully cached. Prevents double-counting savings. |
| `urls[*].original_text` | Original anchor text (e.g., `Documentation`). Stored so `--restore` can reconstruct `[Documentation](url)` instead of `[url](url)`. Only present when the text differs from the URL. |

### Lockfile resolution

The lockfile path is resolved in this order (first match wins):

| Priority | Source | Example |
|---|---|---|
| 1 | Explicit `--lockfile` argument | `doc-lok README.md --lockfile /tmp/custom.json` |
| 2 | `DOC_LOK_LOCKFILE` environment variable | `DOC_LOK_LOCKFILE=/tmp/lock.json doc-lok README.md` |
| 3 | `doc-lok.json` in the Markdown file's directory | `/path/to/file.md` → `/path/to/doc-lok.json` |
| 4 | `doc-lok.json` in `process.cwd()` | Fallback default |

Note: priority 3 and 4 collapse — `path.dirname(path.resolve(mdFilePath))` is used, so if `mdFilePath` is in the cwd, both resolve to the same file.

### Atomic writes

The lockfile is written **atomically** via write-temp-then-rename:

1. `doc-lok.json.<pid>.tmp` is written.
2. `fs.rename(tmp, lockfile)` is called — atomic on POSIX.

This prevents corruption if the process is killed mid-write. It does **not** prevent two `doc-lok` processes from clobbering each other's lockfile updates if they run concurrently in the same project (the temp filename uses PID, so no corruption, but the last-writer wins).

### Committing the lockfile

The lockfile is a runtime artifact. By default, `.gitignore` excludes `doc-lok.json`. If you want to share cached state across CI / teammates who use the same links, commit it explicitly:

```bash
git add -f doc-lok.json
git commit -m "chore: share doc-lok cache"
```

Each project should normally generate its own lockfile; sharing it is for ad-hoc reuse.

---

## The Marker Format

When an unchanged inline link is replaced, it becomes:

```html
<!-- doc-lok:cached#abc123 -->
```

…where `abc123` is the first 6 hex characters of the SHA-256 of the URL.

### Why the hash?

The hash makes restore unambiguous — even if 10 different URLs were condensed in the same document, each marker knows exactly which URL it represents. Restore looks up the hash in the lockfile, finds the URL, finds the original anchor text, and rewrites the marker as `[text](url)`.

### What markers look like inside markdown

Source:
```markdown
Read the [open source docs](https://example.com/docs) for details.
```

After condense:
```markdown
Read the <!-- doc-lok:cached#100680 --> for details.
```

After restore:
```markdown
Read the [open source docs](https://example.com/docs) for details.
```

### What if the hash is unknown?

If restore encounters a marker whose hash has no matching lockfile entry (e.g., you deleted the lockfile), the marker is left **as-is**. This is intentional — it lets you investigate or swap in a different lockfile rather than silently dropping information.

---

## Network Behavior

### Two-phase validation

For each unique URL, `doc-lok` performs:

1. **HEAD request** (fast path):
   - Issues `HEAD`.
   - Extracts the `ETag` header.
   - If `ETag` equals the lockfile's stored `etag`, the content is considered **unchanged**. No body transfer.

2. **Streamed GET** (fallback):
   - Issued when the HEAD response has no ETag, or the ETag doesn't match.
   - Streams the response body through an incremental `crypto.createHash('sha256')`.
   - Each chunk is hashed then discarded — memory stays **O(1)** regardless of payload size.
   - Compares the final SHA-256 to the lockfile's `last_known_sha256`. Match → unchanged. Mismatch → updated.

### Redirects

`301`, `302`, `307`, and `308` redirects are followed automatically (up to 5 hops). The `Location` header is resolved via `new URL(location, currentUrl)`, so relative redirects work. The **original URL from the Markdown** remains the lockfile key — only the validation request follows the redirect chain.

### Timeouts

Each request has a default timeout of **15 seconds**. On timeout, the request is destroyed, the URL is marked as an error, and processing continues with the next URL.

### Concurrency

Validation is **sequential** — one URL at a time. This:

- Keeps memory usage predictable.
- Avoids hammering a single host with parallel requests.
- Prevents connection-pool exhaustion on documents with hundreds of links.

For documents with many links, expect the total runtime to be roughly `(N × per-request-latency)`. If you need concurrency, use the library API and `Promise.allSettled()` over `validateUrl()` directly.

### Authentication

`doc-lok` does **not** send any `Authorization` headers or cookies. Private / authenticated URLs will return `401` / `403` and be marked as errors in the diagnostics.

### TLS / certificate handling

Standard Node.js TLS verification applies. Self-signed or invalid certs will cause a network error per-URL (not fatal). There's currently no `--insecure` flag.

---

## Code-Block Awareness

`doc-lok` walks the Markdown line-by-line, tracking whether it's inside:

- Inline code spans (single backtick, toggled per-line).
- Fenced code blocks (` ``` ` or `~~~`, opened/closed by matching fence).
- Indented code blocks (4+ leading spaces).

Links inside any of these are **never** extracted or validated. This keeps documentation examples readable:

````markdown
```bash
# This example link is left alone, NOT replaced with a marker:
doc-lok README.md [help](https://example.com)
```
````
~~~
Inline code: `use the [old API](https://v1.example.com)` — never condensed.
~~~

Indented code:

    [reference](https://example.com)

INDENTED-code links are also ignored.

---

## Markdown Syntax Coverage

| Syntax | Example | Parsed? | Validated? | Condensed? |
|---|---|---|---|---|
| Inline link | `[text](https://x.com)` | ✅ | ✅ | ✅ |
| Inline link with title | `[text](https://x.com "Title")` | ✅ | ✅ | ✅ |
| Reference definition | `[ref]: https://x.com` | ✅ | ✅ | ❌ (left intact) |
| Reference with title | `[ref]: https://x.com "Title"` | ✅ | ✅ | ❌ |
| Reference with angle brackets | `[ref]: <https://x.com>` | ✅ | ✅ | ❌ |
| Non-HTTP(S) | `[text](mailto:a@b.com)` | ❌ | ❌ | ❌ |
| Inside inline code `` `[…]…` `` | ❌ | ❌ | ❌ |
| Inside fenced code block | ❌ | ❌ | ❌ |
| Inside indented code block | ❌ | ❌ | ❌ |

### Why reference defs aren't condensed

They're already token-cheap (just a URL), and removing them would break Markdown renderers that look up `[ref]` usages elsewhere. They are still validated so the lockfile stays current.

### What's *not* parsed

- `[text](url 'title')` (single-quote titles) — currently unsupported.
- `[text](url (title))` (parenthesised titles) — currently unsupported.
- Escaped `\[link\]` — not treated as link.

These are limitations of the current regex (`src/scanner.ts`). Real-world READMEs that use these patterns will leave those links as-is (not validated, not condensed).

---

## Workflows

### 1. Piping into another tool

```bash
# Python LLM pipeline (diagnostics go to stderr, not to your script)
doc-lok docs/spec.md --quiet | python3 prompt.py

# Go binary reading from stdin
doc-lok docs/spec.md --quiet | ./my-go-binary

# Rust
doc-lok docs/spec.md --quiet | cargo run --bin prompter
```

### 2. Agent / LLM integration

For agentic workflows where an LLM needs to decide whether to condense:

```bash
# Step 1: check freshness without modifying the file
doc-lok README.md --check --json > check.json

# The agent reads check.json, sees which URLs are stale,
# then decides whether to condense.

# Step 2: condense with structured output
doc-lok README.md --json > condense.json

# The agent reads condense.json.output and uses that as the prompt.
```

Library-level integration (TypeScript):

```typescript
import { condenseMarkdown, checkMarkdown } from "doc-lok";

const check = await checkMarkdown("./README.md");
for (const d of check.diagnostics) {
  console.log(`${d.url}: ${d.status}`);
}

const condensed = await condenseMarkdown("./README.md");
console.log(condensed.output);
```

### 3. GitHub Actions

```yaml
- name: Install doc-lok
  run: npm install -g doc-lok

- name: Condense docs before LLM step
  run: doc-lok docs/context.md --quiet > docs/condensed.md

- name: Send to LLM
  run: ./scripts/prompt-llm.sh docs/condensed.md
```

**Warning:** If you run `doc-lok` in CI on Markdown sources you don't fully trust, the URLs in that Markdown will be fetched from the CI runner. There's currently no SSRF guard. Don't run it on untrusted PRs until internal-address blocking is implemented.

### 4. Condense → edit → restore round-trip

```bash
# 1. Condense
doc-lok README.md > README.condensed.md

# 2. Edit the condensed file (e.g., add notes, reformat)
$EDITOR README.condensed.md

# 3. Restore the links (uses the same lockfile, since both files
#    are in the same directory)
doc-lok README.condensed.md --restore > README.final.md
```

Lockfile resolution is **per markdown file's directory** by default. If `README.md` and `README.condensed.md` are in the same directory, they share `./doc-lok.json` automatically. If they're in different directories, pass `--lockfile` to share.

---

## Condense vs. Check: When to Use Which

| Property | `doc-lok file.md` (condense) | `doc-lok file.md --check` |
|---|---|---|
| Rewrites the markdown | ✅ Yes (stdout) | ❌ No |
| Returns piece-by-piece diagnostics | ✅ | ✅ |
| Updates the lockfile | ✅ | ✅ |
| Returns the markdown in JSON output | ✅ (`output` field) | ❌ |
| Useful for | Shrinking prompts before sending to LLM | Pre-flight: "should I condense?" / "is anything stale?" |

### Important caveat: savings accounting in `--check`

Strictly speaking, `--check` is "non-destructive" with respect to the **markdown file**, not the lockfile. Savings from successful second-time ETag matches are still added to `global_tokens_saved`, and the per-URL `cached` flag is still set. Subsequent `condense` runs of the same URL then report `tokensSaved=0`.

In other words: **don't run `--check` repeatedly before `condense`, or you'll silently move the savings into the check run.** Use `--check` as a *one-off* pre-flight, not as a regular heartbeat.

---

## Environment Variables

| Variable | Purpose | Default |
|---|---|---|
| `DOC_LOK_LOCKFILE` | Override the lockfile path. Lower priority than `--lockfile`, higher than auto-resolution. | (not set) |

There are no other environment variables. Configuration is intentionally minimal.

---

## Troubleshooting

### "Saved 0 tokens this run"
You're probably on the **first run** for the lockfile — nothing is cached yet, so all inline links are left intact (status `updated`). Run `doc-lok` again; the second run will see cached SHAs/ETags and condense.

### "Restored 0 link(s)"
Either:
- The file has no markers (`<!-- doc-lok:cached#… -->`), or
- Every marker in the file has a hash with no matching lockfile entry (e.g., the lockfile was deleted or is from a different document).

Check the file for markers; if present, run `doc-lok --restore` with the same `--lockfile` you used during `condense`.

### "Network error for <url>"
A per-URL failure (timeout, DNS, 4xx/5xx, TLS error). The message includes the underlying cause, e.g., `network error for https://example.com: HEAD https://example.com → HTTP 503`. The run still completes; the URL is marked `error` in diagnostics and its link is left intact in the output.

### "HEAD … timed out after 15000ms"
The remote server didn't respond within 15 seconds. The URL is marked as an error. There's currently no `--timeout` CLI flag — to change the timeout, use the library API and pass `timeoutMs` to `validateUrl()`.

### "Too many redirects for <url>"
The URL issued more than 5 redirects (the configured limit). There's currently no `--max-redirects` CLI flag — use the library API.

### `--lockfile` seems to be ignored
If you ran `doc-lok README.md --lockfile` with **no path after the flag**, the parser treats it as a missing argument and silently falls back to auto-resolution (known bug). Always pass an explicit path: `doc-lok README.md --lockfile /path/to/lock.json`.

### Unknown flags don't error out
If you pass e.g. `--concurrency=4`, the parser sets `process.exitCode = 2` but **continues parsing**. Currently known bug. To be safe, check the exit code after the run.

### Lockfile is enormous
There's no eviction — entries accumulate forever even for links that no longer appear in the source. To reset, just delete `doc-lok.json` and let the next run rebuild it.

### Two `doc-lok` runs stomped each other
The lockfile uses atomic write-rename to prevent corruption, but `updateEntry` is read-modify-write. If two `doc-lok` instances ran concurrently on the same project, the last writer wins. Don't parallelize `doc-lok` runs against one lockfile.

---

## Limitations & Known Caveats

### By design
- **HTTP(S) only.** Relative links, `mailto:`, `ftp:`, etc. are left untouched.
- **No content inlining.** doc-lok condenses link *text*, not the page *content* the link points to. It validates whether remote resources changed but never injects their content into your prompt.
- **No recursive following.** Only validates URLs found in the markdown — does not crawl linked pages.
- **No authentication.** No `Authorization` headers; private URLs return `401`/`403`.
- **Sequential validation.** One URL at a time. Slow for 100+ links. Use the library API for concurrency.
- **Per-project lockfile.** There's no global cache. Use `--lockfile` or `DOC_LOK_LOCKFILE` to share.

### Heuristics (useful but approximate)
- **Token estimate** uses the standard ~4 chars/token heuristic. Real token counts vary by tokenizer, content language, and tokenisation algorithm. Treat `tokensSaved` as a rough guide, not a billing figure.
- **ETag reliability varies.** Some servers don't return ETags. Then `doc-lok` falls back to a full streamed GET + SHA-256 comparison — efficient on memory, but transfers the full body.

### Known bugs (tracked in TODO.md)
- **24-bit marker hash** (`hashUrl` returns 6 hex chars). Collisions are astronomically unlikely for small projects but theoretically possible after ~4 000 unique URLs.
- **`global_tokens_saved` accounting** is mutated by `--check` runs in addition to `--condense` runs. Use `--check` sparingly if you care about the ROI number.
- **No SSRF guard.** URLs in untrusted Markdown will be fetched from the host running `doc-lok`. Don't run in CI on untrusted PRs.
- **`--lockfile` with no value** silently falls back to default resolution instead of erroring.
- **Unknown flags** don't stop parsing.
- **Reference definitions inside code blocks** are still validated (regex doesn't honour code-block state).

For the full list and remediation plan, see [`TODO.md`](../TODO.md) in the repo root.

---

*This document describes `doc-lok` v0.2.0. CLI flags, JSON shapes, and behaviour may change in subsequent minor versions — check the [CHANGELOG](../CHANGELOG.md) when upgrading.*