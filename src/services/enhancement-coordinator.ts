import type { MarkdownView, App, Editor, MarkdownFileInfo } from "obsidian";
import { looksComplete, paragraphCandidateAt } from "../domain/paragraphs";
import { resolveSuggestion } from "../domain/suggestions";
import { LayaClient } from "../integrations/laya-client";
import type { EnhancementScope, Suggestion } from "../types";
import { ContextRetrieval } from "./context-retrieval";
import { appendEditLog } from "./edit-log";
import { OllamaClient } from "./ollama-client";
import { activeMarkdownFile, activeMarkdownView, type ContextStore } from "./store";

export type EnhancementPhase = "idle" | "waiting" | "retrieving" | "reviewing";
export interface EnhancementState {
  filePath: string;
  phase: EnhancementPhase;
  detail: string;
}
type Listener = (state: EnhancementState) => void;

/** Debounces editor activity, retrieves bucket evidence, and creates review-only edits. */
export class EnhancementCoordinator {
  private readonly retrieval: ContextRetrieval;
  private readonly timers = new Map<string, number>();
  private readonly requests = new Map<string, symbol>();
  private readonly listeners = new Set<Listener>();
  private readonly lastRevisionAt = new Map<string, number>();
  private state: EnhancementState = { filePath: "", phase: "idle", detail: "Waiting for a completed thought" };

  public constructor(private readonly app: App, private readonly store: ContextStore) {
    this.retrieval = new ContextRetrieval(app);
  }

  public onState(listener: Listener): () => void {
    this.listeners.add(listener);
    listener({ ...this.state });
    return () => this.listeners.delete(listener);
  }

  public onEditorChange(editor: Editor, info: MarkdownView | MarkdownFileInfo): void {
    const view = activeMarkdownView(this.app);
    if (!view || !info.file || view.file?.path !== info.file.path || view.editor !== editor || (info.editor && view.editor !== info.editor) || !this.store.settings.liveEnhancement) return;
    const filePath = info.file.path;
    const now = Date.now();
    if (now - (this.lastRevisionAt.get(filePath) ?? 0) > 1_000) {
      this.lastRevisionAt.set(filePath, now);
      this.store.markDocumentChanged(filePath);
    }
    this.cancel(filePath);
    const bucketId = this.store.getAssignment(filePath);
    const bucket = bucketId ? this.store.getBucket(bucketId) : undefined;
    if (!bucket) {
      this.setState({ filePath, phase: "idle", detail: "Attach a context bucket to this note" });
      return;
    }
    if (!bucket.sources.length) {
      this.setState({ filePath, phase: "idle", detail: "Add a bucket source to begin reviewing" });
      return;
    }
    this.setState({ filePath, phase: "waiting", detail: `Waiting ${Math.round(this.store.settings.paragraphPauseMs / 100) / 10}s after you stop typing` });
    const timer = window.setTimeout(() => {
      this.timers.delete(filePath);
      void this.analyze(view, "paragraph");
    }, this.store.settings.paragraphPauseMs);
    this.timers.set(filePath, timer);
  }

  public async reviewCurrent(scope: EnhancementScope): Promise<void> {
    const view = activeMarkdownView(this.app);
    if (!view) throw new Error("Open a Markdown note first.");
    this.cancel(view.file?.path ?? "");
    await this.analyze(view, scope, true);
  }

  private async analyze(view: MarkdownView, scope: EnhancementScope, force = false): Promise<void> {
    const filePath = view.file?.path;
    const editor = view.editor;
    const bucketId = filePath ? this.store.getAssignment(filePath) : undefined;
    if (!filePath || !editor || !bucketId) return;
    const bucket = this.store.getBucket(bucketId);
    if (!bucket || bucket.sources.length === 0) return;
    const analysis = this.store.getAnalysis(filePath);
    const document = editor.getValue();
    const paragraph = scope === "paragraph" ? paragraphCandidateAt(editor) : null;
    const target = paragraph?.text ?? document;
    if (!target.trim() || document.length > 100_000) return;
    if (paragraph && analysis.completedFingerprints.includes(paragraph.fingerprint)) return;
    if (scope === "paragraph" && !(await this.isComplete(paragraph?.text ?? "", document))) return;
    if (scope === "document" && !force && analysis.lastFullReviewRevision === analysis.documentRevision && Date.now() - analysis.lastFullReviewAt < 60_000) return;

    const token = Symbol(filePath);
    this.requests.set(filePath, token);
    try {
      this.setState({ filePath, phase: "retrieving", detail: `Finding relevant evidence in ${bucket.name}` });
      const context = await this.retrieval.retrieve(bucket, target, this.store.settings.contextCharacterBudget);
      if (this.requests.get(filePath) !== token || view.file?.path !== filePath) return;
      this.setState({ filePath, phase: "reviewing", detail: "Checking corrections and omissions" });
      const client = new OllamaClient(this.store.settings.enhancementBaseUrl, this.store.settings.enhancementModel, this.store.settings.requestTimeoutMs);
      const result = await client.enhance({ scope, target, retrievedContext: context, documentExcerpt: styleSampleOf(document, target) });
      if (this.requests.get(filePath) !== token || view.file?.path !== filePath) return;
      const current = view.editor.getValue();
      if (scope === "paragraph" && (!paragraph || !occursOnce(current, paragraph.text))) {
        this.setState({ filePath, phase: "idle", detail: "Paragraph changed while the review was running" });
        return;
      }
      const safeSuggestions = result.suggestions.flatMap((item): Suggestion[] => occursOnce(current, item.target) ? [{
        id: crypto.randomUUID(), bucketId, filePath, scope, operation: item.operation, kind: item.kind,
        anchor: item.target, replacement: item.replacement, explanation: item.explanation,
        sourceIds: item.sourceIds, confidence: item.confidence, createdAt: Date.now(), status: "pending",
        paragraphFingerprint: paragraph?.fingerprint,
      }] : []);
      const suggestions = await this.filterByStyle(document, safeSuggestions);
      this.store.addSuggestions(suggestions);
      if (paragraph) this.store.updateAnalysis(filePath, { completedFingerprints: [...analysis.completedFingerprints, paragraph.fingerprint].slice(-500) });
      if (scope === "document") this.store.updateAnalysis(filePath, { lastFullReviewRevision: analysis.documentRevision, lastFullReviewAt: Date.now() });
      this.setState({ filePath, phase: "idle", detail: suggestions.length ? `${suggestions.length} review item${suggestions.length === 1 ? "" : "s"} ready` : "No changes needed" });
    } catch (error) {
      if (this.requests.get(filePath) === token) this.setState({ filePath, phase: "idle", detail: errorMessage(error) });
    } finally {
      if (this.requests.get(filePath) === token) this.requests.delete(filePath);
    }
  }



  public apply(suggestionId: string): boolean {
    const view = activeMarkdownView(this.app);
    const filePath = view?.file?.path;
    const suggestion = this.store.suggestions.find((item) => item.id === suggestionId);
    if (!view || !filePath || !suggestion || suggestion.filePath !== filePath) return false;
    const document = view.editor.getValue();
    const anchor = resolveSuggestion(document, suggestion);
    if (anchor.staleReason) {
      this.store.updateSuggestion(suggestionId, { status: "stale" });
      this.setState({ filePath, phase: "idle", detail: anchor.staleReason });
      return false;
    }
    view.editor.replaceRange(suggestion.replacement, view.editor.offsetToPos(anchor.from), view.editor.offsetToPos(anchor.to), "context-bucket-review");
    this.store.updateSuggestion(suggestionId, { status: "accepted" });
    void appendEditLog(this.app, this.store.settings.storageFolder, suggestion, "accepted");
    this.store.markDocumentChanged(filePath);
    this.setState({ filePath, phase: "idle", detail: "Suggestion applied" });
    return true;
  }


  public reject(suggestionId: string): void {
    const suggestion = this.store.suggestions.find((item) => item.id === suggestionId);
    if (!suggestion) return;
    this.store.updateSuggestion(suggestionId, { status: "rejected" });
    void appendEditLog(this.app, this.store.settings.storageFolder, suggestion, "rejected");
    const filePath = activeMarkdownFile(this.app)?.path;
    if (filePath === suggestion.filePath) this.setState({ filePath, phase: "idle", detail: "Suggestion dismissed" });
  }

  public applyAll(): number {
    const view = activeMarkdownView(this.app);
    const filePath = view?.file?.path;
    if (!view || !filePath) return 0;
    let applied = 0;
    for (const suggestion of [...this.store.getPendingSuggestions(filePath)].sort((a, b) => a.createdAt - b.createdAt)) {
      if (this.apply(suggestion.id)) applied += 1;
    }
    this.setState({ filePath, phase: "idle", detail: applied ? `${applied} suggestion${applied === 1 ? "" : "s"} applied` : "No suggestions were safe to apply" });
    return applied;
  }

  public markStale(filePath: string): void {
    const view = activeMarkdownView(this.app);
    if (!view || view.file?.path !== filePath) return;
    const document = view.editor.getValue();
    for (const suggestion of this.store.getPendingSuggestions(filePath)) {
      const anchor = resolveSuggestion(document, suggestion);
      if (anchor.staleReason) this.store.updateSuggestion(suggestion.id, { status: "stale" });
    }
  }

  public cancel(filePath: string): void {
    const timer = this.timers.get(filePath);
    if (timer !== undefined) window.clearTimeout(timer);
    this.timers.delete(filePath);
    this.requests.set(filePath, Symbol("cancelled"));
  }

  public dispose(): void {
    for (const timer of this.timers.values()) window.clearTimeout(timer);
    this.timers.clear();
    this.requests.clear();
    this.listeners.clear();
  }

  private async isComplete(text: string, document: string): Promise<boolean> {
    if (this.store.settings.completionMode === "heuristic") return looksComplete(text);
    const client = new LayaClient(this.store.settings.layaBaseUrl, this.store.settings.completionThreshold, Math.min(10_000, this.store.settings.requestTimeoutMs));
    return (await client.isComplete(text, document)).complete;
  }

  /**
   * Optional style gate: when Laya is enabled, suggestions whose replacement
   * wording visibly departs from the author's voice are dropped before they are
   * ever shown. Failures open the gate (suggestions pass through unchanged).
   */
  private async filterByStyle(document: string, suggestions: Suggestion[]): Promise<Suggestion[]> {
    const replacements = suggestions.filter((item) => item.operation === "replace" && item.anchor && item.replacement);
    if (this.store.settings.completionMode === "heuristic" || replacements.length === 0) return suggestions;
    try {
      const client = new LayaClient(this.store.settings.layaBaseUrl, this.store.settings.completionThreshold, Math.min(10_000, this.store.settings.requestTimeoutMs));
      const verdicts = await client.matchesStyle(document, replacements.map((item) => ({ target: item.anchor, replacement: item.replacement })));
      const allowed = new Set(replacements.filter((_, index) => verdicts.get(index) !== false).map((item) => item.id));
      return suggestions.filter((item) => allowed.has(item.id));
    } catch {
      return suggestions;
    }
  }

  private setState(update: EnhancementState): void {
    this.state = { ...update };
    for (const listener of this.listeners) listener({ ...this.state });
  }
}

function occursOnce(text: string, anchor: string): boolean {
  const first = text.indexOf(anchor);
  return first >= 0 && text.indexOf(anchor, first + anchor.length) < 0;
}

/** Surrounding note text (excluding the review target) as a sample of the author's voice. */
function styleSampleOf(document: string, target: string): string {
  const index = document.indexOf(target);
  if (index < 0) return document.slice(0, 2_500);
  const before = document.slice(Math.max(0, index - 1_500), index);
  const after = document.slice(index + target.length, index + target.length + 1_500);
  return [before, after].join("\n\n[…]\n\n").slice(0, 3_000);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The note review could not be completed.";
}
