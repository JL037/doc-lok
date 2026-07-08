# P0 Implementation Notes — HTTP Redirects & Restore Anchor Text

This document explains the two P0 correctness items implemented in this release:

1. **HTTP redirect following** in `src/network.ts`.
2. **Faithful restore of original anchor text** via the lockfile.

It covers the problem, the design decisions, the exact code changes, and the trade-offs.

---

## 1. HTTP redirect following

### Problem

`doc-lok` uses Node.js's native `node:https`/`node:http` `request` API. Unlike `fetch()` or higher-level libraries such as `axios`, the native API **does not follow redirects automatically**.

Before this change, a URL that returned `301`, `302`, `307`, or `308` behaved incorrectly:

- For `HEAD` requests, the redirect response's ETag was accepted as the resource's ETag, even though it belonged to the redirect response, not the final target.
- For `GET` requests, the redirect response body (often empty or a tiny HTML page) was streamed through the SHA-256 hasher and stored as the "known" content of the URL.

This corrupted the integrity of the lockfile: a URL could be marked as cached when the tool had never actually seen the real payload.

### Design decisions

1. **Follow redirects in both HEAD and GET paths.** A `HEAD` chain may end with a matching ETag, allowing us to skip the body transfer entirely. If it doesn't, the `GET` path follows the same chain to hash the final payload.
2. **Resolve relative `Location` headers.** Some servers return absolute URLs (`https://example.com/new`), others return relative paths (`/new` or `new`). We use `new URL(location, url).toString()` to handle both.
3. **Keep the original URL as the lockfile key.** If a user's Markdown links to `http://example.com/old`, that URL string is what appears in the lockfile. The final redirected resource is only used for validation. This preserves the mapping between the document and its lockfile entry and avoids surprise key churn when a redirect target changes.
4. **Default redirect cap of 5.** This prevents infinite loops while remaining generous enough for common short redirect chains (e.g., `http → https` or `short link → canonical URL`).
5. **No new dependencies.** The redirect logic is implemented with native `URL` resolution and recursive promise calls.

### Code changes

- `src/network.ts`
  - Added `maxRedirects` to `ValidateOptions`.
  - Added `DEFAULT_MAX_REDIRECTS = 5` and an `isRedirect()` helper.
  - `headRequest()` now checks for redirect status codes, resolves `Location`, and recurses.
  - `streamGet()` does the same, draining the redirect response body before recursing.

### Example behavior

```markdown
[Example](http://example.com/old)
```

If `http://example.com/old` redirects to `https://example.com/new`:

1. `HEAD http://example.com/old` → `302` to `/new`.
2. `HEAD https://example.com/new` → `200` with ETag `"abc"`.
3. If `"abc"` matches the lockfile → unchanged, no body downloaded.
4. If it doesn't match → `GET http://example.com/old` follows the same redirect and hashes the body of `https://example.com/new`.
5. The lockfile entry key remains `http://example.com/old`.

### Edge cases handled

- **Redirect loops:** Exceeding `maxRedirects` throws `Too many redirects for ${url}`, which surfaces as an error diagnostic.
- **Missing `Location` header:** Treated as a network error.
- **Relative `Location` headers:** Resolved against the current request URL.
- **Method preservation:** Both HEAD and GET chains preserve their method (307/308 semantics are honored by our recursive implementation).

---

## 2. Restore original anchor text

### Problem

Before this change, `restoreMarkdown()` always reconstructed links as `[url](url)`:

```markdown
<!-- input -->
[Documentation](https://example.com)

<!-- after condense -->
<!-- doc-lok:cached#abc123 -->

<!-- after restore -->
[https://example.com](https://example.com)  ❌ lost the word "Documentation"
```

This broke the round-trip contract. A document condensed, edited, and restored would lose descriptive link text, hurting readability.

### Why the lockfile is the right place for this

`doc-lok` already depends on `doc-lok.json` for restore. The marker only contains a 6-character hash; `restoreMarkdown()` looks up that hash in the lockfile to recover the full URL. Because the lockfile is already required, storing the original anchor text there introduces **no new dependency**.

An alternative suggested by an external review was to embed Base64-encoded anchor text directly inside the HTML comment marker:

```markdown
<!-- doc-lok:cached#abc123 RG9jdW1lbnRhdGlvbg== -->
```

We rejected this as the default approach because:

- It bloats the marker, partially defeating the purpose of condensing.
- HTML comments cannot contain `--`, requiring escaping logic.
- It does not handle multiple links to the same URL with different texts any better than the lockfile approach.

We kept the inline-embedding idea as a future opt-in `--self-contained` mode for users who need to move a condensed `.md` file without its lockfile.

### Design decisions

1. **Add `original_text` to `UrlEntry`.** Only stored when the link text differs from the URL. Links like `[https://example.com](https://example.com)` do not create redundant entries.
2. **Bump lockfile `version` to `2`.** Signals the new schema while remaining backward-compatible. Older lockfiles without `original_text` still restore to `[url](url)`.
3. **Preserve `original_text` across re-validation.** `updateEntry()` now spreads the previous entry (`...(prev ?? {})`) before overwriting core fields. This prevents `checkMarkdown()` or subsequent `condenseMarkdown()` runs from accidentally deleting anchor text.
4. **Last-seen-wins for duplicate URLs.** If the same URL appears multiple times with different anchor text (e.g., `[A](url)` and `[B](url)`), the lockfile stores only one `original_text`. The last occurrence in the document wins. This is a deliberate simplicity trade-off; storing per-occurrence text would require a larger schema change.
5. **No marker format change.** Markers remain `<!-- doc-lok:cached#hash -->`, keeping parsers simple and avoiding migration of existing condensed files.

### Code changes

- `src/state.ts`
  - Added `original_text?: string` to `UrlEntry`.
  - Bumped `DEFAULT_LOCKFILE.version` from `1` to `2`.
  - Updated `updateEntry()` to preserve existing fields.

- `src/parser.ts`
  - `replaceLinks()` now accepts the `Lockfile` and records `original_text` for each condensed link whose text differs from its URL.
  - `restoreMarkdown()` reads `lockfile.urls[url]?.original_text ?? url` and reconstructs `[text](url)`.

### Example behavior

```markdown
<!-- input -->
Read the [Documentation](https://example.com) for details.

<!-- after condense -->
Read the <!-- doc-lok:cached#abc123 --> for details.

<!-- lockfile entry -->
{
  "urls": {
    "https://example.com": {
      "last_known_sha256": "...",
      "etag": "...",
      "original_text": "Documentation"
    }
  }
}

<!-- after restore -->
Read the [Documentation](https://example.com) for details.  ✅
```

### Edge cases handled

- **Legacy lockfiles without `original_text`:** Restore falls back to `[url](url)`.
- **Re-validation:** `checkMarkdown()` and repeated `condenseMarkdown()` calls preserve `original_text`.
- **Text equals URL:** No `original_text` is stored; restore naturally returns `[url](url)`.
- **Multiple links to the same URL:** Last-seen text is used for all restored markers.

---

## Testing

Both features are covered by new tests:

- `test/network.test.ts` — 4 redirect tests (302 follow, relative Location, ETag short-circuit, redirect loop).
- `test/parser-refs.test.ts` — 5 restore-fidelity tests (stored text restore, legacy fallback, condense→restore round-trip, `checkMarkdown` preservation, duplicate URL last-seen-wins).
- `test/state.test.ts` — default version 2 and `updateEntry` field preservation.

Total test count increased from **79 to 89**.

---

## Trade-off summary

| Decision | Pros | Cons |
|---|---|---|
| Follow redirects natively | Zero dependencies; keeps lockfile key stable | Slightly more code than using `fetch` |
| Cap redirects at 5 | Prevents infinite loops | Rare deep chains may need tuning |
| Store anchor text in lockfile | Tiny markers; no HTML-comment escaping; natural metadata home | Condensed file is not self-contained without lockfile |
| Last-seen-wins for duplicate URLs | Simple schema | Multiple distinct texts for the same URL are collapsed |
| Spread previous entry in `updateEntry` | Forward-compatible with future fields | Slightly less explicit than field-by-field copy |

## Future work

- Add an opt-in `--self-contained` mode that embeds anchor text in markers for users who need to move `.md` files without the lockfile.
- Consider a per-occurrence text map if multiple distinct anchor texts for the same URL becomes a common use case.
