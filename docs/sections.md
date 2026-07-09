# doc-lok — `--section` selective inline

> How to inline only the parts of a linked page you actually need.
> Real token savings, zero information loss.

---

## Table of Contents

- [The problem this solves](#the-problem-this-solves)
- [How it works](#how-it-works)
- [Quick start](#quick-start)
- [Default behavior](#default-behavior)
- [Selecting sections](#selecting-sections)
  - [Section name matching](#section-name-matching)
  - [Special values `all` and `toc`](#special-values-all-and-toc)
  - [Unknown and ambiguous sections](#unknown-and-ambiguous-sections)
- [The Markdown conversion step](#the-markdown-conversion-step)
- [Cache layout](#cache-layout)
- [Library API](#library-api)
- [JSON output for agents](#json-output-for-agents)
- [Multi-turn agent workflow](#multi-turn-agent-workflow)
- [Limitations](#limitations)
- [Token economics](#token-economics)

---

## The problem this solves

`doc-lok --inline` (the P1 feature) fetches a linked page and injects its
content straight into your Markdown so the LLM can read it. On repeat
runs the body is served from disk — network is saved, latency is saved.

But the LLM **still re-reads every byte of the body every run.** If the
linked page is a 50,000-token API reference, your prompt is 50,000
tokens heavier on every call — even if the LLM only needs to look at
one 300-token section about authentication.

The obvious fix people reach for is `--summary` — have an LLM compress
the page to ~300 tokens. But summarization is **lossy**: a summary of
the auth section probably won't mention the exact `retry_backoff_ms`
parameter the LLM is being asked about.

`--section` is the lossless alternative. doc-lok converts the page to
Markdown, builds a section index, and inlines only the section(s) you
ask for. The LLM gets exactly the content it needs, with no information
thrown away — and on repeat runs everything is served from cache.

---

## How it works

```
  ┌─ fetch HTML body ────────┐
  │                         │
  │  ↓ convert to Markdown  │   src/convert.ts
  │  ↓ detect headings      │
  │  ↓ build section index  │
  │                         │
  └─ cache .md + .index ────┘
                            │
                            ↓
        ┌─ match requested sections ─┐
        │  --section auth             │   src/sections.ts
        │  --section api              │
        └─────────────────────────────┘
                            │
                            ↓
        ┌─ inject inline blocks ──────┐
        │  one per matched section   │   src/parser.ts
        └─────────────────────────────┘
```

- Conversion happens **once**, on first fetch (or when the page changes).
- Re-runs hit only a HEAD request to confirm staleness; everything else
  is served from local disk.
- Section selection is deterministic — same input, same output, every
  time. That's what makes prompts byte-identical across runs and unlocks
  provider-side prompt caching (Anthropic, OpenAI both cache identical
  prompt prefixes and bill ~10x less for the cached segment).

---

## Quick start

```bash
# 1. Default — inject only the section index (table of contents).
#    Tiny prompt. Lets the LLM (or you) decide what to look up next.
doc-lok README.md --inline --allow-private

# 2. Inline one specific section.
doc-lok README.md --inline --allow-private --section auth

# 3. Inline several sections.
doc-lok README.md --inline --allow-private --section auth --section api

# 4. Inline the whole body (this is what `--inline` alone used to do).
doc-lok README.md --inline --allow-private --section all

# 5. Pipe straight to an LLM, no intermediate files.
doc-lok README.md --inline --allow-private --section auth --quiet \
  | my-llm-client

# 6. Reverse the operation — strip inline blocks, leave original links.
doc-lok context.md --restore > README.final.md
```

---

## Default behavior

`--inline` with **no `--section` flag** inlines the **table of contents
only**, not the full body. Example:

Source markdown:
```markdown
# My Doc
Read the [docs](https://example.com/docs).
```

After `doc-lok ... --inline --allow-private` (no `--section`):
```markdown
# My Doc
Read the [docs](https://example.com/docs).

<!-- doc-lok:inline#abc123...def <index>

## Sections
- [Introduction](#introduction)
- [Authentication](#authentication)
- [API Reference](#api-reference)
- [Rate Limits](#rate-limits)
- [Migrations](#migrations)

-->
```

The LLM sees the list of available topics. To actually read one, you
tell doc-lok which one:

```bash
doc-lok README.md --inline --allow-private --section authentication
```

…and doc-lok inlines just that section's content. Everything else stays
on disk in the cache.

**Why this default?** A smaller prompt is cheaper. The LLM shouldn't
read 50,000 tokens of API docs when it might only need one section. If
you want the old behavior (full body inline), pass `--section all`.

---

## Selecting sections

### Section name matching

Section names are derived from the page's headings. The matcher tries,
in priority order:

1. **Exact slug match** — `"authentication"` matches a heading whose
   slug is exactly `authentication`.
2. **Case-insensitive slug match** — `"Auth"` matches `authentication`.
3. **Case-insensitive heading-contains match** — `"rate"` matches both
   `Rate Limits` and `Retry Strategy & Rate Throttling`.

Slug generation (GitHub-style):
- Lowercase
- Strip characters that aren't letters, digits, spaces, or `-`
- Replace runs of whitespace with a single `-`

Examples:
| Heading | Slug |
|---|---|
| `Authentication` | `authentication` |
| `API Reference` | `api-reference` |
| `Authentication & Authorization` | `authentication--authorization` |
| `OAuth 2.0` | `oauth-20` |
| `Retry Strategy & Rate Throttling` | `retry-strategy--rate-throttling` |

### Special values `all` and `toc`

| Flag | What it does |
|---|---|
| (no `--section` flag) | Inline the table of contents only (the default). |
| `--section toc` or `--section index` | Same as above — explicit form. |
| `--section all` or `--section *` | Inline the **full converted body**. Reproduces the original `--inline` (P1) behavior. |
| `--section auth` | Inline just the matched section(s). |
| `--section auth --section api` | Inline each matched section, in the order requested. One block per section. |

### Unknown and ambiguous sections

If you pass `--section xyz` and no section on the page matches:

```
✗ https://example.com/docs  [error]  unknown section: "xyz"
  available sections: introduction, authentication, api-reference, rate-limits, migrations
```

The link is left intact in the output; no inline block is emitted for
the unknown request. Other matched sections (if any were requested)
still inline normally.

If `--section rate` matches both `Rate Limits` and `Retry Strategy &
Rate Throttling`:

```
✗ https://example.com/docs  [error]  ambiguous section: "rate"
  candidates: rate-limits, retry-strategy--rate-throttling
  hint: pass the full slug, e.g. --section rate-limits
```

You then re-run with the explicit slug. Disambiguation is always your
call — doc-lok never silently picks one.

---

## The Markdown conversion step

The HTML body is converted to clean Markdown before inlining. This:

- Strips boilerplate (`<script>`, `<style>`, `<nav>`, `<footer>`,
  `<aside>`, `<noscript>`, `<form>`, `<svg>`, `<canvas>`).
- Converts headings, paragraphs, lists, code blocks (with language
  hints), blockquotes, tables, links, images, and inline formatting.
- Is **lossless** for content (everything the LLM might need is kept).
- Drops about 70–80% of typical web-page bytes (boilerplate bloat).

### Built-in converter (default)

doc-lok ships with a minimal HTML → Markdown converter that handles the
common cases. It's ~300 lines, no runtime dependencies, and covers:

| Handled | Notes |
|---|---|
| `<h1>`–`<h6>` | Becomes `#`–`######` |
| `<p>`, `<br>`, `<hr>` | Paragraph, newline, `---` |
| `<ul>`, `<ol>`, `<li>` | Nested with proper indent |
| `<pre><code class="language-js">` | ` ```js ` fenced code |
| `<blockquote>` | `> ` prefix per line |
| `<table>` | Pipe table, `|` escaped in cell content |
| `<a href>` | `[text](url)` (non-http links dropped) |
| `<img alt src>` | `![alt](src)` |
| `<strong>`, `<b>` | `**text**` |
| `<em>`, `<i>` | `*text*` |
| `<details><summary>` | Unfolded to a heading + body (readable) |

Not handled (left as raw text or skipped): math (KaTeX/MathML), complex
nested tables, footnote refs, callout/admonition boxes.

### Optional `turndown` fallback

For pages with complex tables, math, or unusual structures, install the
peer dependency and request it explicitly:

```bash
npm install -g turndown           # or: npm install turndown
doc-lok README.md --inline --allow-private \
  --section authentication --converter turndown
```

With `--converter turndown`:
- If `turndown` is installed → doc-lok uses it for richer conversion
  (better table fidelity, smarter list handling, etc.).
- If `turndown` is not installed → the run errors out with a clear
  message: `turndown not installed; run "npm install turndown" or use --converter minimal`.

`--converter minimal` is the default. The peer dep is **never**
auto-installed.

---

## Cache layout

Everything lives under `.doc-lok/` next to the lockfile:

```
your-project/
├── doc-lok.json                       lockfile (metadata)
└── .doc-lok/
    └── cache/
        ├── <sha256>.raw               original fetched body
        ├── <sha256>.md                converted Markdown
        └── <sha256>.index.json        section index (slug/level/heading)
```

- The SHA in the filename is the SHA-256 of the **original body**, so a
  content change produces a new filename. Old cache files become stale
  (use `--prune` when it ships in P4, or delete `.doc-lok/cache/`
  manually).
- The lockfile records `converted: true` and a `section_slugs` list per
  URL, but the cache files on disk are the source of truth for content.
- `.doc-lok/` is in `.gitignore` by default. Sharing the cache across
  machines or CI workers requires explicit opt-in (`--cache-dir <path>`
  pointed at a synced volume).

---

## Library API

```typescript
import {
  inlineMarkdown,
  convertHtmlToMarkdown,
  matchSections,
  slugifyHeading,
  type Section,
} from "doc-lok";

// Default — inject TOC only, like the CLI default.
const r = await inlineMarkdown("README.md", undefined, {
  allowPrivate: true,
});

// Inject one section.
const r2 = await inlineMarkdown("README.md", undefined, {
  allowPrivate: true,
  sections: ["authentication"],
});

// Multiple sections, in the order you pass them.
const r3 = await inlineMarkdown("README.md", undefined, {
  allowPrivate: true,
  sections: ["intro", "api-reference", "rate-limits"],
});

// Use turndown (peer dep) for richer conversion of complex tables.
const r4 = await inlineMarkdown("README.md", undefined, {
  allowPrivate: true,
  sections: ["schema"],
  converter: "turndown",
});

console.log(r.output);              // markdown with inline blocks
console.log(r.inlinedCount);        // number of blocks written
console.log(r.diagnostics);         // per-URL status + matched sections
```

Lower-level utilities for custom integrations:

```typescript
const { markdown, sections } = convertHtmlToMarkdown(rawHtmlString);
const slug = slugifyHeading("Authentication & Authorization");
//   → "authentication--authorization"

const match = matchSections(sections, ["auth", "rate"]);
//   → { matched: [...], unknown: [...], ambiguous: [...] }
```

### `InlineOptions` type (full)

```typescript
interface InlineOptions {
  allowPrivate?: boolean;                 // SSRF guard opt-in
  timeoutMs?: number;                     // per-request timeout
  cacheDir?: string;                      // override cache location
  maxBytes?: number;                      // default 1 MB
  allowedContentTypes?: readonly string[];// default text/html, text/plain
  sections?: string[];                    // default [] (TOC only)
  converter?: "minimal" | "turndown";     // default "minimal"
}
```

---

## JSON output for agents

`--json` returns structured output that includes the per-URL section
lists — this is the discovery interface for agent workflows.

```bash
doc-lok README.md --inline --allow-private --json
```

```jsonc
{
  "mode": "inline",
  "output": "# My Doc\n\nRead the [docs](...).\n\n<!-- doc-lok:inline#... <index>\n...\n-->",
  "diagnostics": [
    {
      "url": "https://example.com/docs",
      "status": "cached",        // or "updated" / "error"
      "tokensSaved": 0,          // see "Token economics"
      "matchedSections": [],     // empty when TOC-only default
      "availableSections": [
        "introduction", "authentication", "api-reference",
        "rate-limits", "migrations"
      ]
    }
  ],
  "tokensSaved": 0,
  "inlinedCount": 1,
  "cacheDir": "/path/to/.doc-lok/cache",
  "lockfilePath": "/path/to/doc-lok.json",
  "lockfile": { /* ... */ }
}
```

An agent reads `availableSections` on turn 1, then re-runs with the
specific sections it needs for turn 2.

---

## Multi-turn agent workflow

This is where `--section` earns its keep. Consider an agent answering
"how do I configure retry behaviour in this API?":

**Turn 1** — inject the index so the LLM can browse:

```bash
doc-lok docs/api.md --inline --allow-private --json
```

The LLM sees `availableSections: ["introduction", "authentication",
"api-reference", "rate-limits", "migrations"]`. It decides it needs to
read `rate-limits` (which probably covers retries).

**Turn 2** — pull the relevant section:

```bash
doc-lok docs/api.md --inline --allow-private --section rate-limits --quiet \
  | llm-client
```

The LLM gets the full `rate-limits` section verbatim — including the
exact `retry_backoff_ms` parameter value it was asked about. No
summarization, no loss. Everything served from disk cache (HEAD-only
network check).

**Turn 3** (if needed) — pull another section:

```bash
doc-lok docs/api.md --inline --allow-private \
  --section rate-limits --section migrations --quiet \
  | llm-client
```

The cache already has both, so the network round-trip is HEAD-only.
Your prompt has just the two relevant sections, not the 50k-token whole
page. Token savings scale with selectivity.

---

## Limitations

- **Pages without headings.** A flat article with no `<h1>`–`<h6>` has
  no section structure. doc-lok falls back to whole-body inline and
  reports `availableSections: ["all"]`. `--section <name>` won't match
  anything except `all`.
- **Non-HTML pages.** `text/plain` bodies are treated as already-markdown
  (no HTML stripping) and won't be split into sections.
- **Other content types** (PDF, JSON, binaries) are rejected by the
  default content-type allowlist. Pass `--allowed-content-type` (CLI)
  or `allowedContentTypes` (library) to override per content type.
- **Ambiguous slug names.** `"auth"` may match multiple headings; the
  CLI errors and asks you to disambiguate. There's no fuzzy preference
  — you always pass an explicit slug or heading fragment.
- **Large sections are not truncated.** A 10k-token section is inlined
  as 10k tokens. If you want smaller, reach for `--summary` (P2c,
  opt-in, lossy) instead.
- **No recursive link following.** Sections are from the linked page
  only; doc-lok never crawls links inside sections.
- **Conversion isn't perfect.** The minimal converter mangles complex
  tables and skips math. Install `turndown` and use `--converter
  turndown` for richer fidelity.

---

## Token economics

| What you ask for | Run 1 | Run 2+ (cached) |
|---|---|---|
| `--inline` (TOC only) | Fetch body + convert + cache + inject ~200 tokens | HEAD only + inject ~200 tokens (same) |
| `--inline --section auth` | Fetch + convert + cache + inject ~500-2000 tokens (the section) | HEAD only + inject same section from cache |
| `--inline --section all` | Full body inline (same as P1) | HEAD only + full body from cache |
| `--inline --section auth --section api` | One block per section, in order | Same, all from cache |

**What's actually saved:**

- Network: full fetch only happens on first encounter or when the page
  changes. All repeat runs are HEAD-only.
- Latency: same — HEAD is fast.
- LLM tokens: **proportional to what you select**. TOC-only uses ~200
  tokens. A single 1k-token section uses 1k tokens. The full body uses
  its full size. **You control this by what you ask for.**
- Provider-side prompt caching: byte-identical prompts across runs
  unlock Claude / OpenAI prefix caching at ~10x discount on the cached
  segment. doc-lok can't claim this as its own savings — the provider
  does it — but `--section` makes prompts deterministic, which is what
  triggers it.

**What's never saved:**

- The LLM still re-reads every byte of every inline block on every
  prompt. There is no Across-Run LLM Memory. doc-lok controls what
  goes into the prompt; the provider controls what gets cached; the
  LLM is stateless.

For genuine across-run LLM token savings on the *whole* body, use
`--summary` (P2c, roadmap). `--section` is the lossless path — it saves
tokens by being more selective, not by compressing.

---

*This feature is on the roadmap as P2 (`--section` selective inline).
It builds on P1 (`--inline` content cache) and precedes P2c
(opt-in `--summary` lossy compression). See [`TODO.md`](../TODO.md) and
[`ROADMAP.md`](../ROADMAP.md) for the build plan.*