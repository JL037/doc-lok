/**
 * sections.ts — Section type, slugify, and section matching.
 *
 * A "section" is a heading and the content that follows it, up to the
 * next heading at the same or higher level (or EOF). Sections are
 * detected from converted Markdown by scanning for ATX headings
 * (`#` through `######`).
 *
 * Section matching is exact-slug → case-insensitive slug →
 * case-insensitive heading-contains, in that priority order. Unknown
 * queries (zero matches) and ambiguous queries (2+ matches) are
 * reported separately so the caller can produce helpful diagnostics.
 */

/** A heading and the byte range it covers in the converted Markdown. */
export interface Section {
  /** GitHub-style slug, e.g. `authentication--authorization`. */
  slug: string;
  /** Heading level 1–6. */
  level: number;
  /** Original heading text, e.g. `Authentication & Authorization`. */
  heading: string;
  /** Byte offset of the heading line in the converted Markdown. */
  start: number;
  /** Byte offset where the next section at same/higher level begins (or EOF). */
  end: number;
}

/** Result of matching requested section names against available ones. */
export interface SectionMatchResult {
  /** Sections that matched exactly one request, deduplicated, in page order. */
  matched: Section[];
  /** Requested names that matched zero sections. */
  unknown: string[];
  /** Requested names that matched 2+ sections, with their candidates. */
  ambiguous: Array<{ query: string; candidates: Section[] }>;
}

/**
 * Generate a GitHub-style slug from heading text.
 *
 * Lowercase → strip characters that aren't letters, digits, spaces, or `-`
 * → replace runs of whitespace with a single `-`.
 *
 * Examples:
 *   `Authentication`                    → `authentication`
 *   `API Reference`                     → `api-reference`
 *   `Authentication & Authorization`     → `authentication--authorization`
 *   `OAuth 2.0`                         → `oauth-20`
 *   `Retry Strategy & Rate Throttling`  → `retry-strategy--rate-throttling`
 */
export function slugifyHeading(heading: string): string {
  return heading
    .toLowerCase()
    // Keep letters, digits, spaces, and hyphens. Drop everything else
    // (including `&`, `.`, `/`, `(`, `)`, etc.).
    .replace(/[^a-z0-9 -]/g, "")
    // Replace each space with a hyphen (not runs of spaces → one
    // hyphen, but each space individually). This matches GitHub's
    // slug behaviour: "Auth & Auth" → "auth--auth" (double hyphen
    // because the stripped `&` left two spaces, each becoming `-`).
    .replace(/ /g, "-")
    // Trim leading/trailing hyphens.
    .replace(/^-+|-+$/g, "");
}

/**
 * Special section names handled by the caller before matchSections.
 * matchSections itself does not know about these so it stays
 * single-purpose; the parser decides what "no sections requested"
 * vs. "all" vs. "toc" mean.
 */
export const SPECIAL_SECTION_NAMES = new Set(["all", "*", "toc", "index"]);

/** True if the requested name is a special value handled by the caller. */
export function isSpecialSectionName(name: string): boolean {
  return SPECIAL_SECTION_NAMES.has(name.toLowerCase());
}

/**
 * Resolve a single requested name to zero or more candidate sections.
 *
 * Match priority:
 *   1. Exact slug match (case-sensitive).
 *   2. Case-insensitive slug match.
 *   3. Case-insensitive heading-contains match.
 *
 * Returns the matches. The caller decides whether multiple matches
 * count as ambiguous.
 */
export function resolveSectionName(
  available: Section[],
  name: string,
): Section[] {
  // Fast path: exact slug match.
  const exact = available.filter((s) => s.slug === name);
  if (exact.length > 0) return exact;

  // Case-insensitive slug match.
  const lower = name.toLowerCase();
  const ciSlug = available.filter((s) => s.slug.toLowerCase() === lower);
  if (ciSlug.length > 0) return ciSlug;

  // Case-insensitive heading-contains match.
  const ciContains = available.filter((s) =>
    s.heading.toLowerCase().includes(lower),
  );
  return ciContains;
}

/**
 * Match a list of requested section names against available sections.
 *
 * - Each request is resolved independently.
 * - 0 matches  → added to `unknown`.
 * - 1 match     → added to `matched` (deduplicated by slug, page order).
 * - 2+ matches → added to `ambiguous` with the candidate list.
 *
 * Special values (`all`, `*`, `toc`, `index`) are NOT handled here —
 * the caller intercepts them before calling this function. If a
 * special value slips through, `matchSections` treats it as a normal
 * query (which typically won't match and ends up in `unknown`).
 */
export function matchSections(
  sections: Section[],
  requests: readonly string[],
): SectionMatchResult {
  const matchedBySlug = new Set<string>();
  const matched: Section[] = [];
  const unknown: string[] = [];
  const ambiguous: Array<{ query: string; candidates: Section[] }> = [];

  for (const name of requests) {
    const candidates = resolveSectionName(sections, name);
    if (candidates.length === 0) {
      unknown.push(name);
      continue;
    }
    if (candidates.length === 1) {
      const s = candidates[0];
      if (!matchedBySlug.has(s.slug)) {
        matchedBySlug.add(s.slug);
        matched.push(s);
      }
      continue;
    }
    // 2+ candidates — ambiguous. Don't add any to matched; the user
    // must disambiguate with a more specific slug.
    ambiguous.push({ query: name, candidates });
  }

  // Re-sort matched into page order (by start offset) so output is
  // deterministic and matches the document's natural flow.
  matched.sort((a, b) => a.start - b.start);

  return { matched, unknown, ambiguous };
}