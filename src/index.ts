/**
 * index.ts — Public library entry point.
 *
 * Exports the programmatic API for direct import into TypeScript / Node
 * projects (e.g. Mastra agents).
 */

export { condenseMarkdown, restoreMarkdown, checkMarkdown, inlineMarkdown } from "./parser.js";
export type {
  CondenseResult,
  CheckResult,
  LinkDiagnostic,
  InlineResult,
  InlineOptions,
} from "./parser.js";
export { MARKER, INLINE_MARKER, COMPRESSED_MARKER_TOKENS } from "./parser.js";

export {
  readLockfile,
  writeLockfile,
  resolveLockfilePath,
  estimateTokens,
  updateEntry,
  hashUrl,
} from "./state.js";
export type { Lockfile, UrlEntry } from "./state.js";

export { validateUrl } from "./network.js";
export type { ValidationResult, ValidateOptions } from "./network.js";

export { assertSafeUrl, SsrfBlockedError } from "./ssrf.js";
export type { SsrfOptions } from "./ssrf.js";

export { convertHtmlToMarkdown, detectSections } from "./convert.js";
export type { ConvertResult, ConvertOptions, ConverterMode } from "./convert.js";

export { slugifyHeading, matchSections, resolveSectionName, isSpecialSectionName } from "./sections.js";
export type { Section, SectionMatchResult } from "./sections.js";

export {
  resolveCacheDir,
  bodyPath,
  readBody,
  writeBody,
  removeBody,
  clearCache,
  markdownPath,
  readMarkdown,
  writeMarkdown,
  indexPath,
  readIndex,
  writeIndex,
} from "./cache.js";
