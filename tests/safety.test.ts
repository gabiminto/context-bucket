import { describe, expect, it } from "vitest";
import { resolveSuggestion } from "../src/domain/suggestions";
import { parseEnhancement, repairTruncatedJson } from "../src/services/ollama-client";
import { normalizeData } from "../src/defaults";
import { sourceKind } from "../src/domain/source-kinds";
import { rankChunks } from "../src/services/context-retrieval";

const baseSuggestion = {
  id: "s1", bucketId: "b1", filePath: "Note.md", scope: "paragraph" as const,
  operation: "replace" as const, kind: "definition" as const,
  anchor: "working memory", replacement: "working memory is a limited-capacity system",
  explanation: "Clarifies the definition.", sourceIds: ["source-1"], confidence: 0.9,
  createdAt: 1, status: "pending" as const,
};

describe("suggestion safety", () => {
  it("resolves an exact unique anchor", () => {
    expect(resolveSuggestion("A working memory example.", baseSuggestion)).toEqual({ from: 2, to: 16 });
  });
  it("rejects ambiguous anchors", () => {
    const result = resolveSuggestion("working memory and working memory", baseSuggestion);
    expect(result.staleReason).toContain("ambiguous");
  });
  it("rejects a no-op replacement", () => {
    const result = resolveSuggestion("working memory", { ...baseSuggestion, replacement: "working memory" });
    expect(result.staleReason).toContain("would not change");
  });
});

describe("model output validation", () => {
  it("filters invalid operations and low-confidence suggestions", () => {
    const content = JSON.stringify({ suggestions: [
      { operation: "delete", kind: "definition", target: "x", replacement: "y", explanation: "bad", confidence: 0.9 },
      { operation: "replace", kind: "definition", target: "x", replacement: "y", explanation: "unsupported", confidence: 0.4 },
    ] });
    expect(parseEnhancement(content, "x", new Set(["source-1"]))).toEqual([]);
  });
  it("keeps only allowed source IDs", () => {
    const content = JSON.stringify({ suggestions: [{
      operation: "replace", kind: "clarity", target: "term", replacement: "clear term",
      explanation: "Improve wording", sourceIds: ["source-1", "remote"], confidence: 0.9,
    }] });
    const result = parseEnhancement(content, "term", new Set(["source-1"]));
    expect(result[0]?.sourceIds).toEqual(["source-1"]);
  });
  it("recovers suggestions from output truncated mid-array by a token limit", () => {
    const truncated = '{"suggestions":[{"operation":"replace","kind":"definition","target":"term","replacement":"better term","explanation":"Fix","sourceIds":["source-1"],"confidence":0.9},{"operation":"insert_after","kind":"critical","target":"term","repl';
    const result = parseEnhancement(truncated, "term", new Set(["source-1"]));
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ operation: "replace", target: "term", replacement: "better term" });
  });
  it("recovers suggestions from output truncated inside a string value", () => {
    const truncated = '{"suggestions":[{"operation":"replace","kind":"clarity","target":"term","replacement":"clearer term","explanation":"Improves the wording","confidence":0.9},{"operation":"insert_after","kind":"critical","target":"term","replacem';
    const result = parseEnhancement(truncated, "term", new Set(["source-1"]));
    expect(result).toHaveLength(1);
    expect(result[0]?.replacement).toBe("clearer term");
  });
  it("still fails on unrecoverable output", () => {
    expect(repairTruncatedJson("not json at all {")).toBeUndefined();
    expect(() => parseEnhancement("", "term", new Set())).toThrow(/valid JSON/);
  });
});

describe("persistence and retrieval", () => {
  it("normalizes source provenance while preserving linked note references", () => {
    const data = normalizeData({ buckets: [{ id: "b", name: "Class", sources: [{
      id: "s", name: "slides.pdf", kind: "pdf", sourcePath: "slides.pdf", origin: "linked", linkedFrom: ["Note.md"], sourceMtime: 42,
    }] }] });
    expect(data.buckets[0]?.sources[0]).toMatchObject({ origin: "linked", linkedFrom: ["Note.md"], sourceMtime: 42 });
  });
  it("supports the source types accepted by the multi-file picker", () => {
    expect(sourceKind("md")).toBe("note");
    expect(sourceKind("pdf")).toBe("pdf");
    expect(sourceKind("docx")).toBe("docx");
    expect(sourceKind("pptx")).toBe("pptx");
    expect(sourceKind("wav")).toBe("recording");
    expect(sourceKind("xyz")).toBeNull();
  });
  it("normalizes malformed data without throwing", () => {
    const data = normalizeData({ settings: { paragraphPauseMs: "bad" }, buckets: [{ id: "b", name: "Class", sources: [{ kind: "nope" }] }] });
    expect(data.schemaVersion).toBe(2);
    expect(data.buckets[0]?.sources).toEqual([]);
    expect(data.settings.paragraphPauseMs).toBe(1_600);
  });
  it("ranks a matching chunk above unrelated chunks", () => {
    const chunks = [
      { sourceId: "a", sourceName: "A", heading: "Memory", text: "Working memory supports temporary information." },
      { sourceId: "b", sourceName: "B", heading: "Plants", text: "Photosynthesis converts light into energy." },
    ];
    expect(rankChunks(chunks, "working memory", 2, 1_000)[0]?.sourceId).toBe("a");
  });
});
