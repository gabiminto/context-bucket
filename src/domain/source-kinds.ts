import type { SourceKind } from "../types";

const SOURCE_EXTENSIONS: Record<string, SourceKind> = {
  md: "note",
  markdown: "note",
  txt: "text",
  csv: "text",
  json: "text",
  pdf: "pdf",
  docx: "docx",
  pptx: "pptx",
  wav: "recording",
  mp3: "recording",
  m4a: "recording",
  webm: "recording",
  vtt: "transcript",
  srt: "transcript",
};

export function sourceKind(extension: string): SourceKind | null {
  return SOURCE_EXTENSIONS[extension.toLowerCase()] ?? null;
}
