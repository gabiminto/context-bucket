export type SourceKind = "note" | "text" | "pdf" | "docx" | "pptx" | "recording" | "transcript";
export type SourceOrigin = "imported" | "linked" | "generated";

export interface SourceRecord {
  id: string;
  bucketId: string;
  name: string;
  kind: SourceKind;
  sourcePath: string;
  extractedPath?: string;
  createdAt: number;
  size: number;
  origin: SourceOrigin;
  linkedFrom?: string[];
  sourceMtime?: number;
}

export interface ContextBucket {
  id: string;
  name: string;
  createdAt: number;
  sources: SourceRecord[];
}

export type SuggestionScope = "paragraph" | "document";
export type SuggestionOperation = "replace" | "insert_after" | "insert_before";
export type SuggestionStatus = "pending" | "accepted" | "rejected" | "stale";
export type SuggestionKind = "definition" | "critical" | "clarity" | "format";
export type CompletionMode = "heuristic" | "laya";
export type EnhancementScope = "paragraph" | "document";

export interface Suggestion {
  id: string;
  bucketId: string;
  filePath: string;
  scope: SuggestionScope;
  operation: SuggestionOperation;
  kind: SuggestionKind;
  anchor: string;
  replacement: string;
  explanation: string;
  sourceIds: string[];
  confidence: number;
  createdAt: number;
  status: SuggestionStatus;
  paragraphFingerprint?: string;
}

export interface AnalysisState {
  filePath: string;
  documentRevision: number;
  lastFullReviewRevision: number;
  lastFullReviewAt: number;
  completedFingerprints: string[];
}

export interface ContextBucketSettings {
  liveEnhancement: boolean;
  paragraphPauseMs: number;
  completionMode: CompletionMode;
  completionThreshold: number;
  layaBaseUrl: string;
  enhancementBaseUrl: string;
  enhancementModel: string;
  contextCharacterBudget: number;
  requestTimeoutMs: number;
  storageFolder: string;
  transcriptionHelperPath: string;
  transcriptionModelFolder: string;
  lastSelectedBucketId: string;
}

export interface PersistedContextBucketData {
  schemaVersion: number;
  settings: ContextBucketSettings;
  buckets: ContextBucket[];
  noteBucketAssignments: Record<string, string>;
  suggestions: Suggestion[];
  analysis: Record<string, AnalysisState>;
}

export interface RetrievedChunk {
  sourceId: string;
  sourceName: string;
  text: string;
  score: number;
}

export interface RuntimeStatus {
  ok: boolean;
  detail: string;
  models?: string[];
}

export interface ModelSuggestion {
  id: string;
  operation: SuggestionOperation;
  kind: SuggestionKind;
  target: string;
  replacement: string;
  explanation: string;
  sourceIds: string[];
  confidence: number;
}

export interface EnhancementResult {
  suggestions: ModelSuggestion[];
}

