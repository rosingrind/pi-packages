import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { sanitizeRow } from "#src/ui/row-sanitizer";

/**
 * The drift regression barrier: a row that carries an embedded newline, a
 * carriage return, or a cursor-moving escape sequence desyncs pi-tui's diff
 * renderer from the real screen — the renderer counts one row while the
 * terminal paints another, and every later frame drifts until a full repaint.
 * sanitizeRow must make any single row safe to paint at any width.
 */
describe("sanitizeRow", () => {
  it("returns an empty row unchanged", () => {
    expect(sanitizeRow("", 40)).toBe("");
  });

  it("passes clean text through untouched", () => {
    expect(sanitizeRow("hello world", 40)).toBe("hello world");
  });

  it("replaces embedded newlines with a space", () => {
    expect(sanitizeRow("line one\nline two", 40)).toBe("line one line two");
  });

  it("replaces CRLF and bare carriage returns with a space", () => {
    expect(sanitizeRow("progress\r\nfinal", 40)).toBe("progress final");
    expect(sanitizeRow("10%\r50%\r100%", 40)).toBe("10% 50% 100%");
  });

  it("strips C0 control characters (bell, backspace, tab, NUL)", () => {
    expect(sanitizeRow("bad\x07row\x08here\tok", 40)).toBe("badrowhereok");
    expect(sanitizeRow("\x00hidden", 40)).toBe("hidden");
  });

  it("strips DEL", () => {
    expect(sanitizeRow("ok\x7f!", 40)).toBe("ok!");
  });

  it("preserves SGR color sequences", () => {
    expect(sanitizeRow("\x1b[31mred\x1b[0m plain", 40)).toBe("\x1b[31mred\x1b[0m plain");
  });

  it("strips cursor-moving escape sequences", () => {
    expect(sanitizeRow("up\x1b[2A", 40)).toBe("up");
    expect(sanitizeRow("home\x1b[1;1H", 40)).toBe("home");
    expect(sanitizeRow("clear\x1b[2J", 40)).toBe("clear");
  });

  it("strips a stray ESC that starts no recognized sequence", () => {
    expect(sanitizeRow("stray\x1bbetween", 40)).toBe("straybetween");
  });

  it("strips OSC sequences whole, leaving no payload fragments", () => {
    expect(sanitizeRow("a\x1b]133;B\x07b", 40)).toBe("ab");
    expect(sanitizeRow("a\x1b]0;title\x1b\\b", 40)).toBe("ab");
  });

  it("truncates to the given width", () => {
    const row = sanitizeRow("abcdefghij", 4);
    expect(visibleWidth(row)).toBeLessThanOrEqual(4);
    expect(row.startsWith("a")).toBe(true);
  });

  it("does not count SGR sequences toward visible width when truncating", () => {
    const row = sanitizeRow("\x1b[31mabcdef\x1b[0m", 5);
    expect(visibleWidth(row)).toBeLessThanOrEqual(5);
    expect(row).toContain("\x1b[31m");
  });

  it("is idempotent", () => {
    const once = sanitizeRow("messy\rtext\n\x1b[31mcolored\x1b[0m\x07", 20);
    expect(sanitizeRow(once, 20)).toBe(once);
  });
});
