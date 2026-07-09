import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const CLI = path.resolve("dist/cli.js");

describe("CLI --restore", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "doc-lok-cli-restore-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
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

  it("restores markers when --restore is passed", async () => {
    const lockPath = path.join(tmpDir, ".doc-lok", "lock.json");
    const lock = {
      version: 1,
      global_tokens_saved: 0,
      urls: {
        "https://example.com": {
          last_known_sha256: "abc",
          etag: null,
          token_cost_raw: 10,
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
      `# Hello\n\nVisit <!-- doc-lok:cached#${hash} -->\n`,
    );

    const { stdout, stderr, code } = await run([
      "--restore",
      "--lockfile",
      lockPath,
      mdPath,
    ]);

    expect(code).toBe(0);
    expect(stdout).toContain("[https://example.com](https://example.com)");
    expect(stderr).toContain("Restored 1 link(s)");
  });

  it("suppresses restore diagnostics with --quiet", async () => {
    const lockPath = path.join(tmpDir, ".doc-lok", "lock.json");
    const lock = {
      version: 1,
      global_tokens_saved: 0,
      urls: {},
    };
    await fs.mkdir(path.dirname(lockPath), { recursive: true }); await fs.writeFile(lockPath, JSON.stringify(lock), "utf8");

    const mdPath = await writeMd("empty.md", "# Hello\n");

    const { stdout, stderr, code } = await run([
      "--restore",
      "--quiet",
      "--lockfile",
      lockPath,
      mdPath,
    ]);

    expect(code).toBe(0);
    expect(stderr).toBe("");
  });

  it("prints updated help text", async () => {
    const { stderr, code } = await run(["--help"]);
    expect(code).toBe(0);
    expect(stderr).toContain("--restore");
    expect(stderr).toContain("Inflate");
  });
});
