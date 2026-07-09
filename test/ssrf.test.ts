import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createServer, type Server } from "node:http";

import { condenseMarkdown } from "../src/parser.js";
import { assertSafeUrl, SsrfBlockedError } from "../src/ssrf.js";

describe("SSRF guard — assertSafeUrl", () => {
  it("blocks a loopback URL by default", async () => {
    await expect(assertSafeUrl("http://127.0.0.1/secret")).rejects.toThrow(
      /loopback/,
    );
  });

  it("blocks localhost by default (resolves to 127.0.0.1)", async () => {
    await expect(assertSafeUrl("http://localhost/secret")).rejects.toThrow(
      /loopback/,
    );
  });

  it("blocks a link-local URL (AWS metadata endpoint)", async () => {
    await expect(
      assertSafeUrl("http://169.254.169.254/latest/meta-data/"),
    ).rejects.toThrow(/link-local/);
  });

  it("blocks RFC1918 private ranges", async () => {
    await expect(assertSafeUrl("http://10.0.0.1/")).rejects.toThrow(
      /private/,
    );
    await expect(assertSafeUrl("http://172.16.5.5/")).rejects.toThrow(
      /private/,
    );
    await expect(assertSafeUrl("http://192.168.1.1/")).rejects.toThrow(
      /private/,
    );
  });

  it("blocks IPv6 loopback", async () => {
    await expect(assertSafeUrl("http://[::1]/")).rejects.toThrow(/loopback/);
  });

  it("allows public hostnames", async () => {
    // example.com is a public reserved-doc IP (96.7.253.118 / similar)
    // — should never fall in a blocked range. DNS may fail in CI; if so,
    // the test reports the DNS error, not a SSRF block.
    await expect(assertSafeUrl("https://example.com/")).resolves.toBeUndefined();
  });

  it("respects the allowPrivate opt-in", async () => {
    await expect(
      assertSafeUrl("http://127.0.0.1/secret", { allowPrivate: true }),
    ).resolves.toBeUndefined();
  });

  it("blocks URL literal that is already an IP", async () => {
    // No DNS lookup needed — IP-literal hostname should be classified
    // directly, so this test never touches the network.
    await expect(assertSafeUrl("http://169.254.170.234/")).rejects.toThrow(
      /link-local/,
    );
  });

  it("throws SsrfBlockedError with address and range fields", async () => {
    try {
      await assertSafeUrl("http://127.0.0.1/x");
      throw new Error("expected SsrfBlockedError");
    } catch (err) {
      expect(err).toBeInstanceOf(SsrfBlockedError);
      const e = err as SsrfBlockedError;
      expect(e.address).toBe("127.0.0.1");
      expect(e.range).toContain("loopback");
    }
  });
});

describe("SSRF guard — end-to-end with condenseMarkdown", () => {
  let tmpDir: string;
  let server: Server;
  let port: number;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "doc-lok-ssrf-e2e-"));

    server = createServer((req, res) => {
      res.writeHead(200);
      res.end("ok");
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

  it("blocks localhost URLs by default and reports an error diagnostic", async () => {
    const url = `http://localhost:${port}/safe`;
    const mdPath = await writeMd("blocked.md", `[Link](${url})\n`);

    const result = await condenseMarkdown(mdPath);

    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].status).toBe("error");
    expect(result.diagnostics[0].message).toMatch(/ssrf blocked.*loopback/);

    // Link is left intact in the output.
    expect(result.output).toContain(`[Link](${url})`);
  });

  it("allows localhost URLs when allowPrivate is opted in", async () => {
    const url = `http://localhost:${port}/safe`;
    const mdPath = await writeMd("allowed.md", `[Link](${url})\n`);

    const result = await condenseMarkdown(mdPath, undefined, {
      allowPrivate: true,
    });

    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].status).toBe("updated");
    expect(result.diagnostics[0].message).toBeUndefined();
  });

  it("blocks even when DNS resolution is needed for an IP literal", async () => {
    // Use a hostname that resolves to loopback. `localhost` does this
    // already — but here we also test the `127.0.0.1` IP literal form
    // to ensure the no-DNS path is exercised through the full CLI.
    const mdPath = await writeMd("literal.md", "[Link](http://127.0.0.1/)\n");

    const result = await condenseMarkdown(mdPath);

    expect(result.diagnostics[0].status).toBe("error");
    expect(result.diagnostics[0].message).toMatch(/ssrf blocked.*loopback/);
  });
});