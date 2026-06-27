import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createServer, type Server } from "node:http";

import { condenseMarkdown, MARKER } from "../src/parser.js";

describe("condenseMarkdown", () => {
  let tmpDir: string;
  let server: Server;
  let port: number;
  let requestCount: Map<string, number>;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "doc-lok-parser-test-"));
    requestCount = new Map();

    server = createServer((req, res) => {
      const key = `${req.method} ${req.url}`;
      requestCount.set(key, (requestCount.get(key) ?? 0) + 1);

      const pathname = req.url!;

      if (pathname === "/stable") {
        res.setHeader("etag", '"stable-etag"');
        res.writeHead(200);
        res.end("stable content");
        return;
      }

      if (pathname === "/changed") {
        res.setHeader("etag", '"changed-etag"');
        res.writeHead(200);
        res.end("changed content");
        return;
      }

      if (pathname === "/error") {
        res.writeHead(503);
        res.end("unavailable");
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

  it("returns empty diagnostics for a file with no links", async () => {
    const mdPath = await writeMd("no-links.md", "# Hello\n\nNo URLs here.\n");
    const result = await condenseMarkdown(mdPath);

    expect(result.output).toBe("# Hello\n\nNo URLs here.\n");
    expect(result.diagnostics).toHaveLength(0);
    expect(result.tokensSaved).toBe(0);
    expect(result.lockfilePath).toBe(path.join(tmpDir, "doc-lok.json"));
  });

  it("replaces unchanged links with the marker on second run", async () => {
    const url = `http://localhost:${port}/stable`;
    const mdPath = await writeMd("stable.md", `[Stable Link](${url})\n`);

    // First run — new URL, should be "updated"
    const run1 = await condenseMarkdown(mdPath);
    expect(run1.diagnostics[0].status).toBe("updated");
    expect(run1.output).toContain(`[Stable Link](${url})`);

    // Second run — same ETag, should be "cached"
    const run2 = await condenseMarkdown(mdPath);
    expect(run2.diagnostics[0].status).toBe("cached");
    expect(run2.output).toContain(MARKER);
    expect(run2.output).not.toContain(`[Stable Link](${url})`);
  });

  it("does not replace a link that has changed", async () => {
    const url = `http://localhost:${port}/changed`;
    const mdPath = await writeMd("changed.md", `[Changed](${url})\n`);

    const run1 = await condenseMarkdown(mdPath);
    expect(run1.diagnostics[0].status).toBe("updated");

    // Simulate a server-side change by mutating the stored ETag and SHA-256.
    // Mutating only the SHA isn't enough because the HEAD request will see the
    // matching ETag and short-circuit. We must also invalidate the ETag so the
    // GET body is fetched and SHA-256 comparison runs.
    const lockPath = path.join(tmpDir, "doc-lok.json");
    const lock = JSON.parse(await fs.readFile(lockPath, "utf8"));
    lock.urls[url].etag = '"old-etag"';
    lock.urls[url].last_known_sha256 =
      "0000000000000000000000000000000000000000000000000000000000000000";
    await fs.writeFile(lockPath, JSON.stringify(lock), "utf8");

    const run2 = await condenseMarkdown(mdPath);
    expect(run2.diagnostics[0].status).toBe("updated");
    expect(run2.output).toContain(`[Changed](${url})`);
  });

  it("isolates errors per-URL and continues processing", async () => {
    const goodUrl = `http://localhost:${port}/stable`;
    const badUrl = `http://localhost:${port}/error`;
    const mdPath = await writeMd(
      "mixed.md",
      `[Good](${goodUrl}) and [Bad](${badUrl})\n`,
    );

    const result = await condenseMarkdown(mdPath);

    expect(result.diagnostics).toHaveLength(2);
    const goodDiag = result.diagnostics.find((d) => d.url === goodUrl);
    const badDiag = result.diagnostics.find((d) => d.url === badUrl);

    expect(goodDiag!.status).toBe("updated");
    expect(badDiag!.status).toBe("error");
    expect(badDiag!.message).toContain("503");

    // The good link should still be present in output
    expect(result.output).toContain(`[Good](${goodUrl})`);
  });

  it("deduplicates repeated links", async () => {
    const url = `http://localhost:${port}/stable`;
    const mdPath = await writeMd(
      "dupes.md",
      `[First](${url}) [Second](${url}) [Third](${url})\n`,
    );

    const result = await condenseMarkdown(mdPath);

    // Should only have 1 diagnostic despite 3 occurrences
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].url).toBe(url);

    // Should only have made one network request pair (req.url is the path)
    expect(requestCount.get(`HEAD /stable`)).toBe(1);
    expect(requestCount.get(`GET /stable`)).toBe(1);
  });

  it("ignores non-http(s) links", async () => {
    const mdPath = await writeMd(
      "local.md",
      `[Relative](./local.md) [Mail](mailto:a@b.com) [FTP](ftp://x.com)\n`,
    );

    const result = await condenseMarkdown(mdPath);
    expect(result.diagnostics).toHaveLength(0);
    expect(result.output).toContain("[Relative](./local.md)");
    expect(result.output).toContain("[Mail](mailto:a@b.com)");
    expect(result.output).toContain("[FTP](ftp://x.com)");
  });

  it("uses an explicit lockfile path when provided", async () => {
    const url = `http://localhost:${port}/stable`;
    const mdPath = await writeMd("explicit.md", `[Link](${url})\n`);
    const customLock = path.join(tmpDir, "custom-lock.json");

    const result = await condenseMarkdown(mdPath, customLock);
    expect(result.lockfilePath).toBe(customLock);

    const lockExists = await fs
      .stat(customLock)
      .then(() => true)
      .catch(() => false);
    expect(lockExists).toBe(true);
  });

  it("respects link titles", async () => {
    const url = `http://localhost:${port}/stable`;
    const mdPath = await writeMd("title.md", `[Link](${url} "A Title")\n`);

    const result = await condenseMarkdown(mdPath);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].url).toBe(url);
  });

  it("accumulates global_tokens_saved across runs", async () => {
    const url = `http://localhost:${port}/stable`;
    const mdPath = await writeMd("accum.md", `[Link](${url})\n`);

    const run1 = await condenseMarkdown(mdPath);
    const run2 = await condenseMarkdown(mdPath);

    const lock = JSON.parse(
      await fs.readFile(path.join(tmpDir, "doc-lok.json"), "utf8"),
    );

    // First run adds savings, second run adds 0 because cached
    expect(lock.global_tokens_saved).toBe(run1.tokensSaved);
    expect(run2.tokensSaved).toBe(0);
  });
});
