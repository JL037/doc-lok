import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createServer, type Server } from "node:http";

import {
  condenseMarkdown,
  inlineMarkdown,
  restoreMarkdown,
  MARKER,
  INLINE_MARKER,
} from "../src/parser.js";
import {
  CHARS_PER_TOKEN,
  COMPRESSED_MARKER_TOKENS,
  estimateTokens,
} from "../src/state.js";

// ─── Shared local HTTP server ───────────────────────────────────────────────

describe("regression: cache-miss fallback after condense", () => {
  let tmpDir: string;
  let server: Server;
  let port: number;
  let requestLog: string[];

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "doc-lok-regression-"));
    requestLog = [];

    server = createServer((req, res) => {
      requestLog.push(`${req.method} ${req.url}`);
      const pathname = req.url!;

      if (pathname === "/stable") {
        res.setHeader("etag", '"stable-etag"');
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.writeHead(200);
        res.end("<h1>Stable Page</h1>\n<p>Content here.</p>");
        return;
      }
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.writeHead(200);
      res.end("<p>default</p>");
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as any).port;
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function writeMd(name: string, content: string): Promise<string> {
    const p = path.join(tmpDir, name);
    await fs.writeFile(p, content, "utf8");
    return p;
  }

  it("condense then inline: no 'cache miss' diagnostic, body is inlined", async () => {
    const url = `http://localhost:${port}/stable`;
    const mdPath = await writeMd("test.md", `# Doc\n\n[link](${url})\n`);

    // Step 1: condense — populates lockfile with ETag + SHA, no body cache.
    await condenseMarkdown(mdPath, undefined, { allowPrivate: true });

    // Step 2: inline — ETag will match (HEAD fast-path), but body was never
    // saved to disk. The fallback GET should fetch it transparently.
    const result = await inlineMarkdown(mdPath, undefined, {
      allowPrivate: true,
      sections: ["all"],
    });

    // No "cache miss" diagnostic should appear.
    const cacheMiss = result.diagnostics.find(
      (d) => d.message?.includes("cache miss"),
    );
    expect(cacheMiss).toBeUndefined();

    // The body should have been inlined.
    expect(result.output).toContain(INLINE_MARKER);
    expect(result.output).toContain("Stable Page");
    expect(result.inlinedCount).toBe(1);

    // A GET request should have been issued (the fallback).
    const gets = requestLog.filter((r) => r.startsWith("GET /stable"));
    expect(gets.length).toBeGreaterThanOrEqual(1);
  });

  it("condense then inline run 2: all cached, no fallback GET needed", async () => {
    const url = `http://localhost:${port}/stable`;
    const mdPath = await writeMd("test2.md", `# Doc\n\n[link](${url})\n`);

    // Condense, then inline (fallback GET populates body cache).
    await condenseMarkdown(mdPath, undefined, { allowPrivate: true });
    await inlineMarkdown(mdPath, undefined, {
      allowPrivate: true,
      sections: ["all"],
    });

    const getsBefore = requestLog.filter((r) => r.startsWith("GET")).length;

    // Second inline run — body is now cached, should be HEAD-only.
    const result = await inlineMarkdown(mdPath, undefined, {
      allowPrivate: true,
      sections: ["all"],
    });

    const getsAfter = requestLog.filter((r) => r.startsWith("GET")).length;
    expect(getsAfter).toBe(getsBefore); // no new GET

    expect(result.output).toContain("Stable Page");
    expect(result.inlinedCount).toBe(1);

    // All diagnostics should be "cached" (no "updated" from fallback).
    const cached = result.diagnostics.find(
      (d) => d.url === url && d.status === "cached",
    );
    expect(cached).toBeDefined();
  });
});

// ─── Round-trip fidelity ────────────────────────────────────────────────────

describe("regression: condense → restore round-trip fidelity", () => {
  let tmpDir: string;
  let server: Server;
  let port: number;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "doc-lok-roundtrip-"));

    server = createServer((req, res) => {
      const pathname = req.url!;
      if (pathname === "/stable") {
        res.setHeader("etag", '"stable-etag"');
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.writeHead(200);
        res.end("<h1>Stable Page</h1>");
        return;
      }
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.writeHead(200);
      res.end("<p>default</p>");
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as any).port;
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function writeMd(name: string, content: string): Promise<string> {
    const p = path.join(tmpDir, name);
    await fs.writeFile(p, content, "utf8");
    return p;
  }

  it("preserves custom link text through condense → restore", async () => {
    const url = `http://localhost:${port}/stable`;
    const original = `# Title\n\nRead the [My Guide](${url}) for details.\n`;
    const mdPath = await writeMd("roundtrip.md", original);

    // Run 1: condense (fetch + record metadata).
    await condenseMarkdown(mdPath, undefined, { allowPrivate: true });
    // Run 2: condense (ETag matches → link replaced with marker).
    const condensed = await condenseMarkdown(mdPath, undefined, {
      allowPrivate: true,
    });

    // The marker should be present and the original link text absent.
    expect(condensed.output).toContain(MARKER);
    expect(condensed.output).not.toContain(`[My Guide](${url})`);

    // Write condensed output to disk and restore.
    const condensedPath = path.join(tmpDir, "condensed.md");
    await fs.writeFile(condensedPath, condensed.output, "utf8");

    const restored = await restoreMarkdown(condensedPath);

    // The restored output should contain the exact original link text.
    expect(restored.output).toContain(`[My Guide](${url})`);
    expect(restored.output).not.toContain(MARKER);
    expect(restored.restoredCount).toBe(1);
  });

  it("preserves link with title attribute through round-trip", async () => {
    const url = `http://localhost:${port}/stable`;
    const original = `[Click Here](${url} "Tooltip Text")\n`;
    const mdPath = await writeMd("title.md", original);

    await condenseMarkdown(mdPath, undefined, { allowPrivate: true });
    const condensed = await condenseMarkdown(mdPath, undefined, {
      allowPrivate: true,
    });

    expect(condensed.output).toContain(MARKER);

    const condensedPath = path.join(tmpDir, "condensed-title.md");
    await fs.writeFile(condensedPath, condensed.output, "utf8");

    const restored = await restoreMarkdown(condensedPath);

    // Restore reconstructs [text](url), titles are not stored.
    expect(restored.output).toContain(`[Click Here](${url})`);
    expect(restored.output).not.toContain(MARKER);
  });

  it("preserves multiple links with different text through round-trip", async () => {
    // Use two different URLs — the lockfile stores one original_text
    // per URL, so same-URL links share a single text entry.
    const url1 = `http://localhost:${port}/stable`;
    const url2 = `http://localhost:${port}/default`;
    const original =
      `First [Alpha](${url1}) and second [Beta](${url2}) link.\n`;
    const mdPath = await writeMd("multi.md", original);

    await condenseMarkdown(mdPath, undefined, { allowPrivate: true });
    const condensed = await condenseMarkdown(mdPath, undefined, {
      allowPrivate: true,
    });

    const condensedPath = path.join(tmpDir, "condensed-multi.md");
    await fs.writeFile(condensedPath, condensed.output, "utf8");

    const restored = await restoreMarkdown(condensedPath);

    // Both links should be restored with their original text.
    expect(restored.output).toContain(`[Alpha](${url1})`);
    expect(restored.output).toContain(`[Beta](${url2})`);
    expect(restored.output).not.toContain(MARKER);
  });
});

// ─── Token savings math ─────────────────────────────────────────────────────

describe("regression: token savings math", () => {
  let tmpDir: string;
  let server: Server;
  let port: number;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "doc-lok-token-math-"));

    // Return a known fixed-size body so we can compute expected token costs.
    // Body: "<h1>Stable Page</h1>" = 20 bytes.
    server = createServer((req, res) => {
      const pathname = req.url!;
      if (pathname === "/stable") {
        res.setHeader("etag", '"stable-etag"');
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.writeHead(200);
        res.end("<h1>Stable Page</h1>"); // 20 bytes
        return;
      }
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.writeHead(200);
      res.end("<p>default</p>");
    });

    await new Promise<void>((resolve) => server.listen(0, resolve));
    port = (server.address() as any).port;
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function writeMd(name: string, content: string): Promise<string> {
    const p = path.join(tmpDir, name);
    await fs.writeFile(p, content, "utf8");
    return p;
  }

  it("estimateTokens matches ceil(length / CHARS_PER_TOKEN)", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1); // 4 chars → 1 token
    expect(estimateTokens("abcde")).toBe(2); // 5 chars → 2 tokens
    expect(estimateTokens("a".repeat(40))).toBe(10); // 40 chars → 10 tokens
  });

  it("COMPRESSED_MARKER_TOKENS is 18", () => {
    expect(COMPRESSED_MARKER_TOKENS).toBe(18);
    expect(CHARS_PER_TOKEN).toBe(4);
  });

  it("condense run 2: tokensSaved = raw - compressed, only on first cache", async () => {
    const url = `http://localhost:${port}/stable`;
    const mdPath = await writeMd("math.md", `[link](${url})\n`);

    // Run 1: fetch, record metadata. tokensSaved should be 0 (first time).
    const run1 = await condenseMarkdown(mdPath, undefined, {
      allowPrivate: true,
    });
    expect(run1.tokensSaved).toBe(0);

    // The lockfile should have token_cost_raw = ceil(20 / 4) = 5.
    const lockPath = path.join(tmpDir, ".doc-lok", "lock.json");
    const lock1 = JSON.parse(await fs.readFile(lockPath, "utf8"));
    const entry = lock1.urls[url];
    expect(entry.token_cost_raw).toBe(Math.ceil(20 / 4)); // 5
    expect(entry.token_cost_compressed).toBe(18);
    // After run 1, cached is false — the URL was fetched for the first
    // time (status "updated"). It only becomes true on run 2 when the
    // ETag matches and the content is confirmed unchanged.
    expect(entry.cached).toBe(false);

    // Run 2: ETag matches, link is cached. tokensSaved = raw - compressed.
    const run2 = await condenseMarkdown(mdPath, undefined, {
      allowPrivate: true,
    });

    const expectedSavings = Math.max(0, entry.token_cost_raw - 18);
    expect(run2.tokensSaved).toBe(expectedSavings);

    // global_tokens_saved should match.
    const lock2 = JSON.parse(await fs.readFile(lockPath, "utf8"));
    expect(lock2.global_tokens_saved).toBe(expectedSavings);

    // Now cached should be true after the second run.
    expect(lock2.urls[url].cached).toBe(true);
  });

  it("condense run 3: tokensSaved is 0 (already counted)", async () => {
    const url = `http://localhost:${port}/stable`;
    const mdPath = await writeMd("math3.md", `[link](${url})\n`);

    await condenseMarkdown(mdPath, undefined, { allowPrivate: true });
    await condenseMarkdown(mdPath, undefined, { allowPrivate: true });

    const lockPath = path.join(tmpDir, ".doc-lok", "lock.json");
    const lockBefore = JSON.parse(await fs.readFile(lockPath, "utf8"));
    const globalBefore = lockBefore.global_tokens_saved;

    const run3 = await condenseMarkdown(mdPath, undefined, {
      allowPrivate: true,
    });
    expect(run3.tokensSaved).toBe(0);

    const lockAfter = JSON.parse(await fs.readFile(lockPath, "utf8"));
    expect(lockAfter.global_tokens_saved).toBe(globalBefore); // unchanged
  });
});
