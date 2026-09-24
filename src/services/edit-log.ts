import { normalizePath, type App } from "obsidian";
import type { Suggestion } from "../types";

export interface EditLogEntry {
  timestamp: number;
  action: "accepted" | "rejected";
  filePath: string;
  bucketId: string;
  kind: Suggestion["kind"];
  operation: Suggestion["operation"];
  anchor: string;
  replacement: string;
  explanation: string;
  confidence: number;
}

function editLogPath(storageFolder: string): string {
  return normalizePath(`${storageFolder}/edits.json`);
}

async function readEntries(app: App, path: string): Promise<EditLogEntry[]> {
  try {
    const raw = await app.vault.adapter.read(path);
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as EditLogEntry[]) : [];
  } catch {
    return [];
  }
}

export async function appendEditLog(app: App, storageFolder: string, suggestion: Suggestion, action: "accepted" | "rejected"): Promise<void> {
  const path = editLogPath(storageFolder);
  const entry: EditLogEntry = {
    timestamp: Date.now(),
    action,
    filePath: suggestion.filePath,
    bucketId: suggestion.bucketId,
    kind: suggestion.kind,
    operation: suggestion.operation,
    anchor: suggestion.anchor,
    replacement: suggestion.replacement,
    explanation: suggestion.explanation,
    confidence: suggestion.confidence,
  };
  try {
    const entries = await readEntries(app, path);
    entries.push(entry);
    if (entries.length > 5_000) entries.splice(0, entries.length - 5_000);
    await app.vault.adapter.write(path, JSON.stringify(entries, null, 2));
  } catch {
    // Logging must never block or break the accept/dismiss flow.
  }
}