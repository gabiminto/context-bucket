import { requestLocalJson, trimTrailingSlash } from "../integrations/local-http";
import type {
  EnhancementResult,
  EnhancementScope,
  ModelSuggestion,
  RetrievedChunk,
  RuntimeStatus,
  SuggestionKind,
  SuggestionOperation,
} from "../types";

const OPERATIONS = new Set<SuggestionOperation>(["replace", "insert_after", "insert_before"]);
const KINDS = new Set<SuggestionKind>(["definition", "critical", "clarity", "format"]);

/** A loopback-only client for structured note review through Ollama. */
export class OllamaClient {
  public constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly timeoutMs: number,
  ) {}

  public async health(): Promise<RuntimeStatus> {
    try {
      const models = await this.listModels();
      const selected = !this.model || models.includes(this.model);
      return {
        ok: selected,
        detail: selected
          ? this.model ? `${this.model} is ready` : `${models.length} local model${models.length === 1 ? "" : "s"} available; select one in settings`
          : `${this.model} is not installed in Ollama`,
        models,
      };
    } catch (error) {
      return { ok: false, detail: errorMessage(error) };
    }
  }

  public async listModels(): Promise<string[]> {
    const body = await requestLocalJson<unknown>(`${trimTrailingSlash(this.baseUrl)}/api/tags`, { method: "GET", timeoutMs: 4_000 });
    if (!isRecord(body) || !Array.isArray(body.models)) return [];
    return body.models.flatMap((model) => isRecord(model) && typeof model.name === "string" ? [model.name] : []).sort((a, b) => a.localeCompare(b));
  }

  public async enhance(input: {
    scope: EnhancementScope;
    target: string;
    retrievedContext: RetrievedChunk[];
    documentExcerpt?: string;
  }): Promise<EnhancementResult> {
    if (!this.model.trim()) throw new Error("Select an Ollama model in Context Bucket settings first.");
    const allowedSourceIds = new Set(input.retrievedContext.map((chunk) => chunk.sourceId));
    const context = input.retrievedContext.length
      ? input.retrievedContext.map((chunk) => `<source id="${chunk.sourceId}" name="${escapeXml(chunk.sourceName)}">\n${chunk.text}\n</source>`).join("\n\n")
      : "(no relevant bucket context)";
    const targetLabel = input.scope === "paragraph" ? "CANDIDATE_PARAGRAPH" : "WHOLE_DOCUMENT";
    const styleExcerpt = input.documentExcerpt?.trim();
    const styleBlock = styleExcerpt
      ? `\n\nAUTHOR_STYLE_SAMPLE (representative of the author's voice; never quote or copy from it into the note):\n${styleExcerpt}`
      : "";
    const system = [
      "You are a meticulous academic note editor. Return only valid JSON.",
      "Review only the supplied note text. Use the source bucket to verify facts and identify material omissions; never invent citations or facts that the sources do not support.",
      "Correct materially wrong definitions, add genuinely critical caveats or connections, clarify ambiguous wording, and improve Markdown or technical notation.",
      "MUST match the author's writing style, demonstrated in AUTHOR_STYLE_SAMPLE: reuse the author's existing terminology, phrasing, tone (formal/casual), sentence structure, and notation conventions (including how they write LaTeX or abbreviations). Do not introduce your own vocabulary, reword sentences the author already wrote correctly, or 'polish' the prose. Keep every replacement as close to the original wording as possible while fixing only the substantive issue.",
      "Reject your own suggestion if it changes wording the author chose stylistically (voice, contractions, British/US spelling, heading or list conventions) without fixing a factual or clarity problem.",
      "For paragraph scope, keep every target inside CANDIDATE_PARAGRAPH. For document scope, use insert_after for additions so the original note remains intact.",
      "Return at most 6 suggestions and never suggest the same edit twice. An empty suggestions array is preferred to a cosmetic edit.",
    ].join(" ");
    const user = [
      `SCOPE: ${input.scope.toUpperCase()}`,
      `AVAILABLE_SOURCE_IDS: ${JSON.stringify([...allowedSourceIds])}`,
      "Each suggestion must be an object with: id (short string), operation (replace, insert_after, or insert_before), kind (definition, critical, clarity, or format), target (an exact unique substring of the review text), replacement, explanation, sourceIds (only from the available IDs), and confidence (0 to 1).",
      "Use only sourceIds that directly support the suggested claim. Confidence below 0.55 is not useful. Return {\"suggestions\": []} when no evidence-backed change is needed.",
      `BUCKET_CONTEXT:\n${context}${styleBlock}`,
      `${targetLabel}:\n${input.target}`,
    ].join("\n\n");

    const body = await requestLocalJson<unknown>(`${trimTrailingSlash(this.baseUrl)}/api/chat`, {
      method: "POST",
      body: JSON.stringify({
        model: this.model,
        stream: false,
        format: "json",
        think: false,
        keep_alive: "10m",
        options: { temperature: 0.1, num_ctx: Math.min(32_768, 16_000), num_predict: 4_000 },
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
      }),
      timeoutMs: this.timeoutMs,
    });
    if (!isRecord(body) || !isRecord(body.message) || typeof body.message.content !== "string") {
      throw new Error("Ollama returned an invalid response.");
    }
    return { suggestions: parseEnhancement(body.message.content, input.target, allowedSourceIds) };
  }
}

export function parseEnhancement(content: string, reviewText: string, allowedSourceIds: Set<string>): ModelSuggestion[] {
  const normalized = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized);
  } catch {
    parsed = repairTruncatedJson(normalized);
    if (parsed === undefined) throw new Error("The enhancement model did not return valid JSON.");
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.suggestions)) {
    throw new Error("Ollama returned an invalid enhancement result.");
  }
  return parsed.suggestions.slice(0, 12).flatMap((value, index) => parseSuggestion(value, index, reviewText, allowedSourceIds));
}

/**
 * Recovers complete suggestions from output truncated mid-array by a token
 * limit. Closes any open string, object, and array, then re-parses. Returns
 * undefined when the result is still not valid JSON.
 */
export function repairTruncatedJson(text: string): unknown {
  if (!text.trim()) return undefined;
  let repaired = "";
  let inString = false;
  let escaped = false;
  const stack: string[] = [];
  for (const char of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === "{" || char === "[") {
      stack.push(char);
    } else if ((char === "}" && stack[stack.length - 1] === "{") || (char === "]" && stack[stack.length - 1] === "[")) {
      stack.pop();
    }
    repaired += char;
  }
  if (inString && !escaped) repaired += '"';
  repaired = repaired.replace(/,\s*$/, "");
  // Drop a trailing partial property or value left dangling by truncation.
  repaired = repaired.replace(/,?\s*"[^"]*"\s*$/, "");
  repaired = repaired.replace(/,?\s*"[^"]*"\s*:\s*$/, "");
  repaired = repaired.replace(/,\s*$/, "");
  for (const open of stack.reverse()) repaired += open === "{" ? "}" : "]";
  try {
    return JSON.parse(repaired);
  } catch {
    return undefined;
  }
}

function parseSuggestion(value: unknown, index: number, reviewText: string, allowedSourceIds: Set<string>): ModelSuggestion[] {
  if (!isRecord(value) || !OPERATIONS.has(value.operation as SuggestionOperation)) return [];
  if (!KINDS.has(value.kind as SuggestionKind) || typeof value.target !== "string" || typeof value.replacement !== "string") return [];
  if (typeof value.explanation !== "string" || !value.explanation.trim()) return [];
  const target = value.target;
  if (!target.trim() || target.length > 8_000 || value.replacement.length > 12_000) return [];
  const first = reviewText.indexOf(target);
  if (first < 0 || reviewText.indexOf(target, first + target.length) >= 0) return [];
  if (value.operation === "replace" && target === value.replacement) return [];
  if (value.operation !== "replace" && !value.replacement.trim()) return [];
  const confidence = typeof value.confidence === "number" && Number.isFinite(value.confidence)
    ? Math.max(0, Math.min(1, value.confidence))
    : 0;
  if (confidence < 0.55) return [];
  const sourceIds = Array.isArray(value.sourceIds)
    ? [...new Set(value.sourceIds.filter((id): id is string => typeof id === "string" && allowedSourceIds.has(id)))].slice(0, 4)
    : [];
  return [{
    id: typeof value.id === "string" && value.id.trim() ? value.id.trim().slice(0, 80) : `suggestion-${index + 1}`,
    operation: value.operation as SuggestionOperation,
    kind: value.kind as SuggestionKind,
    target,
    replacement: value.replacement,
    explanation: value.explanation.trim().slice(0, 500),
    sourceIds,
    confidence,
  }];
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Ollama is unavailable.";
}

