/**
 * network.ts — Optimised HTTP validation for remote Markdown links.
 *
 * Strategy:
 *  1. Fast `HEAD` request → compare ETag first (no body transfer).
 *  2. If ETag missing or mismatched, stream the response body through an
 *     incremental SHA-256 hash so we never hold the full payload in memory.
 */

import { createHash } from "node:crypto";
import { createWriteStream, promises as fs, type WriteStream } from "node:fs";
import { request } from "node:https";
import { request as httpRequest } from "node:http";
import * as path from "node:path";

import { assertSafeUrl, type SsrfOptions } from "./ssrf.js";

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
  /** Content-Type header value if the server returned one. */
  contentType: string | null;
  /**
   * Absolute path the body was written to during the streamed GET,
   * when {@link ValidateOptions.cacheDir} is set. `null` if no body
   * was fetched (HEAD fast-path) or `cacheDir` was not requested.
   */
  cachedBodyPath: string | null;
}

/** Options accepted by `validateUrl`. */
export interface ValidateOptions extends SsrfOptions {
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
  /**
   * When set, the streamed GET body is written to a file under this
   * directory (named `<sha256>.raw`) as it streams — chunks are
   * hashed AND tee'd to disk in a single pass, so O(1) memory still
   * holds. `cachedBodyPath` in the result is the path written.
   * Unchanged (HEAD fast-path) responses do NOT write to disk here;
   * the caller uses `knownSha256` to find the existing cache file.
   */
  cacheDir?: string;
  /**
   * Refuse the body if it exceeds this many bytes. Default: unlimited.
   * When streaming and the accumulated byte length crosses this limit
   * the request is destroyed with an `oversized` error.
   */
  maxBytes?: number;
  /**
   * Allowlist of Content-Type prefixes (e.g. `["text/html", "text/plain"]`).
   * When set, a `Content-Type` header that does not start with one of the
   * allowed prefixes causes the body to be skipped with an error.
   * Default: any content type allowed.
   */
  allowedContentTypes?: readonly string[];
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
  return assertSafeUrl(url, opts)
    .then(() => headRequest(url, opts))
    .then((head) => {
      if (head.etag && opts.knownEtag && head.etag === opts.knownEtag) {
        return {
          unchanged: true,
          sha256: opts.knownSha256 ?? "",
          etag: head.etag,
          byteLength: 0,
          tokenCost: 0,
          contentType: null,
          cachedBodyPath: null,
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
          assertSafeUrl(nextUrl, opts)
            .then(() => headRequest(nextUrl, opts, redirectCount + 1))
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

    // Cache-dir + temp-file setup. Only initialised when `opts.cacheDir`
    // is set; otherwise we skip the disk write entirely.
    const cacheDir = opts.cacheDir;
    let tmpPath: string | null = null;
    let writeStream: WriteStream | null = null;
    let tmpCleanedUp = false;

    const cleanupTemp = async () => {
      if (tmpCleanedUp) return;
      tmpCleanedUp = true;
      if (writeStream) {
        writeStream.destroy();
        writeStream = null;
      }
      if (tmpPath) {
        try { await fs.unlink(tmpPath); } catch { /* ignore */ }
        tmpPath = null;
      }
    };

    const req = lib(
      url,
      { method: "GET", timeout: timeoutMs, signal: opts.signal },
      async (res) => {
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
          await cleanupTemp();
          const nextUrl = new URL(location, url).toString();
          assertSafeUrl(nextUrl, opts)
            .then(() => streamGet(nextUrl, opts, etagFromHead, redirectCount + 1))
            .then(resolve)
            .catch(reject);
          return;
        }

        if (res.statusCode === undefined || res.statusCode >= 400) {
          res.resume();
          await cleanupTemp();
          reject(new Error(`GET ${url} → HTTP ${res.statusCode ?? "?"}`));
          return;
        }

        const etag = res.headers.etag ?? etagFromHead;
        const rawContentType =
          res.headers["content-type"] ??
          res.headers["Content-Type"] ??
          null;
        const contentType =
          rawContentType == null
            ? null
            : Array.isArray(rawContentType)
              ? rawContentType[0] ?? null
              : rawContentType;

        // Enforce content-type allowlist BEFORE streaming bytes.
        if (
          contentType &&
          opts.allowedContentTypes &&
          opts.allowedContentTypes.length > 0
        ) {
          const prefix = opts.allowedContentTypes.find((allowed) =>
            contentType.toLowerCase().startsWith(allowed.toLowerCase()),
          );
          if (!prefix) {
            res.resume();
            await cleanupTemp();
            reject(
              new Error(
                `GET ${url} → content-type ${contentType} not allowed ` +
                  `(allowed: ${opts.allowedContentTypes!.join(", ")})`,
              ),
            );
            return;
          }
        }

        // Open the temp file now that we're going to stream bytes.
        if (cacheDir) {
          await fs.mkdir(cacheDir, { recursive: true });
          tmpPath = path.join(
            cacheDir,
            `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
          );
          writeStream = createWriteStream(tmpPath);
        }

        res.on("data", async (chunk: Buffer) => {
          hasher.update(chunk);
          byteLength += chunk.length;

          // Enforce maxBytes cap as we stream.
          if (opts.maxBytes !== undefined && byteLength > opts.maxBytes) {
            res.destroy(
              new Error(
                `GET ${url} → body exceeded max-bytes limit of ${opts.maxBytes}`,
              ),
            );
            await cleanupTemp();
            return;
          }

          if (writeStream) {
            // Writeasync — backpressure is acceptable here because chunks
            // are also being hashed and the response stream will buffer
            // briefly. For our cache sizes (≤ 1MB default) this is fine.
            writeStream.write(chunk);
          }
        });

        res.on("end", async () => {
          const sha256 = hasher.digest("hex");
          const unchanged =
            !!opts.knownSha256 && sha256 === opts.knownSha256;
          let cachedBodyPath: string | null = null;

          if (writeStream && tmpPath) {
            await new Promise<void>((r) => writeStream!.end(() => r()));
            const final = path.join(cacheDir!, `${sha256}.raw`);
            try {
              await fs.rename(tmpPath, final);
              cachedBodyPath = final;
              tmpPath = null;
            } catch {
              await cleanupTemp();
            }
          }

          resolve({
            unchanged,
            sha256,
            etag,
            byteLength,
            tokenCost: Math.ceil(byteLength / 4), // ≈4 bytes/token
            contentType,
            cachedBodyPath,
          });
        });

        res.on("error", async (err) => {
          await cleanupTemp();
          reject(err);
        });
      },
    );

    req.on("error", async (err) => {
      await cleanupTemp();
      reject(err);
    });
    req.on("timeout", async () => {
      req.destroy(new Error(`GET ${url} timed out after ${timeoutMs}ms`));
      await cleanupTemp();
    });
    req.end();
  });
}
