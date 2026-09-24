import type { Editor, EditorPosition } from "obsidian";
import { fingerprint } from "../core/fingerprint";

export interface ParagraphCandidate {
  text: string;
  fingerprint: string;
  from: EditorPosition;
  to: EditorPosition;
  line: number;
}

const STRUCTURAL = /^(?:#{1,6}\s|>\s*\[!|>+\s*|\[\^[^]]+\]:|```|~~~|\$\$|[-*_]{3,}\s*$)/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const EMBED_ONLY = /^\s*!\[\[[^\]]+\]\]\s*$/;

/** Markdown paragraph boundaries are deliberately conservative so an edit stays local. */
export function paragraphCandidateAt(editor: Editor, cursor = editor.getCursor("head")): ParagraphCandidate | null {
  const total = editor.lineCount();
  if (total === 0) return null;
  let line = Math.max(0, Math.min(cursor.line, total - 1));
  if (!editor.getLine(line).trim() && line > 0) {
    line -= 1;
    while (line > 0 && !editor.getLine(line).trim()) line -= 1;
  }
  const endLine = line;
  if (!editor.getLine(endLine).trim()) return null;

  let startLine = endLine;
  if (!isListItem(editor.getLine(startLine))) {
    while (startLine > 0) {
      const previous = editor.getLine(startLine - 1);
      if (!previous.trim() || isStructural(previous) || isListItem(previous) || TABLE_ROW.test(previous)) break;
      startLine -= 1;
    }
  }

  let stopLine = endLine;
  while (stopLine + 1 < total) {
    const next = editor.getLine(stopLine + 1);
    if (!next.trim() || isStructural(next) || isListItem(next) || TABLE_ROW.test(next)) break;
    stopLine += 1;
  }

  const from = { line: startLine, ch: 0 };
  const to = stopLine + 1 < total
    ? { line: stopLine + 1, ch: 0 }
    : { line: stopLine, ch: editor.getLine(stopLine).length };
  const text = editor.getRange(from, to).trim();
  if (!isEnhanceableParagraph(text, editor, startLine)) return null;
  return { text, fingerprint: fingerprint(text), from, to, line: startLine };
}

export function isEnhanceableParagraph(text: string, editor?: Editor, startLine = 0): boolean {
  const normalized = text.trim();
  if (normalized.length < 20 || normalized.length > 12_000) return false;
  if (STRUCTURAL.test(normalized) || TABLE_ROW.test(normalized) || EMBED_ONLY.test(normalized)) return false;
  if ((normalized.match(/```/g) ?? []).length > 0 || (normalized.match(/\$\$/g) ?? []).length > 0) return false;
  if (editor && fenceState(editor, startLine) !== "text") return false;
  return /[\p{L}]/u.test(normalized);
}

/** A cheap first gate used before asking an optional Laya server. */
export function looksComplete(text: string): boolean {
  const value = text.trim();
  if (value.length < 40) return false;
  if (/(?:^|[\s(])[^)]+$/.test(value) || /\b(?:and|or|but|because|which|that|with|to|of|the|a|an|is|are|was|were)\s*$/i.test(value)) return false;
  if (/[.!?)](?:[*_~`"')\]]*)$/.test(value)) return true;
  if (/```[^\n]*$|^#{1,6}\s/.test(value)) return true;
  return false;
}

function isStructural(line: string): boolean {
  return STRUCTURAL.test(line) || TABLE_ROW.test(line) || EMBED_ONLY.test(line);
}

function isListItem(line: string): boolean {
  return /^\s*(?:[-+*]|\d+[.)])\s+/.test(line);
}

function fenceState(editor: Editor, beforeLine: number): "text" | "fence" {
  let state: "text" | "fence" = "text";
  for (let line = 0; line < beforeLine; line += 1) {
    if (/^\s*(?:```|~~~)/.test(editor.getLine(line))) state = state === "text" ? "fence" : "text";
  }
  return state;
}
