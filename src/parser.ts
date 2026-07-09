/**
 * parser.ts — Markdown link discovery, validation orchestration, and
 * condensing replacement.
 *
 * Workflow:
 *  1. Read the Markdown file.
 *  2. Regex-scan for `[text](url)` inline links and `[ref]: url` definitions
 *     (http/https only).
 *  3. For each unique URL, validate via `network.ts`.
 *  4. Update the lockfile with SHA-256 / ETag / token-savings metadata.
 *  5. Replace up-to-date inline link blocks with an HTML comment marker.
 *  6. Reference-style definitions are validated but never replaced (they are
 *     already token-cheap; removing them breaks Markdown rendering).
 *  7. Restore mode replaces `<!-- doc-lok:cached#hash -->` markers back with
 *     the original `[text](url)` links using the lockfile as the source of
 *     truth.
 */

import { promises as fs } from "node:fs";

import { validateUrl, type ValidationResult } from "./network.js";
import {
  COMPRESSED_MARKER_TOKENS,
  estimateTokens,
  hashUrl,
  readLockfile,
  resolveLockfilePath,
  updateEntry,
  writeLockfile,
  type Lockfile,
} from "./state.js";
import { extractInlineLinks, extractRefDefs } from "./scanner.js";
import type { SsrfOptions } from "./ssrf.js";
import {
  readBody,
  resolveCacheDir,
  readMarkdown,
  writeMarkdown,
  readIndex,
  writeIndex,
} from "./cache.js";
import { convertHtmlToMarkdown, type ConverterMode } from "./convert.js";
import {
  matchSections,
  isSpecialSectionName,
  type Section,
} from "./sections.js";

/** Options shared across the high-level markdown functions. */
export interface MarkdownOptions extends SsrfOptions {
  /**
   * Override the per-request timeout (ms). Default 15 000.
   * Currently informational — threaded through to `validateUrl`.
   */
  timeoutMs?: number;
}

/** Default size cap for `--inline` bodies (1 MB). */
const DEFAULT_INLINE_MAX_BYTES = 1_048_576;

/** Default content-type allowlist for `--inline`. */
const DEFAULT_INLINE_CONTENT_TYPES = ["text/html", "text/plain"] as const;

/** Additional options for `inlineMarkdown`. */
export interface InlineOptions extends MarkdownOptions {
  /**
   * Override the default cache directory (`.doc-lok/cache` next to the
   * lockfile). Path is resolved relative to `process.cwd()`.
   */
  cacheDir?: string;
  /**
   * Refuse bodies larger than this. Default 1 MB.
   */
  maxBytes?: number;
  /**
   * Allowlist of Content-Type prefixes. Default: `text/html`, `text/plain`.
   * Pass an empty array to allow any content type.
   */
  allowedContentTypes?: readonly string[];
  /**
   * Section names to inline. Default `[]` — inline the table-of-contents
   * only. Special values: `"all"` / `"*"` for the full body, `"toc"` /
   * `"index"` for the TOC-only default. Otherwise, name(s) are matched
   * against detected headings via `matchSections`.
   */
  sections?: string[];
  /**
   * HTML→Markdown converter mode. Default `"minimal"` (built-in, zero deps).
   * Pass `"turndown"` to use the `turndown` peer dependency.
   */
  converter?: ConverterMode;
}

/** Per-link diagnostic emitted by `inlineMarkdown` (extends the base). */
export interface InlineDiagnostic extends LinkDiagnostic {
  /** Slugs of sections that were actually inlined (empty for TOC-only or error). */
  matchedSections?: string[];
  /** All section slugs available on the page (for agent discovery). */
  availableSections?: string[];
}

/** Result returned by `inlineMarkdown`. */
export interface InlineResult {
  /** Markdown with inline content blocks injected under unchanged links. */
  output: string;
  /** Per-link diagnostics. */
  diagnostics: InlineDiagnostic[];
  /** Total tokens saved this run (network + latency, not LLM tokens — see README). */
  tokensSaved: number;
  /** Path to the lockfile that was read/written. */
  lockfilePath: string;
  /** Full lockfile state after this run. */
  lockfile: Lockfile;
  /** Cache directory used for body storage. */
  cacheDir: string;
  /** Number of inline blocks written (vs. skipped due to error / oversized). */
  inlinedCount: number;
}

/**
 * Regex capturing reference-style link definitions:
 *   [ref]:  https://example.com  "optional title"
 *   [ref]: <https://example.com> "optional title"
 * Groups: 1=label, 2=url (may include angle brackets)
 */
/** HTML comment marker injected in place of unchanged inline links. */
const MARKER = "<!-- doc-lok:cached";

/** HTML comment marker prefix used by `inlineMarkdown` to wrap fetched bodies. */
const INLINE_MARKER = "<!-- doc-lok:inline";

/** Per-link diagnostic emitted to the CLI. */
export interface LinkDiagnostic {
  url: string;
  status: "cached" | "updated" | "error";
  tokensSaved: number;
  message?: string;
}

/** Aggregate result returned by `condenseMarkdown`. */
export interface CondenseResult {
  /** The condensed Markdown text. */
  output: string;
  /** Per-link diagnostics. */
  diagnostics: LinkDiagnostic[];
  /** Total tokens saved in this run. */
  tokensSaved: number;
  /** Path to the lockfile that was read/written. */
  lockfilePath: string;
  /** Full lockfile state after this run (for agent / --json consumption). */
  lockfile: Lockfile;
}

/**
 * Extract all unique http(s) URLs from inline links and reference
 * definitions.  Reference definitions are tracked so their URLs can be
 * validated, but they are never replaced in the output.
 */
function extractUniqueUrls(md: string): {
  inlineUrls: string[];
  refUrls: string[];
} {
  const inlineLinks = extractInlineLinks(md);
  const inlineSet = new Set<string>(inlineLinks.map((l) => l.url));

  const refDefs = extractRefDefs(md);
  const refSet = new Set<string>(refDefs.map((r) => r.url));

  return { inlineUrls: [...inlineSet], refUrls: [...refSet] };
}

/**
 * Condense a Markdown file by replacing unchanged remote inline links with a
 * tiny HTML comment marker.  Reference-style definitions are validated (so
 * the lockfile stays current) but are left in place.
 *
 * @param mdFilePath  Absolute or relative path to the `.md` file.
 * @param lockfilePath  Optional explicit lockfile path.
 */
export async function condenseMarkdown(
  mdFilePath: string,
  lockfilePath?: string,
  opts: MarkdownOptions = {},
): Promise<CondenseResult> {
  const resolvedLock = resolveLockfilePath(mdFilePath, lockfilePath);
  const lockfile = await readLockfile(resolvedLock);
  const source = await fs.readFile(mdFilePath, "utf8");

  const { inlineUrls, refUrls } = extractUniqueUrls(source);
  const uniqueUrls = [...new Set([...inlineUrls, ...refUrls])];

  const diagnostics: LinkDiagnostic[] = [];
  let runTokensSaved = 0;

  const results = new Map<string, ValidationResult>();
  for (const url of uniqueUrls) {
    const prev = lockfile.urls[url];
    try {
      const result = await validateUrl(url, {
        knownEtag: prev?.etag ?? null,
        knownSha256: prev?.last_known_sha256 ?? null,
        allowPrivate: opts.allowPrivate,
        timeoutMs: opts.timeoutMs,
      });
      results.set(url, result);

      const rawTokenCost =
        result.tokenCost > 0 ? result.tokenCost : estimateTokens(url);
      const { tokensSaved } = updateEntry(
        lockfile,
        url,
        result.sha256,
        result.etag,
        rawTokenCost,
        result.unchanged,
      );

      const status: LinkDiagnostic["status"] = result.unchanged
        ? "cached"
        : "updated";

      // Only count token savings for inline links that were actually cached.
      if (inlineUrls.includes(url) && result.unchanged) {
        runTokensSaved += tokensSaved;
      }

      diagnostics.push({ url, status, tokensSaved });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      diagnostics.push({ url, status: "error", tokensSaved: 0, message: msg });
    }
  }

  // Rewrite the Markdown, replacing unchanged inline links with the marker.
  const output = replaceLinks(source, results, lockfile);

  await writeLockfile(resolvedLock, lockfile);

  return {
    output,
    diagnostics,
    tokensSaved: runTokensSaved,
    lockfilePath: resolvedLock,
    lockfile,
  };
}

/**
 * Inline mode (`--inline`): fetch the body of each linked URL, cache it,
 * and inject a fenced HTML-comment block into the Markdown so the LLM
 * sees the linked content directly. Unchanged URLs on re-runs skip the
 * body re-fetch entirely (HEAD only) — saves network + latency, and
 * makes the prompt byte-identical across runs (which unlocks provider-
 * side prompt caching on Anthropic / OpenAI).
 *
 * **Does not save LLM tokens on its own** — the inlined body is still
 * sent and tokenized every run. See ROADMAP P2 (`--summary`) for the
 * feature that actually shrinks LLM token cost.
 *
 * @param mdFilePath  Absolute or relative path to the `.md` file.
 * @param lockfilePath  Optional explicit lockfile path.
 * @param opts  Optional: `cacheDir`, `maxBytes`, `allowedContentTypes`,
 *              `allowPrivate`, `timeoutMs`.
 */
export async function inlineMarkdown(
  mdFilePath: string,
  lockfilePath?: string,
  opts: InlineOptions = {},
): Promise<InlineResult> {
  const resolvedLock = resolveLockfilePath(mdFilePath, lockfilePath);
  const lockfile = await readLockfile(resolvedLock);
  const source = await fs.readFile(mdFilePath, "utf8");

  const cacheDir = resolveCacheDir(resolvedLock, opts.cacheDir);
  const maxBytes = opts.maxBytes ?? DEFAULT_INLINE_MAX_BYTES;
  const allowedContentTypes =
    opts.allowedContentTypes ?? DEFAULT_INLINE_CONTENT_TYPES;
  const converterMode: ConverterMode = opts.converter ?? "minimal";
  const requestedSections = opts.sections ?? [];

  // Resolve special section values once.
  // `all` / `*` → full body inline.
  // `toc` / `index` (or empty) → TOC-only (the default).
  const wantsAll = requestedSections.some(
    (s) => s.toLowerCase() === "all" || s === "*",
  );
  const wantsToc =
    !wantsAll &&
    (requestedSections.length === 0 ||
      requestedSections.every(
        (s) => s.toLowerCase() === "toc" || s.toLowerCase() === "index",
      ));
  const sectionQueries = wantsAll || wantsToc
    ? []
    : requestedSections.filter((s) => !isSpecialSectionName(s));

  const { inlineUrls, refUrls } = extractUniqueUrls(source);
  const uniqueUrls = [...new Set([...inlineUrls, ...refUrls])];

  const diagnostics: InlineDiagnostic[] = [];
  let runTokensSaved = 0;
  let inlinedCount = 0;

  // Map URL → inline block content (deterministic).
  const inlineBlocks = new Map<string, string>();

  for (const url of uniqueUrls) {
    const prev = lockfile.urls[url];
    try {
      const result = await validateUrl(url, {
        knownEtag: prev?.etag ?? null,
        knownSha256: prev?.last_known_sha256 ?? null,
        allowPrivate: opts.allowPrivate,
        timeoutMs: opts.timeoutMs,
        cacheDir,
        maxBytes,
        allowedContentTypes,
      });

      // Decide where to source the body from.
      let body: string | null = null;
      if (result.cachedBodyPath) {
        body = await readBody(cacheDir, result.sha256);
      } else if (result.unchanged && prev?.last_known_sha256) {
        body = await readBody(cacheDir, prev.last_known_sha256);
        if (body === null) {
          // ETag matched (HEAD fast-path) but the body was never cached
          // on disk — this happens when condense or --check ran first
          // (they record ETags but don't save bodies). Fall back to a
          // full GET to populate the body cache, then use the result.
          const reFetch = await validateUrl(url, {
            knownEtag: null,
            knownSha256: null,
            allowPrivate: opts.allowPrivate,
            timeoutMs: opts.timeoutMs,
            cacheDir,
            maxBytes,
            allowedContentTypes,
          });
          if (reFetch.cachedBodyPath) {
            body = await readBody(cacheDir, reFetch.sha256);
          }
          // Update result so downstream code uses the fresh SHA/etag.
          if (body !== null) {
            result.sha256 = reFetch.sha256;
            result.etag = reFetch.etag;
            result.byteLength = reFetch.byteLength;
            result.tokenCost = reFetch.tokenCost;
            result.unchanged = reFetch.unchanged;
          }
        }
      }

      if (body === null) {
        diagnostics.push({
          url,
          status: "updated",
          tokensSaved: 0,
          message: "no body available to inline (first-run + HEAD-only)",
        });
        continue;
      }

      // Convert body to Markdown + build section index. Cache the
      // converted Markdown + index on disk so repeat runs are free.
      const bodySha = result.sha256 || prev?.last_known_sha256 || "";
      let md: string | null = await readMarkdown(cacheDir, bodySha);
      let sections: Section[] | null = await readIndex(cacheDir, bodySha);
      if (md === null || sections === null) {
        const conv = await convertHtmlToMarkdown(body, {
          converter: converterMode,
        });
        md = conv.markdown;
        sections = conv.sections;
        await writeMarkdown(cacheDir, bodySha, md);
        await writeIndex(cacheDir, bodySha, sections);
      }

      // Update lockfile (network savings only — see README token table).
      const rawTokenCost =
        result.byteLength > 0
          ? result.tokenCost
          : estimateTokens(body);
      const { tokensSaved } = updateEntry(
        lockfile,
        url,
        result.sha256,
        result.etag,
        rawTokenCost,
        result.unchanged,
      );
      const entry = lockfile.urls[url];
      if (entry) {
        entry.converted = true;
        entry.section_slugs = sections.map((s) => s.slug);
      }

      const h = hashUrl(url);
      const availableSlugs = sections.map((s) => s.slug);

      // Decide what to emit based on section selection.
      const blocks: string[] = [];
      const matchedSlugs: string[] = [];

      if (wantsAll) {
        blocks.push(formatInlineBlock(h, md, "<body>"));
        matchedSlugs.push("all");
      } else if (wantsToc && sections.length > 0) {
        blocks.push(formatInlineBlock(h, renderToc(sections), "<index>"));
        matchedSlugs.push("toc");
      } else if (wantsToc && sections.length === 0) {
        // No headings detected — fall back to full body.
        blocks.push(formatInlineBlock(h, md, "<body>"));
        matchedSlugs.push("all");
      } else {
        const match = matchSections(sections, sectionQueries);
        // Emit one block per matched section, in request order.
        // matchSections returns matched in page order; re-sort to
        // request order so output matches what the user asked for.
        const bySlug = new Map(match.matched.map((s) => [s.slug, s]));
        for (const q of sectionQueries) {
          // Re-resolve to keep request order; matchSections dedupes.
          const cand = bySlug.get(q) ??
            match.matched.find((s) =>
              s.slug === q || s.slug.toLowerCase() === q.toLowerCase() ||
              s.heading.toLowerCase().includes(q.toLowerCase()),
            );
          if (cand) {
            const body_slice = md.slice(cand.start, cand.end).trim();
            blocks.push(
              formatInlineBlock(h, body_slice, `<section:${cand.slug}>`),
            );
            matchedSlugs.push(cand.slug);
          }
        }

        // Unknown / ambiguous diagnostics.
        for (const u of match.unknown) {
          diagnostics.push({
            url,
            status: "error",
            tokensSaved: 0,
            message: `unknown section: "${u}"\n  available sections: ${
              availableSlugs.join(", ")
            }`,
            availableSections: availableSlugs,
          });
        }
        for (const a of match.ambiguous) {
          diagnostics.push({
            url,
            status: "error",
            tokensSaved: 0,
            message: `ambiguous section: "${a.query}"\n  candidates: ${
              a.candidates.map((c) => c.slug).join(", ")
            }\n  hint: pass the full slug, e.g. --section ${
              a.candidates[0]?.slug ?? ""
            }`,
            availableSections: availableSlugs,
          });
        }

        if (blocks.length === 0) {
          // Nothing matched; the link stays intact (no inline block).
          continue;
        }
      }

      // Concatenate all blocks for this URL into one injection.
      inlineBlocks.set(url, blocks.join("\n\n"));

      if (inlineUrls.includes(url)) {
        runTokensSaved += tokensSaved;
        inlinedCount++;
      }

      diagnostics.push({
        url,
        status: result.unchanged ? "cached" : "updated",
        tokensSaved,
        matchedSections: matchedSlugs,
        availableSections: availableSlugs,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      diagnostics.push({ url, status: "error", tokensSaved: 0, message: msg });
    }
  }

  const output = injectInlineBlocks(source, inlineBlocks);

  await writeLockfile(resolvedLock, lockfile);

  return {
    output,
    diagnostics,
    tokensSaved: runTokensSaved,
    lockfilePath: resolvedLock,
    lockfile,
    cacheDir,
    inlinedCount,
  };
}

/** Render a section list as a Markdown TOC. */
function renderToc(sections: Section[]): string {
  const lines = sections.map((s) => {
    const indent = "  ".repeat(Math.max(0, s.level - 1));
    return `${indent}- [${s.heading}](#${s.slug})`;
  });
  return `## Sections\n${lines.join("\n")}`;
}

/** Format an inline block (HTML comment wrapping the provided body). */
function formatInlineBlock(hash: string, body: string, tag: string): string {
  const safe = body.replace(/-->/g, "--&gt;");
  return `${INLINE_MARKER}#${hash} ${tag}\n${safe}\n-->`;
}

/**
 * Inject inline blocks after each inline link whose URL is in the map.
 * Leaves changed / errored URLs untouched. Applies edits from end to
 * start so byte offsets stay valid.
 */
function injectInlineBlocks(
  md: string,
  inlineBlocks: Map<string, string>,
): string {
  const links = extractInlineLinks(md);
  const replacements: Array<{ start: number; end: number; replacement: string }> = [];

  for (const link of links) {
    const block = inlineBlocks.get(link.url);
    if (!block) continue;
    // Insert the block immediately AFTER the link, keeping the link
    // itself so the LLM can still cite the source. A blank line before
    // the block keeps it readable.
    const inject = `${link.text === "" ? "" : " "}\n\n${block}\n`;
    // Replace the link with `[text](url)` + the inline block. The link
    // is preserved verbatim; the block is appended after it on the
    // same byte range (i.e. the replacement includes the original link
    // so the start/end indices still produce the right output).
    const original = md.slice(link.start, link.end);
    replacements.push({
      start: link.start,
      end: link.end,
      replacement: `${original}${inject}`,
    });
  }

  replacements.sort((a, b) => b.start - a.start);
  let output = md;
  for (const rep of replacements) {
    output = output.slice(0, rep.start) + rep.replacement + output.slice(rep.end);
  }
  return output;
}

/**
 * Restore a condensed Markdown file by replacing `<!-- doc-lok:cached#hash -->`
 * markers back with the original `[text](url)` links.
 *
 * Uses the lockfile as the source of truth — every URL whose hash appears in
 * a marker must have a corresponding entry in the lockfile.
 *
 * @param mdFilePath  Absolute or relative path to the condensed `.md` file.
 * @param lockfilePath  Optional explicit lockfile path.
 */
export async function restoreMarkdown(
  mdFilePath: string,
  lockfilePath?: string,
): Promise<{ output: string; restoredCount: number; lockfilePath: string }> {
  const resolvedLock = resolveLockfilePath(mdFilePath, lockfilePath);
  const lockfile = await readLockfile(resolvedLock);
  const source = await fs.readFile(mdFilePath, "utf8");

  // Build url → originalLink map from lockfile entries.
  // We need to reconstruct what the original inline link looked like.
  // The lockfile stores the URL and, when available, the original anchor text.
  const urlByHash = new Map<string, string>();
  for (const [url] of Object.entries(lockfile.urls)) {
    urlByHash.set(hashUrl(url), url);
  }

  let restoredCount = 0;

  // Inline blocks: `<!-- doc-lok:inline#<hash> <tag>\n<body>\n-->` spans
  // multiple lines and is injected right after the original link. The
  // `<tag>` is one of `<index>`, `<section:slug>`, or `<body>`. Restore
  // strips the block (and any leading whitespace introduced when
  // doc-lok wrote it), leaving the original `[text](url)` in place.
  // NOTE: old-format blocks (no `<tag>`) are NOT stripped — P1 never
  // shipped to npm, so this is a clean break.
  let output = source.replace(
    /[ \t]*\n*<!-- doc-lok:inline#([a-f0-9]{64}) <\w+[:\w-]*>\n[\s\S]*?\n-->\n?/g,
    (match, hash: string) => {
      if (!urlByHash.has(hash)) return match; // unknown hash — leave intact
      restoredCount++;
      return "";
    },
  );

  // Cached markers: restore the original `[text](url)` link.
  output = output.replace(
    /<!-- doc-lok:cached#([a-f0-9]{64}) -->/g,
    (match, hash: string) => {
      const url = urlByHash.get(hash);
      if (!url) return match; // unknown hash — leave intact
      restoredCount++;
      const text = lockfile.urls[url]?.original_text ?? url;
      return `[${text}](${url})`;
    },
  );

  return { output, restoredCount, lockfilePath: resolvedLock };
}

/**
 * Replace every `[text](url)` whose validation reported `unchanged: true`
 * with an HTML comment marker that embeds a short URL hash.
 *
 * Uses exact byte positions from the scanner so links inside code blocks
 * are never touched. Also records the original anchor text in the lockfile
 * so restore can reconstruct `[text](url)` instead of `[url](url)`.
 */
function replaceLinks(
  md: string,
  results: Map<string, ValidationResult>,
  lockfile: Lockfile,
): string {
  const links = extractInlineLinks(md);
  const replacements: Array<{ start: number; end: number; replacement: string }> = [];

  for (const link of links) {
    const r = results.get(link.url);
    if (r?.unchanged) {
      // Preserve the original anchor text for restore, but only when it
      // differs from the URL (avoids redundant lockfile growth).
      const entry = lockfile.urls[link.url];
      if (entry && link.text !== link.url) {
        entry.original_text = link.text;
      }

      replacements.push({
        start: link.start,
        end: link.end,
        replacement: `${MARKER}#${hashUrl(link.url)} -->`,
      });
    }
  }

  // Apply replacements from end to start so indices don't shift.
  replacements.sort((a, b) => b.start - a.start);
  let output = md;
  for (const rep of replacements) {
    output = output.slice(0, rep.start) + rep.replacement + output.slice(rep.end);
  }
  return output;
}

/** Result returned by `checkMarkdown` — validation only, no file modification. */
export interface CheckResult {
  /** Per-link diagnostics with freshness status. */
  diagnostics: LinkDiagnostic[];
  /** Total tokens that *would* be saved if condensed. */
  tokensSaved: number;
  /** Path to the lockfile that was read/written. */
  lockfilePath: string;
  /** Full lockfile state (so agents can inspect SHAs without a separate read). */
  lockfile: Lockfile;
}

/**
 * Check URL freshness in a Markdown file without modifying it.
 *
 * Validates every http(s) URL (inline + reference), updates the lockfile with
 * current SHA-256 / ETag metadata, and returns diagnostics.  The Markdown file
 * itself is never rewritten — this is a read-only probe designed for agents
 * that need to know whether links are stale before deciding to condense.
 *
 * @param mdFilePath  Absolute or relative path to the `.md` file.
 * @param lockfilePath  Optional explicit lockfile path.
 */
export async function checkMarkdown(
  mdFilePath: string,
  lockfilePath?: string,
  opts: MarkdownOptions = {},
): Promise<CheckResult> {
  const resolvedLock = resolveLockfilePath(mdFilePath, lockfilePath);
  const lockfile = await readLockfile(resolvedLock);
  const source = await fs.readFile(mdFilePath, "utf8");

  const { inlineUrls, refUrls } = extractUniqueUrls(source);
  const uniqueUrls = [...new Set([...inlineUrls, ...refUrls])];

  const diagnostics: LinkDiagnostic[] = [];
  let potentialTokensSaved = 0;

  for (const url of uniqueUrls) {
    const prev = lockfile.urls[url];
    try {
      const result = await validateUrl(url, {
        knownEtag: prev?.etag ?? null,
        knownSha256: prev?.last_known_sha256 ?? null,
        allowPrivate: opts.allowPrivate,
        timeoutMs: opts.timeoutMs,
      });

      const rawTokenCost =
        result.tokenCost > 0 ? result.tokenCost : estimateTokens(url);
      const { tokensSaved } = updateEntry(
        lockfile,
        url,
        result.sha256,
        result.etag,
        rawTokenCost,
        result.unchanged,
      );

      const status: LinkDiagnostic["status"] = result.unchanged
        ? "cached"
        : "updated";

      if (inlineUrls.includes(url) && result.unchanged) {
        potentialTokensSaved += tokensSaved;
      }

      diagnostics.push({ url, status, tokensSaved });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      diagnostics.push({ url, status: "error", tokensSaved: 0, message: msg });
    }
  }

  await writeLockfile(resolvedLock, lockfile);

  return {
    diagnostics,
    tokensSaved: potentialTokensSaved,
    lockfilePath: resolvedLock,
    lockfile,
  };
}

/** Re-export the marker prefix for consumers that want to detect it. */
export { MARKER, INLINE_MARKER, COMPRESSED_MARKER_TOKENS };
export type { Lockfile };
