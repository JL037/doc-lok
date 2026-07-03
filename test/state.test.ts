import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  resolveLockfilePath,
  readLockfile,
  writeLockfile,
  estimateTokens,
  updateEntry,
  COMPRESSED_MARKER_TOKENS,
  CHARS_PER_TOKEN,
  type Lockfile,
} from "../src/state.js";

describe("resolveLockfilePath", () => {
  const originalEnv = process.env.DOC_LOK_LOCKFILE;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.DOC_LOK_LOCKFILE;
    } else {
      process.env.DOC_LOK_LOCKFILE = originalEnv;
    }
  });

  it("returns explicit path when provided", () => {
    const result = resolveLockfilePath("docs/readme.md", "/tmp/custom.json");
    expect(result).toBe(path.resolve("/tmp/custom.json"));
  });

  it("respects DOC_LOK_LOCKFILE env var", () => {
    process.env.DOC_LOK_LOCKFILE = "/env/lock.json";
    const result = resolveLockfilePath("docs/readme.md");
    expect(result).toBe(path.resolve("/env/lock.json"));
  });

  it("falls back to doc-lok.json next to the markdown file", () => {
    delete process.env.DOC_LOK_LOCKFILE;
    const result = resolveLockfilePath("docs/readme.md");
    expect(result).toBe(path.resolve("docs/doc-lok.json"));
  });
});

describe("readLockfile", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "doc-lok-state-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns a default skeleton when the file does not exist", async () => {
    const result = await readLockfile(path.join(tmpDir, "missing.json"));
    expect(result).toEqual({
      version: 1,
      global_tokens_saved: 0,
      urls: {},
    });
  });

  it("reads and parses a valid lockfile", async () => {
    const lockPath = path.join(tmpDir, "doc-lok.json");
    const data: Lockfile = {
      version: 1,
      global_tokens_saved: 42,
      urls: {
        "https://example.com": {
          last_known_sha256: "abc",
          etag: '"etag1"',
          token_cost_raw: 100,
          token_cost_compressed: 15,
          last_checked: "2024-01-01T00:00:00.000Z",
        },
      },
    };
    await fs.writeFile(lockPath, JSON.stringify(data), "utf8");

    const result = await readLockfile(lockPath);
    expect(result).toEqual(data);
  });

  it("normalizes a partially-formed lockfile", async () => {
    const lockPath = path.join(tmpDir, "doc-lok.json");
    await fs.writeFile(lockPath, JSON.stringify({ version: 2 }), "utf8");

    const result = await readLockfile(lockPath);
    expect(result.version).toBe(2);
    expect(result.global_tokens_saved).toBe(0);
    expect(result.urls).toEqual({});
  });

  it("re-throws non-ENOENT errors", async () => {
    // Create a directory at the lockfile path so fs.readFile throws EISDIR
    const lockPath = path.join(tmpDir, "is-a-dir.json");
    await fs.mkdir(lockPath, { recursive: true });
    await expect(readLockfile(lockPath)).rejects.toThrow();
  });
});

describe("writeLockfile", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "doc-lok-state-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("atomically writes a well-formed JSON file", async () => {
    const lockPath = path.join(tmpDir, "doc-lok.json");
    const data: Lockfile = {
      version: 1,
      global_tokens_saved: 10,
      urls: {},
    };

    await writeLockfile(lockPath, data);

    const raw = await fs.readFile(lockPath, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed).toEqual(data);
    expect(raw.endsWith("\n")).toBe(true);
  });

  it("creates intermediate directories", async () => {
    const lockPath = path.join(tmpDir, "deep", "nested", "doc-lok.json");
    const data: Lockfile = {
      version: 1,
      global_tokens_saved: 0,
      urls: {},
    };

    await writeLockfile(lockPath, data);

    const parsed = JSON.parse(await fs.readFile(lockPath, "utf8"));
    expect(parsed).toEqual(data);
  });
});

describe("estimateTokens", () => {
  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("rounds up fractional tokens", () => {
    expect(estimateTokens("a".repeat(CHARS_PER_TOKEN - 1))).toBe(1);
    expect(estimateTokens("a".repeat(CHARS_PER_TOKEN))).toBe(1);
    expect(estimateTokens("a".repeat(CHARS_PER_TOKEN + 1))).toBe(2);
  });

  it("scales linearly with length", () => {
    const text = "a".repeat(CHARS_PER_TOKEN * 10);
    expect(estimateTokens(text)).toBe(10);
  });
});

describe("updateEntry", () => {
  it("adds a new URL entry and computes token savings when unchanged", () => {
    const lockfile: Lockfile = {
      version: 1,
      global_tokens_saved: 0,
      urls: {},
    };

    const { entry, tokensSaved } = updateEntry(
      lockfile,
      "https://example.com",
      "sha256-abc",
      '"etag1"',
      100,
      true, // isUnchanged
    );

    expect(entry.last_known_sha256).toBe("sha256-abc");
    expect(entry.etag).toBe('"etag1"');
    expect(entry.token_cost_raw).toBe(100);
    expect(entry.token_cost_compressed).toBe(COMPRESSED_MARKER_TOKENS);
    expect(entry.last_checked).toMatch(/^\d{4}-/);

    expect(tokensSaved).toBe(100 - COMPRESSED_MARKER_TOKENS);
    expect(lockfile.global_tokens_saved).toBe(100 - COMPRESSED_MARKER_TOKENS);
    expect(lockfile.urls["https://example.com"]).toBe(entry);
  });

  it("returns 0 savings for an already-cached URL", () => {
    const lockfile: Lockfile = {
      version: 1,
      global_tokens_saved: 100, // already counted previously
      urls: {
        "https://example.com": {
          last_known_sha256: "old-sha",
          etag: '"old-etag"',
          token_cost_raw: 200,
          token_cost_compressed: COMPRESSED_MARKER_TOKENS,
          last_checked: "2024-01-01T00:00:00.000Z",
          cached: true,
        },
      },
    };

    const { tokensSaved } = updateEntry(
      lockfile,
      "https://example.com",
      "old-sha", // same SHA = unchanged
      '"old-etag"',
      200,
      true, // isUnchanged
    );

    expect(tokensSaved).toBe(0); // already cached, no new savings
    expect(lockfile.global_tokens_saved).toBe(100); // unchanged
    expect(lockfile.urls["https://example.com"].last_known_sha256).toBe(
      "old-sha",
    );
  });

  it("preserves the highest raw token cost across runs", () => {
    const lockfile: Lockfile = {
      version: 1,
      global_tokens_saved: 0,
      urls: {
        "https://example.com": {
          last_known_sha256: "old-sha",
          etag: '"old-etag"',
          token_cost_raw: 200, // full GET cost
          token_cost_compressed: COMPRESSED_MARKER_TOKENS,
          last_checked: "2024-01-01T00:00:00.000Z",
        },
      },
    };

    // Simulate a HEAD-only hit with tiny cost — should NOT overwrite the 200.
    const { entry } = updateEntry(
      lockfile,
      "https://example.com",
      "old-sha",
      '"old-etag"',
      5, // tiny HEAD estimate
      true,
    );

    expect(entry.token_cost_raw).toBe(200); // preserved, not overwritten
  });

  it("never subtracts from global_tokens_saved on negative savings", () => {
    const lockfile: Lockfile = {
      version: 1,
      global_tokens_saved: 100,
      urls: {},
    };

    const { tokensSaved } = updateEntry(
      lockfile,
      "https://example.com",
      "sha",
      null,
      5, // less than COMPRESSED_MARKER_TOKENS
      true,
    );

    expect(tokensSaved).toBe(0); // negative savings clamped to 0
    expect(lockfile.global_tokens_saved).toBe(100); // unchanged
  });

  it("returns 0 savings for a changed (updated) URL", () => {
    const lockfile: Lockfile = {
      version: 1,
      global_tokens_saved: 0,
      urls: {},
    };

    const { tokensSaved } = updateEntry(
      lockfile,
      "https://example.com",
      "sha",
      null,
      100,
      false, // isUnchanged = false (content changed)
    );

    expect(tokensSaved).toBe(0); // changed URLs are left intact, no savings
    expect(lockfile.global_tokens_saved).toBe(0);
  });
});
