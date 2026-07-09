import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createServer, type Server } from "node:http";

import { checkMarkdown } from "../src/parser.js";

// Tests hit a local-loopback HTTP server — opt into the SSRF guard.
const check = (p: string, l?: string) =>
  checkMarkdown(p, l, { allowPrivate: true });

describe("checkMarkdown", () => {
  let tmpDir: string;
  let server: Server;
  let port: number;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "doc-lok-check-test-"));

    server = createServer((req, res) => {
      const pathname = req.url!;
      if (pathname === "/stable") {
        res.setHeader("etag", '"stable-etag"');
        res.writeHead(200);
        res.end("stable content");
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

  it("returns diagnostics without modifying the markdown file", async () => {
    const url = `http://localhost:${port}/stable`;
    const mdPath = await writeMd("check.md", `[Link](${url})\n`);
    const original = await fs.readFile(mdPath, "utf8");

    const result = await check(mdPath);

    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].url).toBe(url);
    expect(result.diagnostics[0].status).toBe("updated");
    expect(result.lockfile).toBeDefined();
    expect(result.lockfile.urls[url]).toBeDefined();
    expect(result.lockfile.urls[url].last_known_sha256).toBeTruthy();

    const after = await fs.readFile(mdPath, "utf8");
    expect(after).toBe(original);
  });

  it("reports cached on second run", async () => {
    const url = `http://localhost:${port}/stable`;
    const mdPath = await writeMd("cached.md", `[Link](${url})\n`);

    await check(mdPath);
    const result = await check(mdPath);

    expect(result.diagnostics[0].status).toBe("cached");
  });

  it("includes lockfile state with SHA-256 and ETag", async () => {
    const url = `http://localhost:${port}/stable`;
    const mdPath = await writeMd("lockstate.md", `[Link](${url})\n`);

    const result = await check(mdPath);

    const entry = result.lockfile.urls[url];
    expect(entry).toBeDefined();
    expect(entry.last_known_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(entry.etag).toBe('"stable-etag"');
    expect(entry.last_checked).toBeTruthy();
  });

  it("isolates errors per-URL", async () => {
    const goodUrl = `http://localhost:${port}/stable`;
    const badUrl = `http://localhost:${port}/error`;
    const mdPath = await writeMd("mixed.md", `[Good](${goodUrl}) [Bad](${badUrl})\n`);

    const result = await check(mdPath);

    expect(result.diagnostics).toHaveLength(2);
    const goodDiag = result.diagnostics.find((d) => d.url === goodUrl);
    const badDiag = result.diagnostics.find((d) => d.url === badUrl);

    expect(goodDiag!.status).toBe("updated");
    expect(badDiag!.status).toBe("error");
    expect(badDiag!.message).toContain("503");
  });

  it("returns empty diagnostics for a file with no links", async () => {
    const mdPath = await writeMd("no-links.md", "# Hello\n\nNo URLs here.\n");
    const result = await check(mdPath);

    expect(result.diagnostics).toHaveLength(0);
    expect(result.tokensSaved).toBe(0);
  });

  it("uses an explicit lockfile path when provided", async () => {
    const url = `http://localhost:${port}/stable`;
    const mdPath = await writeMd("explicit.md", `[Link](${url})\n`);
    const customLock = path.join(tmpDir, "custom-lock.json");

    const result = await check(mdPath, customLock);
    expect(result.lockfilePath).toBe(customLock);

    const lockExists = await fs
      .stat(customLock)
      .then(() => true)
      .catch(() => false);
    expect(lockExists).toBe(true);
  });
});
