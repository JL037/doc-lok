/**
 * index.ts — Public library entry point.
 *
 * Exports the programmatic API for direct import into TypeScript / Node
 * projects (e.g. Mastra agents).
 */

export { condenseMarkdown, restoreMarkdown, checkMarkdown } from "./parser.js";
export type { CondenseResult, CheckResult, LinkDiagnostic } from "./parser.js";
export { MARKER, COMPRESSED_MARKER_TOKENS } from "./parser.js";

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
