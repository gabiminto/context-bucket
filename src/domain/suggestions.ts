import type { Suggestion } from "../types";

export interface AnchorResult {
  from: number;
  to: number;
  staleReason?: string;
}

/** Suggestions apply only when their exact, non-empty anchor occurs once. */
export function resolveSuggestion(document: string, suggestion: Suggestion): AnchorResult {
  const anchor = suggestion.anchor;
  if (!anchor.trim() || anchor.length > 12_000) return { from: 0, to: 0, staleReason: "The suggestion has no safe text anchor." };
  if (suggestion.replacement.length > 24_000) return { from: 0, to: 0, staleReason: "The suggested edit is unexpectedly large." };
  const first = document.indexOf(anchor);
  if (first < 0) return { from: 0, to: 0, staleReason: "The anchored note text has changed." };
  if (document.indexOf(anchor, first + anchor.length) >= 0) return { from: 0, to: 0, staleReason: "The anchor is ambiguous because it occurs more than once." };

  const end = first + anchor.length;
  switch (suggestion.operation) {
    case "replace":
      if (anchor === suggestion.replacement) return { from: 0, to: 0, staleReason: "The suggestion would not change the note." };
      return { from: first, to: end };
    case "insert_before":
      if (!suggestion.replacement) return { from: 0, to: 0, staleReason: "The suggestion has no content to insert." };
      return { from: first, to: first };
    case "insert_after":
      if (!suggestion.replacement) return { from: 0, to: 0, staleReason: "The suggestion has no content to insert." };
      return { from: end, to: end };
  }
}

export function suggestionSummary(suggestion: Suggestion): string {
  const labels = { definition: "Definition", critical: "Missing context", clarity: "Clarity", format: "Formatting" } as const;
  return labels[suggestion.kind];
}
