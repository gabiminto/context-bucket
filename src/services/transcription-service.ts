import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface TranscriptResult {
  text: string;
  segments: TranscriptSegment[];
}

export interface TranscriptionProgress {
  phase: "starting" | "loading" | "transcribing" | "complete";
  progress?: number;
  detail: string;
}

interface HelperMessage {
  type?: string;
  phase?: TranscriptionProgress["phase"];
  progress?: number;
  detail?: string;
  text?: string;
  segments?: TranscriptSegment[];
  error?: string;
}

/**
 * Thin client for the Context Bucket Swift/WhisperKit helper. The helper keeps
 * one-line JSON messages on stdout and accepts one transcribe command on stdin.
 */
export class TranscriptionService {
  private process?: ChildProcessWithoutNullStreams;
  private buffer = "";

  constructor(private readonly onProgress: (progress: TranscriptionProgress) => void) {}

  async transcribe(helperPath: string, audioPath: string, modelFolder: string): Promise<TranscriptResult> {
    if (!helperPath.trim()) throw new Error("Set the Context Bucket transcription helper path in settings.");
    if (this.process) throw new Error("A lecture transcription is already running.");
    const child = spawn(helperPath, [], { stdio: ["pipe", "pipe", "pipe"] });
    this.process = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    this.onProgress({ phase: "starting", detail: "Starting the local transcription helper…" });

    return new Promise<TranscriptResult>((resolve, reject) => {
      let settled = false;
      let stderr = "";
      const finish = (error?: Error, result?: TranscriptResult): void => {
        if (settled) return;
        settled = true;
        this.process = undefined;
        this.buffer = "";
        if (error) reject(error);
        else resolve(result ?? { text: "", segments: [] });
      };
      child.stdout.on("data", (data: string) => this.consume(data, resolve, finish));
      child.stderr.on("data", (data: string) => { stderr = `${stderr}${data}`.slice(-4_000); });
      child.on("error", (error) => finish(error));
      child.on("exit", (code) => {
        if (code === 0) finish();
        else finish(new Error(stderr.trim() || `Transcription helper exited with code ${code ?? "unknown"}.`));
      });
      child.stdin.write(`${JSON.stringify({ type: "transcribe", audioPath, modelFolder: modelFolder || undefined })}\n`);
    });
  }

  cancel(): void {
    this.process?.stdin.write(`${JSON.stringify({ type: "cancel" })}\n`);
    this.process?.kill();
    this.process = undefined;
    this.buffer = "";
  }

  private consume(data: string, resolve: (value: TranscriptResult) => void, finish: (error?: Error) => void): void {
    this.buffer += data;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let message: HelperMessage;
      try {
        message = JSON.parse(line) as HelperMessage;
      } catch {
        finish(new Error("The transcription helper emitted invalid JSON."));
        return;
      }
      if (message.type === "error") {
        finish(new Error(message.error || "The transcription helper reported an error."));
        return;
      }
      if (message.type === "result" && typeof message.text === "string") {
        this.onProgress({ phase: "complete", progress: 1, detail: "Transcription complete." });
        resolve({ text: message.text, segments: Array.isArray(message.segments) ? message.segments : [] });
        return;
      }
      if (message.type === "progress" && message.phase) {
        this.onProgress({
          phase: message.phase,
          progress: typeof message.progress === "number" ? message.progress : undefined,
          detail: message.detail ?? "Transcribing locally…",
        });
      }
    }
  }
}
