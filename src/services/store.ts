import { MarkdownView, type App, type Plugin, type TFile } from "obsidian";
import { DEFAULT_DATA, normalizeData } from "../defaults";
import type {
  AnalysisState,
  ContextBucket,
  ContextBucketSettings,
  PersistedContextBucketData,
  SourceRecord,
  Suggestion,
} from "../types";

type StoreListener = () => void;

export class ContextStore {
  private data: PersistedContextBucketData = structuredClone(DEFAULT_DATA);
  private saveQueue: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<StoreListener>();

  public constructor(private readonly plugin: Plugin) {}

  public async load(): Promise<void> {
    this.data = normalizeData(await this.plugin.loadData());
  }

  public save(): Promise<void> {
    const snapshot = structuredClone(this.data);
    this.saveQueue = this.saveQueue.then(() => this.plugin.saveData(snapshot));
    return this.saveQueue;
  }

  public onChange(listener: StoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public get settings(): ContextBucketSettings { return this.data.settings; }
  public get buckets(): ContextBucket[] { return this.data.buckets; }
  public get suggestions(): Suggestion[] { return this.data.suggestions; }

  public getBucket(bucketId: string): ContextBucket | undefined {
    return this.data.buckets.find((bucket) => bucket.id === bucketId);
  }

  public createBucket(name: string): ContextBucket {
    const bucket: ContextBucket = { id: crypto.randomUUID(), name: name.trim().slice(0, 100) || "Untitled bucket", createdAt: Date.now(), sources: [] };
    this.data.buckets.push(bucket);
    this.data.settings.lastSelectedBucketId = bucket.id;
    this.changed();
    return bucket;
  }

  public deleteBucket(bucketId: string): void {
    this.data.buckets = this.data.buckets.filter((bucket) => bucket.id !== bucketId);
    this.data.suggestions = this.data.suggestions.filter((suggestion) => suggestion.bucketId !== bucketId);
    for (const [path, assigned] of Object.entries(this.data.noteBucketAssignments)) {
      if (assigned === bucketId) delete this.data.noteBucketAssignments[path];
    }
    if (this.data.settings.lastSelectedBucketId === bucketId) this.data.settings.lastSelectedBucketId = this.data.buckets[0]?.id ?? "";
    this.changed();
  }

  public getAssignment(filePath: string): string | undefined {
    const assigned = this.data.noteBucketAssignments[filePath];
    return assigned && this.getBucket(assigned) ? assigned : undefined;
  }

  public setAssignment(filePath: string, bucketId: string): void {
    if (!this.getBucket(bucketId)) throw new Error("Select an existing bucket first.");
    this.data.noteBucketAssignments[filePath] = bucketId;
    this.data.settings.lastSelectedBucketId = bucketId;
    this.changed();
  }

  public clearAssignment(filePath: string): void {
    delete this.data.noteBucketAssignments[filePath];
    this.changed();
  }

  public addSource(source: SourceRecord): SourceRecord {
    const bucket = this.getBucket(source.bucketId);
    if (!bucket) throw new Error("The selected context bucket no longer exists.");
    const existing = bucket.sources.find((item) => item.sourcePath === source.sourcePath);
    if (existing) {
      const linkedFrom = new Set([...(existing.linkedFrom ?? []), ...(source.linkedFrom ?? [])]);
      Object.assign(existing, source, {
        id: existing.id,
        origin: existing.origin === "linked" && source.origin === "linked" ? "linked" : existing.origin,
        linkedFrom: linkedFrom.size ? [...linkedFrom].slice(0, 500) : undefined,
      });
      this.changed();
      return existing;
    }
    bucket.sources.push(source);
    this.changed();
    return source;
  }

  public reconcileLinkedSources(bucketId: string, notePath: string, replacements: Map<string, SourceRecord>): void {
    const bucket = this.getBucket(bucketId);
    if (!bucket) return;
    for (let index = bucket.sources.length - 1; index >= 0; index -= 1) {
      const source = bucket.sources[index];
      if (!source || source.origin !== "linked" || !source.linkedFrom?.includes(notePath)) continue;
      const replacement = replacements.get(source.sourcePath);
      const remainingNotes = source.linkedFrom.filter((path) => path !== notePath);
      if (replacement && replacement.extractedPath === source.extractedPath) replacement.linkedFrom = [...remainingNotes, notePath].slice(0, 500);
      else if (replacement) {
        this.deleteLinkedSourceFiles(source);
        replacement.linkedFrom = [...remainingNotes, notePath].slice(0, 500);
      }
      if (!replacement && remainingNotes.length) {
        source.linkedFrom = remainingNotes;
        continue;
      }
      this.deleteLinkedSourceFiles(source);
      bucket.sources.splice(index, 1);
    }
    for (const source of replacements.values()) this.addSource(source);
    this.changed();
  }

  public updateSource(bucketId: string, sourceId: string, update: Partial<SourceRecord>): SourceRecord | undefined {
    const source = this.getBucket(bucketId)?.sources.find((item) => item.id === sourceId);
    if (!source) return undefined;
    Object.assign(source, update);
    this.changed();
    return source;
  }

  public removeSource(bucketId: string, sourceId: string): SourceRecord | undefined {
    const bucket = this.getBucket(bucketId);
    const index = bucket?.sources.findIndex((item) => item.id === sourceId) ?? -1;
    if (!bucket || index < 0) return undefined;
    const [source] = bucket.sources.splice(index, 1);
    if (source?.origin === "linked") this.deleteLinkedSourceFiles(source);
    this.changed();
    return source;
  }

  public getSource(bucketId: string, sourceId: string): SourceRecord | undefined {
    return this.getBucket(bucketId)?.sources.find((item) => item.id === sourceId);
  }

  public getAnalysis(filePath: string): AnalysisState {
    const existing = this.data.analysis[filePath];
    if (existing) return existing;
    const created: AnalysisState = {
      filePath,
      documentRevision: 0,
      lastFullReviewRevision: -1,
      lastFullReviewAt: 0,
      completedFingerprints: [],
    };
    this.data.analysis[filePath] = created;
    return created;
  }

  public markDocumentChanged(filePath: string): AnalysisState {
    const current = this.getAnalysis(filePath);
    return this.updateAnalysis(filePath, { documentRevision: current.documentRevision + 1 });
  }

  public updateAnalysis(filePath: string, update: Partial<AnalysisState>): AnalysisState {
    const next = { ...this.getAnalysis(filePath), ...update };
    this.data.analysis[filePath] = next;
    this.changed();
    return next;
  }

  public addSuggestions(suggestions: Suggestion[]): void {
    for (const suggestion of suggestions) {
      const duplicate = this.data.suggestions.some((item) => item.status === "pending"
        && item.filePath === suggestion.filePath
        && item.operation === suggestion.operation
        && item.anchor === suggestion.anchor
        && item.replacement === suggestion.replacement);
      if (!duplicate) this.data.suggestions.push(suggestion);
    }
    this.pruneSuggestions();
    this.changed();
  }

  public updateSuggestion(id: string, update: Partial<Suggestion>): Suggestion | undefined {
    const suggestion = this.data.suggestions.find((item) => item.id === id);
    if (!suggestion) return undefined;
    Object.assign(suggestion, update);
    this.changed();
    return suggestion;
  }

  public getPendingSuggestions(filePath?: string): Suggestion[] {
    return this.data.suggestions
      .filter((item) => item.status === "pending" && (!filePath || item.filePath === filePath))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  public updateSettings(update: Partial<ContextBucketSettings>): void {
    this.data.settings = { ...this.data.settings, ...update };
    this.changed();
  }

  public snapshot(): PersistedContextBucketData {
    return structuredClone(this.data);
  }

  private changed(): void {
    void this.save();
    for (const listener of this.listeners) listener();
  }

  private pruneSuggestions(): void {
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1_000;
    this.data.suggestions = this.data.suggestions
      .filter((item) => item.status === "pending" || item.createdAt >= cutoff)
      .slice(-1_000);
  }

  private deleteLinkedSourceFiles(source: SourceRecord): void {
    if (!source.extractedPath || source.extractedPath === source.sourcePath) return;
    const extracted = this.plugin.app.vault.getAbstractFileByPath(source.extractedPath);
    if (extracted) void this.plugin.app.vault.trash(extracted, true);
  }
}

export function activeMarkdownFile(app: App): TFile | null {
  const activeFile = app.workspace.getActiveFile();
  if (activeFile?.extension === "md") return activeFile;
  const view = app.workspace.getActiveViewOfType(MarkdownView);
  return view?.file?.extension === "md" ? view.file : null;
}

export function activeMarkdownView(app: App): MarkdownView | null {
  const file = activeMarkdownFile(app);
  if (!file) return null;
  const active = app.workspace.getActiveViewOfType(MarkdownView);
  if (active?.file?.path === file.path) return active;
  for (const leaf of app.workspace.getLeavesOfType("markdown")) {
    if (leaf.view instanceof MarkdownView && leaf.view.file?.path === file.path) return leaf.view;
  }
  return null;
}

