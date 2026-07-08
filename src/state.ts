/**
 * state.ts — Manages the `doc-lok.json` lockfile that persists per-URL
 * cryptographic metadata so unchanged remote resources can be skipped.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";

/** Metadata tracked for every URL seen by doc-lok. */
export interface UrlEntry {
  /** Last computed SHA-256 hex digest of the response body. */
  last_known_sha256: string;
  /** HTTP ETag returned by the server, if any. */
  etag: string | null;
  /** Approximate token cost of the raw (un-condensed) content. */
  token_cost_raw: number;
  /** Token cost after condensing (the HTML comment marker). */
  token_cost_compressed: number;
  /** ISO-8601 timestamp of the last successful validation. */
  last_checked: string;
  /** True once this URL has been successfully cached/condensed for the first time.
   *  Used to prevent double-counting token savings in global_tokens_saved.
   *  Absent in legacy lockfiles — treated as false on first read. */
  cached?: boolean;
  /** Original anchor text from the inline link, stored so restore can
   *  reconstruct `[text](url)` instead of `[url](url)`. Only present when the
   *  anchor text differs from the URL. */
  original_text?: string;
}

/** Top-level lockfile shape. */
export interface Lockfile {
  /** Schema version for forward compatibility. */
  version: number;
  /** Running global tally of tokens saved across all runs. */
  global_tokens_saved: number;
  /** Per-URL metadata keyed by canonical URL string. */
  urls: Record<string, UrlEntry>;
}

/** Default lockfile written when none exists yet. */
const DEFAULT_LOCKFILE: Lockfile = {
  version: 2,
  global_tokens_saved: 0,
  urls: {},
};

/** Rough tokens-per-character heuristic (≈4 chars/token for English text). */
export const CHARS_PER_TOKEN = 4;

/** The condensed marker occupies ~18 tokens including delimiters (now includes a 6-char URL hash). */
export const COMPRESSED_MARKER_TOKENS = 18;

/**
 * Resolve the lockfile path.  Resolution order:
 *  1. Explicit `lockfilePath` argument.
 *  2. `DOC_LOK_LOCKFILE` env var.
 *  3. `doc-lok.json` in the same directory as the Markdown file.
 *  4. `doc-lok.json` in `process.cwd()`.
 */
export function resolveLockfilePath(
  mdFilePath: string,
  lockfilePath?: string,
): string {
  if (lockfilePath) return path.resolve(lockfilePath);
  const env = process.env.DOC_LOK_LOCKFILE;
  if (env) return path.resolve(env);
  const mdDir = path.dirname(path.resolve(mdFilePath));
  return path.join(mdDir, "doc-lok.json");
}

/** Read and parse the lockfile, returning a default skeleton if absent. */
export async function readLockfile(lockfilePath: string): Promise<Lockfile> {
  try {
    const raw = await fs.readFile(lockfilePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<Lockfile>;
    return normalizeLockfile(parsed);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return structuredClone(DEFAULT_LOCKFILE);
    }
    throw err;
  }
}

/** Atomically write the lockfile to disk (write-temp-then-rename). */
export async function writeLockfile(
  lockfilePath: string,
  data: Lockfile,
): Promise<void> {
  const dir = path.dirname(lockfilePath);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${lockfilePath}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
  await fs.rename(tmp, lockfilePath);
}

/** Coerce a partially-parsed object into a well-formed Lockfile. */
function normalizeLockfile(input: Partial<Lockfile>): Lockfile {
  const version = typeof input.version === "number" ? input.version : 1;
  const global_tokens_saved =
    typeof input.global_tokens_saved === "number"
      ? input.global_tokens_saved
      : 0;
  const urls = input.urls ?? {};
  return { version, global_tokens_saved, urls };
}

/** Estimate token count from a string length. */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Compute a short stable hash of a URL for marker embedding.
 * Returns the first 6 hex characters of the SHA-256 digest.
 */
export function hashUrl(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 6);
}

/** Record a successful validation result against a lockfile entry.
 *
 * @param isUnchanged  Whether the remote content is unchanged since last run.
 *                    When true, tokensSaved is 0 (already counted).
 *                    When false, tokensSaved reflects first-time savings.
 */
export function updateEntry(
  lockfile: Lockfile,
  url: string,
  sha256: string,
  etag: string | null,
  rawTokenCost: number,
  isUnchanged: boolean,
): { entry: UrlEntry; tokensSaved: number } {
  const prev = lockfile.urls[url];
  const compressed = COMPRESSED_MARKER_TOKENS;

  // Preserve the highest raw cost we've seen.
  // Never overwrite a full-GET cost with a tiny HEAD-only estimate.
  const preservedRawCost =
    prev && prev.token_cost_raw > rawTokenCost
      ? prev.token_cost_raw
      : rawTokenCost;

  // Only count savings on the FIRST time a URL is successfully cached.
  // After that, the savings were already counted in a previous run.
  const wasAlreadyCached = prev?.cached === true;
  const tokensSaved =
    isUnchanged && !wasAlreadyCached
      ? Math.max(0, preservedRawCost - compressed)
      : 0;

  const entry: UrlEntry = {
    ...(prev ?? {}),
    last_known_sha256: sha256,
    etag,
    token_cost_raw: preservedRawCost,
    token_cost_compressed: compressed,
    last_checked: new Date().toISOString(),
    cached: wasAlreadyCached || isUnchanged,
  };

  lockfile.urls[url] = entry;
  lockfile.global_tokens_saved += tokensSaved;

  return { entry, tokensSaved };
}
