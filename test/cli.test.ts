import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createServer, type Server } from "node:http";

const CLI = path.resolve("dist/cli.js");

describe("CLI", () => {
  let tmpDir: string;
  let server: Server;
  let port: number;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "doc-lok-cli-test-"));

    server = createServer((req, res) => {
      const pathname = req.url!;
      if (pathname === "/stable") {
        res.setHeader("etag", '"stable"');
        res.writeHead(200);
        res.end("content");
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

  it("prints help with --help", async () => {
    const { stdout, stderr, code } = await run(["--help"]);
    expect(code).toBe(0);
    expect(stderr).toContain("USAGE");
    expect(stderr).toContain("doc-lok");
  });

  it("prints version with --version", async () => {
    const { stdout, stderr, code } = await run(["--version"]);
    expect(code).toBe(0);
    expect(stdout).toContain("0.1.3");
  });

  it("exits with code 2 when no file given", async () => {
    const { stderr, code } = await run([]);
    expect(code).toBe(2);
    expect(stderr).toContain("no input file");
  });

  it("exits with code 2 on unknown arguments", async () => {
    const { stderr, code } = await run(["--unknown-flag"]);
    expect(code).toBe(2);
    expect(stderr).toContain("Unknown argument");
  });

  it("writes condensed markdown to stdout", async () => {
    const url = `http://localhost:${port}/stable`;
    const mdPath = await writeMd("out.md", `[Link](${url})\n`);

    const { stdout, stderr, code } = await run([mdPath]);
    expect(code).toBe(0);
    expect(stdout).toContain(`[Link](${url})`);
    expect(stderr).toContain("doc-lok");
    expect(stderr).toContain("updated");
  });

  it("suppresses diagnostics with --quiet", async () => {
    const url = `http://localhost:${port}/stable`;
    const mdPath = await writeMd("quiet.md", `[Link](${url})\n`);

    const { stdout, stderr, code } = await run(["--quiet", mdPath]);
    expect(code).toBe(0);
    expect(stdout).toContain(`[Link](${url})`);
    expect(stderr).toBe("");
  });

  it("uses custom lockfile path via --lockfile", async () => {
    const url = `http://localhost:${port}/stable`;
    const mdPath = await writeMd("lock.md", `[Link](${url})\n`);
    const customLock = path.join(tmpDir, "my-lock.json");

    const { stderr, code } = await run(["--lockfile", customLock, mdPath]);
    expect(code).toBe(0);
    expect(stderr).toContain(customLock);

    const exists = await fs.stat(customLock).then(() => true).catch(() => false);
    expect(exists).toBe(true);
  });

  it("exits with code 1 on fatal errors", async () => {
    const mdPath = path.join(tmpDir, "nonexistent", "file.md");
    const { stderr, code } = await run([mdPath]);
    expect(code).toBe(1);
    expect(stderr).toContain("fatal error");
  });
});
