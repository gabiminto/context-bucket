import { FileSystemAdapter, Notice, normalizePath, type App } from "obsidian";
import { TFile } from "obsidian";
import type { ContextBucket, SourceRecord } from "../types";
import { RecordingService, type RecordingState } from "./recording-service";
import type { ContextStore } from "./store";
import { TranscriptionService, type TranscriptionProgress } from "./transcription-service";

export interface LectureState extends RecordingState {
  phase: "idle" | "recording" | "saving" | "transcribing" | "complete" | "error";
  detail: string;
  progress?: number;
  bucketId: string;
}

type Listener = (state: LectureState) => void;

export class LectureWorkflow {
  private readonly recording = new RecordingService();
  private readonly transcription: TranscriptionService;
  private readonly listeners = new Set<Listener>();
  private readonly state: LectureState = { active: false, elapsedMs: 0, level: 0, phase: "idle", detail: "Ready", bucketId: "" };

  public constructor(private readonly app: App, private readonly store: ContextStore) {
    this.transcription = new TranscriptionService((progress) => this.onProgress(progress));
    this.recording.onState((recording) => this.setState(recording));
  }

  public async transcribe(source: SourceRecord): Promise<void> {
    const bucket = this.store.getBucket(source.bucketId);
    const file = this.app.vault.getAbstractFileByPath(source.sourcePath);
    if (!bucket || !(file instanceof TFile)) throw new Error("The lecture recording is no longer in the vault.");
    if (!(this.app.vault.adapter instanceof FileSystemAdapter)) throw new Error("Local transcription requires a desktop vault.");
    this.setState({ phase: "transcribing", bucketId: bucket.id, progress: 0, detail: "Starting local transcription…" });
    try {
      const result = await this.transcription.transcribe(
        this.store.settings.transcriptionHelperPath,
        this.app.vault.adapter.getFilePath(file.path),
        this.store.settings.transcriptionModelFolder,
      );
      if (!result.text.trim()) throw new Error("The transcription helper returned an empty transcript.");
      const folder = source.sourcePath.split("/").slice(0, -1).join("/");
      const stem = source.sourcePath.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "Lecture transcript";
      const transcriptPath = normalizePath(`${folder}/${stem} transcript.md`);
      await this.app.vault.create(transcriptPath, `# ${stem}\n\n${result.text.trim()}\n`);
      const transcript: SourceRecord = {
        id: crypto.randomUUID(), bucketId: bucket.id, name: transcriptPath.split("/").pop() ?? "Lecture transcript.md",
        kind: "transcript", sourcePath: transcriptPath, extractedPath: transcriptPath,
        createdAt: Date.now(), size: new Blob([result.text]).size, origin: "generated",
      };
      this.store.addSource(transcript);
      this.setState({ phase: "complete", bucketId: bucket.id, progress: 1, detail: "Transcript saved and added to retrieval." });
      new Notice("Lecture transcript added to the context bucket.");
    } catch (error) {
      this.setState({ phase: "error", bucketId: bucket.id, detail: errorMessage(error) });
      throw error;
    }
  }

  public get currentState(): LectureState { return { ...this.state }; }

  public onState(listener: Listener): () => void {
    this.listeners.add(listener);
    listener({ ...this.state });
    return () => this.listeners.delete(listener);
  }

  public async toggle(bucketId: string): Promise<void> {
    if (this.state.active) await this.stop(bucketId);
    else await this.start();
  }

  public cancel(): void {
    this.transcription.cancel();
    this.setState({ phase: "idle", detail: "Transcription cancelled" });
  }

  public dispose(): void {
    this.recording.dispose();
    this.transcription.cancel();
    this.listeners.clear();
  }

  private async start(): Promise<void> {
    if (this.state.active) return;
    try {
      await this.recording.start();
      this.setState({ phase: "recording", bucketId: this.state.bucketId, detail: "Recording lecture" });
    } catch (error) {
      this.setState({ phase: "error", detail: errorMessage(error) });
      throw error;
    }
  }

  private async stop(bucketId: string): Promise<void> {
    const bucket = this.store.getBucket(bucketId);
    if (!bucket) throw new Error("Select a context bucket before recording.");
    const audio = await this.recording.stop();
    this.setState({ phase: "saving", bucketId, detail: "Saving recording…" });
    const source = await this.saveRecording(bucket, audio);
    this.store.addSource(source);
    this.setState({ phase: "complete", bucketId, detail: "Recording saved. Transcribe it when you are ready." });
    new Notice("Lecture recording added to the context bucket.");
  }

  private async saveRecording(bucket: ContextBucket, audio: ArrayBuffer): Promise<SourceRecord> {
    const settings = this.store.settings;
    const folder = normalizePath(`${settings.storageFolder || "Context Bucket"}/${bucket.name.replace(/[\\/:*?"<>|]/g, "-")}`);
    if (!(this.app.vault.adapter instanceof FileSystemAdapter)) throw new Error("Lecture recording requires a desktop vault.");
    if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const path = normalizePath(`${folder}/Lecture ${stamp}.wav`);
    await this.app.vault.createBinary(path, audio);
    return { id: crypto.randomUUID(), bucketId: bucket.id, name: path.split("/").pop() ?? "Lecture.wav", kind: "recording", sourcePath: path, createdAt: Date.now(), size: audio.byteLength, origin: "generated" };
  }

  private setState(update: Partial<LectureState>): void {
    Object.assign(this.state, update);
    for (const listener of this.listeners) listener({ ...this.state });
  }

  private onProgress(progress: TranscriptionProgress): void {
    this.setState({ phase: progress.phase === "complete" ? "complete" : "transcribing", progress: progress.progress, detail: progress.detail });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The lecture workflow could not be completed.";
}
