/**
 * row-sanitizer.ts — the last barrier between transcript rows and the terminal.
 *
 * A row that carries an embedded newline, a carriage return, or a
 * cursor-moving escape sequence desyncs pi-tui's diff renderer from the real
 * screen: the renderer counts one row while the terminal paints another, and
 * every later frame drifts until a full repaint (Ctrl+O) rebuilds it. Child
 * transcripts carry arbitrary third-party tool output, so every row the
 * transcript overlay paints passes through `sanitizeRow` first.
 *
 * Policy: SGR sequences (color) are the only escapes a painted row may carry —
 * they cannot move the cursor. Every other escape sequence is stripped whole,
 * newlines and carriage returns become spaces, and the remaining C0 controls
 * and DEL are dropped. The result is truncated to `width`, ANSI-aware.
 */
import { truncateToWidth } from "@earendil-works/pi-tui";

/** Color-only escape sequences — preserved verbatim. */
const SGR_SEQUENCE = /\x1b\[[0-9;:]*m/g;

/** Any other CSI sequence (cursor movement, erase, mode set) — stripped whole. */
const CSI_SEQUENCE = /\x1b\[[0-9;:?]*[A-Za-z]/g;

/** OSC sequences (window title, shell-integration marks) — stripped whole. */
const OSC_SEQUENCE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** C0 control characters and DEL, in both their literal forms. */
const CONTROLS = /[\x00-\x1f\x7f]/g;

/** Make one row safe to paint at `width`: color survives, nothing else escapes. */
export function sanitizeRow(row: string, width: number): string {
  if (!CONTROLS.test(row)) return truncateToWidth(row, width);
  CONTROLS.lastIndex = 0;

  const segments: string[] = [];
  let last = 0;
  for (const match of row.matchAll(SGR_SEQUENCE)) {
    const start = match.index ?? 0;
    segments.push(cleanText(row.slice(last, start)), match[0]);
    last = start + match[0].length;
  }
  segments.push(cleanText(row.slice(last)));
  return truncateToWidth(segments.join(""), width);
}

/** Text between SGR spans: escape sequences stripped whole, newlines become spaces. */
function cleanText(text: string): string {
  return text
    .replace(OSC_SEQUENCE, "")
    .replace(CSI_SEQUENCE, "")
    .replace(/\r\n|\r|\n/g, " ")
    .replace(CONTROLS, "");
}
