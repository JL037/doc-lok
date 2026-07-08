# Changelog

All notable changes to `doc-lok` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

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
- SHA-256/ETag lockfile (`doc-lok.json`).
- HEAD-first validation with streamed SHA-256 GET fallback.
- `--restore` command to inflate markers back into links.
