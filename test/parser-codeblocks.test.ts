import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createServer, type Server } from "node:http";

import { condenseMarkdown, MARKER } from "../src/parser.js";

describe("Code block exclusion (BUG — currently fails)", () => {
  let tmpDir: string;
  let server: Server;
  let port: number;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "doc-lok-codeblock-test-"));

    server = createServer((req, res) => {
      if (req.url === "/stable") {
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

  it("should NOT condense links inside inline code", async () => {
    const url = `http://localhost:${port}/stable`;
    const mdPath = await writeMd("inline-code.md", `Run \`[bad](${url})\` in your terminal.\n`);

    const result = await condenseMarkdown(mdPath);

    // After a first run, the link is "updated".
    // After a second run (cache warm), the marker should NOT appear inside backticks.
    const run2 = await condenseMarkdown(mdPath);

    // BUG: currently the regex replaces the link even though it's inside inline code.
    expect(run2.output).not.toContain("`<!-- doc-lok:cached");
    expect(run2.output).toContain(`[bad](${url})`);
  });

  it("should NOT condense links inside fenced code blocks", async () => {
    const url = `http://localhost:${port}/stable`;
    const mdPath = await writeMd(
      "fenced-code.md",
      `\n\`\`\`md
[bad](${url})
\`\`\`\n`,
    );

    const run2 = await condenseMarkdown(mdPath);
    const run3 = await condenseMarkdown(mdPath);

    // BUG: currently replaces links inside fenced code blocks too.
    expect(run3.output).not.toContain("<!-- doc-lok:cached");
    expect(run3.output).toContain(`[bad](${url})`);
  });

  it("should NOT condense links inside indented code blocks", async () => {
    const url = `http://localhost:${port}/stable`;
    const mdPath = await writeMd(
      "indented-code.md",
      `    [bad](${url})\n`,
    );

    const run2 = await condenseMarkdown(mdPath);
    const run3 = await condenseMarkdown(mdPath);

    expect(run3.output).not.toContain("<!-- doc-lok:cached");
    expect(run3.output).toContain(`[bad](${url})`);
  });

  it("should still condense links in normal paragraphs", async () => {
    const url = `http://localhost:${port}/stable`;
    const mdPath = await writeMd("normal.md", `[Good](${url})\n`);

    const run1 = await condenseMarkdown(mdPath);
    const run2 = await condenseMarkdown(mdPath);

    expect(run2.output).toContain(MARKER);
    expect(run2.output).not.toContain(`[Good](${url})`);
  });
});
