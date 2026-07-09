import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";

import { inlineMarkdown, restoreMarkdown, INLINE_MARKER } from "../src/parser.js";

const CLI = path.resolve("dist/cli.js");

// A multi-section HTML page for testing.
const MULTI_SECTION_HTML = `<!DOCTYPE html>
<html><body>
<h1>API Documentation</h1>
<p>Overview paragraph.</p>
<h2>Authentication</h2>
<p>Use OAuth 2.0 for auth. Set <code>retry_backoff_ms</code> to 1000.</p>
<h2>API Reference</h2>
<p>Endpoints documented here.</p>
<h3>GET /users</h3>
<p>Returns a list of users.</p>
<h2>Rate Limits</h2>
<p>100 requests per minute.</p>
<h2>Migrations</h2>
<p>How to migrate from v1 to v2.</p>
</body></html>`;

describe("inlineMarkdown — section selection (library API)", () => {
  let tmpDir: string;
  let server: Server;
  let port: number;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "doc-lok-section-test-"));

    server = createServer((req, res) => {
      const pathname = req.url!;
      if (pathname === "/multi") {
        res.setHeader("etag", '"multi-v1"');
        res.setHeader("content-type", "text/html; charset=utf-8");
        res.writeHead(200);
        res.end(MULTI_SECTION_HTML);
        return;
      }
      if (pathname === "/flat") {
        // A page with no headings — should fall back to full body.
        res.setHeader("etag", '"flat"');
        res.setHeader("content-type", "text/html");
        res.writeHead(200);
        res.end("<p>No headings here, just a paragraph.</p>");
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

  async function writeMd(name: string, content: string): Promise<string> {
    const p = path.join(tmpDir, name);
    await fs.writeFile(p, content, "utf8");
    return p;
  }

  async function listCacheFiles(): Promise<string[]> {
    const cacheDir = path.join(tmpDir, ".doc-lok", "cache");
    try {
      return await fs.readdir(cacheDir);
    } catch {
      return [];
    }
  }

  const baseOpts = { allowPrivate: true };

  it("default (no sections): inlines TOC only, not the full body", async () => {
    const url = `http://localhost:${port}/multi`;
    const mdPath = await writeMd("toc.md", `# Doc\n\n[docs](${url})\n`);

    const result = await inlineMarkdown(mdPath, undefined, baseOpts);

    expect(result.output).toContain(INLINE_MARKER);
    expect(result.output).toContain("<index>");
    // The TOC lists section headings but does NOT include section content.
    expect(result.output).toContain("Authentication");
    expect(result.output).toContain("API Reference");
    expect(result.output).toContain("Rate Limits");
    // Section body content is NOT inlined (TOC only).
    expect(result.output).not.toContain("OAuth 2.0");
    expect(result.output).not.toContain("retry_backoff_ms");
    expect(result.inlinedCount).toBe(1);
  });

  it("--section all: inlines the full converted Markdown body", async () => {
    const url = `http://localhost:${port}/multi`;
    const mdPath = await writeMd("all.md", `# Doc\n\n[docs](${url})\n`);

    const result = await inlineMarkdown(mdPath, undefined, {
      ...baseOpts,
      sections: ["all"],
    });

    expect(result.output).toContain(INLINE_MARKER);
    expect(result.output).toContain("<body>");
    // Full body content is present.
    expect(result.output).toContain("Authentication");
    expect(result.output).toContain("OAuth 2.0");
    expect(result.output).toContain("retry_backoff_ms");
    expect(result.output).toContain("Rate Limits");
    expect(result.inlinedCount).toBe(1);
  });

  it("--section authentication: inlines just that section", async () => {
    const url = `http://localhost:${port}/multi`;
    const mdPath = await writeMd("auth.md", `# Doc\n\n[docs](${url})\n`);

    const result = await inlineMarkdown(mdPath, undefined, {
      ...baseOpts,
      sections: ["authentication"],
    });

    expect(result.output).toContain(INLINE_MARKER);
    expect(result.output).toContain("<section:authentication>");
    // The auth section content is present.
    expect(result.output).toContain("OAuth 2.0");
    expect(result.output).toContain("retry_backoff_ms");
    // Other sections' content is NOT inlined.
    expect(result.output).not.toContain("100 requests per minute");
    expect(result.output).not.toContain("How to migrate");
    expect(result.inlinedCount).toBe(1);
  });

  it("--section auth --section rate-limits: inlines two sections", async () => {
    const url = `http://localhost:${port}/multi`;
    const mdPath = await writeMd("two.md", `# Doc\n\n[docs](${url})\n`);

    const result = await inlineMarkdown(mdPath, undefined, {
      ...baseOpts,
      sections: ["authentication", "rate-limits"],
    });

    expect(result.output).toContain("<section:authentication>");
    expect(result.output).toContain("<section:rate-limits>");
    expect(result.output).toContain("OAuth 2.0");
    expect(result.output).toContain("100 requests per minute");
    // API Reference content is NOT inlined.
    expect(result.output).not.toContain("Endpoints documented");
    expect(result.inlinedCount).toBe(1);
  });

  it("unknown section: error diagnostic with available sections listed", async () => {
    const url = `http://localhost:${port}/multi`;
    const mdPath = await writeMd("unknown.md", `# Doc\n\n[docs](${url})\n`);

    const result = await inlineMarkdown(mdPath, undefined, {
      ...baseOpts,
      sections: ["nonexistent-section"],
    });

    // Link is left intact.
    expect(result.output).toContain(`[docs](${url})`);
    // No inline block emitted.
    expect(result.output).not.toContain(INLINE_MARKER);
    expect(result.inlinedCount).toBe(0);
    // Error diagnostic with available sections.
    const errDiag = result.diagnostics.find((d) => d.status === "error");
    expect(errDiag).toBeDefined();
    expect(errDiag!.message).toContain("unknown section");
    expect(errDiag!.message).toContain("authentication");
    expect(errDiag!.availableSections).toBeDefined();
    expect(errDiag!.availableSections!).toContain("authentication");
    expect(errDiag!.availableSections!).toContain("rate-limits");
  });

  it("ambiguous section: error diagnostic with candidates + hint", async () => {
    // The `/multi` page has no ambiguous slugs, so this test uses
    // a heading-contains match that might be ambiguous. We'll
    // use a page with two headings containing "api".
    const html = `<h2>API Reference</h2><p>ref</p><h2>API Examples</h2><p>ex</p>`;
    server.removeAllListeners("request");
    server.on("request", (_req, res) => {
      res.setHeader("etag", '"amb"');
      res.setHeader("content-type", "text/html");
      res.writeHead(200);
      res.end(html);
    });

    const url = `http://localhost:${port}/multi`;
    const mdPath = await writeMd("amb.md", `# Doc\n\n[docs](${url})\n`);

    const result = await inlineMarkdown(mdPath, undefined, {
      ...baseOpts,
      sections: ["api"],
    });

    const ambDiag = result.diagnostics.find(
      (d) => d.status === "error" && d.message?.includes("ambiguous"),
    );
    expect(ambDiag).toBeDefined();
    expect(ambDiag!.message).toContain("candidates");
    expect(ambDiag!.message).toContain("hint");
  });

  it("page with no headings: falls back to full body inline", async () => {
    const url = `http://localhost:${port}/flat`;
    const mdPath = await writeMd("flat.md", `# Doc\n\n[docs](${url})\n`);

    // default with no headings → full body (no TOC to show).
    const result = await inlineMarkdown(mdPath, undefined, baseOpts);

    expect(result.output).toContain(INLINE_MARKER);
    // The page had no headings, so availableSections should be empty
    // and the body should be inlined.
    expect(result.output).toContain("No headings here");
  });

  it("cache: .md and .index.json files created on first run", async () => {
    const url = `http://localhost:${port}/multi`;
    const mdPath = await writeMd("cache.md", `# Doc\n\n[docs](${url})\n`);

    await inlineMarkdown(mdPath, undefined, baseOpts);

    const files = await listCacheFiles();
    expect(files.some((f) => f.endsWith(".raw"))).toBe(true);
    expect(files.some((f) => f.endsWith(".md"))).toBe(true);
    expect(files.some((f) => f.endsWith(".index.json"))).toBe(true);
  });

  it("second run reuses .md and .index.json from cache (no re-conversion)", async () => {
    const url = `http://localhost:${port}/multi`;
    const mdPath = await writeMd("reuse.md", `# Doc\n\n[docs](${url})\n`);

    // First run — converts and caches.
    await inlineMarkdown(mdPath, undefined, baseOpts);
    const filesAfterFirst = await listCacheFiles();
    const mdCount = filesAfterFirst.filter((f) => f.endsWith(".md")).length;

    // Second run — should reuse cache (no new .md files).
    await inlineMarkdown(mdPath, undefined, baseOpts);
    const filesAfterSecond = await listCacheFiles();
    const mdCount2 = filesAfterSecond.filter((f) => f.endsWith(".md")).length;

    expect(mdCount2).toBe(mdCount); // no new .md files created
  });

  it("--restore strips section blocks and keeps the original link", async () => {
    const url = `http://localhost:${port}/multi`;
    const mdPath = await writeMd("restore.md", `# Doc\n\n[docs](${url})\n`);

    // Inline with a section.
    const inlined = await inlineMarkdown(mdPath, undefined, {
      ...baseOpts,
      sections: ["authentication"],
    });
    expect(inlined.output).toContain(INLINE_MARKER);

    // Write inlined output to disk.
    const inlinedPath = path.join(tmpDir, "inlined.md");
    await fs.writeFile(inlinedPath, inlined.output, "utf8");

    // Restore — strips the block, keeps the link.
    const restored = await restoreMarkdown(inlinedPath);
    expect(restored.output).not.toContain(INLINE_MARKER);
    expect(restored.output).toContain(`[docs](${url})`);
    expect(restored.restoredCount).toBeGreaterThanOrEqual(1);
  });
});

describe("inlineMarkdown — --section CLI", () => {
  let tmpDir: string;
  let server: Server;
  let port: number;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "doc-lok-section-cli-"));

    server = createServer((req, res) => {
      const pathname = req.url!;
      if (pathname === "/multi") {
        res.setHeader("etag", '"multi-v1"');
        res.setHeader("content-type", "text/html");
        res.writeHead(200);
        res.end(MULTI_SECTION_HTML);
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

  it("--inline --section authentication inlines just that section", async () => {
    const url = `http://localhost:${port}/multi`;
    const mdPath = await writeMd("auth.md", `[docs](${url})\n`);

    const { stdout, code } = await run([
      mdPath, "--inline", "--allow-private", "--section", "authentication",
    ]);

    expect(code).toBe(0);
    expect(stdout).toContain("[docs](${url}".replace("${url}", url));
    expect(stdout).toContain(INLINE_MARKER);
    expect(stdout).toContain("<section:authentication>");
    expect(stdout).toContain("OAuth 2.0");
    expect(stdout).not.toContain("100 requests per minute");
  });

  it("--inline --json includes availableSections and matchedSections", async () => {
    const url = `http://localhost:${port}/multi`;
    const mdPath = await writeMd("json.md", `[docs](${url})\n`);

    const { stdout, code } = await run([
      mdPath, "--inline", "--allow-private", "--json",
    ]);

    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.mode).toBe("inline");
    expect(parsed.diagnostics).toHaveLength(1);
    const diag = parsed.diagnostics[0];
    expect(diag.url).toBe(url);
    expect(diag.availableSections).toBeDefined();
    expect(diag.availableSections).toContain("authentication");
    expect(diag.availableSections).toContain("rate-limits");
    expect(diag.matchedSections).toBeDefined();
    expect(diag.matchedSections).toContain("toc");
  });

  it("--inline --section unknown reports error via stderr", async () => {
    const url = `http://localhost:${port}/multi`;
    const mdPath = await writeMd("unknown.md", `[docs](${url})\n`);

    const { stdout, stderr, code } = await run([
      mdPath, "--inline", "--allow-private", "--section", "nonexistent",
    ]);

    expect(code).toBe(0);
    expect(stdout).not.toContain(INLINE_MARKER);
    expect(stderr).toContain("unknown section");
    expect(stderr).toContain("available sections");
  });
});