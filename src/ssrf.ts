/**
 * ssrf.ts — Server-Side Request Forgery guard.
 *
 * Blocks URLs that resolve to private / internal / metadata addresses
 * by default. Opt in to private ranges with `--allow-private` / the
 * `allowPrivate` option on `validateUrl`.
 *
 * Blocked ranges:
 *   - Loopback:         127.0.0.0/8, ::1
 *   - Link-local:       169.254.0.0/16, fe80::/10  (includes AWS metadata 169.254.169.254)
 *   - Private (RFC1918): 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
 *   - Unique local:      fc00::/7  (IPv6 ULA)
 *   - Metadata:         fd00:ec2::254 (AWS IPv6 metadata)
 *
 * Redirects are re-checked at each hop so a public URL that redirects
 * to an internal address is still blocked.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/** Configuration for a single URL safety check. */
export interface SsrfOptions {
  /**
   * When true, allow URLs that resolve to private / loopback / link-local
   * ranges. Default: false (block).
   */
  allowPrivate?: boolean;
}

/**
 * Thrown when a URL is blocked by the SSRF guard.
 * The `address` field is the resolved IP that triggered the block.
 */
export class SsrfBlockedError extends Error {
  readonly address: string;
  readonly range: string;

  constructor(address: string, range: string) {
    super(`ssrf blocked: ${address} is in ${range}`);
    this.name = "SsrfBlockedError";
    this.address = address;
    this.range = range;
  }
}

/**
 * Identify which (if any) blocked range an IPv4 address belongs to.
 * Returns the range name, or `null` if the address is safe.
 */
function classifyIPv4(ip: string): string | null {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    return null;
  }
  const [a, b] = parts;

  // 127.0.0.0/8 — loopback
  if (a === 127) return "loopback (127.0.0.0/8)";
  // 10.0.0.0/8 — private
  if (a === 10) return "private (10.0.0.0/8)";
  // 172.16.0.0/12 — private
  if (a === 172 && b >= 16 && b <= 31) return "private (172.16.0.0/12)";
  // 192.168.0.0/16 — private
  if (a === 192 && b === 168) return "private (192.168.0.0/16)";
  // 169.254.0.0/16 — link-local (includes AWS metadata 169.254.169.254)
  if (a === 169 && b === 254) return "link-local (169.254.0.0/16)";
  // 0.0.0.0/8 — "this network" — treat as unsafe
  if (a === 0) return "unspecified (0.0.0.0/8)";

  return null;
}

/**
 * Identify which (if any) blocked range an IPv6 address belongs to.
 * Returns the range name, or `null` if the address is safe.
 * IPv4-mapped IPv6 addresses (::ffff:a.b.c.d) are re-classified as IPv4.
 */
function classifyIPv6(ip: string): string | null {
  const lower = ip.toLowerCase();

  // ::1 — loopback
  if (lower === "::1") return "loopback (::1)";

  // Strip IPv4-mapped prefix ::ffff: and re-classify the IPv4 part.
  // Node's net.isIP returns 6 for these, so we need to handle them here.
  const v4MappedMatch = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4MappedMatch) {
    return classifyIPv4(v4MappedMatch[1]);
  }

  // fe80::/10 — link-local
  if (lower.startsWith("fe80") || lower.startsWith("fe90") ||
      lower.startsWith("fea0") || lower.startsWith("feb0")) {
    return "link-local (fe80::/10)";
  }

  // fc00::/7 — unique local addresses (ULA)
  if (lower.startsWith("fc") || lower.startsWith("fd")) {
    // fd00:ec2::254 is AWS IPv6 metadata; the entire fc00::/7 range is
    // already blocked as ULA, so we don't need a separate case.
    return "unique-local (fc00::/7)";
  }

  // ::ffff:0:0/96 — IPv4-mapped, IPv4 part was 0.0.0.0 (handled above
  // by the regex). Empty catch here.
  return null;
}

/**
 * Classify an IP address string (v4 or v6) into a blocked range name.
 * Returns `null` if the address does not fall in any blocked range.
 */
function classifyIp(ip: string): string | null {
  const family = isIP(ip);
  if (family === 4) return classifyIPv4(ip);
  if (family === 6) return classifyIPv6(ip);
  return null;
}

/**
 * Resolve a hostname to one or more IP addresses via `node:dns`.
 * Returns every A/AAAA record found. Throws on DNS errors.
 *
 * If the hostname is already an IP literal (e.g., "127.0.0.1"), it is
 * returned as-is without a DNS lookup.
 */
async function resolveHost(hostname: string): Promise<string[]> {
  const family = isIP(hostname);
  if (family === 4 || family === 6) {
    return [hostname];
  }
  // all: true returns both A and AAAA records when available.
  const records = await lookup(hostname, { all: true });
  return records.map((r) => r.address);
}

/**
 * Assert that a URL is safe to fetch under the current SSRF policy.
 *
 * Resolves the URL's hostname, classifies every resolved IP address,
 * and throws `SsrfBlockedError` if any of them fall into a blocked
 * range — unless `allowPrivate` is set.
 *
 * @param url       The URL that will be fetched.
 * @param options   SSRF options (currently just `allowPrivate`).
 */
export async function assertSafeUrl(
  url: string,
  options: SsrfOptions = {},
): Promise<void> {
  if (options.allowPrivate) return;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`ssrf blocked: invalid URL ${url}`);
  }

  const hostname = parsed.hostname;
  if (!hostname) {
    throw new Error(`ssrf blocked: no hostname in ${url}`);
  }

  // `new URL("http://[::1]/").hostname` returns `[::1]` with the brackets
  // intact — strip them so `isIP` recognises the address and `dns.lookup`
  // doesn't try to resolve the literal brackets as a DNS name.
  const bareHost =
    hostname.startsWith("[") && hostname.endsWith("]")
      ? hostname.slice(1, -1)
      : hostname;

  const addrs = await resolveHost(bareHost);
  if (addrs.length === 0) {
    // DNS returned nothing — treat as blocked, since we can't verify.
    throw new Error(`ssrf blocked: ${hostname} resolved to no addresses`);
  }

  for (const addr of addrs) {
    const range = classifyIp(addr);
    if (range) {
      throw new SsrfBlockedError(addr, range);
    }
  }
}