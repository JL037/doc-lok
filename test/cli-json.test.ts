import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createServer, type Server } from "node:http";

const CLI = path.resolve("dist/cli.js");

describe("CLI --json and --check", () => {
  let tmpDir: string;
  let server: Server;
  let port: number;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "doc-lok-json-test-"));

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

  it("--check does not modify the markdown file", async () => {
    const url = `http://localhost:${port}/stable`;
    const mdPath = await writeMd("check.md", `[Link](${url})\n`);
    const original = await fs.readFile(mdPath, "utf8");

    const { stdout, code } = await run([mdPath, "--check", "--json"]);
    expect(code).toBe(0);

    const parsed = JSON.parse(stdout);
    expect(parsed.mode).toBe("check");
    expect(parsed.diagnostics).toHaveLength(1);
    expect(parsed.diagnostics[0].url).toBe(url);
    expect(parsed.diagnostics[0].status).toBe("updated");

    const after = await fs.readFile(mdPath, "utf8");
    expect(after).toBe(original);
  });

  it("--check reports cached on second run", async () => {
    const url = `http://localhost:${port}/stable`;
    const mdPath = await writeMd("cached.md", `[Link](${url})\n`);

    await run([mdPath, "--check", "--json"]);
    const { stdout, code } = await run([mdPath, "--check", "--json"]);
    expect(code).toBe(0);

    const parsed = JSON.parse(stdout);
    expect(parsed.diagnostics[0].status).toBe("cached");
  });

  it("--check --json includes lockfile state", async () => {
    const url = `http://localhost:${port}/stable`;
    const mdPath = await writeMd("lockstate.md", `[Link](${url})\n`);

    const { stdout, code } = await run([mdPath, "--check", "--json"]);
    expect(code).toBe(0);

    const parsed = JSON.parse(stdout);
    expect(parsed.lockfile).toBeDefined();
    expect(parsed.lockfile.urls[url]).toBeDefined();
    expect(parsed.lockfile.urls[url].last_known_sha256).toBeTruthy();
    expect(parsed.lockfile.urls[url].etag).toBe('"stable-etag"');
  });

  it("--json condense outputs structured JSON with output field", async () => {
    const url = `http://localhost:${port}/stable`;
    const mdPath = await writeMd("condense.md", `[Link](${url})\n`);

    // First run to populate lockfile
    await run([mdPath, "--json"]);

    // Second run should cache
    const { stdout, code } = await run([mdPath, "--json"]);
    expect(code).toBe(0);

    const parsed = JSON.parse(stdout);
    expect(parsed.mode).toBe("condense");
    expect(parsed.output).toBeDefined();
    expect(parsed.output).toContain("doc-lok:cached");
    expect(parsed.diagnostics).toHaveLength(1);
    expect(parsed.diagnostics[0].status).toBe("cached");
    expect(parsed.lockfile).toBeDefined();
  });

  it("--json restore outputs structured JSON", async () => {
    const url = `http://localhost:${port}/stable`;
    const mdPath = await writeMd("restore.md", `[Link](${url})\n`);

    // Condense first
    await run([mdPath, "--json"]);
    const condensed = await fs.readFile(mdPath, "utf8");

    // The file on disk is not modified by condense — we need to write the
    // condensed output back to a file to test restore.
    const condensedPath = path.join(tmpDir, "condensed.md");
    const condenseResult = await run([mdPath, "--json"]);
    const parsed = JSON.parse(condenseResult.stdout);
    await fs.writeFile(condensedPath, parsed.output, "utf8");

    const { stdout, code } = await run([condensedPath, "--restore", "--json"]);
    expect(code).toBe(0);

    const restoreParsed = JSON.parse(stdout);
    expect(restoreParsed.mode).toBe("restore");
    expect(restoreParsed.restoredCount).toBe(1);
    expect(restoreParsed.output).toContain(`[${url}](${url})`);
    expect(restoreParsed.lockfile).toBeDefined();
  });

  it("--json outputs error object on fatal error", async () => {
    const mdPath = path.join(tmpDir, "nonexistent", "file.md");
    const { stdout, code } = await run([mdPath, "--json"]);
    expect(code).toBe(1);

    const parsed = JSON.parse(stdout);
    expect(parsed.error).toBeDefined();
  });

  it("--check reports errors for unreachable URLs", async () => {
    const goodUrl = `http://localhost:${port}/stable`;
    const badUrl = `http://localhost:${port}/error`;
    const mdPath = await writeMd("mixed.md", `[Good](${goodUrl}) [Bad](${badUrl})\n`);

    const { stdout, code } = await run([mdPath, "--check", "--json"]);
    expect(code).toBe(0);

    const parsed = JSON.parse(stdout);
    const goodDiag = parsed.diagnostics.find((d: any) => d.url === goodUrl);
    const badDiag = parsed.diagnostics.find((d: any) => d.url === badUrl);

    expect(goodDiag.status).toBe("updated");
    expect(badDiag.status).toBe("error");
    expect(badDiag.message).toContain("503");
  });

  it("--check without --json outputs human-readable diagnostics to stderr", async () => {
    const url = `http://localhost:${port}/stable`;
    const mdPath = await writeMd("human.md", `[Link](${url})\n`);

    const { stdout, stderr, code } = await run([mdPath, "--check"]);
    expect(code).toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toContain("doc-lok check");
    expect(stderr).toContain(url);
  });
});
