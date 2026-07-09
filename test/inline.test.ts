import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";

import {
  inlineMarkdown,
  restoreMarkdown,
  INLINE_MARKER,
} from "../src/parser.js";

const CLI = path.resolve("dist/cli.js");

describe("inlineMarkdown — library API", () => {
  let tmpDir: string;
  let server: Server;
  let port: number;
  let requestLog: string[];

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "doc-lok-inline-test-"));
    requestLog = [];

    server = createServer((req, res) => {
      requestLog.push(`${req.method} ${req.url}`);
      const pathname = req.url!;

      if (pathname === "/stable") {
        res.setHeader("etag", '"stable"');
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.writeHead(200);
        res.end("<h1>Stable Documentation</h1>");
        return;
      }
      if (pathname === "/updated") {
        // Vary body + ETag each call so doc-lok sees a change every run.
        const stamp = String(requestLog.length);
        res.setHeader("etag", `"v${stamp}"`);
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.writeHead(200);
        res.end(`<h1>Updated ${stamp}</h1>`);
        return;
      }
      if (pathname === "/pdf") {
        res.setHeader("content-type", "application/pdf");
        res.writeHead(200);
        res.end("%PDF-1.4 not real");
        return;
      }
      if (pathname === "/huge") {
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.writeHead(200);
        res.end("x".repeat(100_000));
        return;
      }
      if (pathname === "/error") {
        res.writeHead(503);
        res.end("unavailable");
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

  async function listCache(): Promise<string[]> {
    const cacheDir = path.join(tmpDir, ".doc-lok", "cache");
    try {
      return await fs.readdir(cacheDir);
    } catch {
      return [];
    }
  }

  // Inline mode shares the SSRF guard; tests must opt in to localhost.
  const opts = { allowPrivate: true };

  // Default --inline is now TOC-only. Use `sections: ["all"]` for full
// body. The opts helper below pins `allowPrivate: true`; individual tests
// add `sections` as needed.
const allOpts = { ...opts, sections: ["all"] } as const;

it("first run: injects the fetched body in a fenced block after the link", async () => {
    const url = `http://localhost:${port}/stable`;
    const mdPath = await writeMd("inline.md", `# Docs\n\n[docs](${url})\n`);

    const result = await inlineMarkdown(mdPath, undefined, allOpts);

    // Original link is preserved
    expect(result.output).toContain(`[docs](${url})`);
    // An inline block is present
    expect(result.output).toContain(INLINE_MARKER);
    // Body content is visible inside the block (converted to Markdown).
    // The minimal converter emits `# Stable Documentation`.
    expect(result.output).toContain("Stable Documentation");
    // Cache directory was populated
    const cacheFiles = await listCache();
    expect(
      cacheFiles.some((f) => f.endsWith(".raw")),
    ).toBe(true);
    // inlinedCount reflects one inline block written
    expect(result.inlinedCount).toBe(1);
  });

  it("second run: HEAD-only, reuses the cached body, no GET issued", async () => {
    const url = `http://localhost:${port}/stable`;
    const mdPath = await writeMd("cached.md", `# Docs\n\n[docs](${url})\n`);

    // Warm the cache
    await inlineMarkdown(mdPath, undefined, allOpts);

    const getCountBefore = requestLog.filter((r) => r.startsWith("GET")).length;
    const getHeadsBefore = requestLog.filter((r) => r.startsWith("HEAD")).length;

    // Second run — should be HEAD-only
    const result = await inlineMarkdown(mdPath, undefined, allOpts);

    const getCountAfter = requestLog.filter((r) => r.startsWith("GET")).length;
    const getHeadsAfter = requestLog.filter((r) => r.startsWith("HEAD")).length;

    expect(getCountAfter).toBe(getCountBefore); // no new GET
    expect(getHeadsAfter).toBe(getHeadsBefore + 1); // exactly one new HEAD

    // Block content is identical to first run
    expect(result.output).toContain("Stable Documentation");
    expect(result.output).toContain(INLINE_MARKER);
    expect(result.inlinedCount).toBe(1);
  });

  it("updated URL: refetches and inline block reflects new content", async () => {
    const url = `http://localhost:${port}/updated`;
    const mdPath = await writeMd("updated.md", `# Docs\n\n[docs](${url})\n`);

    const run1 = await inlineMarkdown(mdPath, undefined, allOpts);
    expect(run1.output).toMatch(/Updated \d+/);
    const stamp1 = run1.output.match(/Updated (\d+)/)![1];

    const run2 = await inlineMarkdown(mdPath, undefined, allOpts);
    const stamp2 = run2.output.match(/Updated (\d+)/)![1];

    // New body was fetched, so the stamp should differ
    expect(stamp1).not.toBe(stamp2);
    expect(run2.inlinedCount).toBe(1);
  });

  it("server error: leaves link intact, no inline block, error diagnostic", async () => {
    const url = `http://localhost:${port}/error`;
    const mdPath = await writeMd("error.md", `# Docs\n\n[docs](${url})\n`);

    const result = await inlineMarkdown(mdPath, undefined, opts);

    expect(result.output).toContain(`[docs](${url})`);
    expect(result.output).not.toContain(INLINE_MARKER);
    expect(result.inlinedCount).toBe(0);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].status).toBe("error");
    expect(result.diagnostics[0].message).toMatch(/503/);
  });

  it("--max-bytes refuses oversized bodies, leaves the link intact", async () => {
    const url = `http://localhost:${port}/huge`;
    const mdPath = await writeMd("huge.md", `# Docs\n\n[docs](${url})\n`);

    const result = await inlineMarkdown(mdPath, undefined, {
      ...opts,
      maxBytes: 1024, // 1KB cap; server returns 100KB
    });

    expect(result.output).toContain(`[docs](${url})`);
    expect(result.output).not.toContain(INLINE_MARKER);
    expect(result.inlinedCount).toBe(0);
    expect(result.diagnostics[0].status).toBe("error");
    expect(result.diagnostics[0].message).toMatch(/max-bytes/);
  });

  it("content-type allowlist: blocks non-HTML responses", async () => {
    const url = `http://localhost:${port}/pdf`;
    const mdPath = await writeMd("pdf.md", `# Docs\n\n[docs](${url})\n`);

    const result = await inlineMarkdown(mdPath, undefined, opts);

    expect(result.output).toContain(`[docs](${url})`);
    expect(result.output).not.toContain(INLINE_MARKER);
    expect(result.inlinedCount).toBe(0);
    expect(result.diagnostics[0].status).toBe("error");
    expect(result.diagnostics[0].message).toMatch(/content-type/);
  });

  it("SSRF blocks localhost by default (no allowPrivate)", async () => {
    const url = `http://localhost:${port}/stable`;
    const mdPath = await writeMd("ssrf.md", `# Docs\n\n[docs](${url})\n`);

    const result = await inlineMarkdown(mdPath); // no allowPrivate

    expect(result.diagnostics[0].status).toBe("error");
    expect(result.diagnostics[0].message).toMatch(/ssrf blocked.*loopback/);
    expect(result.output).toContain(`[docs](${url})`);
    expect(result.inlinedCount).toBe(0);
  });

  it("restore strips inline blocks and keeps the original link", async () => {
    const url = `http://localhost:${port}/stable`;
    const mdPath = await writeMd("restore.md", `# Docs\n\n[docs](${url})\n`);

    // Inline — creates the block and the lockfile
    const inline = await inlineMarkdown(mdPath, undefined, opts);
    expect(inline.output).toContain(INLINE_MARKER);

    // Write the inlined output to disk so restore can read it
    const inlinedPath = path.join(tmpDir, "inlined.md");
    await fs.writeFile(inlinedPath, inline.output, "utf8");

    // Restore — should strip the block and leave just the link
    const restored = await restoreMarkdown(inlinedPath);
    expect(restored.output).not.toContain(INLINE_MARKER);
    expect(restored.output).toContain(`[docs](${url})`);
    expect(restored.restoredCount).toBeGreaterThanOrEqual(1);
  });

  it("cache directory defaults to .doc-lok/cache next to the lockfile", async () => {
    const url = `http://localhost:${port}/stable`;
    const mdPath = await writeMd("cachedir.md", `# Docs\n\n[docs](${url})\n`);

    const result = await inlineMarkdown(mdPath, undefined, opts);
    const expected = path.join(tmpDir, ".doc-lok", "cache");
    expect(result.cacheDir).toBe(expected);

    const cacheFiles = await fs.readdir(expected);
    expect(cacheFiles.some((f) => f.endsWith(".raw"))).toBe(true);
  });

  it("honors an explicit --cache-dir override", async () => {
    const url = `http://localhost:${port}/stable`;
    const mdPath = await writeMd("cachedir2.md", `# Docs\n\n[docs](${url})\n`);
    const customCache = path.join(tmpDir, "custom-cache");

    const result = await inlineMarkdown(mdPath, undefined, {
      ...opts,
      cacheDir: customCache,
    });
    expect(result.cacheDir).toBe(customCache);

    const cacheFiles = await fs.readdir(customCache);
    expect(cacheFiles.some((f) => f.endsWith(".raw"))).toBe(true);
  });
});

describe("inlineMarkdown — CLI", () => {
  let tmpDir: string;
  let server: Server;
  let port: number;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "doc-lok-inline-cli-"));

    server = createServer((req, res) => {
      const pathname = req.url!;
      if (pathname === "/stable") {
        res.setHeader("etag", '"stable"');
        res.setHeader("content-type", "text/html");
        res.writeHead(200);
        res.end("<h1>Stable Documentation</h1>");
        return;
      }
      res.setHeader("content-type", "text/html");
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

  function run(args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
    return new Promise((resolve) => {
      const child = spawn("node", [CLI, ...args], {
        cwd: process.cwd(),
        env: { ...process.env },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => { stdout += d; });
      child.stderr.on("data", (d) => { stderr += d; });
      child.on("close", (code) => {
        resolve({ stdout, stderr, code });
      });
    });
  }

  async function writeMd(name: string, content: string): Promise<string> {
    const p = path.join(tmpDir, name);
    await fs.writeFile(p, content, "utf8");
    return p;
  }

  it("--inline --section all writes the full body to stdout", async () => {
    const url = `http://localhost:${port}/stable`;
    const mdPath = await writeMd("inline.md", `[docs](${url})\n`);

    const { stdout, stderr, code } = await run([
      mdPath,
      "--inline",
      "--allow-private",
      "--section",
      "all",
    ]);

    expect(code).toBe(0);
    expect(stdout).toContain(`[docs](${url})`);
    expect(stdout).toContain(INLINE_MARKER);
    expect(stdout).toContain("Stable Documentation");
    expect(stderr).toContain("doc-lok inline");
  });

  it("--inline --quiet writes only the markdown to stdout", async () => {
    const url = `http://localhost:${port}/stable`;
    const mdPath = await writeMd("inline.md", `[docs](${url})\n`);

    const { stdout, stderr, code } = await run([
      mdPath,
      "--inline",
      "--allow-private",
      "--quiet",
    ]);

    expect(code).toBe(0);
    expect(stdout).toContain(INLINE_MARKER);
    expect(stderr).toBe("");
  });

  it("--inline --json emits structured JSON with mode=inline", async () => {
    const url = `http://localhost:${port}/stable`;
    const mdPath = await writeMd("inline.md", `[docs](${url})\n`);

    const { stdout, code } = await run([
      mdPath,
      "--inline",
      "--allow-private",
      "--json",
    ]);

    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.mode).toBe("inline");
    expect(parsed.output).toContain(INLINE_MARKER);
    expect(parsed.inlinedCount).toBe(1);
    expect(parsed.cacheDir).toBeDefined();
    expect(parsed.diagnostics).toHaveLength(1);
  });

  it("--inline without --allow-private blocks localhost and reports an error", async () => {
    const url = `http://localhost:${port}/stable`;
    const mdPath = await writeMd("inline.md", `[docs](${url})\n`);

    const { stdout, stderr, code } = await run([
      mdPath,
      "--inline",
    ]);

    // The run succeeds (no fatal error) — the per-URL SSRF block
    // is a diagnostic, not a fatal CLI error.
    expect(code).toBe(0);
    expect(stdout).toContain(`[docs](${url})`);
    expect(stdout).not.toContain(INLINE_MARKER);
    expect(stderr).toMatch(/ssrf blocked.*loopback/);
  });

  it("--inline --max-bytes 8 rejects an oversized body", async () => {
    // The /stable body is "<h1>Stable Documentation</h1>" — larger than 8 bytes.
    // But we'll use a path that returns a longer body to be sure.
    const url = `http://localhost:${port}/stable`;
    const mdPath = await writeMd("huge.md", `[docs](${url})\n`);

    const { stdout, code } = await run([
      mdPath,
      "--inline",
      "--allow-private",
      "--max-bytes",
      "8",
    ]);

    expect(code).toBe(0);
    // The link is preserved but the block was rejected.
    expect(stdout).toContain(`[docs](${url})`);
    expect(stdout.replace(`[docs](${url})\n`, "")).not.toContain(INLINE_MARKER);
  });
});