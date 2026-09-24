import type {
  AnalysisState,
  ContextBucket,
  ContextBucketSettings,
  PersistedContextBucketData,
  SourceRecord,
  Suggestion,
} from "./types";

export const DEFAULT_SETTINGS: ContextBucketSettings = {
  liveEnhancement: true,
  paragraphPauseMs: 1_600,
  completionMode: "heuristic",
  completionThreshold: 0.82,
  layaBaseUrl: "http://127.0.0.1:8000",
  enhancementBaseUrl: "http://127.0.0.1:11434",
  enhancementModel: "qwen3.5:4b",
  contextCharacterBudget: 8_000,
  requestTimeoutMs: 120_000,
  storageFolder: "Sources",
  transcriptionHelperPath: "",
  transcriptionModelFolder: "",
  lastSelectedBucketId: "",
};

export const DEFAULT_DATA: PersistedContextBucketData = {
  schemaVersion: 2,
  settings: { ...DEFAULT_SETTINGS },
  buckets: [],
  noteBucketAssignments: {},
  suggestions: [],
  analysis: {},
};

export function normalizeData(value: unknown): PersistedContextBucketData {
  const candidate = record(value);
  const rawSettings = record(candidate.settings);
  const settings: ContextBucketSettings = {
    liveEnhancement: boolean(rawSettings.liveEnhancement, DEFAULT_SETTINGS.liveEnhancement),
    paragraphPauseMs: number(rawSettings.paragraphPauseMs, DEFAULT_SETTINGS.paragraphPauseMs, 600, 15_000),
    completionMode: rawSettings.completionMode === "laya" ? "laya" : "heuristic",
    completionThreshold: number(rawSettings.completionThreshold, DEFAULT_SETTINGS.completionThreshold, 0.5, 0.99),
    layaBaseUrl: text(rawSettings.layaBaseUrl, DEFAULT_SETTINGS.layaBaseUrl, 200),
    enhancementBaseUrl: text(rawSettings.enhancementBaseUrl, DEFAULT_SETTINGS.enhancementBaseUrl, 200),
    enhancementModel: text(rawSettings.enhancementModel, "", 200),
    contextCharacterBudget: number(rawSettings.contextCharacterBudget, DEFAULT_SETTINGS.contextCharacterBudget, 1_000, 40_000),
    requestTimeoutMs: number(rawSettings.requestTimeoutMs, DEFAULT_SETTINGS.requestTimeoutMs, 10_000, 600_000),
    storageFolder: text(rawSettings.storageFolder, DEFAULT_SETTINGS.storageFolder, 100).replace(/^\/+|\/+$/g, ""),
    transcriptionHelperPath: text(rawSettings.transcriptionHelperPath, "", 500),
    transcriptionModelFolder: text(rawSettings.transcriptionModelFolder, "", 500),
    lastSelectedBucketId: text(rawSettings.lastSelectedBucketId, "", 100),
  };
  const buckets = Array.isArray(candidate.buckets) ? candidate.buckets.flatMap(normalizeBucket) : [];
  const bucketIds = new Set(buckets.map((bucket) => bucket.id));
  if (!bucketIds.has(settings.lastSelectedBucketId)) settings.lastSelectedBucketId = buckets[0]?.id ?? "";
  return {
    schemaVersion: 2,
    settings,
    buckets,
    noteBucketAssignments: stringRecord(candidate.noteBucketAssignments, bucketIds),
    suggestions: Array.isArray(candidate.suggestions) ? candidate.suggestions.flatMap(normalizeSuggestion) : [],
    analysis: analysisRecord(candidate.analysis),
  };
}

function normalizeBucket(value: unknown): ContextBucket[] {
  const candidate = record(value);
  if (typeof candidate.id !== "string" || typeof candidate.name !== "string") return [];
  const id = candidate.id;
  return [{
    id,
    name: candidate.name.trim().slice(0, 100) || "Untitled bucket",
    createdAt: finite(candidate.createdAt, Date.now()),
    sources: Array.isArray(candidate.sources) ? candidate.sources.flatMap((source) => normalizeSource(source, id)) : [],
  }];
}

function normalizeSource(value: unknown, bucketId: string): SourceRecord[] {
  const candidate = record(value);
  const kinds: SourceRecord["kind"][] = ["note", "text", "pdf", "docx", "pptx", "recording", "transcript"];
  if (typeof candidate.id !== "string" || typeof candidate.name !== "string" || typeof candidate.sourcePath !== "string") return [];
  if (!kinds.includes(candidate.kind as SourceRecord["kind"])) return [];
  return [{
    id: candidate.id,
    bucketId,
    name: candidate.name,
    kind: candidate.kind as SourceRecord["kind"],
    sourcePath: candidate.sourcePath,
    extractedPath: typeof candidate.extractedPath === "string" ? candidate.extractedPath : undefined,
    createdAt: finite(candidate.createdAt, Date.now()),
    size: Math.max(0, finite(candidate.size, 0)),
    origin: candidate.origin === "linked" || candidate.origin === "generated" ? candidate.origin : "imported",
    linkedFrom: Array.isArray(candidate.linkedFrom)
      ? candidate.linkedFrom.filter((path): path is string => typeof path === "string").slice(0, 500)
      : undefined,
    sourceMtime: typeof candidate.sourceMtime === "number" && Number.isFinite(candidate.sourceMtime)
      ? Math.max(0, candidate.sourceMtime)
      : undefined,
  }];
}

function normalizeSuggestion(value: unknown): Suggestion[] {
  const candidate = record(value);
  const operations = ["replace", "insert_after", "insert_before"];
  const kinds = ["definition", "critical", "clarity", "format"];
  if (typeof candidate.id !== "string" || typeof candidate.filePath !== "string" || typeof candidate.anchor !== "string") return [];
  if (!operations.includes(String(candidate.operation))) return [];
  const scope = candidate.scope === "document" ? "document" : "paragraph";
  const status = ["pending", "accepted", "rejected", "stale"].includes(String(candidate.status))
    ? candidate.status as Suggestion["status"]
    : "pending";
  return [{
    id: candidate.id,
    bucketId: typeof candidate.bucketId === "string" ? candidate.bucketId : "",
    filePath: candidate.filePath,
    scope,
    operation: candidate.operation as Suggestion["operation"],
    kind: kinds.includes(String(candidate.kind)) ? candidate.kind as Suggestion["kind"] : "clarity",
    anchor: candidate.anchor,
    replacement: typeof candidate.replacement === "string" ? candidate.replacement : "",
    explanation: typeof candidate.explanation === "string" ? candidate.explanation : "",
    sourceIds: Array.isArray(candidate.sourceIds) ? candidate.sourceIds.filter((id): id is string => typeof id === "string") : [],
    confidence: Math.max(0, Math.min(1, finite(candidate.confidence, 0))),
    createdAt: finite(candidate.createdAt, Date.now()),
    status,
    paragraphFingerprint: typeof candidate.paragraphFingerprint === "string" ? candidate.paragraphFingerprint : undefined,
  }];
}


function analysisRecord(value: unknown): Record<string, AnalysisState> {
  const output: Record<string, AnalysisState> = {};
  for (const [path, item] of Object.entries(record(value))) {
    const candidate = record(item);
    if (!path) continue;
    output[path] = {
      filePath: path,
      documentRevision: Math.max(0, finite(candidate.documentRevision, 0)),
      lastFullReviewRevision: finite(candidate.lastFullReviewRevision, -1),
      lastFullReviewAt: Math.max(0, finite(candidate.lastFullReviewAt, 0)),
      completedFingerprints: Array.isArray(candidate.completedFingerprints)
        ? candidate.completedFingerprints.filter((item): item is string => typeof item === "string").slice(-500)
        : [],
    };
  }
  return output;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringRecord(value: unknown, allowed: Set<string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record(value)).filter(([key, item]) => allowed.has(key) && typeof item === "string"),
  ) as Record<string, string>;
}

function text(value: unknown, fallback: string, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : fallback;
}

function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function number(value: unknown, fallback: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, finite(value, fallback)));
}
