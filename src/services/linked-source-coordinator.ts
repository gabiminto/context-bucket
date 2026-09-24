import { TFile, type App } from "obsidian";
import { sourceKind } from "../domain/source-kinds";
import type { SourceRecord } from "../types";
import { ingestLinkedFile } from "./source-ingestion";
import { activeMarkdownFile, type ContextStore } from "./store";

export interface LinkedSourceState {
  filePath: string;
  active: boolean;
  detail: string;
}

type Listener = (state: LinkedSourceState) => void;

/** Keeps the assigned bucket synchronized with resolvable links and embeds in its note. */
export class LinkedSourceCoordinator {
  private readonly timers = new Map<string, number>();
  private readonly runs = new Map<string, symbol>();
  private readonly listeners = new Set<Listener>();
  private state: LinkedSourceState = { filePath: "", active: false, detail: "" };

  public constructor(private readonly app: App, private readonly store: ContextStore) {}

  public get currentState(): LinkedSourceState { return { ...this.state }; }

  public onState(listener: Listener): () => void {
    this.listeners.add(listener);
    listener({ ...this.state });
    return () => this.listeners.delete(listener);
  }

  public async assign(file: TFile, bucketId: string): Promise<void> {
    const previousBucketId = this.store.getAssignment(file.path);
    this.store.setAssignment(file.path, bucketId);
    if (previousBucketId && previousBucketId !== bucketId) {
      this.store.reconcileLinkedSources(previousBucketId, file.path, new Map());
    }
    await this.syncNote(file);
  }

  public detach(file: TFile): void {
    const previousBucketId = this.store.getAssignment(file.path);
    this.store.clearAssignment(file.path);
    if (previousBucketId) this.store.reconcileLinkedSources(previousBucketId, file.path, new Map());
    this.setState({ filePath: file.path, active: false, detail: "Bucket detached from this note" });
  }

  public scheduleActive(): void {
    const file = activeMarkdownFile(this.app);
    if (file) this.schedule(file);
  }

  public schedule(file: TFile): void {
    if (file.extension !== "md") return;
    const existing = this.timers.get(file.path);
    if (existing !== undefined) window.clearTimeout(existing);
    this.timers.set(file.path, window.setTimeout(() => {
      this.timers.delete(file.path);
      void this.syncNote(file);
    }, 500));
  }

  public async refreshModified(file: TFile): Promise<void> {
    const matches = this.store.buckets.flatMap((bucket) => bucket.sources
      .filter((source) => source.origin === "linked" && source.sourcePath === file.path)
      .map((source) => ({ bucket, source })));
    for (const { bucket, source } of matches) {
      try {
        const refreshed = await ingestLinkedFile(this.app, bucket, file, this.store.settings.storageFolder);
        refreshed.id = source.id;
        refreshed.createdAt = source.createdAt;
        refreshed.linkedFrom = source.linkedFrom;
        this.store.addSource(refreshed);
      } catch {
        // A failed refresh leaves the previous extracted text available for retrieval.
      }
    }
  }

  public async syncNote(file: TFile): Promise<void> {
    const bucketId = this.store.getAssignment(file.path);
    if (!bucketId) return;
    const bucket = this.store.getBucket(bucketId);
    if (!bucket) return;
    const run = Symbol(file.path);
    this.runs.set(file.path, run);
    this.setState({ filePath: file.path, active: true, detail: "Checking linked files…" });
    try {
      const linkedFiles = this.resolveLinkedFiles(file);
      const replacements = new Map<string, SourceRecord>();
      for (const linkedFile of linkedFiles) {
        const existing = bucket.sources.find((source) => source.sourcePath === linkedFile.path);
        if (existing?.sourceMtime === linkedFile.stat.mtime) {
          replacements.set(linkedFile.path, { ...existing, linkedFrom: [...(existing.linkedFrom ?? []), file.path] });
          continue;
        }
        try {
          const source = await ingestLinkedFile(this.app, bucket, linkedFile, this.store.settings.storageFolder);
          source.linkedFrom = [...(existing?.linkedFrom ?? []), file.path];
          if (existing) source.id = existing.id;
          replacements.set(linkedFile.path, source);
        } catch {
          // Unsupported, empty, or damaged links are left out without blocking other files.
        }
      }
      if (this.runs.get(file.path) !== run) return;
      this.store.reconcileLinkedSources(bucketId, file.path, replacements);
      this.setState({
        filePath: file.path,
        active: false,
        detail: `${linkedFiles.length} linked file${linkedFiles.length === 1 ? "" : "s"} detected`,
      });
    } finally {
      if (this.runs.get(file.path) === run) {
        this.runs.delete(file.path);
        this.setState({ ...this.state, active: false });
      }
    }
  }

  public dispose(): void {
    for (const timer of this.timers.values()) window.clearTimeout(timer);
    this.timers.clear();
    this.runs.clear();
    this.listeners.clear();
  }

  private resolveLinkedFiles(note: TFile): TFile[] {
    const cache = this.app.metadataCache.getFileCache(note);
    const references = [...(cache?.links ?? []), ...(cache?.embeds ?? [])];
    const paths = new Set<string>();
    for (const reference of references) {
      const linkpath = reference.link.split("#", 1)[0]?.trim();
      if (!linkpath) continue;
      const destination = this.app.metadataCache.getFirstLinkpathDest(linkpath, note.path);
      if (destination && destination.path !== note.path && sourceKind(destination.extension.toLowerCase())) paths.add(destination.path);
    }
    return [...paths]
      .map((path) => this.app.vault.getAbstractFileByPath(path))
      .filter((file): file is TFile => file instanceof TFile)
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  private setState(state: LinkedSourceState): void {
    this.state = { ...state };
    for (const listener of this.listeners) listener({ ...this.state });
  }
}
