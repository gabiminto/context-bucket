import { Component, ItemView, MarkdownRenderer, MarkdownView, Notice, type App, type TFile, type WorkspaceLeaf } from "obsidian";
import type ContextBucketPlugin from "../main";
import { BucketModal } from "./bucket-modal";
import { ingestFile } from "../services/source-ingestion";
import { activeMarkdownFile, activeMarkdownView } from "../services/store";
import type { EnhancementState } from "../services/enhancement-coordinator";
import type { ContextBucket, SourceRecord, Suggestion } from "../types";

const VIEW_TYPE = "context-bucket-view";

export class BucketView extends ItemView {
  private readonly unsubscribe: Array<() => void> = [];
  private enhancementState: EnhancementState = { filePath: "", phase: "idle", detail: "" };
  private reviewRequest: "paragraph" | "document" | null = null;
  public constructor(leaf: WorkspaceLeaf, private readonly plugin: ContextBucketPlugin) { super(leaf); }
  public getViewType(): string { return VIEW_TYPE; }
  public getDisplayText(): string { return "Context buckets"; }
  public override getIcon(): "inbox" { return "inbox"; }
  protected override onOpen(): Promise<void> {
    this.render();
    this.unsubscribe.push(this.plugin.store.onChange(() => this.render()));
    this.unsubscribe.push(this.plugin.coordinator.onState((state) => {
      this.enhancementState = state;
      if (state.phase === "idle") this.reviewRequest = null;
      this.render();
    }));
    this.unsubscribe.push(this.plugin.linkedSources.onState(() => this.render()));
    this.unsubscribe.push(this.plugin.lecture.onState(() => this.render()));
    this.registerEvent(this.app.workspace.on("file-open", () => this.render()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.render()));
    this.registerEvent(this.app.workspace.on("layout-change", () => this.render()));
    return Promise.resolve();
  }
  protected override onClose(): Promise<void> {
    for (const off of this.unsubscribe.splice(0)) off();
    this.contentEl.empty();
    return Promise.resolve();
  }

  private render(): void {
    const { store } = this.plugin;
    const root = this.contentEl;
    root.empty();
    root.addClass("context-bucket-bucket-view");
    const header = root.createDiv({ cls: "context-bucket-view-header" });
    header.createEl("h2", { text: "Context buckets" });
    const newButton = header.createEl("button", { text: "＋ New bucket" });
    newButton.addEventListener("click", () => this.openBucketModal());
    if (!store.buckets.length) {
      const empty = root.createDiv({ cls: "context-bucket-empty-state" });
      empty.createEl("strong", { text: "Start a context bucket" });
      empty.createEl("p", { text: "Collect slides, readings, and lecture transcripts here. Context Bucket uses relevant excerpts while you write." });
      return;
    }
    const selectedId = this.currentBucketId();
    const file = this.currentFile();
    const picker = root.createDiv({ cls: "context-bucket-bucket-picker" });
    const select = picker.createEl("select");
    const prompt = select.createEl("option", { value: "", text: file ? "No bucket attached" : "Select a bucket…" });
    prompt.selected = !selectedId;
    for (const bucket of store.buckets) {
      const option = select.createEl("option", { value: bucket.id, text: `${bucket.name} · ${bucket.sources.length}` });
      if (bucket.id === selectedId) option.selected = true;
    }
    select.addEventListener("change", () => {
      if (!select.value) {
        if (file) void this.plugin.linkedSources.detach(file);
        return;
      }
      if (file) void this.plugin.linkedSources.assign(file, select.value).catch((error: unknown) => this.report(error));
      else store.updateSettings({ lastSelectedBucketId: select.value });
    });
    const bucket = selectedId ? store.getBucket(selectedId) : undefined;
    if (!bucket) {
      const empty = root.createDiv({ cls: "context-bucket-empty-state" });
      empty.createEl("strong", { text: file ? "No bucket attached" : "No bucket selected" });
      empty.createEl("p", { text: file ? "Choose a bucket above. One bucket can be attached to many notes, but each note uses one bucket." : "Select a bucket above to manage its sources." });
      return;
    }
    this.renderSources(root, bucket);
    this.renderReview(root);
    this.renderLecture(root, bucket);
  }


  private renderSources(root: HTMLElement, bucket: ContextBucket): void {
    const file = this.currentFile();
    const section = root.createDiv({ cls: "context-bucket-section" });
    const heading = section.createDiv({ cls: "context-bucket-section-heading" });
    heading.createEl("h3", { text: "Source material" });
    const importButton = heading.createEl("button", { text: "Import files" });
    importButton.addEventListener("click", () => { void this.chooseSource(bucket); });
    if (!bucket.sources.length) section.createEl("p", { text: "No sources yet. Import one or more Markdown, text, PDF, DOCX, PPTX, audio, or transcript files.", cls: "context-bucket-muted" });
    const linkedStatus = this.plugin.linkedSources.currentState;
    if (linkedStatus.filePath === file?.path && linkedStatus.detail) section.createEl("p", { text: linkedStatus.detail, cls: "context-bucket-linked-status" });
    for (const source of bucket.sources) {
      const row = section.createDiv({ cls: "context-bucket-source-row" });
      row.createEl("span", { text: source.name, cls: "context-bucket-source-name" });
      row.createEl("span", { text: source.origin === "linked" ? `linked · ${source.kind}` : source.kind, cls: "context-bucket-source-kind" });
      if (source.kind === "recording") {
        const transcribe = row.createEl("button", { text: "Transcribe" });
        transcribe.addEventListener("click", () => { void this.transcribe(source); });
      }
      const remove = row.createEl("button", { text: "×", cls: "context-bucket-icon-button" });
      remove.setAttribute("aria-label", `Remove ${source.name}`);
      remove.addEventListener("click", () => {
        this.plugin.store.removeSource(bucket.id, source.id);
        new Notice(`${source.name} removed from this bucket.`);
      });
    }
  }

  private renderReview(root: HTMLElement): void {
    const file = this.currentFile();
    const section = root.createDiv({ cls: "context-bucket-section context-bucket-review-section" });
    const heading = section.createDiv({ cls: "context-bucket-section-heading" });
    heading.createEl("h3", { text: "Review queue" });
    const actions = heading.createDiv({ cls: "context-bucket-button-row" });
    const enhancement = this.enhancementState;
    const isCurrentFile = file?.path === enhancement.filePath;
    const currentPhase = isCurrentFile ? enhancement.phase : "idle";
    const paragraphPhase = this.reviewRequest === "paragraph" && currentPhase === "idle" ? "retrieving" : currentPhase;
    const documentPhase = this.reviewRequest === "document" && currentPhase === "idle" ? "retrieving" : currentPhase;
    const isBusy = currentPhase !== "idle" || this.reviewRequest !== null;
    const paragraph = this.createReviewButton(actions, "paragraph", paragraphPhase, isBusy, this.reviewRequest === "paragraph");
    paragraph.addEventListener("click", () => { void this.review("paragraph"); });
    const document = this.createReviewButton(actions, "document", documentPhase, isBusy, this.reviewRequest === "document");
    document.addEventListener("click", () => { void this.review("document"); });
    const analysis = file ? this.plugin.store.getAnalysis(file.path) : null;
    if (analysis?.lastFullReviewAt) {
      section.createDiv({ text: `Last scanned ${formatRelativeTime(analysis.lastFullReviewAt)}`, cls: "context-bucket-last-scanned" });
    }
    if (isBusy) {
      const status = section.createDiv({
        cls: "context-bucket-review-status",
        attr: { role: "status", "aria-live": "polite" },
      });
      const copy = status.createDiv({ cls: "context-bucket-review-status-copy" });
      copy.createDiv({ text: enhancement.detail || "Preparing the review", cls: "context-bucket-review-status-detail" });
      copy.createDiv({ text: reviewPhaseLabel(isCurrentFile ? currentPhase : "retrieving"), cls: "context-bucket-review-status-phase" });
    }
    const pending = this.plugin.store.getPendingSuggestions(file?.path);
    if (!pending.length) {
      section.createEl("p", { text: "No pending suggestions. Nothing is edited without your approval.", cls: "context-bucket-muted" });
      return;
    }
    const applyAll = section.createEl("button", { text: "Apply all safe suggestions", cls: "mod-cta" });
    applyAll.addEventListener("click", () => this.plugin.coordinator.applyAll());
    for (const suggestion of pending) {
      const card = section.createDiv({ cls: "context-bucket-review-card" });
      card.addClass("context-bucket-review-card-clickable");
      card.addEventListener("click", () => this.scrollToSuggestion(suggestion.anchor));
      card.createDiv({ text: `${suggestionKindLabel(suggestion.kind)} · ${Math.round(suggestion.confidence * 100)}%`, cls: "context-bucket-review-meta" });
      const explanation = card.createDiv({ cls: "context-bucket-review-explanation" });
      renderMarkdown(explanation, suggestion.explanation);
      const change = card.createDiv({ cls: "context-bucket-review-change" });
      if (suggestion.operation === "replace") {
        const before = change.createDiv({ cls: "context-bucket-change-line" });
        before.createSpan({ text: "−", cls: "context-bucket-change-minus", attr: { "aria-hidden": "true" } });
        const beforeText = before.createSpan({ cls: "context-bucket-change-before" });
        renderMarkdown(beforeText, suggestion.anchor);
        const after = change.createDiv({ cls: "context-bucket-change-line" });
        after.createSpan({ text: "+", cls: "context-bucket-change-plus", attr: { "aria-hidden": "true" } });
        const afterText = after.createSpan({ cls: "context-bucket-change-after" });
        renderMarkdown(afterText, suggestion.replacement);
      } else if (suggestion.replacement) {
        const after = change.createDiv({ cls: "context-bucket-change-line" });
        after.createSpan({ text: "+", cls: "context-bucket-change-plus", attr: { "aria-hidden": "true" } });
        const afterText = after.createSpan({ cls: "context-bucket-change-after" });
        renderMarkdown(afterText, suggestion.replacement);
      }
      const row = card.createDiv({ cls: "context-bucket-card-actions" });
      const accept = row.createEl("button", { text: "Accept", cls: "mod-cta" });
      accept.addEventListener("click", () => { this.plugin.coordinator.apply(suggestion.id); });
      const reject = row.createEl("button", { text: "Dismiss" });
      reject.addEventListener("click", () => this.plugin.coordinator.reject(suggestion.id));
    }
  }


  private renderLecture(root: HTMLElement, bucket: ContextBucket): void {
    const section = root.createDiv({ cls: "context-bucket-section context-bucket-lecture-section" });
    section.createEl("h3", { text: "Lecture capture" });
    const state = this.plugin.lecture.currentState;
    const line = section.createEl("p", { text: state.phase === "recording" ? `Recording · ${formatDuration(state.elapsedMs)}` : "Record a lecture and add the transcript to this bucket.", cls: "context-bucket-muted" });
    const button = section.createEl("button", { text: state.active ? "Stop and save recording" : "Record lecture" });
    button.addEventListener("click", () => { void this.plugin.lecture.toggle(bucket.id).catch((error: unknown) => new Notice(error instanceof Error ? error.message : "Recording failed.")); });
    if (state.phase === "transcribing" && state.progress !== undefined) line.setText(`Transcribing · ${Math.round(state.progress * 100)}%`);
  }

  private chooseSource(bucket: ContextBucket): Promise<void> {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = ".md,.markdown,.txt,.csv,.json,.pdf,.docx,.pptx,.wav,.mp3,.m4a,.webm,.vtt,.srt";
    input.addEventListener("change", () => { void this.importFiles(input.files, bucket); });
    input.click();
    return Promise.resolve();
  }

  private async importFiles(files: FileList | null, bucket: ContextBucket): Promise<void> {
    if (!files?.length) return;
    const inputs = Array.from(files);
    const failures: string[] = [];
    let imported = 0;
    for (const file of inputs) {
      try {
        const source = await ingestFile(this.plugin.app, bucket, file, this.plugin.store.settings.storageFolder);
        this.plugin.store.addSource(source);
        imported += 1;
      } catch (error) {
        failures.push(`${file.name}: ${error instanceof Error ? error.message : "import failed"}`);
      }
    }
    if (failures.length) {
      new Notice(`Imported ${imported} of ${inputs.length} sources. ${failures[0]}${failures.length > 1 ? ` (+${failures.length - 1} more)` : ""}`, 10_000);
    } else {
      new Notice(`${imported} source${imported === 1 ? "" : "s"} added.`);
    }
  }

  private async transcribe(source: SourceRecord): Promise<void> {
    try { await this.plugin.lecture.transcribe(source); } catch (error) { new Notice(error instanceof Error ? error.message : "Transcription failed."); }
  }

  private createReviewButton(parent: HTMLElement, scope: "paragraph" | "document", phase: EnhancementState["phase"], isBusy: boolean, isActiveRequest: boolean): HTMLButtonElement {
    const button = parent.createEl("button", {
      text: scope === "paragraph" ? "Review paragraph" : "Review note",
      cls: "context-bucket-review-button",
      attr: { "data-phase": phase, ...(isActiveRequest ? { "data-active": "true" } : {}) },
    });
    button.disabled = isBusy;
    button.setAttribute("aria-busy", String(isBusy));
    if (isBusy) {
      const indicator = button.createSpan({ cls: "context-bucket-review-indicator" });
      indicator.setAttribute("aria-hidden", "true");
      indicator.createSpan({ cls: "context-bucket-review-orb context-bucket-review-orb-a" });
      indicator.createSpan({ cls: "context-bucket-review-orb context-bucket-review-orb-b" });
      indicator.createSpan({ cls: "context-bucket-review-orb context-bucket-review-orb-c" });
    }
    return button;
  }

  private async review(scope: "paragraph" | "document"): Promise<void> {
    this.reviewRequest = scope;
    this.render();
    try {
      await this.plugin.coordinator.reviewCurrent(scope);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Review failed.");
    } finally {
      this.reviewRequest = null;
      this.render();
    }
  }

  private openBucketModal(): void {
    new BucketModal(this.app, (name) => {
      const bucket = this.plugin.store.createBucket(name);
      const file = this.currentFile();
      if (file) this.plugin.store.setAssignment(file.path, bucket.id);
    }).open();
  }

  /** Scrolls the active editor so the underlined suggestion anchor is in view. */
  private scrollToSuggestion(anchor: string): void {
    const view = activeMarkdownView(this.app);
    const editor = view?.editor;
    if (!editor) return;
    const text = editor.getValue();
    const index = text.indexOf(anchor);
    if (index < 0 || index !== text.lastIndexOf(anchor)) return;
    const pos = editor.offsetToPos(index);
    const { line } = pos;
    const endPos = editor.offsetToPos(index + anchor.length);
    const endLine = endPos.line;
    const scrollTargetLine = Math.max(0, line - 2);
    editor.setCursor(pos);
    editor.scrollIntoView({ from: { line: scrollTargetLine, ch: 0 }, to: { line: endLine, ch: endPos.ch } }, true);
  }

  private currentFile(): TFile | null {
    return activeMarkdownFile(this.app);
  }

  private currentBucketId(): string {
    const file = this.currentFile();
    return file ? this.plugin.store.getAssignment(file.path) ?? "" : this.plugin.store.settings.lastSelectedBucketId;
  }

  private report(error: unknown): void {
    new Notice(error instanceof Error ? error.message : "Context Bucket could not update this note.");
  }
}

function reviewPhaseLabel(phase: EnhancementState["phase"]): string {
  if (phase === "waiting") return "Listening for a pause";
  if (phase === "retrieving") return "Gathering context";
  if (phase === "reviewing") return "Reading your writing";
  return "Working";
}

function suggestionKindLabel(kind: Suggestion["kind"]): string {
  if (kind === "definition") return "Definition";
  if (kind === "critical") return "Correction";
  if (kind === "clarity") return "Clarity";
  return "Formatting";
}

function renderMarkdown(el: HTMLElement, text: string): void {
  void (async () => {
    try {
      const app = (window as unknown as { app: App }).app;
      const view = app.workspace.getActiveViewOfType(MarkdownView);
      await MarkdownRenderer.render(app, text, el, view?.file?.path ?? "", new Component());
    } catch {
      el.setText(text);
    }
  })();
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function formatRelativeTime(timestamp: number): string {
  const elapsed = Date.now() - timestamp;
  if (elapsed < 60_000) return "just now";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

