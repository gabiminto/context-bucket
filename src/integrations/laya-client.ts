import { requestLocalJson, trimTrailingSlash } from "./local-http";

export interface CompletionDecision {
  complete: boolean;
  probability: number;
  confidence: number;
  raw: unknown;
}

interface LayaChoiceAnswer {
  type?: string;
  choice?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
}

interface LayaResponse {
  answers?: Record<string, LayaChoiceAnswer>;
}

/** Laya decides only whether the candidate paragraph is a complete thought. */
export class LayaClient {
  constructor(private readonly baseUrl: string, private readonly threshold: number, private readonly timeoutMs = 8_000) {}

  async isComplete(paragraph: string, precedingText = ""): Promise<CompletionDecision> {
    const response = await requestLocalJson<LayaResponse>(`${trimTrailingSlash(this.baseUrl)}/v1/systemone`, {
      method: "POST",
      body: JSON.stringify({
        state: { paragraph, precedingParagraph: precedingText.slice(-1_500) },
        questions: {
          paragraph_complete: {
            type: "choice",
            instructions: "Decide whether the candidate paragraph expresses a finished, self-contained thought suitable for academic note review. Ignore whether its claims are correct.",
            criteria: {
              complete: "The paragraph has a finished thought and does not visibly stop mid-sentence, definition, comparison, or list item.",
              incomplete: "The paragraph is empty, visibly unfinished, ends mid-thought, or depends on text that has not been supplied.",
            },
          },
        },
      }),
      timeoutMs: this.timeoutMs,
    });
    return parseCompletion(response, this.threshold);
  }

  /** Laya decides only whether proposed edit wording matches the author's voice; it never edits the note. */
  async matchesStyle(document: string, targets: Array<{ target: string; replacement: string }>): Promise<Map<number, boolean>> {
    const response = await requestLocalJson<LayaStyleResponse>(`${trimTrailingSlash(this.baseUrl)}/v1/systemone`, {
      method: "POST",
      body: JSON.stringify({
        state: {
          documentExcerpt: document.slice(-4_000),
          edits: targets.map((edit, index) => ({ index, target: edit.target.slice(0, 500), replacement: edit.replacement.slice(0, 500) })),
        },
        questions: {
          style_match: {
            type: "choice",
            instructions: "Decide whether the replacement text preserves the author's established voice and wording conventions in the note excerpt. Judge only style, not factual correctness.",
            criteria: {
              match: "The replacement reads like the same author wrote it: similar tone, terminology, sentence structure, and notation conventions.",
              mismatch: "The replacement noticeably changes the author's voice - different vocabulary, register, phrasing patterns, or notation style.",
            },
          },
        },
      }),
      timeoutMs: this.timeoutMs,
    });
    return parseStyleVerdict(response, targets.length);
  }
}

interface LayaStyleResponse {
  answers?: Record<string, { type?: string; choice?: string; probabilities?: Record<string, number> }>;
}

function parseStyleVerdict(response: unknown, count: number): Map<number, boolean> {
  const answers = (response as LayaStyleResponse | null)?.answers ?? {};
  const map = new Map<number, boolean>();
  for (let index = 0; index < count; index++) {
    const answer = answers[`edit_${index}`];
    const choice = answer?.choice;
    const probability = choice ? answer?.probabilities?.[choice] : undefined;
    map.set(index, choice === "match" && (probability === undefined || probability >= 0.5));
  }
  return map;
}

export function parseCompletion(response: unknown, threshold: number): CompletionDecision {
  const answer = (response as LayaResponse | null)?.answers?.paragraph_complete;
  if (!answer || answer.type !== "choice" || typeof answer.choice !== "string") {
    throw new Error("Laya did not return a valid paragraph-completion decision.");
  }
  const probability = answer.probabilities?.[answer.choice];
  if (typeof probability !== "number" || !Number.isFinite(probability)) {
    throw new Error("Laya returned a completion decision without a usable probability.");
  }
  if (answer.choice !== "complete" && answer.choice !== "incomplete") {
    throw new Error("Laya returned an unknown paragraph-completion option.");
  }
  return {
    complete: answer.choice === "complete" && probability >= threshold,
    probability,
    confidence: typeof answer.confidence === "number" ? answer.confidence : Math.max(probability, 1 - probability),
    raw: response,
  };
}
