---
description: Use doc-lok to check URL freshness and condense markdown before reading files with external links
---

# doc-lok Agent Workflow

## When to Use

Use this workflow when you are about to read or process a Markdown file that contains external `http(s)` links, and the project has `doc-lok` installed.

## Detecting doc-lok

Check for doc-lok in the project by looking for any of:
- `doc-lok` in `package.json` (dependencies or devDependencies)
- `node_modules/.bin/doc-lok` (installed locally)
- `dist/cli.js` in the doc-lok source directory
- A `doc-lok.json` lockfile in the project root or alongside markdown files

## Workflow Steps

### 1. Check URL freshness (non-destructive)

Before reading a markdown file, run:

```bash
doc-lok <file.md> --check --json
```

This outputs structured JSON to stdout with:
- `diagnostics[]` — per-URL status: `cached` (unchanged), `updated` (changed/new), `error` (fetch failed)
- `lockfile.urls` — full lockfile state with `last_known_sha256`, `etag`, `last_checked` per URL
- `tokensSaved` — potential savings if condensed

The markdown file is **not modified**. The lockfile is updated with current SHAs.

### 2. Interpret staleness

For each URL in the diagnostics:
- `status: "cached"` — content unchanged since last check. The SHA in the lockfile matches the remote content. Safe to condense (replace with marker).
- `status: "updated"` — content has changed or is new. The link should be kept intact so you can see the current content.
- `status: "error"` — URL could not be fetched (404, 503, timeout, etc.). The link should be kept intact.

### 3. Condense if appropriate

If all or most links are `cached` and you want to save context window tokens:

```bash
doc-lok <file.md> --json
```

This outputs JSON with:
- `output` — the condensed markdown (unchanged links replaced with `<!-- doc-lok:cached#hash -->`)
- `diagnostics[]` — same as check mode
- `lockfile` — updated lockfile state

Use the `output` field as your condensed context. The original file is not modified — the condensed text goes to stdout only.

### 4. Restore if needed

If you need the original links back (e.g., to write changes back to the file):

```bash
doc-lok <file.md> --restore --json
```

This replaces markers with `[url](url)` links using the lockfile as a lookup table.

## JSON Output Schema

All `--json` output includes a `mode` field (`"check"`, `"condense"`, `"restore"`) and a `lockfile` object:

```json
{
  "mode": "check",
  "diagnostics": [
    { "url": "https://...", "status": "cached", "tokensSaved": 342 },
    { "url": "https://...", "status": "updated", "tokensSaved": 0 },
    { "url": "https://...", "status": "error", "tokensSaved": 0, "message": "..." }
  ],
  "tokensSaved": 342,
  "lockfilePath": "/path/to/doc-lok.json",
  "lockfile": {
    "version": 1,
    "global_tokens_saved": 18432,
    "urls": {
      "https://example.com/docs": {
        "last_known_sha256": "9f86d0...",
        "etag": "\"abc123\"",
        "token_cost_raw": 357,
        "token_cost_compressed": 18,
        "last_checked": "2026-06-27T08:36:00.000Z"
      }
    }
  }
}
```

On fatal errors, the JSON output is `{ "error": "message" }` with exit code 1.

## Agent Decision Tree

1. **Project has doc-lok?** → proceed. Otherwise, read the file normally.
2. **File has external http(s) links?** → run `--check --json` first.
3. **All links cached?** → safe to use condensed version (`--json`).
4. **Some links updated?** → read the file normally, or condense and note which links are fresh.
5. **Need to write back to the file?** → use `--restore` to inflate markers first.
