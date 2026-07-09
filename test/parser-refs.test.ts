import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createServer, type Server } from "node:http";

import { condenseMarkdown, restoreMarkdown, checkMarkdown, MARKER } from "../src/parser.js";

// Tests hit a local-loopback HTTP server — opt into the SSRF guard.
const condense = (p: string, l?: string) =>
  condenseMarkdown(p, l, { allowPrivate: true });
const check = (p: string, l?: string) =>
  checkMarkdown(p, l, { allowPrivate: true });

describe("Reference-style link support", () => {
  let tmpDir: string;
  let server: Server;
  let port: number;
  let requestLog: Array<{ method: string; url: string }>;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "doc-lok-ref-test-"));
    requestLog = [];

    server = createServer((req, res) => {
      requestLog.push({ method: req.method!, url: req.url! });
      const pathname = req.url!;

      if (pathname === "/stable") {
        res.setHeader("etag", '"stable"');
        res.writeHead(200);
        res.end("stable content");
        return;
      }

      res.writeHead(200);
      res.end("default");
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

  it("validates reference definitions but does not replace them", async () => {
    const url = `http://localhost:${port}/stable`;
    const mdPath = await writeMd(
      "refs.md",
      `[OpenAI]: ${url}\n\nCheck out [OpenAI] for more info.\n`,
    );

    const result = await condense(mdPath);

    // The definition line should still be present.
    expect(result.output).toContain(`[OpenAI]: ${url}`);
    expect(result.output).not.toContain(MARKER);

    // The URL should have been validated (HEAD request logged).
    expect(requestLog.some((r) => r.url === "/stable")).toBe(true);
  });

  it("condenses inline links while leaving reference defs intact", async () => {
    const inlineUrl = `http://localhost:${port}/stable`;
    const refUrl = `http://localhost:${port}/stable`; // same for simplicity
    const mdPath = await writeMd(
      "mixed.md",
      `[inline](${inlineUrl})\n[OpenAI]: ${refUrl}\n`,
    );

    const run1 = await condense(mdPath);
    expect(run1.output).toContain(`[inline](${inlineUrl})`);
    expect(run1.output).toContain(`[OpenAI]: ${refUrl}`);

    const run2 = await condense(mdPath);
    expect(run2.output).toContain(MARKER);
    expect(run2.output).toContain(`[OpenAI]: ${refUrl}`);
  });

  it("parses reference definitions with angle brackets", async () => {
    const url = `http://localhost:${port}/stable`;
    const mdPath = await writeMd(
      "angled.md",
      `[OpenAI]: <${url}>\n\nCheck out [OpenAI].\n`,
    );

    const result = await condense(mdPath);
    expect(result.output).toContain(`[OpenAI]: <${url}>`);
    expect(requestLog.some((r) => r.url === "/stable")).toBe(true);
  });

  it("parses reference definitions with optional titles", async () => {
    const url = `http://localhost:${port}/stable`;
    const mdPath = await writeMd(
      "titled.md",
      `[OpenAI]: ${url} "OpenAI Homepage"\n[Github]: ${url} 'GitHub Repo'\n[NPM]: ${url} (npm package)\n`,
    );

    const result = await condense(mdPath);
    expect(result.output).toContain(`[OpenAI]: ${url} "OpenAI Homepage"`);
    expect(result.output).toContain(`[Github]: ${url} 'GitHub Repo'`);
    expect(result.output).toContain(`[NPM]: ${url} (npm package)`);
  });

  it("ignores reference definitions that are not http(s)", async () => {
    const mdPath = await writeMd(
      "local-refs.md",
      `[local]: ./readme.md\n[mail]: mailto:a@b.com\n`,
    );

    const result = await condense(mdPath);
    expect(result.diagnostics).toHaveLength(0);
    expect(result.output).toContain("[local]: ./readme.md");
    expect(result.output).toContain("[mail]: mailto:a@b.com");
  });

  it("deduplicates reference URLs across multiple definitions", async () => {
    const url = `http://localhost:${port}/stable`;
    const mdPath = await writeMd(
      "dup-refs.md",
      `[OpenAI]: ${url}\n[Alt]: ${url}\n`,
    );

    const result = await condense(mdPath);

    // Should only validate once despite two definitions.
    const headCount = requestLog.filter(
      (r) => r.method === "HEAD" && r.url === "/stable",
    ).length;
    expect(headCount).toBe(1);

    expect(result.output).toContain(`[OpenAI]: ${url}`);
    expect(result.output).toContain(`[Alt]: ${url}`);
  });

  it("does not count reference definition savings in tokensSaved", async () => {
    const url = `http://localhost:${port}/stable`;
    const mdPath = await writeMd("ref-only.md", `[OpenAI]: ${url}\n`);

    const result = await condense(mdPath);
    // Reference defs are not replaced, so no token savings.
    expect(result.tokensSaved).toBe(0);
  });
});

describe("restoreMarkdown", () => {
  let tmpDir: string;
  let server: Server;
  let port: number;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "doc-lok-restore-test-"));

    server = createServer((req, res) => {
      const pathname = req.url!;
      if (pathname === "/stable") {
        res.setHeader("etag", '"stable"');
        res.writeHead(200);
        res.end("stable content");
        return;
      }
      res.writeHead(200);
      res.end("default");
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

  it("restores markers back to links using the lockfile", async () => {
    const lockPath = path.join(tmpDir, ".doc-lok", "lock.json");
    const lock = {
      version: 1,
      global_tokens_saved: 100,
      urls: {
        "https://example.com": {
          last_known_sha256: "abc",
          etag: null,
          token_cost_raw: 50,
          token_cost_compressed: 18,
          last_checked: "2024-01-01T00:00:00.000Z",
        },
      },
    };
    await fs.mkdir(path.dirname(lockPath), { recursive: true }); await fs.writeFile(lockPath, JSON.stringify(lock), "utf8");

    const { hashUrl } = await import("../src/state.js");
    const hash = hashUrl("https://example.com");

    const mdPath = await writeMd(
      "condensed.md",
      `# Hello\n\nVisit <!-- doc-lok:cached#${hash} --> for details.\n`,
    );

    const result = await restoreMarkdown(mdPath, lockPath);
    expect(result.output).toContain(
      "[https://example.com](https://example.com)",
    );
    expect(result.output).not.toContain("doc-lok:cached");
    expect(result.restoredCount).toBe(1);
  });

  it("leaves unknown markers in place", async () => {
    const lockPath = path.join(tmpDir, ".doc-lok", "lock.json");
    const lock = {
      version: 1,
      global_tokens_saved: 0,
      urls: {},
    };
    await fs.mkdir(path.dirname(lockPath), { recursive: true }); await fs.writeFile(lockPath, JSON.stringify(lock), "utf8");

    const mdPath = await writeMd(
      "unknown.md",
      "# Hello\n\nVisit <!-- doc-lok:cached#0000000000000000000000000000000000000000000000000000000000000000 --> for details.\n",
    );

    const result = await restoreMarkdown(mdPath, lockPath);
    expect(result.output).toContain(
      "<!-- doc-lok:cached#0000000000000000000000000000000000000000000000000000000000000000 -->",
    );
    expect(result.restoredCount).toBe(0);
  });

  it("restores multiple distinct markers", async () => {
    const lockPath = path.join(tmpDir, ".doc-lok", "lock.json");
    const lock = {
      version: 1,
      global_tokens_saved: 0,
      urls: {
        "https://a.com": {
          last_known_sha256: "a",
          etag: null,
          token_cost_raw: 10,
          token_cost_compressed: 18,
          last_checked: "2024-01-01T00:00:00.000Z",
        },
        "https://b.com": {
          last_known_sha256: "b",
          etag: null,
          token_cost_raw: 10,
          token_cost_compressed: 18,
          last_checked: "2024-01-01T00:00:00.000Z",
        },
      },
    };
    await fs.mkdir(path.dirname(lockPath), { recursive: true }); await fs.writeFile(lockPath, JSON.stringify(lock), "utf8");

    // Compute hashes manually to craft the marker.
    const { hashUrl } = await import("../src/state.js");
    const hashA = hashUrl("https://a.com");
    const hashB = hashUrl("https://b.com");

    const mdPath = await writeMd(
      "multi.md",
      `A: <!-- doc-lok:cached#${hashA} --> and B: <!-- doc-lok:cached#${hashB} -->\n`,
    );

    const result = await restoreMarkdown(mdPath, lockPath);
    expect(result.restoredCount).toBe(2);
    expect(result.output).toContain("[https://a.com](https://a.com)");
    expect(result.output).toContain("[https://b.com](https://b.com)");
  });

  it("returns the lockfile path used", async () => {
    const mdPath = await writeMd("simple.md", "# Hello\n");
    const result = await restoreMarkdown(mdPath);
    expect(result.lockfilePath).toBe(path.join(tmpDir, ".doc-lok", "lock.json"));
  });

  it("restores the original anchor text when present in the lockfile", async () => {
    const lockPath = path.join(tmpDir, ".doc-lok", "lock.json");
    const lock = {
      version: 2,
      global_tokens_saved: 100,
      urls: {
        "https://example.com": {
          last_known_sha256: "abc",
          etag: null,
          token_cost_raw: 50,
          token_cost_compressed: 18,
          last_checked: "2024-01-01T00:00:00.000Z",
          original_text: "Documentation",
        },
      },
    };
    await fs.mkdir(path.dirname(lockPath), { recursive: true }); await fs.writeFile(lockPath, JSON.stringify(lock), "utf8");

    const { hashUrl } = await import("../src/state.js");
    const hash = hashUrl("https://example.com");

    const mdPath = await writeMd(
      "condensed.md",
      `# Hello\n\nVisit <!-- doc-lok:cached#${hash} --> for details.\n`,
    );

    const result = await restoreMarkdown(mdPath, lockPath);
    expect(result.output).toContain("[Documentation](https://example.com)");
    expect(result.output).not.toContain("doc-lok:cached");
    expect(result.restoredCount).toBe(1);
  });

  it("falls back to URL as link text when original_text is absent", async () => {
    const lockPath = path.join(tmpDir, ".doc-lok", "lock.json");
    const lock = {
      version: 1,
      global_tokens_saved: 100,
      urls: {
        "https://example.com": {
          last_known_sha256: "abc",
          etag: null,
          token_cost_raw: 50,
          token_cost_compressed: 18,
          last_checked: "2024-01-01T00:00:00.000Z",
        },
      },
    };
    await fs.mkdir(path.dirname(lockPath), { recursive: true }); await fs.writeFile(lockPath, JSON.stringify(lock), "utf8");

    const { hashUrl } = await import("../src/state.js");
    const hash = hashUrl("https://example.com");

    const mdPath = await writeMd(
      "condensed-legacy.md",
      `# Hello\n\nVisit <!-- doc-lok:cached#${hash} --> for details.\n`,
    );

    const result = await restoreMarkdown(mdPath, lockPath);
    expect(result.output).toContain(
      "[https://example.com](https://example.com)",
    );
    expect(result.restoredCount).toBe(1);
  });

  it("records anchor text during condense and restores it later", async () => {
    const url = `http://localhost:${port}/stable`;
    const mdPath = await writeMd(
      "original.md",
      `# Hello\n\nRead the [Documentation](${url}) for more info.\n`,
    );

    // First run warms the lockfile and stores original_text.
    await condense(mdPath);
    // Second run condenses the link.
    const run2 = await condense(mdPath);
    expect(run2.output).toContain(MARKER);

    // Write the condensed output so restore has markers to inflate.
    await fs.writeFile(mdPath, run2.output, "utf8");

    const restored = await restoreMarkdown(mdPath);
    expect(restored.output).toContain(`[Documentation](${url})`);
    expect(restored.output).not.toContain(MARKER);
    expect(restored.restoredCount).toBe(1);
  });

  it("preserves original_text across checkMarkdown runs", async () => {
    const url = `http://localhost:${port}/stable`;
    const mdPath = await writeMd(
      "check-preserve.md",
      `# Hello\n\nRead the [Docs](${url}).\n`,
    );

    await condense(mdPath);
    await check(mdPath);

    const restored = await restoreMarkdown(mdPath);
    expect(restored.output).toContain(`[Docs](${url})`);
  });

  it("uses the last-seen anchor text when the same URL appears multiple times", async () => {
    const url = `http://localhost:${port}/stable`;
    const mdPath = await writeMd(
      "multi-text.md",
      `# Hello\n\n[A](${url}) and [B](${url}).\n`,
    );

    await condense(mdPath);
    const run2 = await condense(mdPath);
    expect(run2.output.match(new RegExp(MARKER, "g"))?.length).toBe(2);

    // Write the condensed output so restore has markers to inflate.
    await fs.writeFile(mdPath, run2.output, "utf8");

    const restored = await restoreMarkdown(mdPath);
    // Both markers restore with the last-seen text "B".
    expect(restored.output).toContain(`[B](${url})`);
    expect(restored.output).not.toContain(`[A](${url})`);
  });
});
