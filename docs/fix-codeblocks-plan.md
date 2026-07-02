# Plan: Fix Links Inside Code Blocks

## Problem

`doc-lok` uses a global regex (`INLINE_LINK_RE`) to find `[text](url)` across the entire Markdown file. This means it **also matches links inside:

- Inline code: `` `[link](url)` ``
- Fenced code blocks: ` ``` ` ... ` ``` `
- Indented code blocks: `    [link](url)`

These are false positives — the links are not actual hyperlinks in the rendered document, and condensing them corrupts the Markdown.

## Root Cause

`src/parser.ts` line 34:

```ts
const INLINE_LINK_RE = /\[([^\]]*)\]\((https?:\/\/[^)\s]+)(?:\s+"[^"]*")?\)/g;
```

This regex has **no awareness of Markdown structure**. It scans raw text and treats every `[text](url)` as a link regardless of context.

## Solution: Context-Aware Markdown Scanner

We will replace the naive regex with a **lightweight state machine** that scans the Markdown character-by-character (or line-by-line) and tracks whether the cursor is inside a code block or inline code.

This keeps our **zero-runtime-dependency** guarantee. No external Markdown parser is added.

### Phase 1 — Design the Scanner

Create a new module `src/scanner.ts` with a single public function:

```ts
export function extractInlineLinks(md: string): Array<{ text: string; url: string; start: number; end: number }>
```

The scanner walks through `md` and maintains state:

| State | Trigger | Behaviour |
|-------|---------|-----------|
| `normal` | default | Regex-match `[text](url)` and collect |
| `inlineCode` | `` ` `` (single backtick, not inside a fenced block) | Skip all content until next `` ` `` |
| `fencedCode` | ` ``` ` or ` ~~~ ` at start of line | Skip all content until matching closing fence |
| `indentedCode` | 4+ spaces at start of line | Skip entire line |

Key rules:
- Fenced code blocks must be at the **start of a line** (optional whitespace, then the fence).
- The closing fence must also be at the start of a line.
- Inline code backticks inside fenced blocks do **not** switch state — fenced block wins.
- A link that spans a state boundary (rare/invalid Markdown) is ignored.

### Phase 2 — Implement `extractInlineLinks`

Pseudocode:

```
let state = 'normal'
let fenceChar = null
let fenceLength = 0
let results = []

for each line in md.split('\n'):
  if state === 'normal':
    if line.trimStart().startsWith('```') or '~~~':
      state = 'fencedCode'
      fenceChar = ...
      fenceLength = ...
      continue
    if line starts with 4 spaces:
      continue  // indented code block
    // scan for inline code and links within the line
    for each char in line:
      if char === '`' and not in fenced block:
        toggle inlineCode state
      if not inlineCode:
        try regex match for [text](url) at current position
        if match: record { text, url, start, end }

  else if state === 'fencedCode':
    if line.trimStart().startsWith(fenceChar repeated fenceLength):
      state = 'normal'
```

### Phase 3 — Update `replaceLinks`

Currently `replaceLinks` runs `md.replace(INLINE_LINK_RE, ...)` which is global and blind.

With the scanner, we now have **exact byte positions** (`start`, `end`) for each genuine inline link. Replacement becomes a **positional string splice** from the end to the start:

```ts
function replaceLinks(md: string, results: Map<string, ValidationResult>): string {
  const links = extractInlineLinks(md); // new scanner
  const replacements: Array<{ start: number; end: number; replacement: string }> = [];

  for (const link of links) {
    const r = results.get(link.url);
    if (r?.unchanged) {
      replacements.push({
        start: link.start,
        end: link.end,
        replacement: `${MARKER}#${hashUrl(link.url)} -->`,
      });
    }
  }

  // Apply replacements from end to start so indices don't shift.
  replacements.sort((a, b) => b.start - a.start);
  let output = md;
  for (const rep of replacements) {
    output = output.slice(0, rep.start) + rep.replacement + output.slice(rep.end);
  }
  return output;
}
```

### Phase 4 — Update Tests

1. The 4 new failing tests in `test/parser-codeblocks.test.ts` should now **pass**.
2. Existing tests in `parser.test.ts` and `parser-refs.test.ts` should be unaffected because they use normal paragraphs (no code blocks).

### Phase 5 — Edge Cases to Test

| Case | Expected |
|------|----------|
| Link inside `` `code` `` | Ignored |
| Link inside ` ```js\n...\n``` ` | Ignored |
| Link inside indented block (4 spaces) | Ignored |
| Link immediately after inline code closes | Matched |
| Link inside a fenced block that uses `~~~` | Ignored |
| Nested backticks `` `` ` `` `` | Inline code should still be detected |
| Fenced block with language tag ` ```python ` | Ignored |
| Partial fence (`` ` `` mid-line) | Not a fenced block; treated as inline code |

## Why Not Just Use a Markdown Parser Library?

Adding `remark`, `marked`, or `markdown-it` would:
- Break the **zero-runtime-dependency** design decision.
- Increase install size and attack surface.
- Introduce abstraction leakage (we only care about inline links, not the full AST).

A 50-line state machine covers 99% of real-world Markdown and keeps the package lean.

## Files to Change

| File | Action |
|------|--------|
| `src/scanner.ts` | Create — new context-aware link extractor |
| `src/parser.ts` | Replace `INLINE_LINK_RE` usage with scanner + positional replacement |
| `test/parser-codeblocks.test.ts` | Already created — these tests will flip from failing → passing |

## Effort Estimate

- Scanner implementation: ~40 lines
- `replaceLinks` refactor: ~20 lines
- Testing + edge cases: ~30 minutes
- **Total: <1 hour**
