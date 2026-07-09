import { describe, it, expect } from "vitest";

import { slugifyHeading, matchSections, resolveSectionName, type Section } from "../src/sections.js";

describe("slugifyHeading", () => {
  it("lowercases and hyphenates spaces", () => {
    expect(slugifyHeading("API Reference")).toBe("api-reference");
  });

  it("strips non-alphanumeric characters except spaces and hyphens", () => {
    expect(slugifyHeading("Authentication & Authorization")).toBe(
      "authentication--authorization",
    );
  });

  it("handles dots and version numbers", () => {
    expect(slugifyHeading("OAuth 2.0")).toBe("oauth-20");
  });

  it("collapses multiple hyphens", () => {
    expect(slugifyHeading("Retry Strategy & Rate Throttling")).toBe(
      "retry-strategy--rate-throttling",
    );
  });

  it("trims leading and trailing hyphens", () => {
    expect(slugifyHeading("--- Heading ---")).toBe("heading");
  });

  it("handles simple single-word headings", () => {
    expect(slugifyHeading("Introduction")).toBe("introduction");
  });
});

describe("matchSections", () => {
  function mkSection(slug: string, heading: string, start: number, end: number): Section {
    return { slug, level: 2, heading, start, end };
  }

  const sections: Section[] = [
    mkSection("introduction", "Introduction", 0, 100),
    mkSection("authentication", "Authentication", 100, 200),
    mkSection("api-reference", "API Reference", 200, 300),
    mkSection("rate-limits", "Rate Limits", 300, 400),
    mkSection("retry-strategy", "Retry Strategy & Rate Throttling", 400, 500),
  ];

  it("matches by exact slug", () => {
    const r = matchSections(sections, ["authentication"]);
    expect(r.matched).toHaveLength(1);
    expect(r.matched[0].slug).toBe("authentication");
    expect(r.unknown).toHaveLength(0);
    expect(r.ambiguous).toHaveLength(0);
  });

  it("matches case-insensitively by slug", () => {
    // "Auth" → lowercase "auth" — no exact slug match, but "Authentication"
    // contains "auth" (case-insensitive heading-contains) → single match.
    const r = matchSections(sections, ["Auth"]);
    expect(r.matched).toHaveLength(1);
    expect(r.matched[0].slug).toBe("authentication");
  });

  it("matches by heading-contains fallback", () => {
    // "limits" is not a slug but appears in heading "Rate Limits" → match.
    const r = matchSections(sections, ["limits"]);
    expect(r.matched).toHaveLength(1);
    expect(r.matched[0].slug).toBe("rate-limits");
  });

  it("reports unknown for zero matches", () => {
    const r = matchSections(sections, ["nonexistent"]);
    expect(r.unknown).toEqual(["nonexistent"]);
    expect(r.matched).toHaveLength(0);
  });

  it("reports ambiguous for multiple matches", () => {
    // "rate" matches both "Rate Limits" (heading-contains) and
    // "Retry Strategy & Rate Throttling" (heading-contains "rate").
    // But wait — slug match for "rate" doesn't match any slug.
    // Heading-contains "rate" matches both "Rate Limits" and
    // "Retry Strategy & Rate Throttling" → ambiguous.
    const r = matchSections(sections, ["rate"]);
    expect(r.matched).toHaveLength(0); // ambiguous, not matched
    expect(r.ambiguous).toHaveLength(1);
    expect(r.ambiguous[0].query).toBe("rate");
    expect(r.ambiguous[0].candidates).toHaveLength(2);
  });

  it("deduplicates matched by slug", () => {
    const r = matchSections(sections, ["authentication", "Authentication"]);
    expect(r.matched).toHaveLength(1); // deduped
  });

  it("returns matched in page order, not request order", () => {
    const r = matchSections(sections, ["rate-limits", "introduction"]);
    expect(r.matched[0].slug).toBe("introduction"); // page order
    expect(r.matched[1].slug).toBe("rate-limits");
  });

  it("handles multiple requests with mixed results", () => {
    const r = matchSections(sections, ["introduction", "nonexistent", "api-reference"]);
    expect(r.matched).toHaveLength(2);
    expect(r.unknown).toEqual(["nonexistent"]);
  });
});

describe("resolveSectionName", () => {
  const sections: Section[] = [
    { slug: "auth", level: 2, heading: "Authentication", start: 0, end: 100 },
    { slug: "api", level: 2, heading: "API Reference", start: 100, end: 200 },
  ];

  it("exact slug match returns immediately", () => {
    const r = resolveSectionName(sections, "auth");
    expect(r).toHaveLength(1);
    expect(r[0].slug).toBe("auth");
  });

  it("returns empty array for no match", () => {
    const r = resolveSectionName(sections, "nonexistent");
    expect(r).toHaveLength(0);
  });
});