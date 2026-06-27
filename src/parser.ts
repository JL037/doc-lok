/**
 * parser.ts — Markdown link discovery, validation orchestration, and
 * condensing replacement.
 *
 * Workflow:
 *  1. Read the Markdown file.
 *  2. Regex-scan for `[text](url)` patterns (http/https only).
 *  3. For each unique URL, validate via `network.ts`.
 *  4. Update the lockfile with SHA-256 / ETag / token-savings metadata.
 *  5. Replace up-to-date link blocks with an HTML comment marker.
 */

import { promises as fs } from "node:fs";

import { validateUrl, type ValidationResult } from "./network.js";
import {
  COMPRESSED_MARKER_TOKENS,
  estimateTokens,
  readLockfile,
  resolveLockfilePath,
  updateEntry,
  writeLockfile,
  type Lockfile,
} from "./state.js";

/** Regex capturing Markdown link syntax: `[label](url)`. */
const LINK_RE = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)(?:\s+"[^"]*")?\)/g;

/** HTML comment marker injected in place of unchanged links. */
const MARKER = "<!-- doc-lok:cached -->";

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
}

/**
 * Condense a Markdown file by replacing unchanged remote links with a
 * tiny HTML comment marker.
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

  const urls = extractUniqueUrls(source);
  const diagnostics: LinkDiagnostic[] = [];
  let runTokensSaved = 0;

  // Validate every unique URL sequentially (keeps memory predictable and
  // avoids hammering a single host with concurrent requests).
  const results = new Map<string, ValidationResult>();
  for (const url of urls) {
    const prev = lockfile.urls[url];
    try {
      const result = await validateUrl(url, {
        knownEtag: prev?.etag ?? null,
        knownSha256: prev?.last_known_sha256 ?? null,
      });
      results.set(url, result);

      const rawTokenCost =
        result.tokenCost > 0
          ? result.tokenCost
          : estimateTokens(url); // fallback for HEAD-only hits
      const { tokensSaved } = updateEntry(
        lockfile,
        url,
        result.sha256,
        result.etag,
        rawTokenCost,
      );

      const status: LinkDiagnostic["status"] = result.unchanged
        ? "cached"
        : "updated";
      runTokensSaved += Math.max(0, tokensSaved);

      diagnostics.push({
        url,
        status,
        tokensSaved: Math.max(0, tokensSaved),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      diagnostics.push({
        url,
        status: "error",
        tokensSaved: 0,
        message: msg,
      });
    }
  }

  // Rewrite the Markdown, replacing unchanged links with the marker.
  const output = replaceLinks(source, results);

  await writeLockfile(resolvedLock, lockfile);

  return {
    output,
    diagnostics,
    tokensSaved: runTokensSaved,
    lockfilePath: resolvedLock,
  };
}

/** Extract all unique http(s) URLs from Markdown link syntax. */
function extractUniqueUrls(md: string): string[] {
  const set = new Set<string>();
  let m: RegExpExecArray | null;
  LINK_RE.lastIndex = 0;
  while ((m = LINK_RE.exec(md)) !== null) {
    set.add(m[2]);
  }
  return [...set];
}

/**
 * Replace every `[text](url)` whose validation reported `unchanged: true`
 * with the HTML comment marker.
 */
function replaceLinks(
  md: string,
  results: Map<string, ValidationResult>,
): string {
  return md.replace(LINK_RE, (full, _label: string, url: string) => {
    const r = results.get(url);
    if (r?.unchanged) {
      return MARKER;
    }
    return full;
  });
}

/** Re-export the marker for consumers that want to detect it. */
export { MARKER, COMPRESSED_MARKER_TOKENS };
export type { Lockfile };
