/**
 * network.ts — Optimised HTTP validation for remote Markdown links.
 *
 * Strategy:
 *  1. Fast `HEAD` request → compare ETag first (no body transfer).
 *  2. If ETag missing or mismatched, stream the response body through an
 *     incremental SHA-256 hash so we never hold the full payload in memory.
 */

import { createHash } from "node:crypto";
import { request } from "node:https";
import { request as httpRequest } from "node:http";

/** Result of a network validation probe. */
export interface ValidationResult {
  /** Whether the remote content is unchanged since the last lockfile entry. */
  unchanged: boolean;
  /** SHA-256 hex digest of the response body (empty string for HEAD-only hits). */
  sha256: string;
  /** ETag header value if the server returned one. */
  etag: string | null;
  /** Raw byte length of the response body (0 for HEAD). */
  byteLength: number;
  /** Approximate token cost of the raw body. */
  tokenCost: number;
}

/** Options accepted by `validateUrl`. */
export interface ValidateOptions {
  /** Previously known ETag, used for fast `If-None-Match` comparison. */
  knownEtag: string | null;
  /** Previously known SHA-256, used to detect unchanged content. */
  knownSha256: string | null;
  /** AbortSignal to cancel the in-flight request. */
  signal?: AbortSignal;
  /** Per-request timeout in milliseconds (default 15 000). */
  timeoutMs?: number;
  /** Maximum number of redirects to follow (default 5). */
  maxRedirects?: number;
}

const DEFAULT_TIMEOUT = 15_000;
const DEFAULT_MAX_REDIRECTS = 5;

/** Return true for redirect status codes that should be followed. */
function isRedirect(statusCode: number | undefined): boolean {
  return statusCode === 301 || statusCode === 302 || statusCode === 307 || statusCode === 308;
}

/**
 * Validate a single URL.
 *
 * Performs a `HEAD` first.  If the server returns an ETag that matches
 * `knownEtag`, the content is considered unchanged and no body is fetched.
 * Otherwise a `GET` is issued and the body is streamed through an
 * incremental SHA-256 hasher.
 */
export function validateUrl(
  url: string,
  opts: ValidateOptions,
): Promise<ValidationResult> {
  return headRequest(url, opts)
    .then((head) => {
      if (head.etag && opts.knownEtag && head.etag === opts.knownEtag) {
        return {
          unchanged: true,
          sha256: opts.knownSha256 ?? "",
          etag: head.etag,
          byteLength: 0,
          tokenCost: 0,
        } satisfies ValidationResult;
      }
      // ETag mismatch or missing → fall through to a streamed GET.
      return streamGet(url, opts, head.etag);
    })
    .catch((err: unknown) => {
      // Re-throw with a descriptive message but preserve the URL context.
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`network error for ${url}: ${msg}`);
    });
}

/** Lightweight HEAD response metadata. */
interface HeadResult {
  etag: string | null;
  statusCode: number;
}

/** Issue a HEAD request and extract the ETag header, following redirects. */
function headRequest(
  url: string,
  opts: ValidateOptions,
  redirectCount = 0,
): Promise<HeadResult> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https:") ? request : httpRequest;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
    const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

    const req = lib(
      url,
      { method: "HEAD", timeout: timeoutMs, signal: opts.signal },
      (res) => {
        res.resume(); // drain immediately

        if (isRedirect(res.statusCode)) {
          const location = res.headers.location;
          if (!location) {
            reject(
              new Error(
                `HEAD ${url} → HTTP ${res.statusCode} but no Location header`,
              ),
            );
            return;
          }
          if (redirectCount >= maxRedirects) {
            reject(new Error(`Too many redirects for ${url}`));
            return;
          }
          const nextUrl = new URL(location, url).toString();
          headRequest(nextUrl, opts, redirectCount + 1)
            .then(resolve)
            .catch(reject);
          return;
        }

        if (res.statusCode === undefined || res.statusCode >= 400) {
          reject(new Error(`HEAD ${url} → HTTP ${res.statusCode ?? "?"}`));
          return;
        }
        resolve({ etag: res.headers.etag ?? null, statusCode: res.statusCode });
      },
    );

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error(`HEAD ${url} timed out after ${timeoutMs}ms`));
    });
    req.end();
  });
}

/**
 * Stream a GET response through an incremental SHA-256 hasher.
 *
 * Chunks are fed into the hash and immediately dropped, so memory usage
 * stays O(1) regardless of payload size.
 */
function streamGet(
  url: string,
  opts: ValidateOptions,
  etagFromHead: string | null,
  redirectCount = 0,
): Promise<ValidationResult> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https:") ? request : httpRequest;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
    const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
    const hasher = createHash("sha256");
    let byteLength = 0;

    const req = lib(
      url,
      { method: "GET", timeout: timeoutMs, signal: opts.signal },
      (res) => {
        if (isRedirect(res.statusCode)) {
          const location = res.headers.location;
          if (!location) {
            reject(
              new Error(
                `GET ${url} → HTTP ${res.statusCode} but no Location header`,
              ),
            );
            return;
          }
          if (redirectCount >= maxRedirects) {
            reject(new Error(`Too many redirects for ${url}`));
            return;
          }
          res.resume();
          const nextUrl = new URL(location, url).toString();
          streamGet(nextUrl, opts, etagFromHead, redirectCount + 1)
            .then(resolve)
            .catch(reject);
          return;
        }

        if (res.statusCode === undefined || res.statusCode >= 400) {
          res.resume();
          reject(new Error(`GET ${url} → HTTP ${res.statusCode ?? "?"}`));
          return;
        }

        const etag = res.headers.etag ?? etagFromHead;

        res.on("data", (chunk: Buffer) => {
          hasher.update(chunk);
          byteLength += chunk.length;
        });

        res.on("end", () => {
          const sha256 = hasher.digest("hex");
          const unchanged =
            !!opts.knownSha256 && sha256 === opts.knownSha256;
          resolve({
            unchanged,
            sha256,
            etag,
            byteLength,
            tokenCost: Math.ceil(byteLength / 4), // ≈4 bytes/token
          });
        });

        res.on("error", reject);
      },
    );

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error(`GET ${url} timed out after ${timeoutMs}ms`));
    });
    req.end();
  });
}
