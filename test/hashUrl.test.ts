import { describe, it, expect } from "vitest";
import { hashUrl } from "../src/state.js";

describe("hashUrl", () => {
  it("returns a 64-character hex string (full SHA-256)", () => {
    const h = hashUrl("https://example.com");
    expect(h).toMatch(/^[a-f0-9]{64}$/);
    expect(h).toHaveLength(64);
  });

  it("is stable for the same input", () => {
    const h1 = hashUrl("https://example.com");
    const h2 = hashUrl("https://example.com");
    expect(h1).toBe(h2);
  });

  it("is different for different inputs", () => {
    const h1 = hashUrl("https://a.com");
    const h2 = hashUrl("https://b.com");
    expect(h1).not.toBe(h2);
  });

  it("is case-sensitive", () => {
    const h1 = hashUrl("https://Example.com");
    const h2 = hashUrl("https://example.com");
    expect(h1).not.toBe(h2);
  });
});
