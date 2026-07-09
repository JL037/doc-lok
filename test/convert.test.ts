import { describe, it, expect } from "vitest";

import { convertHtmlToMarkdown, detectSections, type ConvertResult } from "../src/convert.js";

describe("convertHtmlToMarkdown — minimal converter", () => {
  it("converts <h1>–<h6> to ATX headings", async () => {
    const html = "<h1>Title</h1><h2>Section</h2><h3>Sub</h3>";
    const { markdown } = await convertHtmlToMarkdown(html);
    expect(markdown).toContain("# Title");
    expect(markdown).toContain("## Section");
    expect(markdown).toContain("### Sub");
  });

  it("converts <p> to paragraphs", async () => {
    const html = "<p>First paragraph.</p><p>Second paragraph.</p>";
    const { markdown } = await convertHtmlToMarkdown(html);
    expect(markdown).toContain("First paragraph.");
    expect(markdown).toContain("Second paragraph.");
  });

  it("converts <ul><li> to bullet list", async () => {
    const html = "<ul><li>One</li><li>Two</li></ul>";
    const { markdown } = await convertHtmlToMarkdown(html);
    expect(markdown).toContain("- One");
    expect(markdown).toContain("- Two");
  });

  it("converts <strong> and <em> to **bold** and *italic*", async () => {
    const html = "<p>This is <strong>bold</strong> and <em>italic</em>.</p>";
    const { markdown } = await convertHtmlToMarkdown(html);
    expect(markdown).toContain("**bold**");
    expect(markdown).toContain("*italic*");
  });

  it("converts <a href> to [text](url) for http links", async () => {
    const html = '<p>See <a href="https://example.com">the docs</a>.</p>';
    const { markdown } = await convertHtmlToMarkdown(html);
    expect(markdown).toContain("[the docs](https://example.com)");
  });

  it("strips boilerplate tags entirely", async () => {
    const html = '<nav>menu</nav><script>alert(1)</script><p>content</p>';
    const { markdown } = await convertHtmlToMarkdown(html);
    expect(markdown).not.toContain("menu");
    expect(markdown).not.toContain("alert");
    expect(markdown).toContain("content");
  });

  it("passes through text/plain content (no HTML tags) without stripping", async () => {
    const plain = "# Already Markdown\n\nThis is plain text.\n";
    const { markdown } = await convertHtmlToMarkdown(plain);
    expect(markdown).toBe(plain);
  });

  it("detects sections from converted headings", async () => {
    const html = "<h1>Intro</h1><p>body</p><h2>Getting Started</h2><p>content</p>";
    const { sections } = await convertHtmlToMarkdown(html);
    expect(sections).toHaveLength(2);
    expect(sections[0].slug).toBe("intro");
    expect(sections[0].level).toBe(1);
    expect(sections[1].slug).toBe("getting-started");
    expect(sections[1].level).toBe(2);
  });

  it("returns empty sections when no headings", async () => {
    const html = "<p>No headings here.</p>";
    const { sections } = await convertHtmlToMarkdown(html);
    expect(sections).toHaveLength(0);
  });

  it("throws clear error for turndown when not installed", async () => {
    await expect(
      convertHtmlToMarkdown("<p>test</p>", { converter: "turndown" }),
    ).rejects.toThrow(/turndown not installed/);
  });
});

describe("detectSections", () => {
  it("detects headings and computes byte ranges", () => {
    const md = "# Title\n\nintro\n\n## Section A\n\ncontent\n\n## Section B\n\nmore\n";
    const sections = detectSections(md);
    expect(sections).toHaveLength(3);
    expect(sections[0].slug).toBe("title");
    expect(sections[1].slug).toBe("section-a");
    expect(sections[1].end).toBe(sections[2].start); // ends where next H2 begins
    expect(sections[2].end).toBe(md.length); // last section ends at EOF
  });

  it("nested headings end at same-or-higher level only", () => {
    const md = "# A\n## B\n### C\n## D\n";
    const sections = detectSections(md);
    // A is H1, B is H2, C is H3, D is H2
    // A: ends at first heading with level <= 1 → none → EOF
    // B: ends at first heading with level <= 2 → D
    // C: ends at first heading with level <= 3 → D
    // D: ends at EOF
    expect(sections).toHaveLength(4);
    expect(sections[0].slug).toBe("a");
    expect(sections[0].end).toBe(md.length);
    expect(sections[1].slug).toBe("b");
    expect(sections[1].end).toBe(sections[3].start);
    expect(sections[2].slug).toBe("c");
    expect(sections[2].end).toBe(sections[3].start);
    expect(sections[3].slug).toBe("d");
    expect(sections[3].end).toBe(md.length);
  });

  it("returns empty array for no headings", () => {
    expect(detectSections("just text\nno headings\n")).toHaveLength(0);
  });
});