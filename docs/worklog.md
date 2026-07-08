# doc-lok — Development Worklog

## 2026-07-06 — P0 Implementation: HTTP Redirects and Restore Anchor Text

### What was done
1. **HTTP redirect following** in `src/network.ts`:
   - Added `maxRedirects` option to `ValidateOptions` (default 5).
   - `headRequest` and `streamGet` now detect `301`/`302`/`307`/`308`, resolve the `Location` header (including relative URLs), and recurse up to the configured limit.
   - Lockfile keys remain the original Markdown URL; validation targets the final redirected resource.
   - Added 4 redirect tests to `test/network.test.ts`.

2. **Restore original anchor text** in `src/state.ts` and `src/parser.ts`:
   - Added `original_text?: string` to `UrlEntry`.
   - Bumped default lockfile `version` from `1` to `2`.
   - Updated `updateEntry` to spread the previous entry, preserving `original_text` (and any future fields) across re-validation.
   - Updated `replaceLinks` to record `original_text` in the lockfile when condensing an inline link whose text differs from its URL.
   - Updated `restoreMarkdown` to reconstruct `[text](url)` using `original_text`, falling back to `[url](url)` when absent.
   - Added 5 tests to `test/parser-refs.test.ts` covering restore with text, legacy fallback, condense→restore round-trip, `checkMarkdown` preservation, and last-seen-wins behavior for duplicate URLs.
   - Updated `test/state.test.ts` for the new default version and field preservation.
   - Updated `test/cli-json.test.ts` and `test/cli.test.ts` expectations to match the new `[text](url)` restore behavior and `v0.2.0` version.

3. **Documentation updates**:
   - `README.md`: added a concise **Features** section; updated lockfile example, schema tables, network validation notes, and limitations.
   - `docs/status.md`: updated capabilities, roadmap table, known limitations, and architecture decisions.
   - `ROADMAP.md`: corrected the restore-text section to use the lockfile instead of inline markers.
   - `docs/implementation-p0.md`: detailed implementation notes (see file).
   - `CHANGELOG.md`: created to track versioned changes and an `[Unreleased]` section.

### Tests
```
Test Files  10 passed (10)
     Tests  89 passed (89)
```

### Files changed / created
| File | Action |
|------|--------|
| `src/network.ts` | Added redirect following |
| `src/state.ts` | Added `original_text`, bumped lockfile version, preserved fields in `updateEntry` |
| `src/parser.ts` | Record and restore anchor text |
| `test/network.test.ts` | Added redirect tests |
| `test/parser-refs.test.ts` | Added restore anchor-text tests |
| `test/state.test.ts` | Updated for version 2 and field preservation |
| `README.md` | Updated docs |
| `docs/status.md` | Updated status |
| `docs/worklog.md` | Added this entry |
| `ROADMAP.md` | Updated restore-text recommendation |
| `docs/implementation-p0.md` | Created detailed implementation doc |

---

## 2026-07-03 — Code-Block-Aware Parsing, Honest Token Accounting, and Doc Sync

### What was done
1. **Code-block-aware Markdown scanning** in `src/scanner.ts`:
   - New module tracks `normal`, `inlineCode`, `fencedCode`, and `indentedCode` states while walking Markdown line-by-line.
   - Inline links inside inline code backticks, fenced ` ``` `/`~~~` blocks, and indented code blocks are **excluded** from condensing.
   - `src/parser.ts` now uses `extractInlineLinks()` and `extractRefDefs()` from `scanner.ts`, replacing the naive global regex.
2. **Honest token accounting** in `src/state.ts`:
   - Added optional `cached` flag to `UrlEntry`.
   - `updateEntry()` only counts `tokensSaved` the first time a URL is successfully cached, preventing double-counting across repeated runs.
   - Preserves the highest `token_cost_raw` seen so a HEAD-only validation never downgrades a full-GET cost.
3. **Updated documentation to match the v0.1.3 state**:
   - `docs/status.md`: version `0.1.3`, 79 tests / 10 suites, 6 source modules, code-block parsing and agent CLI modes marked done, CI matrix Node 20/22.
   - `README.md`: added `scanner.ts` to project structure and module responsibilities, documented code-block awareness, added `cached` field to lockfile types, corrected test count.
   - `test/parser-codeblocks.test.ts`: removed stale "BUG — currently fails" describe title and misleading BUG comments now that the fix is in place.

### Tests
```
Test Files  10 passed (10)
     Tests  79 passed (79)
```

### Files changed / created
| File | Action |
|------|--------|
| `src/scanner.ts` | Created — code-block-aware link extractor |
| `src/parser.ts` | Uses `scanner.ts`; honest per-run token savings |
| `src/state.ts` | Added `cached` flag and honest savings logic |
| `test/parser-codeblocks.test.ts` | Created; stale BUG comments removed |
| `docs/status.md` | Updated to v0.1.3 |
| `docs/worklog.md` | Added this entry |
| `README.md` | Updated project structure, types, and architecture notes |

---

## 2026-06-27 — Comprehensive Documentation Update

### What was done
Wrote a thorough recap of the project's current capabilities across all documentation files:

1. **Updated `README.md`** — the primary user-facing documentation:
   - Updated tagline to mention reference-style links and round-trip restore.
   - Rewrote the Overview section to explain both inline and reference link handling, the hash-embedded marker format, and the restore command.
   - Added `--restore` to the CLI quick-start with example output.
   - Added `restoreMarkdown` to the Library Usage section.
   - Added `restoreMarkdown` API reference with full parameter/return documentation.
   - Updated CLI Reference to show the `[mode]` syntax (`--restore`).
   - Updated Project Structure to include test files, CI config, and docs.
   - Updated `token_cost_compressed` from 15 → 18 to reflect the hash-embedded marker.
   - Added "Restore uses URL as link text" to Limitations.
   - Added `test` and `test:watch` scripts to the Scripts table.

2. **Rewrote `docs/status.md`** — the canonical project status document:
   - Added a **Capabilities Recap** section with a Markdown syntax support matrix.
   - Added a **Network Validation** diagram explaining the HEAD-then-GET strategy.
   - Added a **Marker Format** section explaining why we moved from `<!-- doc-lok:cached -->` to `<!-- doc-lok:cached#hash -->`.
   - Reorganized Interfaces section with clearer CLI/Library/Low-level groupings.
   - Updated What's Missing table (reference links and restore are now done).
   - Updated Known Limitations.
   - Added Architecture Decisions section documenting hash-embedded markers and reference-definition preservation.

### Key decisions documented
- **Why reference definitions aren't condensed** — They're already ~5-10 tokens (just a URL) and removing them would break `[ref]` usage elsewhere in the document. Validating them still keeps the lockfile warm.
- **Why markers embed a hash** — The old `<!-- doc-lok:cached -->` format was ambiguous. If you condensed 5 different URLs in one document, restore had no way to know which marker belonged to which URL. The 6-char SHA-256 hash (`#abc123`) makes every marker self-describing.
- **Why restore uses `[url](url)`** — The lockfile only stores the URL, not the original link text. Storing `[text](url)` would require a schema migration. `[url](url)` is a safe, functional default.

---

## 2026-06-27 — Reference-Style Links, Restore/Inflate, Tests

### What was done
1. **Reference-style Markdown link support** in `src/parser.ts`:
   - Added `REF_DEF_RE` regex to parse `[ref]: https://...` definitions, including angle-bracketed URLs and optional titles (`"..."`, `'...'`, `(...)`).
   - Reference definitions are **validated** (so the lockfile stays current) but **never replaced** in output — they're already token-cheap and removing them would break Markdown rendering.
   - Token savings are only counted for inline links.
2. **Restore / inflate command**:
   - Added `restoreMarkdown(mdFilePath, lockfilePath?)` to `src/parser.ts` — replaces `<!-- doc-lok:cached#hash -->` markers back with `[url](url)` links using the lockfile as a lookup table.
   - Added `--restore` flag to CLI (`src/cli.ts`) with its own diagnostics block.
   - Added `hashUrl()` to `src/state.ts` — computes the first 6 hex chars of SHA-256(url) for marker embedding.
3. **Marker format changed** from `<!-- doc-lok:cached -->` to `<!-- doc-lok:cached#abc123 -->` to make restore unambiguous.
4. **Updated exports** in `src/index.ts` — re-exported `restoreMarkdown` and `hashUrl`.
5. **Wrote 18 new tests** across 3 suites:
   - `test/parser-refs.test.ts` (11 tests) — reference def parsing, validation without replacement, angle brackets, titles, non-http refs, deduplication, token savings exclusion, restore single/multiple/unknown markers
   - `test/cli-restore.test.ts` (3 tests) — `--restore` flag, `--quiet` with restore, updated help text
   - `test/hashUrl.test.ts` (4 tests) — hex format, stability, distinctness, case sensitivity
6. **Fixed existing tests** — updated `test/network.test.ts` timeout test to use an unbound port, updated `test/parser-refs.test.ts` restore test to compute the hash dynamically instead of hardcoding.

### Tests written and passing
```
Test Files  7 passed (7)
     Tests  59 passed (59)
```

### Key decisions made
- **Hash-embedded markers** — `<!-- doc-lok:cached#abc123 -->` encodes a 6-char SHA-256 hash of the URL. This makes restore unambiguous even if multiple different URLs were condensed in the same document. It also makes markers slightly larger (~18 tokens vs. 15), which is still negligible compared to typical link payloads.
- **Reference definitions stay put** — Unlike inline links, `[ref]: url` definitions are already very compact. Removing them would break Markdown renderers that expect the definition to exist for `[ref]` usage elsewhere in the document. We still validate them so the lockfile stays warm.
- **Restore uses URL as link text** — The lockfile does not store the original link text (`[text](url)`), only the URL. Restoring `[url](url)` is a safe default; storing original text would require a schema migration.

### Files changed / created
| File | Action |
|------|--------|
| `src/parser.ts` | Added `REF_DEF_RE`, `extractUniqueUrls` returns `{inlineUrls, refUrls}`, added `restoreMarkdown()`, `replaceLinks` now embeds URL hash in marker |
| `src/cli.ts` | Added `--restore` flag and branch in `main()` |
| `src/state.ts` | Added `hashUrl()` function |
| `src/index.ts` | Re-exported `restoreMarkdown`, `hashUrl` |
| `test/parser-refs.test.ts` | Created |
| `test/cli-restore.test.ts` | Created |
| `test/hashUrl.test.ts` | Created |
| `test/network.test.ts` | Fixed timeout test (unbound port) |
| `docs/status.md` | Updated feature matrix, limitations, API docs |
| `docs/worklog.md` | Added this entry |

---

## 2026-06-27 — Test Suite, CI & Documentation

### What was done
1. **Installed Vitest** as the test runner (`npm install -D vitest`).
2. **Wrote 41 tests** across 4 suites covering every source module:
   - `test/state.test.ts` (15 tests) — lockfile resolution, read/write, normalization, token estimation, entry updates
   - `test/network.test.ts` (9 tests) — ETag matching, mismatch fallback, SHA-256 detection, 4xx/5xx errors, timeout
   - `test/parser.test.ts` (9 tests) — no-link files, caching on second run, change detection, error isolation, deduplication, non-HTTP links, explicit lockfile, link titles, global savings accumulation
   - `test/cli.test.ts` (8 tests) — `--help`, `--version`, missing file, unknown args, stdout output, `--quiet`, `--lockfile`, fatal error codes
3. **Created `vitest.config.ts`** with Node environment and `test/**/*.test.ts` glob.
4. **Added test scripts** to `package.json`: `test` (run once) and `test:watch` (watch mode).
5. **Created `.github/workflows/ci.yml`** — runs `npm ci`, `npm run build`, `npx vitest run`, and `node dist/cli.js --version` on Node 18, 20, and 22.
6. **Created `docs/status.md`** — comprehensive project status, feature matrix, known limitations, and build instructions.
7. **Created `docs/worklog.md`** — this file.

### Tests written and passing
```
Test Files  4 passed (4)
     Tests  41 passed (41)
```

### Key decisions made
- **No mocking libraries** — Tests spin up real `node:http` servers. This validates the actual `request`/`httpRequest` code paths without abstraction leakage.
- **Tmp dirs for I/O** — Every test that touches the filesystem uses `os.tmpdir()` to avoid polluting the repo.
- **Env var isolation** — `DOC_LOK_LOCKFILE` tests save and restore the original value.

### Files changed / created
| File | Action |
|------|--------|
| `package.json` | Added `test` and `test:watch` scripts; added `vitest` devDependency |
| `vitest.config.ts` | Created |
| `test/state.test.ts` | Created |
| `test/network.test.ts` | Created |
| `test/parser.test.ts` | Created |
| `test/cli.test.ts` | Created |
| `.github/workflows/ci.yml` | Created |
| `docs/status.md` | Created |
| `docs/worklog.md` | Created |

---

## Earlier History

| Date | Commit | What |
|------|--------|------|
| — | `9173e26` | Scaffolded project with TypeScript, ESM config, `.gitignore` |
| — | `9a3831e` | Implemented `state.ts` — lockfile read/write, token tracking |
| — | `197891d` | Implemented `network.ts` — HEAD-first ETag, streamed SHA-256 GET |
| — | `24f6178` | Implemented `parser.ts` — link extraction, validation orchestration, replacement |
| — | `056906c` | Implemented `cli.ts` — argument parsing, stdout/stderr separation |
| — | `0af26af` | Wrote comprehensive README |
| — | `bb9a2e1` | Exported public programmatic API surface in `index.ts` |

---

## Next Planned Work

1. **Custom HTTP headers** — `--header` CLI flag and `headers` option in `validateUrl()` for authenticated endpoints.
2. **npm publish** — Tag `v0.1.0` and publish to the registry.
3. **Watch mode** — `--watch` flag for iterative prompt development.
4. **Restore with original link text** — Store original `[text](url)` in lockfile so restore reconstructs exactly what was there.
