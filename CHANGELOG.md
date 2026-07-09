# Changelog

All notable changes to `doc-lok` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

---

## [0.2.2] — 2026-07-08

### Added

- **Agent workflow file** (`.windsurf/workflows/doc-lok.md`) — 11 agent rules covering all four modes (condense, check, inline, restore), `--section` usage, SSRF guard, first-run behavior, and a decision tree. Available in the repo; README documents how to copy it into any IDE's workflow/rules directory.
- `docs/cli-reference.md` — new Inline mode section with `--section` token savings table, SSRF guard section, inline cache section, inline JSON schema, inline workflow example, and `--allow-private`/`--converter`/`--max-bytes`/`--cache-dir`/`--section` flag documentation.
- README agent integration section expanded with IDE-agnostic install instructions.

### Changed

- `docs/cli-reference.md` — "Three Modes" → "Four Modes", lockfile path corrected from `doc-lok.json` to `.doc-lok/lock.json` throughout, lockfile version updated from 2 to 3, SSRF guard documented (was incorrectly listed as missing), "No content inlining" limitation removed (inline mode exists), version footer updated to 0.2.2.
- `CHANGELOG.md` — fixed stale `doc-lok.json` reference in 0.1.0 entry.

---

## [0.2.1] — 2026-07-08

### Added

- **`--section` selective inline** — `--inline` now converts fetched HTML to Markdown, builds a section index, and inlines only the requested sections. Default injects a table-of-contents (~200 tokens); `--section <name>` inlines specific sections; `--section all` inlines the full body. See [docs/sections.md](./docs/sections.md).
- **`--converter <mode>`** — Choose HTML→Markdown converter: `minimal` (built-in, zero deps) or `turndown` (optional peer dependency).
- **HTML→Markdown converter** (`src/convert.ts`) — Hand-rolled tokenizer handling headings, paragraphs, lists, code blocks, tables, links, images, inline formatting. Strips boilerplate tags (`<nav>`, `<script>`, `<style>`, etc.). `text/plain` passed through as-is.
- **Section matching** (`src/sections.ts`) — GitHub-style `slugifyHeading()` and 3-tier `matchSections()` (exact slug → case-insensitive slug → heading-contains). Unknown/ambiguous diagnostics with available sections listed.
- **Cache layout expansion** — `.doc-lok/cache/` now stores `.md` (converted Markdown) and `.index.json` (section index) alongside `.raw` files.
- **SSRF guard** (`src/ssrf.ts`) — Blocks loopback, link-local, private, and unique-local IP ranges by default. `--allow-private` opts in. Re-checks after redirects.
- **Library API exports** — `convertHtmlToMarkdown`, `detectSections`, `matchSections`, `slugifyHeading`, `resolveSectionName`, `isSpecialSectionName`, `Section`, `SectionMatchResult`, `ConvertResult`, `ConverterMode`, plus cache functions (`readMarkdown`, `writeMarkdown`, `readIndex`, `writeIndex`, `markdownPath`, `indexPath`).
- **`turndown` optional peer dependency** — `--converter turndown` uses turndown for richer HTML→Markdown fidelity. Dynamic import with clear error if not installed.
- **`InlineDiagnostic`** type with `matchedSections` and `availableSections` fields for agent discovery.
- Tests: 158 tests across 15 files (added `convert.test.ts`, `sections.test.ts`, `section-inline.test.ts`, `ssrf.test.ts`, `inline.test.ts`).

### Changed

- **Breaking: `--inline` default behavior** — `--inline` with no `--section` now inlines a table-of-contents only (~200 tokens). Use `--section all` for the old full-body behavior.
- **Breaking: inline block format** — New format: `<!-- doc-lok:inline#<hash> <tag>` where tag is `<index>`, `<section:slug>`, or `<body>`. Old-format blocks (no tag) are not stripped by `--restore` (clean break — P1 never shipped to npm).
- **Lockfile schema bumped** from version 2 to 3. New optional `converted` and `section_slugs` fields on `UrlEntry`. Old lockfiles auto-migrate (fields default to `false`/`[]`).
- **`--restore`** now strips new-format inline blocks (`<index>`, `<section:slug>`, `<body>` tags) in addition to `cached` markers.
- **`--inline` JSON output** now includes `matchedSections` and `availableSections` in diagnostics for agent consumption.

## [0.2.0] — 2026-07-06

### Added

- **HTTP redirect following** — `validateUrl` now follows `301`, `302`, `307`, and `308` redirects automatically (default max 5 hops). The original Markdown URL remains the lockfile key while validation targets the final resource.
- **Restore original anchor text** — The lockfile now stores `original_text` for condensed inline links, so `--restore` reconstructs `[text](url)` instead of `[url](url)`.
- `ValidateOptions.maxRedirects` option for controlling redirect depth.

### Changed

- Lockfile schema bumped from `version: 1` to `version: 2` (additive, backward-compatible).
- `updateEntry()` now preserves existing `UrlEntry` fields across re-validation, preventing accidental loss of metadata like `original_text`.

### Fixed

- Redirect responses are no longer hashed as if they were the target resource.
- `checkMarkdown()` and repeated `condenseMarkdown()` runs no longer wipe stored anchor text.

---

## [0.1.3] — 2026-07-03

### Added

- **Code-block-aware link scanning** — `src/scanner.ts` tracks inline code, fenced blocks, and indented blocks so links inside code are never condensed.
- **Honest token accounting** — Added `cached` flag to `UrlEntry`; `global_tokens_saved` is only incremented the first time a URL is successfully cached.
- **Agent CLI modes** — Added `--check` and `--json` flags for non-destructive, machine-readable workflows.
- Comprehensive test suite (79 tests across 10 files).

### Changed

- Marker format changed to `<!-- doc-lok:cached#hash -->` so restore is unambiguous across multiple URLs.
- Reference-style link definitions are validated but no longer condensed.

---

## [0.1.0] — 2026-07-02

### Added

- Initial release of `doc-lok`.
- CLI and library API for condensing Markdown links.
- SHA-256/ETag lockfile (`.doc-lok/lock.json`).
- HEAD-first validation with streamed SHA-256 GET fallback.
- `--restore` command to inflate markers back into links.
