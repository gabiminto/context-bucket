import { Decoration, ViewPlugin, type EditorView, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import { Component, MarkdownRenderer, type App } from "obsidian";
import { activeMarkdownFile } from "./store";
import type { Suggestion } from "../types";

interface SuggestionMatch {
  suggestion: Suggestion;
  from: number;
  to: number;
}

/** Finds each pending suggestion's anchor; only exact, unique, non-empty matches are decorated. */
function findMatches(doc: string, suggestions: Suggestion[]): SuggestionMatch[] {
  const matches: SuggestionMatch[] = [];
  for (const suggestion of suggestions) {
    if (!suggestion.anchor) continue;
    const first = doc.indexOf(suggestion.anchor);
    if (first < 0 || first !== doc.lastIndexOf(suggestion.anchor)) continue;
    matches.push({ suggestion, from: first, to: first + suggestion.anchor.length });
  }
  return matches.sort((a, b) => a.from - b.from);
}

/** Renders the same suggestion card content the sidebar shows, for the hover popup. */
function renderHoverCard(target: HTMLElement, app: App, suggestion: Suggestion, onApply: () => void, onDismiss: () => void): void {
  const card = target.createDiv({ cls: "context-bucket-hover-card" });
  card.createDiv({ text: `${suggestionKindLabel(suggestion.kind)} · ${Math.round(suggestion.confidence * 100)}%`, cls: "context-bucket-review-meta" });
  const explanation = card.createDiv({ cls: "context-bucket-review-explanation" });
  void MarkdownRenderer.render(app, suggestion.explanation, explanation, suggestion.filePath, new Component()).catch(() => explanation.setText(suggestion.explanation));
  if (suggestion.replacement) {
    const change = card.createDiv({ cls: "context-bucket-review-change" });
    if (suggestion.operation === "replace") {
      const before = change.createDiv({ cls: "context-bucket-change-line" });
      before.createSpan({ text: "−", cls: "context-bucket-change-minus" });
      const beforeText = before.createSpan({ cls: "context-bucket-change-before" });
      void MarkdownRenderer.render(app, suggestion.anchor, beforeText, suggestion.filePath, new Component()).catch(() => beforeText.setText(suggestion.anchor));
      const after = change.createDiv({ cls: "context-bucket-change-line" });
      after.createSpan({ text: "+", cls: "context-bucket-change-plus" });
      const afterText = after.createSpan({ cls: "context-bucket-change-after" });
      void MarkdownRenderer.render(app, suggestion.replacement, afterText, suggestion.filePath, new Component()).catch(() => afterText.setText(suggestion.replacement));
    } else {
      const after = change.createDiv({ cls: "context-bucket-change-line" });
      after.createSpan({ text: "+", cls: "context-bucket-change-plus" });
      const afterText = after.createSpan({ cls: "context-bucket-change-after" });
      void MarkdownRenderer.render(app, suggestion.replacement, afterText, suggestion.filePath, new Component()).catch(() => afterText.setText(suggestion.replacement));
    }
  }
  const row = card.createDiv({ cls: "context-bucket-card-actions" });
  const accept = row.createEl("button", { text: "Accept", cls: "mod-cta" });
  accept.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); onApply(); });
  const reject = row.createEl("button", { text: "Dismiss" });
  reject.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); onDismiss(); });
}

function suggestionKindLabel(kind: Suggestion["kind"]): string {
  if (kind === "definition") return "Definition";
  if (kind === "critical") return "Correction";
  if (kind === "clarity") return "Clarity";
  return "Formatting";
}

/**
 * Underlines pending suggestion anchors directly in the note editor so the
 * exact text each review card refers to is visible while writing. Hovering an
 * underlined anchor shows the same information card the sidebar shows.
 * Decorations are purely visual: the note text is never modified and applying
 * a suggestion still re-resolves the anchor against the live document.
 */
export function buildUnderlineExtension(app: App, getSuggestions: (filePath: string) => Suggestion[], actions: { apply: (id: string) => void; reject: (id: string) => void }) {
  const pluginInstances = new Set<UnderlinePlugin>();
  let hoverCard: HTMLElement | null = null;
  let hideTimer: number | null = null;
  let hoverSuggestionId: string | null = null;

  const hideHoverCard = (immediate = false): void => {
    if (immediate) {
      if (hideTimer !== null) { window.clearTimeout(hideTimer); hideTimer = null; }
      if (hoverCard) { hoverCard.remove(); hoverCard = null; }
      hoverSuggestionId = null;
      return;
    }
    if (hideTimer !== null) window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      hideTimer = null;
      if (hoverCard?.matches(":hover")) return;
      if (hoverCard) { hoverCard.remove(); hoverCard = null; }
      hoverSuggestionId = null;
    }, 250);
  };

  const showHoverCard = (anchor: HTMLElement, suggestion: Suggestion): void => {
    if (hoverSuggestionId === suggestion.id && hoverCard) return; // already showing this card
    if (hideTimer !== null) { window.clearTimeout(hideTimer); hideTimer = null; }
    if (hoverCard) { hoverCard.remove(); hoverCard = null; }
    hoverSuggestionId = suggestion.id;
    hoverCard = document.body.createDiv({ cls: "context-bucket-hover" });
    hoverCard.addEventListener("mouseenter", () => { if (hideTimer !== null) { window.clearTimeout(hideTimer); hideTimer = null; } });
    hoverCard.addEventListener("mouseleave", () => hideHoverCard());
    renderHoverCard(hoverCard, app, suggestion, () => { actions.apply(suggestion.id); hideHoverCard(); }, () => { actions.reject(suggestion.id); hideHoverCard(); });
    // treat the whole suggestion (including soft-wrapped lines) as one block:
    // card goes at the bottom-left corner of that block
    const rect = anchor.getBoundingClientRect();
    hoverCard.style.left = `${Math.max(8, rect.left)}px`;
    hoverCard.style.top = `${rect.bottom + 2}px`;
    hoverCard.style.position = "fixed";
    hoverCard.style.zIndex = "100";
    const cardRect = hoverCard.getBoundingClientRect();
    if (cardRect.bottom > window.innerHeight) {
      // no room below: place above the block instead
      hoverCard.style.top = `${Math.max(8, rect.top - cardRect.height - 2)}px`;
    }
    if (cardRect.right > window.innerWidth) hoverCard.style.left = `${Math.max(8, window.innerWidth - cardRect.width - 8)}px`;
  };

  class UnderlinePlugin {
    public decorations: DecorationSet = Decoration.none;
    private doc = "";
    private suggestions: Suggestion[] = [];
    constructor(private readonly view: EditorView) {
      pluginInstances.add(this);
      this.build();
    }
    public destroy(): void {
      pluginInstances.delete(this);
      hideHoverCard(true);
    }
    public update(update: ViewUpdate): void {
      if (update.docChanged) { this.build(); hideHoverCard(true); }
    }
    /** Re-decorates against the current document and suggestion list (called externally). */
    public rebuild(): void { this.build(); }
    private build(): void {
      const file = activeMarkdownFile(app);
      this.suggestions = file ? getSuggestions(file.path) : [];
      const doc = this.view.state.doc.toString();
      this.doc = doc;
      const builder = new RangeSetBuilder<Decoration>();
      for (const match of findMatches(doc, this.suggestions)) {
        builder.add(match.from, match.to, Decoration.mark({
          class: "context-bucket-inline-anchor",
          attributes: { "data-suggestion-id": match.suggestion.id },
        }));
      }
      this.decorations = builder.finish();
    }
  }

  const viewPlugin = ViewPlugin.fromClass(UnderlinePlugin, {
    decorations: (instance) => instance.decorations,
    eventHandlers: {
      mouseover(event: MouseEvent): boolean | void {
        const target = event.target as HTMLElement | null;
        const anchor = target?.closest(".context-bucket-inline-anchor") as HTMLElement | null;
        if (!anchor) return;
        const id = anchor.getAttribute("data-suggestion-id");
        const file = activeMarkdownFile(app);
        const suggestion = (file ? getSuggestions(file.path) : []).find((item) => item.id === id);
        if (suggestion) showHoverCard(anchor, suggestion);
      },
      mouseout(event: MouseEvent): void {
        const target = event.target as HTMLElement | null;
        const anchor = target?.closest(".context-bucket-inline-anchor");
        if (!anchor) return;
        // moving between child spans inside the anchor shouldn't hide the card
        if ((event.relatedTarget as HTMLElement | null)?.closest?.(".context-bucket-inline-anchor") === anchor) return;
        if ((event.relatedTarget as HTMLElement | null)?.closest?.(".context-bucket-hover")) return;
        hideHoverCard();
      },
    },
  });

  /** Called by the plugin when pending suggestions change so underlines refresh without edits. */
  const refresh = (): void => {
    for (const instance of pluginInstances) instance.rebuild();
  };

  return { extension: viewPlugin, refresh };
}
