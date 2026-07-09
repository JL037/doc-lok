---
description: Use doc-lok to check URL freshness, condense markdown, or inline linked content before reading files with external links
---

# doc-lok Agent Workflow

## What is doc-lok?

`doc-lok` is a pre-prompt context condenser for Markdown files with external
`http(s)` links. It validates links against remote servers, records
SHA-256/ETag metadata in a lockfile (`.doc-lok/lock.json`), and can replace
unchanged links with compact markers — saving LLM context window tokens on
repeat runs. It can also inline linked page content (`--inline`).

## When to Use

Use this workflow when you are about to read or process a Markdown file that
contains external `http(s)` links, and the project has `doc-lok` installed.

**Do NOT use doc-lok when:**
- The file has no external `http(s)` links (relative links, `mailto:`, etc. are ignored)
- The file is inside a code block (links in code blocks are never touched)
- You only need to read the file once and never again (first run saves nothing)
- The project does not have doc-lok installed

## Detecting doc-lok

Check for doc-lok in the project by looking for any of:
- `doc-lok` in `package.json` (dependencies or devDependencies)
- `node_modules/.bin/doc-lok` (installed locally)
- `dist/cli.js` in the doc-lok source directory
- A `.doc-lok/lock.json` lockfile in the project root or alongside markdown files

## Agent Rules

These rules govern how an agent should use doc-lok. Follow them in order.

### R1: Always use `--json` for machine-readable output

When running doc-lok programmatically, always pass `--json`. This produces
structured JSON on stdout instead of raw markdown + human diagnostics. Parse
the JSON to get `output`, `diagnostics`, `lockfile`, and `tokensSaved`.

```bash
doc-lok <file.md> --json           # condense
doc-lok <file.md> --check --json   # check only
doc-lok <file.md> --restore --json # restore
doc-lok <file.md> --inline --json  # inline
```

### R2: Check before condensing

Run `--check --json` first to see which links are stale. This does not modify
the markdown file (only the lockfile is updated). Use the diagnostics to
decide whether condensing is worthwhile.

```bash
doc-lok <file.md> --check --json
```

**Caveat:** `--check` still updates the lockfile and can consume savings
metadata. Do not run `--check` repeatedly before `--condense` — it will
silently move token savings into the check run. Use `--check` as a one-off
pre-flight, not a regular heartbeat.

### R3: First run saves nothing — it warms the cache

On the first run against a file, every URL is fetched and marked `updated`.
No links are condensed. The lockfile is populated so the *next* run can
detect unchanged content. If you see `tokensSaved: 0` and all links show
`status: "updated"`, this is expected — run doc-lok again to get savings.

### R4: Condense to save tokens on repeat reads

If `--check` shows all or most links are `cached`, condense to shrink the
prompt:

```bash
doc-lok <file.md> --json
```

Use the `output` field from the JSON as your condensed context. Unchanged
links are replaced with `<!-- doc-lok:cached#<sha> -->` markers. Changed
and error links are left intact. The original file is not modified —
condensed text goes to stdout only.

### R5: Restore before writing back to a file

If you need to edit a condensed file and write it back to disk, **restore
first**. Markers are not valid Markdown links — a human reading the file
needs the original `[text](url)` form.

```bash
doc-lok <file.md> --restore --json
```

Restore uses the lockfile only (no network requests). It replaces markers
with `[text](url)` links, preserving the original anchor text.

### R6: Use `--inline` when you need the content behind links

If the LLM needs to *see* the content of linked pages (not just the link
text), use `--inline`. This fetches each linked page, converts HTML to
Markdown, and injects it under the link. By default, only a ~200-token
table of contents is injected.

```bash
# TOC only (default) — tiny prompt, just section headings
doc-lok <file.md> --inline --json

# Specific sections — only the parts you need
doc-lok <file.md> --inline --section authentication --json

# Full body — everything
doc-lok <file.md> --inline --section all --json
```

Repeat runs with unchanged URLs are HEAD-only — no body re-fetch. The
converted Markdown and section index are cached on disk in `.doc-lok/cache/`
so they're free on repeat runs.

### R7: Use `--allow-private` for internal URLs

By default, doc-lok blocks private/loopback/link-local IP ranges (SSRF
guard). If the file links to internal URLs (`localhost`, `192.168.x.x`,
etc.), add `--allow-private`:

```bash
doc-lok <file.md> --inline --allow-private --json
```

### R8: Use `--quiet` to suppress stderr noise

When piping output or when you only care about the JSON, add `--quiet` to
suppress human-readable diagnostics on stderr:

```bash
doc-lok <file.md> --json --quiet
```

### R9: Interpret diagnostics correctly

Each URL in `diagnostics[]` has a `status` field:

- **`cached`** — content unchanged since last check. SHA in lockfile matches
  remote. Safe to condense (replace with marker).
- **`updated`** — content has changed or is new (first run). Link should be
  kept intact so you can see current content.
- **`error`** — URL could not be fetched (404, 503, timeout, DNS failure,
  TLS error). Link should be kept intact. The `message` field has details.

Per-URL errors are **not** fatal — the run still exits 0 and other URLs are
processed normally. Only fatal errors (file not found, lockfile write
failure) produce `{ "error": "..." }` with exit code 1.

### R10: Do not run doc-lok concurrently on the same lockfile

The lockfile uses atomic write-rename to prevent corruption, but
`updateEntry` is read-modify-write. If two doc-lok instances run
concurrently on the same project, the last writer wins. Run sequentially.

### R11: Code-block links are never touched

Links inside inline code, fenced code blocks, and indented code blocks are
never extracted, validated, or condensed. Code examples stay readable and
functional. You do not need to worry about doc-lok breaking code samples.

## Mode Reference

| Mode | Flag | What it does | Modifies markdown? |
|---|---|---|---|
| **Condense** | (default) | Replaces unchanged inline links with markers | stdout only |
| **Check** | `--check` | Validates URLs, updates lockfile, no markdown output | no |
| **Inline** | `--inline` | Fetches linked pages, injects content under links | stdout only |
| **Restore** | `--restore` | Replaces markers with original `[text](url)` links | stdout only |

## CLI Flags Quick Reference

```
doc-lok <file.md> [mode] [options]

Modes:
  (default)          Condense — replace unchanged links with markers
  --inline           Inline — fetch and inject linked content
  --check            Check — validate URLs, don't modify the file
  --restore          Restore — reverse condense/inline

Options:
  --section <name>    Section(s) to inline (repeatable). "all" = full body, "toc" = TOC only
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

## JSON Output Schema

All `--json` output includes a `mode` field (`"check"`, `"condense"`,
`"restore"`, `"inline"`) and a `lockfile` object:

```json
{
  "mode": "condense",
  "output": "# My Project\n\nSee <!-- doc-lok:cached#abc123 --> for details.\n",
  "diagnostics": [
    { "url": "https://...", "status": "cached", "tokensSaved": 342 },
    { "url": "https://...", "status": "updated", "tokensSaved": 0 },
    { "url": "https://...", "status": "error", "tokensSaved": 0, "message": "HTTP 503" }
  ],
  "tokensSaved": 342,
  "lockfilePath": "/path/to/.doc-lok/lock.json",
  "lockfile": {
    "version": 3,
    "global_tokens_saved": 18432,
    "urls": {
      "https://example.com/docs": {
        "last_known_sha256": "9f86d0...",
        "etag": "\"abc123\"",
        "token_cost_raw": 357,
        "token_cost_compressed": 18,
        "last_checked": "2026-07-08T11:30:00.000Z",
        "cached": true,
        "original_text": "documentation"
      }
    }
  }
}
```

**Mode-specific fields:**
- `condense` / `inline`: includes `output` (the processed markdown)
- `check`: no `output` field (markdown is not rewritten)
- `restore`: includes `output` and `restoredCount`
- `inline`: also includes `inlinedCount` and `cacheDir`

On fatal errors, the JSON output is `{ "error": "message" }` with exit code 1.
Per-URL errors are **not** fatal — they appear in `diagnostics` with
`status: "error"`.

## Agent Decision Tree

1. **Project has doc-lok?** → proceed. Otherwise, read the file normally.
2. **File has external `http(s)` links?** → proceed. Otherwise, read normally.
3. **Need linked page content in the prompt?** → use `--inline --json`
   (optionally with `--section <name>` to control what gets inlined).
4. **Just want to save tokens on repeat reads?** → run `--check --json` first.
5. **All links `cached`?** → safe to condense (`--json`), use `output` field.
6. **Some links `updated`?** → condense is still safe; updated links stay
   intact. Note which links are fresh for context.
7. **Some links `error`?** → condense is still safe; error links stay intact.
   Consider fetching those URLs manually if the content is critical.
8. **Need to write back to the file?** → use `--restore --json` to inflate
   markers first, then edit the restored output.
9. **Internal/private URLs?** → add `--allow-private`.
10. **First run, all links `updated`, `tokensSaved: 0`?** → expected; run
    again to get savings.
