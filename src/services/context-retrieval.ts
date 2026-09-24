import type { App, TFile } from "obsidian";
import type { ContextBucket, RetrievedChunk } from "../types";

export interface TextChunk {
  sourceId: string;
  sourceName: string;
  text: string;
  heading: string;
}

const STOP_WORDS = new Set(["the", "and", "that", "this", "with", "from", "into", "have", "will", "were", "which", "their", "there", "about", "would", "could", "should", "these", "those", "what", "when", "where", "than", "then", "them", "they", "been", "being"]);

export function chunkText(text: string, target = 1_400, overlap = 180): string[] {
  const paragraphs = text.replace(/\r\n/g, "\n").split(/\n\s*\n/).map((item) => item.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    if (current && current.length + paragraph.length + 2 > target) {
      chunks.push(current);
      current = `${current.slice(-overlap)}\n\n${paragraph}`;
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export function rankChunks(chunks: TextChunk[], query: string, limit: number, characterBudget: number): RetrievedChunk[] {
  const terms = tokenize(query);
  if (!terms.length) return [];
  const uniqueTerms = [...new Set(terms)];
  const documents = chunks.map((chunk) => tokenize(`${chunk.heading} ${chunk.text}`));
  const documentFrequencies = uniqueTerms.map((term) => documents.filter((document) => document.includes(term)).length);
  const frequencies = documents.map((document) => uniqueTerms.map((term) => document.filter((item) => item === term).length));
  const scored = chunks.map((chunk, index) => {
    const termScores = uniqueTerms.flatMap((term, termIndex) => {
      const count = frequencies[index]?.[termIndex] ?? 0;
      if (!count) return [];
      const idf = Math.log((1 + chunks.length) / (1 + (documentFrequencies[termIndex] ?? 0))) + 1;
      return [count * idf * (1 + Math.log(1 + count))];
    });
    const score = termScores.reduce((sum, value) => sum + value, 0) / (1 + Math.log(1 + chunk.text.length / 800));
    return { sourceId: chunk.sourceId, sourceName: chunk.sourceName, text: chunk.text, score };
  }).filter((chunk) => chunk.score > 0).sort((a, b) => b.score - a.score);

  const selected: RetrievedChunk[] = [];
  let used = 0;
  for (const chunk of scored) {
    if (selected.length >= limit) break;
    if (used + chunk.text.length > characterBudget) continue;
    selected.push(chunk);
    used += chunk.text.length;
  }
  return selected;
}

export class ContextRetrieval {
  constructor(private readonly app: App) {}

  async retrieve(bucket: ContextBucket, query: string, characterBudget: number, limit = 8): Promise<RetrievedChunk[]> {
    const chunks: TextChunk[] = [];
    for (const source of bucket.sources) {
      if (source.kind === "recording") continue;
      if (["pdf", "docx", "pptx"].includes(source.kind) && !source.extractedPath) continue;
      const file = this.resolveFile(source.extractedPath ?? source.sourcePath);
      if (!file || file.stat.size > 4_000_000) continue;
      let text: string;
      try {
        text = await this.app.vault.cachedRead(file);
      } catch {
        continue;
      }
      const heading = source.name;
      for (const part of chunkText(text)) {
        const first = part.split("\n").find((line) => /^#{1,6}\s+/.test(line));
        chunks.push({ sourceId: source.id, sourceName: source.name, text: part, heading: first?.replace(/^#{1,6}\s+/, "") ?? heading });
      }
    }
    return rankChunks(chunks, query, limit, characterBudget);
  }

  private resolveFile(path: string): TFile | null {
    const file = this.app.vault.getAbstractFileByPath(path);
    return file && "extension" in file ? file as TFile : null;
  }
}

function tokenize(value: string): string[] {
  return value.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)?.filter((term) => term.length > 2 && !STOP_WORDS.has(term)) ?? [];
}
