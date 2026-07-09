# doc-lok

> Pre-prompt cache for link-bearing Markdown. Records SHA-256/ETag
> metadata for remote links so unchanged content can be skipped on
> repeat runs — saving network, latency, and a small number of LLM
> tokens per link.

## What it does

`doc-lok` scans Markdown files for external `http(s)` links, validates
them against the remote server, and records their content hash
(SHA-256) and ETag in a local `.doc-lok/lock.json` lockfile. On
subsequent runs, it uses those to detect change cheaply (HEAD only)
and skip work it already did.

### Modes

| Mode | Flag | What it does |
|---|---|---|
| **Condense** | (default) | Replaces unchanged inline `[text](url)` links with a compact HTML comment marker (`<!-- doc-lok:cached#<sha> -->`). Saves ~5 tokens per cached link. Changed/new links are left intact. |
| **Inline** | `--inline` | Fetches linked page bodies, converts HTML→Markdown, caches results in `.doc-lok/cache/`. Injects content under each link. Repeat runs are HEAD-only — no body re-fetch. Default injects only a ~200-token table of contents; use `--section` to control what gets inlined. |
| **Section** | `--inline --section <name>` | Modifier on `--inline`: inject only specific sections instead of the full body. Saves LLM tokens vs. an agent fetching the full page — e.g. a 50K-token doc becomes a 2K-token section. `--section all` for full body (no token savings, but network/latency savings on repeat runs). |
| **Check** | `--check` | Validates all URLs and updates the lockfile, but does **not** modify the Markdown file. Non-destructive freshness probe. |
| **Restore** | `--restore` | Reverses condense/inline: replaces markers and inline blocks back with original `[text](url)` links, preserving anchor text. |

### What's NOT shipped yet

These are on the roadmap. The READMEs in some older releases may
reference them as if they exist — they don't.

- **`--summary`** — LLM-generated summaries of linked pages. This is
  where real LLM token savings would happen (a 50K-token doc becomes a
  ~300-token summary). Not implemented.
- **`--diff`** — Line diffs between cached and fresh bodies. Not implemented.
- **`--concurrency`** — Parallel URL validation. Currently sequential.
- **`--ttl`** — Skip network entirely if recently checked. Not implemented.
- **`--prune`** — Remove stale lockfile entries. Not implemented.

## Install

```bash
npm install -g doc-lok   # CLI
npm install doc-lok      # library
```

From source:

```bash
git clone https://github.com/<your-org>/doc-lok.git
cd doc-lok
npm install
npm run build
```

Requires **Node.js ≥ 18**. Zero runtime dependencies — uses only
Node.js built-in modules (`node:crypto`, `node:https`, `node:fs`,
`node:path`). The optional `turndown` peer dependency is only needed
for `--converter turndown`.

## Usage

### The basic workflow

doc-lok operates on a single Markdown file. You run it, it writes
processed Markdown to **stdout** and diagnostics to **stderr**, and it
creates/updates a `.doc-lok/lock.json` lockfile in the same directory.

**Run 1 — cache warm-up.** Every URL is fetched. No links are condensed
yet — the lockfile is populated so the *next* run can detect unchanged
content. No savings on this run.

```bash
$ doc-lok README.md --quiet > condensed.md
# (no savings — lockfile is being populated)
```

**Run 2+ — savings kick in.** URLs whose content hasn't changed are
replaced with tiny markers. The prompt shrinks by ~5 tokens per
unchanged link.

```bash
$ doc-lok README.md --quiet > condensed.md
# unchanged links → <!-- doc-lok:cached#<sha> --> markers
```

Without `--quiet`, you get a diagnostic report on stderr:

```
─ doc-lok ──────────────────────────────
  ✓ https://example.com/docs  [cached]  saved ~342 tok
  ↻ https://example.com/changelog  [updated]  saved ~0 tok
  ✗ https://example.com/broken  [error]  saved ~0 tok  (HTTP 503)
  Total est. tokens saved this run: 342
  Lockfile: /home/user/project/.doc-lok/lock.json
─────────────────────────────────────────
```

- **✓ cached** — content unchanged, link replaced with marker
- **↻ updated** — content changed (or first run), link left intact
- **✗ error** — request failed (DNS, timeout, HTTP error), link left intact

### Choosing a mode

**Condense (default)** — You have a Markdown file with links and want
to shrink it before feeding it to an LLM. Unchanged links become
markers; changed/new links stay visible. Best for repeat runs where
most links haven't changed.

```bash
doc-lok README.md --quiet > condensed.md
```

**Inline (`--inline`)** — You want the LLM to *see* the content behind
the links, not just the link text. doc-lok fetches each linked page,
converts HTML to Markdown, and injects it under the link. By default
only a table of contents is injected (~200 tokens). Use `--section` to
control what gets inlined.

```bash
# TOC only (default) — tiny prompt, just section headings
doc-lok README.md --inline --allow-private

# Specific sections — only the parts you need
doc-lok README.md --inline --allow-private --section authentication

# Full body — everything
doc-lok README.md --inline --allow-private --section all
```

The default (TOC only) and `--section <name>` save LLM tokens compared
to an agent fetching the full page — instead of reading a 50K-token
doc, the agent gets a ~200-token TOC or a 2K-token section. `--section all`
injects the full body, so no LLM token savings vs. fetching it yourself
— but you still save network/latency on repeat runs (HEAD-only, no body
re-fetch) and get byte-identical prompts that unlock provider-side
prompt caching.

**Check (`--check`)** — You want to know if links are stale without
modifying the file. Validates all URLs, updates the lockfile, but
leaves the Markdown untouched. Useful before deciding whether to
condense.

```bash
doc-lok README.md --check
```

**Restore (`--restore`)** — You have a condensed/inlined file and want
the original links back. Reverses both `cached` markers and `inline`
blocks, preserving the original anchor text. No network requests —
uses the lockfile only.

```bash
doc-lok condensed.md --restore > original.md
```

### Piping to other tools

stdout gets the processed Markdown; stderr gets diagnostics. This
makes doc-lok safe to pipe:

```bash
# Python
doc-lok docs/spec.md --quiet | python3 prompt.py

# Go
doc-lok docs/spec.md --quiet | ./my-go-binary

# Capture diagnostics separately
doc-lok README.md > condensed.md 2> diagnostics.log
```

### JSON output for automation

`--json` outputs a structured JSON object to stdout instead of raw
Markdown. Works with all modes:

```bash
doc-lok README.md --json           # condense
doc-lok README.md --check --json   # check
doc-lok README.md --restore --json # restore
doc-lok README.md --inline --json  # inline
```

Schema (condense mode):

```json
{
  "mode": "condense",
  "output": "... condensed markdown ...",
  "diagnostics": [
    { "url": "https://example.com/docs", "status": "cached", "tokensSaved": 342 },
    { "url": "https://example.com/broken", "status": "error", "tokensSaved": 0, "message": "HTTP 503" }
  ],
  "tokensSaved": 342,
  "lockfilePath": "/home/user/project/.doc-lok/lock.json",
  "lockfile": { "version": 3, "global_tokens_saved": 18432, "urls": { ... } }
}
```

On fatal errors with `--json`: `{ "error": "message" }` with exit code 1.
Per-URL errors are **not** fatal — they appear inside `diagnostics` with
`status: "error"`.

### Using as a library

```typescript
import {
  condenseMarkdown, inlineMarkdown, checkMarkdown, restoreMarkdown,
} from "doc-lok";

// Condense — replace unchanged links with markers
const result = await condenseMarkdown("./README.md");
console.log(result.output);         // condensed Markdown
console.log(result.tokensSaved);    // tokens saved this run
console.log(result.lockfilePath);   // .doc-lok/lock.json path
console.log(result.lockfile);       // full lockfile state

// Inline — fetch linked pages, inject content
const inline = await inlineMarkdown("./README.md", undefined, {
  allowPrivate: true,
  sections: ["authentication"],     // specific sections, or ["all"], or [] for TOC
});
console.log(inline.output);
console.log(inline.inlinedCount);

// Check freshness (no file modification)
const check = await checkMarkdown("./README.md");
for (const diag of check.diagnostics) {
  console.log(`${diag.url}: ${diag.status}`);
}

// Restore — reverse condense/inline
const restored = await restoreMarkdown("./condensed.md");
console.log(restored.restoredCount);
```

Additional exports: `validateUrl`, `convertHtmlToMarkdown`,
`matchSections`, `slugifyHeading`, `readLockfile`, `writeLockfile`,
`resolveLockfilePath`, `hashUrl`, `estimateTokens`, and cache functions
(`readBody`, `readMarkdown`, `readIndex`, etc.). Full types included.

### Agent integration

An agent workflow file (`.windsurf/workflows/doc-lok.md` in the repo)
teaches agents how to detect and use doc-lok automatically — when to
check, condense, inline, or restore, with 11 explicit rules and a
decision tree. The `--check --json` and `--json` flags provide
machine-readable output for automated workflows.

To use it with your IDE, copy the workflow file from the repo into your
IDE's workflow/rules directory:

```bash
# Windsurf
curl -fsSL https://raw.githubusercontent.com/<your-org>/doc-lok/main/.windsurf/workflows/doc-lok.md \
  -o .windsurf/workflows/doc-lok.md

# Cursor — adapt the format for .cursor/rules/
# Claude Code — adapt for .claude/commands/
```

The workflow file is IDE-agnostic Markdown — the content works in any
agent that reads workflow or rules files.

## CLI reference

```
doc-lok <file.md> [mode] [options]

Modes:
  (default)         Condense — replace unchanged links with markers
  --inline          Inline — fetch and inject linked content
  --check           Check — validate URLs, don't modify the file
  --restore         Restore — reverse condense/inline

Options:
  --section <name>    Section(s) to inline (repeatable). Special: "all", "toc"
  --converter <mode>  HTML→Markdown: "minimal" (default) or "turndown"
  --max-bytes <n>     Max inline body size in bytes (default 1048576)
  --cache-dir <path>  Override .doc-lok/cache/ directory
  --lockfile <path>   Override lockfile path
  --allow-private     Allow private/loopback URLs (disables SSRF guard)
  --json              Structured JSON output to stdout
  -q, --quiet         Suppress stderr diagnostics
  -V, --version       Print version
  -h, --help          Show help

Exit codes: 0 (success), 1 (fatal error), 2 (arg error)
```

stdout receives the condensed/restored Markdown (or JSON with `--json`).
stderr receives human-readable diagnostics. Safe to pipe.

Full CLI docs: [docs/cli-reference.md](./docs/cli-reference.md)
Section guide: [docs/sections.md](./docs/sections.md)

## How it works

### Lockfile

`.doc-lok/lock.json` stores per-URL metadata:

```json
{
  "version": 3,
  "global_tokens_saved": 18432,
  "urls": {
    "https://example.com/docs": {
      "last_known_sha256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      "etag": "\"abc123\"",
      "token_cost_raw": 357,
      "token_cost_compressed": 18,
      "last_checked": "2026-07-08T11:30:00.000Z",
      "cached": true,
      "original_text": "documentation",
      "converted": true,
      "section_slugs": ["introduction", "authentication", "api-reference"]
    }
  }
}
```

Lockfile resolution order (first match wins):

1. `--lockfile <path>` argument
2. `DOC_LOK_LOCKFILE` environment variable
3. `.doc-lok/lock.json` in the Markdown file's directory
4. `.doc-lok/lock.json` in `process.cwd()`

The lockfile is written atomically (temp-file-then-rename) to prevent
corruption from concurrent processes.

### Network validation

Two-phase strategy to minimize network overhead:

1. **HEAD request** — compare server ETag against lockfile. Match =
   unchanged, no body transfer.
2. **Streamed GET fallback** — when ETag is missing or mismatched, stream
   the body through an incremental SHA-256 hasher (O(1) memory
   regardless of payload size). Compare hash to lockfile.

Redirects (`301`/`302`/`307`/`308`) are followed automatically (up to 5
hops), with SSRF re-check at each hop.

### Inline cache

`--inline` stores fetched content in `.doc-lok/cache/`:

- `<sha>.raw` — original response body
- `<sha>.md` — converted Markdown
- `<sha>.index.json` — section index

Repeat runs with unchanged URLs are HEAD-only — no body re-fetch, no
re-conversion. The converted Markdown and section index are cached on
disk so they're free on repeat runs too.

### Code-block awareness

Links inside inline code, fenced code blocks, and indented code blocks
are never touched — code examples stay readable and functional.

### Error isolation

Each URL is validated independently. A 503, DNS failure, or timeout on
one link produces an error diagnostic but never aborts the entire run.

## Token savings — honestly

The baseline for `--inline` and `--section` is **an agent fetching the full URL and reading the entire page** — not the original Markdown file with just a link. Nobody uses `--inline` if they don't want the content in the prompt.

| Mode | What's saved | How much |
|---|---|---|
| Condense | LLM tokens (link text → 18-token marker) | ~5 tokens per unchanged link |
| Inline (TOC default) | LLM tokens (full page → ~200-token TOC) | ~49,800 tokens per URL — agent sees the index, fetches only what it needs |
| Inline (`--section <name>`) | LLM tokens (full page → only the requested section) | Varies — a 50K-token doc with a 2K-token section saves ~48K tokens |
| Inline (`--section all`) | Network + latency only (HEAD-only repeat runs) | 0 LLM tokens vs. fetching the page yourself — same content, just pre-cached |
| Summary *(roadmap)* | LLM tokens (full body → ~300-token summary) | ~49,700 tokens per URL on repeat runs |

All token counts are heuristic estimates (≈4 chars/token), not exact
tokeniser measurements. Use them as a rough guide for comparing relative
savings across runs, not as a billing figure.

A side benefit of `--inline`: byte-identical repeat prompts unlock
**provider-side prompt caching** (Anthropic Claude, OpenAI both cache
identical prompt prefixes and bill ~10x less for the cached segment).

## Limitations

- **HTTP(S) only.** Relative links, `mailto:`, and other schemes are
  ignored.
- **No authentication.** `doc-lok` sends no `Authorization` headers.
  Private/authenticated URLs return 401/403 and are marked as errors.
  This is a security boundary, not a missing feature.
- **SSRF guard on by default.** Blocks loopback, link-local, and private
  IP ranges. Use `--allow-private` to opt in for internal URLs.
- **Sequential validation.** URLs are fetched one at a time. For
  documents with hundreds of links, this may be slow. Use the library
  API with `validateUrl()` directly if you need concurrent fetching.
- **One level deep.** `--inline` fetches linked pages but does not
  recursively follow links within them.
- **`--check` still writes the lockfile.** The Markdown file is
  untouched, but the lockfile is updated with current metadata.
- **Same URL, different anchor texts.** The lockfile stores only the
  last-seen anchor text. All restored markers for that URL will use it.
- **Token estimates are approximate.** The 4-chars/token heuristic is a
  rough guide, not a billing figure. CJK text is closer to 1 char/token;
  URLs are token-dense.

## Project structure

```
doc-lok/
├── src/
│   ├── index.ts      # Public API re-exports
│   ├── cli.ts        # CLI entry point (argv parser → stdout/stderr)
│   ├── parser.ts     # Condense, inline, restore, check orchestration
│   ├── scanner.ts    # Code-block-aware Markdown link extraction
│   ├── network.ts    # HEAD-first → streamed SHA-256 GET
│   ├── state.ts      # Lockfile read/write, token estimation
│   ├── cache.ts      # Body cache (.raw, .md, .index.json) for --inline
│   ├── convert.ts    # HTML→Markdown converter + section detection
│   ├── sections.ts   # Section matching (3-tier: exact → case-insensitive → contains)
│   └── ssrf.ts       # SSRF guard (private/loopback/link-local blocking)
├── test/             # Test suite (vitest)
├── docs/
│   ├── cli-reference.md
│   └── sections.md
└── package.json
```

## Development

```bash
npm install      # dev dependencies (typescript, @types/node, vitest)
npm run build    # compile src/ → dist/ (tsc)
npm test         # run test suite
npm run clean    # remove dist/
```

## Contributing

1. Fork, create a feature branch.
2. Build and test: `npm run build && npm test`.
3. Keep zero runtime dependencies — Node.js built-ins only.
4. Maintain strict TypeScript (`strict: true`).
5. Update README when adding CLI flags or API changes.
6. Commit with conventional commits: `feat:`, `fix:`, `docs:`.

## License

[MIT](./LICENSE)
