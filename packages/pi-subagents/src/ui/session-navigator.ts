/**
 * session-navigator.ts — The `/subagents:sessions` command: pick a subagent and
 * read its transcript through Pi's own per-entry session components.
 *
 * SDK/TUI consumer half of native session navigation. The unit-testable core
 * (selection, sourcing) lives in `session-navigation.ts`; this module wires that
 * core to the command picker and a read-only scrollable overlay, and owns the
 * renderer — it mounts Pi's interactive components (`AssistantMessageComponent`,
 * `ToolExecutionComponent`, …) into a `Container`, mirroring Pi's own
 * `renderSessionContext` mapping. Rendering lives here, not in the pure module,
 * because the components require a `TUI`, `cwd`, and markdown theme.
 *
 * The overlay is strictly read-only — steering stays in the `steer_subagent` tool
 * and the widget. It consumes a `TranscriptSource`, so a released agent's disk
 * snapshot (`fileSnapshotSource`) swaps in without touching the renderer or the overlay.
 */

import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type MarkdownTheme,
  matchesKey,
  type TUI,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { AgentConfigLookup } from "#src/config/agent-types";
import type { Theme } from "#src/ui/display";
import { sanitizeRow } from "#src/ui/row-sanitizer";
import { fileSnapshotSource, listNavigableAgents, liveSource, type NavigableSubagent, type TranscriptSource } from "#src/ui/session-navigation";
import { TranscriptContent } from "#src/ui/transcript-content";

// ─────────────────────────────────────────────────────────────────────────────

/** Chrome lines: top border + header + header sep + footer sep + footer + bottom border. */
const CHROME_LINES = 6;
/** Floor for the transcript viewport so tiny terminals still show content. */
const MIN_VIEWPORT = 3;
/**
 * Overlay margins clearing pi's own chrome: the header above, and the status
 * line, editor, widget trays, and footer below. Deliberately small (2-3
 * cells) so the overlay fills the chat area; foreign trays that grow beyond
 * the bottom budget can still overlap cosmetically — a documented residual.
 */
const OVERLAY_MARGIN = { top: 2, right: 3, bottom: 6, left: 3 } as const;

/** Component factory shape Pi's `ui.custom` invokes to mount an overlay. */
export type OverlayComponentFactory<R> = (
  tui: TUI,
  theme: Theme,
  keybindings: unknown,
  done: (result: R) => void,
) => Component;

/** Narrow UI interface — only the `ctx.ui` methods the navigator calls. */
export interface SessionNavigatorUI {
  select(title: string, options: string[]): Promise<string | undefined>;
  notify(message: string, level: "info" | "warning" | "error"): void;
  custom<R>(component: OverlayComponentFactory<R>, options?: unknown): Promise<R>;
}

/** Parameters for one `/subagents:sessions` invocation. */
export interface SessionNavigatorParams {
  ui: SessionNavigatorUI;
  agents: readonly NavigableSubagent[];
  registry: AgentConfigLookup;
  /** Working directory for tool-call rendering (relative path display). */
  cwd: string;
  /** Reads a persisted session file for the file-snapshot source. */
  readFile: (path: string) => string;
  /**
   * Temporarily unregister the agent widget while the overlay is open (its
   * height grows exactly when agents run — exactly when the overlay shows).
   * Returns the restore function; invoked even when the overlay throws.
   */
  suspendAgentWidget?: () => () => void;
}

/** Options for the read-only transcript overlay. */
export interface TranscriptOverlayOptions {
  tui: TUI;
  theme: Theme;
  source: TranscriptSource;
  done: (result: undefined) => void;
  cwd: string;
  markdownTheme: MarkdownTheme;
  /** Live status suffix for the footer — model, context, compactions. */
  headerStats?: () => string | undefined;
  /** Initial tool-output presentation; pi's chat default is collapsed. */
  toolOutputExpanded?: boolean;
  /** Hide assistant thinking blocks, mirroring pi's chat setting. */
  hideThinkingBlock?: boolean;
}

/**
 * Handler for the `/subagents:sessions` slash command.
 *
 * Lists navigable subagents, lets the operator pick one, and opens its transcript
 * read-only. Receives the agent snapshot (`manager.listAgents()`) rather than the
 * manager, so it stays a reactive consumer with no inbound call into the core.
 */
export class SessionNavigatorHandler {
  async handle({ ui, agents, registry, cwd, readFile, suspendAgentWidget }: SessionNavigatorParams): Promise<void> {
    const entries = listNavigableAgents(agents, registry);
    if (entries.length === 0) {
      ui.notify("No subagent sessions to view.", "info");
      return;
    }

    const restoreWidget = suspendAgentWidget?.();
    try {
      const choice = await ui.select(
        "Subagent sessions",
        entries.map((entry) => entry.label),
      );
      const entry = entries.find((candidate) => candidate.label === choice);
      if (!entry) return;

      let source: TranscriptSource;

      try {
        source = entry.kind === "live" ? liveSource(entry.record) : fileSnapshotSource(entry.outputFile, readFile);
      } catch {
        ui.notify("Could not read the session transcript file.", "error");
        return;
      }
      const markdownTheme = getMarkdownTheme();
      // Snapshot entries carry no live record, so their entries expose no stats.
      await ui.custom<undefined>(
        (tui, theme, _keybindings, done) =>
          new TranscriptOverlay({
            tui,
            theme,
            source,
            done,
            cwd,
            markdownTheme,
            headerStats: entry.kind === "live" ? entry.stats : undefined,
          }),
        {
          overlay: true,
          overlayOptions: {
            anchor: "top-left",
            width: "100%",
            maxHeight: "100%",
            margin: { ...OVERLAY_MARGIN },
          },
        },
      );
    } finally {
      restoreWidget?.();
    }
  }
}

/**
 * Read-only scrollable transcript overlay.
 *
 * Owns scroll state, chrome, and key handling; the rows it paints come from a
 * `TranscriptContent` collaborator, which holds the transcript's components and
 * refreshes them when the source changes (live agents).
 */
export class TranscriptOverlay implements Component {
  private scrollOffset = 0;
  private autoScroll = true;
  private unsubscribe: (() => void) | undefined;
  private closed = false;

  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly done: (result: undefined) => void;
  private readonly content: TranscriptContent;
  /** Live status suffix for the footer — model, context, compactions. */
  private readonly headerStats: (() => string | undefined) | undefined;
  /** Current tool-output presentation, toggled with Ctrl+O like pi's chat. */
  private toolOutputExpanded: boolean;
  /** Inner width the compositor last rendered at; input must use the same layout. */
  private renderedInnerWidth: number | undefined;

  constructor({
    tui,
    theme,
    source,
    done,
    cwd,
    markdownTheme,
    headerStats,
    toolOutputExpanded,
    hideThinkingBlock,
  }: TranscriptOverlayOptions) {
    this.tui = tui;
    this.theme = theme;
    this.done = done;
    this.headerStats = headerStats;
    this.toolOutputExpanded = toolOutputExpanded ?? false;
    this.content = new TranscriptContent({
      tui,
      cwd,
      markdownTheme,
      source,
      toolOutputExpanded: this.toolOutputExpanded,
      hideThinkingBlock: hideThinkingBlock ?? false,
    });
    this.unsubscribe = source.subscribe((event) => {
      if (this.closed) return;
      this.content.apply(event);
      this.tui.requestRender();
    });
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "q")) {
      this.closed = true;
      this.done(undefined);
      return;
    }

    if (matchesKey(data, "ctrl+o")) {
      this.toolOutputExpanded = !this.toolOutputExpanded;
      this.content.setToolOutputExpanded(this.toolOutputExpanded);
      this.tui.requestRender();
      return;
    }

    const totalLines = this.content.lineCount(this.inputWidth());
    const viewportHeight = this.viewportHeight();
    const maxScroll = Math.max(0, totalLines - viewportHeight);

    if (matchesKey(data, "up") || matchesKey(data, "k")) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (matchesKey(data, "down") || matchesKey(data, "j")) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (matchesKey(data, "pageUp") || matchesKey(data, "shift+up")) {
      this.scrollOffset = Math.max(0, this.scrollOffset - viewportHeight);
      this.autoScroll = false;
    } else if (matchesKey(data, "pageDown") || matchesKey(data, "shift+down")) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + viewportHeight);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (matchesKey(data, "home")) {
      this.scrollOffset = 0;
      this.autoScroll = false;
    } else if (matchesKey(data, "end")) {
      this.scrollOffset = maxScroll;
      this.autoScroll = true;
    }
  }

  render(width: number): string[] {
    if (width < 6) return [];
    const th = this.theme;
    const innerW = width - 4;
    this.renderedInnerWidth = innerW;
    const lines: string[] = [];

    const pad = (s: string, len: number): string => s + " ".repeat(Math.max(0, len - visibleWidth(s)));
    const row = (content: string): string =>
      th.fg("border", "│") + " " + sanitizeRow(pad(content, innerW), innerW) + " " + th.fg("border", "│");
    const hrTop = th.fg("border", `╭${"─".repeat(width - 2)}╮`);
    const hrBot = th.fg("border", `╰${"─".repeat(width - 2)}╯`);
    const hrMid = row(th.fg("dim", "─".repeat(innerW)));

    lines.push(hrTop);

    const totalLines = this.content.lineCount(innerW);
    const viewportHeight = this.viewportHeight();
    const maxScroll = Math.max(0, totalLines - viewportHeight);
    if (this.autoScroll) this.scrollOffset = maxScroll;
    const visibleStart = Math.min(this.scrollOffset, maxScroll);
    const visible = this.content.slice(innerW, visibleStart, viewportHeight);
    for (let i = 0; i < viewportHeight; i++) lines.push(row(visible[i] ?? ""));

    lines.push(hrMid);
    const scrollPct =
      totalLines <= viewportHeight
        ? "100%"
        : `${Math.round(((visibleStart + viewportHeight) / totalLines) * 100)}%`;
    const stats = this.headerStats?.();
    const footerLeft = th.fg("dim", `${totalLines} lines · ${scrollPct}` + (stats ? ` · ${stats}` : ""));
    const footerRight = th.fg("dim", "↑↓ scroll · PgUp/PgDn · Esc close");
    const footerGap = Math.max(1, innerW - visibleWidth(footerLeft) - visibleWidth(footerRight));
    lines.push(row(footerLeft + " ".repeat(footerGap) + footerRight));
    lines.push(hrBot);

    return lines;
  }

  // fallow-ignore-next-line unused-class-member
  invalidate(): void {
    this.content.invalidate();
  }

  dispose(): void {
    this.closed = true;
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
  }

  // ---- Private ----

  /**
   * The width `handleInput` must lay out at: the one the compositor actually
   * supplied, so scroll bounds match the layout on screen. Before the first
   * paint there is none, so fall back to the terminal minus the overlay's
   * side margins.
   */
  private inputWidth(): number {
    return (
      this.renderedInnerWidth ??
      Math.max(0, this.tui.terminal.columns - OVERLAY_MARGIN.left - OVERLAY_MARGIN.right - 4)
    );
  }

  private viewportHeight(): number {
    // Fill the compositor's available height exactly: terminal rows minus the
    // overlay's top/bottom margins and our own chrome.
    const available = this.tui.terminal.rows - OVERLAY_MARGIN.top - OVERLAY_MARGIN.bottom - CHROME_LINES;
    return Math.max(MIN_VIEWPORT, available);
  }
}
