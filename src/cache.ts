/**
 * cache.ts — Body-content cache for `--inline` mode.
 *
 * Bodies live in `<cache-dir>/<sha>.raw` (one file per content snapshot),
 * separate from the lockfile JSON which only tracks metadata. Keeping
 * bodies on disk (not in the lockfile) keeps the JSON small and makes
 * offline runs possible — once a body is cached, `--inline` can reuse
 * it without any network round trip.
 *
 * Default cache directory: `cache/` inside the `.doc-lok/` directory
 * that also holds `lock.json`. So the full layout is:
 *
 *   .doc-lok/
 *   ├── lock.json
 *   └── cache/
 *       ├── <sha>.raw           original fetched body
 *       ├── <sha>.md            converted Markdown
 *       └── <sha>.index.json    section index
 *
 * Override with `--cache-dir <path>` (CLI) or `cacheDir` (library).
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

import type { Section } from "./sections.js";

/** Resolve the cache directory, defaulting to `cache/` next to the lockfile (inside `.doc-lok/`). */
export function resolveCacheDir(
  lockfilePath: string,
  cacheDir?: string,
): string {
  if (cacheDir) return path.resolve(cacheDir);
  // lockfilePath is e.g. `/project/.doc-lok/lock.json`
  // dirname  → `/project/.doc-lok`
  // cache    → `/project/.doc-lok/cache`
  return path.join(path.dirname(path.resolve(lockfilePath)), "cache");
}

/** Return the absolute path where the body for `sha` should be stored. */
export function bodyPath(cacheDir: string, sha: string): string {
  // Defensive: sha is expected to be a 64-char hex digest from the network
  // layer. Reject anything that doesn't look like a hex digest so a
  // malicious or malformed lockfile entry can't write to arbitrary paths.
  if (!/^[a-f0-9]{64}$/.test(sha)) {
    throw new Error(`cache: refused unsafe sha path component: ${sha}`);
  }
  return path.join(cacheDir, `${sha}.raw`);
}

/** Atomically write a body to the cache. Returns the path written. */
export async function writeBody(
  cacheDir: string,
  sha: string,
  body: string,
): Promise<string> {
  const target = bodyPath(cacheDir, sha);
  await fs.mkdir(cacheDir, { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(tmp, body, "utf8");
  await fs.rename(tmp, target);
  return target;
}

/** Read a cached body. Returns `null` if the file does not exist. */
export async function readBody(
  cacheDir: string,
  sha: string,
): Promise<string | null> {
  try {
    return await fs.readFile(bodyPath(cacheDir, sha), "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Remove a cached body. Returns `true` if deleted, `false` if it didn't exist. */
export async function removeBody(
  cacheDir: string,
  sha: string,
): Promise<boolean> {
  try {
    await fs.unlink(bodyPath(cacheDir, sha));
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/** Remove every file in the cache directory. Returns the count deleted. */
export async function clearCache(cacheDir: string): Promise<number> {
  try {
    const entries = await fs.readdir(cacheDir);
    let n = 0;
    for (const entry of entries) {
      if (
        entry.endsWith(".raw") ||
        entry.endsWith(".md") ||
        entry.endsWith(".index.json")
      ) {
        await fs.unlink(path.join(cacheDir, entry));
        n++;
      }
    }
    return n;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Converted-Markdown cache (`<sha>.md`)
// ---------------------------------------------------------------------------

/** Return the path to the converted-Markdown cache file for `sha`. */
export function markdownPath(cacheDir: string, sha: string): string {
  if (!/^[a-f0-9]{64}$/.test(sha)) {
    throw new Error(`cache: refused unsafe sha path component: ${sha}`);
  }
  return path.join(cacheDir, `${sha}.md`);
}

/** Write the converted Markdown for `sha` to the cache, atomically. */
export async function writeMarkdown(
  cacheDir: string,
  sha: string,
  md: string,
): Promise<string> {
  const target = markdownPath(cacheDir, sha);
  await fs.mkdir(cacheDir, { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(tmp, md, "utf8");
  await fs.rename(tmp, target);
  return target;
}

/** Read the cached converted Markdown for `sha`. `null` if absent. */
export async function readMarkdown(
  cacheDir: string,
  sha: string,
): Promise<string | null> {
  try {
    return await fs.readFile(markdownPath(cacheDir, sha), "utf8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Section-index cache (`<sha>.index.json`)
// ---------------------------------------------------------------------------

/** Index file shape persisted on disk. */
interface IndexFile {
  version: 1;
  sections: Array<{
    slug: string;
    level: number;
    heading: string;
    start: number;
    end: number;
  }>;
}

/** Return the path to the section-index cache file for `sha`. */
export function indexPath(cacheDir: string, sha: string): string {
  if (!/^[a-f0-9]{64}$/.test(sha)) {
    throw new Error(`cache: refused unsafe sha path component: ${sha}`);
  }
  return path.join(cacheDir, `${sha}.index.json`);
}

/** Atomically write the section index for `sha` to the cache. */
export async function writeIndex(
  cacheDir: string,
  sha: string,
  sections: Section[],
): Promise<string> {
  const target = indexPath(cacheDir, sha);
  await fs.mkdir(cacheDir, { recursive: true });
  const payload: IndexFile = {
    version: 1,
    sections: sections.map((s) => ({
      slug: s.slug,
      level: s.level,
      heading: s.heading,
      start: s.start,
      end: s.end,
    })),
  };
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
  await fs.rename(tmp, target);
  return target;
}

/** Read the cached section index for `sha`. `null` if absent or malformed. */
export async function readIndex(
  cacheDir: string,
  sha: string,
): Promise<Section[] | null> {
  try {
    const raw = await fs.readFile(indexPath(cacheDir, sha), "utf8");
    const parsed = JSON.parse(raw) as Partial<IndexFile>;
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.sections)) {
      return null;
    }
    return parsed.sections!.map((s) => ({
      slug: String(s.slug),
      level: Number(s.level),
      heading: String(s.heading),
      start: Number(s.start),
      end: Number(s.end),
    }));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    // Malformed JSON — treat as cache miss, don't crash the run.
    return null;
  }
}