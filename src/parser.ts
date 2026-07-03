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

/**
 * Regex capturing reference-style link definitions:
 *   [ref]:  https://example.com  "optional title"
 *   [ref]: <https://example.com> "optional title"
 * Groups: 1=label, 2=url (may include angle brackets)
 */
/** HTML comment marker injected in place of unchanged inline links. */
const MARKER = "<!-- doc-lok:cached";

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
  const output = replaceLinks(source, results);

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
  // Since the lockfile only stores the URL, we use the URL itself as the
  // link text for restored links: [https://example.com](https://example.com).
  const urlByHash = new Map<string, string>();
  for (const [url] of Object.entries(lockfile.urls)) {
    urlByHash.set(hashUrl(url), url);
  }

  let restoredCount = 0;

  const output = source.replace(
    /<!-- doc-lok:cached#([a-f0-9]{6}) -->/g,
    (_match, hash: string) => {
      const url = urlByHash.get(hash);
      if (!url) {
        // Unknown hash — leave the marker in place so the user can investigate.
        return _match;
      }
      restoredCount++;
      return `[${url}](${url})`;
    },
  );

  return { output, restoredCount, lockfilePath: resolvedLock };
}

/**
 * Replace every `[text](url)` whose validation reported `unchanged: true`
 * with an HTML comment marker that embeds a short URL hash.
 *
 * Uses exact byte positions from the scanner so links inside code blocks
 * are never touched.
 */
function replaceLinks(
  md: string,
  results: Map<string, ValidationResult>,
): string {
  const links = extractInlineLinks(md);
  const replacements: Array<{ start: number; end: number; replacement: string }> = [];

  for (const link of links) {
    const r = results.get(link.url);
    if (r?.unchanged) {
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
export { MARKER, COMPRESSED_MARKER_TOKENS };
export type { Lockfile };
