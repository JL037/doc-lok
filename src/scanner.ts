/**
 * scanner.ts — Context-aware Markdown link extractor.
 *
 * Walks through Markdown line-by-line, tracking state (normal, inlineCode,
 * fencedCode, indentedCode) and only extracts `[text](url)` inline links
 * when in normal text.
 *
 * This replaces the naive global regex that matched links inside code blocks.
 */

/** A discovered inline link with exact byte positions for replacement. */
export interface InlineLink {
  text: string;
  url: string;
  start: number;
  end: number;
}

/** Extract all genuine inline `[text](url)` links that are NOT inside code. */
export function extractInlineLinks(md: string): InlineLink[] {
  const results: InlineLink[] = [];
  let state: "normal" | "inlineCode" | "fencedCode" | "indentedCode" = "normal";
  let fenceChar = "";
  let fenceLength = 0;
  let pos = 0;

  const lines = md.split("\n");

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    const lineStartPos = pos;

    if (state === "fencedCode") {
      // Check for closing fence: optional whitespace, then the same fence char
      // repeated at least fenceLength times, then only whitespace.
      const trimmed = line.trimStart();
      const nonSpace = trimmed.replace(/\s/g, "");
      if (
        nonSpace.length >= fenceLength &&
        nonSpace.split("").every((c) => c === fenceChar)
      ) {
        state = "normal";
      }
      pos += line.length + 1; // +1 for newline
      continue;
    }

    if (state === "indentedCode") {
      // Indented code block continues until a non-blank, non-indented line
      if (line.length > 0 && !line.startsWith("    ") && !line.match(/^\s*$/)) {
        state = "normal";
        // Fall through to process this line in normal state
      } else {
        pos += line.length + 1;
        continue;
      }
    }

    if (state === "normal") {
      // Check for fenced code block opening
      const trimmed = line.trimStart();
      if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
        const match = trimmed.match(/^(```+|~~~+)/);
        if (match) {
          state = "fencedCode";
          fenceChar = match[1][0]; // ` or ~
          fenceLength = match[1].length;
          pos += line.length + 1;
          continue;
        }
      }

      // Check for indented code block (4+ spaces at start, not blank)
      if (line.startsWith("    ") && !line.match(/^\s*$/)) {
        state = "indentedCode";
        pos += line.length + 1;
        continue;
      }

      // Scan this line for inline links, respecting inline code backticks
      const lineLinks = scanLineForLinks(line, lineStartPos);
      results.push(...lineLinks);
    }

    pos += line.length + 1;
  }

  return results;
}

/** Scan a single line for inline links, toggling inlineCode state. */
function scanLineForLinks(line: string, lineStartPos: number): InlineLink[] {
  const links: InlineLink[] = [];
  let inInlineCode = false;
  let i = 0;

  while (i < line.length) {
    const char = line[i];

    if (char === "`") {
      // Count consecutive backticks
      let backtickCount = 1;
      while (i + backtickCount < line.length && line[i + backtickCount] === "`") {
        backtickCount++;
      }

      if (backtickCount === 1) {
        // Single backtick toggles inline code
        inInlineCode = !inInlineCode;
        i++;
      } else {
        // Multiple backticks — this could be opening/closing an inline code span
        // For simplicity: if we're not in inline code, enter it. If we are, try to exit.
        if (!inInlineCode) {
          inInlineCode = true;
        } else {
          // Look for matching closing backticks of same count
          inInlineCode = false; // Assume closed
        }
        i += backtickCount;
      }
      continue;
    }

    if (!inInlineCode && char === "[") {
      // Try to match an inline link starting at position i
      const link = tryMatchLink(line, i, lineStartPos);
      if (link) {
        links.push(link);
        i = link.end - lineStartPos;
        continue;
      }
    }

    i++;
  }

  return links;
}

const LINK_REGEX = /^\[([^\]]*)\]\((https?:\/\/[^)\s]+)(?:\s+"[^"]*")?\)/;

/** Attempt to match `[text](url)` starting at position `start` in `line`. */
function tryMatchLink(
  line: string,
  start: number,
  lineStartPos: number,
): InlineLink | null {
  const slice = line.slice(start);
  const match = slice.match(LINK_REGEX);
  if (!match) return null;

  const fullLen = match[0].length;
  return {
    text: match[1],
    url: match[2],
    start: lineStartPos + start,
    end: lineStartPos + start + fullLen,
  };
}

/** Extract reference-style definitions `[ref]: url`. */
export function extractRefDefs(md: string): Array<{ label: string; url: string }> {
  const results: Array<{ label: string; url: string }> = [];
  const REF_DEF_RE =
    /^\[([^\]]+)\]:\s*<?(https?:\/\/[^>\s]+)>?(?:\s+"[^"]*"|\s+'[^']*'|\s*\([^)]*\))?(?=\s*$)/gm;

  let m: RegExpExecArray | null;
  while ((m = REF_DEF_RE.exec(md)) !== null) {
    results.push({ label: m[1], url: m[2] });
  }

  return results;
}
