import { strFromU8, unzipSync } from "fflate";
import * as mammoth from "mammoth";
import "pdfjs-dist/build/pdf.worker.mjs";
import { TFile, type App } from "obsidian";
import { sourceKind } from "../domain/source-kinds";
import type { ContextBucket, SourceRecord } from "../types";

const LIMITS = { fileBytes: 50_000_000, extractedBytes: 2_000_000, entries: 10_000 };

export async function ingestFile(app: App, bucket: ContextBucket, file: File, storageFolder: string): Promise<SourceRecord> {
  if (file.size > LIMITS.fileBytes) throw new Error(`${file.name} is larger than the 50 MB local import limit.`);
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  const kind = sourceKind(extension);
  if (!kind) throw new Error(`Context Bucket cannot extract .${extension || "unknown"} files.`);
  const folder = sourceFolder(storageFolder, bucket.name);
  await ensureFolder(app, folder);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const sourcePath = uniquePath(app, `${folder}/${sanitize(file.name)}`);
  await app.vault.createBinary(sourcePath, toArrayBuffer(bytes));
  return {
    id: crypto.randomUUID(),
    bucketId: bucket.id,
    name: file.name,
    kind,
    sourcePath,
    extractedPath: await writeExtractedText(app, sourcePath, kind, bytes),
    createdAt: Date.now(),
    size: file.size,
    origin: "imported",
    sourceMtime: Number.isFinite(file.lastModified) ? file.lastModified : Date.now(),
  };
}

export async function ingestLinkedFile(app: App, bucket: ContextBucket, file: TFile, storageFolder: string): Promise<SourceRecord> {
  if (file.stat.size > LIMITS.fileBytes) throw new Error(`${file.name} is larger than the 50 MB linked-file limit.`);
  const kind = sourceKind(file.extension.toLowerCase());
  if (!kind) throw new Error(`Context Bucket cannot extract .${file.extension || "unknown"} files.`);
  let extractedPath = file.path;
  if (["pdf", "docx", "pptx"].includes(kind)) {
    const bytes = new Uint8Array(await app.vault.readBinary(file));
    extractedPath = await writeLinkedExtractedText(app, bucket, file, kind, bytes, storageFolder);
  }
  return {
    id: crypto.randomUUID(),
    bucketId: bucket.id,
    name: file.name,
    kind,
    sourcePath: file.path,
    extractedPath,
    createdAt: Date.now(),
    size: file.stat.size,
    origin: "linked",
    linkedFrom: [],
    sourceMtime: file.stat.mtime,
  };
}

export function extractPptx(bytes: Uint8Array): string {
  const archive = unzipSync(bytes, { filter: (file) => file.size < LIMITS.extractedBytes });
  const names = Object.keys(archive);
  if (names.length > LIMITS.entries) throw new Error("The PowerPoint archive has too many entries.");
  return names
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => slideNumber(a) - slideNumber(b))
    .map((name) => {
      const xml = strFromU8(archive[name] ?? new Uint8Array());
      const text = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)]
        .map((match) => decodeXml(match[1] ?? ""))
        .filter(Boolean)
        .join(" ");
      return `## Slide ${slideNumber(name)}\n\n${text}`;
    })
    .filter((slide) => !/^## Slide \d+\n\n$/.test(slide))
    .join("\n\n");
}

async function writeLinkedExtractedText(
  app: App,
  bucket: ContextBucket,
  file: TFile,
  kind: SourceRecord["kind"],
  bytes: Uint8Array,
  storageFolder: string,
): Promise<string> {
  const text = await extractText(kind, bytes);
  if (!text.trim()) throw new Error(`No searchable text was found in ${file.name}.`);
  const folder = `${sourceFolder(storageFolder, bucket.name)}/Linked text`;
  await ensureFolder(app, folder);
  const path = `${folder}/${sanitize(file.name)}-${hashPath(file.path)}.txt`;
  const existing = app.vault.getAbstractFileByPath(path);
  if (existing instanceof TFile) await app.vault.modify(existing, normalizeText(text));
  else await app.vault.create(path, normalizeText(text));
  return path;
}

async function writeExtractedText(app: App, sourcePath: string, kind: SourceRecord["kind"], bytes: Uint8Array): Promise<string | undefined> {
  const text = await extractText(kind, bytes);
  if (!text?.trim()) return undefined;
  const extracted = normalizeText(text);
  const path = uniquePath(app, `${sourcePath}.txt`);
  await app.vault.create(path, extracted);
  return path;
}

async function extractText(kind: SourceRecord["kind"], bytes: Uint8Array): Promise<string> {
  if (kind === "note" || kind === "text") return new TextDecoder().decode(bytes);
  if (kind === "pdf") return extractPdf(bytes);
  if (kind === "docx") return (await mammoth.extractRawText({ arrayBuffer: toArrayBuffer(bytes) })).value;
  if (kind === "pptx") return extractPptx(bytes);
  return "";
}

async function extractPdf(bytes: Uint8Array): Promise<string> {
  const { getDocument } = await import("pdfjs-dist");
  const document = await getDocument({ data: bytes, useWorkerFetch: false, isEvalSupported: false }).promise;
  const pages: string[] = [];
  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const lines: string[] = [];
      let current = "";
      for (const item of content.items) {
        if (!("str" in item)) continue;
        current += item.str;
        if (item.hasEOL) {
          lines.push(current.trim());
          current = "";
        } else current += " ";
      }
      if (current.trim()) lines.push(current.trim());
      pages.push(`## Page ${pageNumber}\n\n${lines.filter(Boolean).join("\n")}`);
      if (pages.join("\n").length > LIMITS.extractedBytes) break;
    }
  } finally {
    await document.destroy();
  }
  return pages.join("\n\n");
}

async function ensureFolder(app: App, path: string): Promise<void> {
  if (app.vault.getAbstractFileByPath(path)) return;
  const slash = path.lastIndexOf("/");
  if (slash >= 0) await ensureFolder(app, path.slice(0, slash));
  try {
    await app.vault.createFolder(path);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("already exists")) throw error;
  }
}

function sourceFolder(storageFolder: string, bucketName: string): string {
  return `${storageFolder || "Context Bucket"}/${sanitize(bucketName)}`;
}

function uniquePath(app: App, requestedPath: string): string {
  if (!app.vault.getAbstractFileByPath(requestedPath)) return requestedPath;
  const dot = requestedPath.lastIndexOf(".");
  const stem = dot > requestedPath.lastIndexOf("/") ? requestedPath.slice(0, dot) : requestedPath;
  const extension = dot > requestedPath.lastIndexOf("/") ? requestedPath.slice(dot) : "";
  for (let index = 2; ; index += 1) {
    const path = `${stem} ${index}${extension}`;
    if (!app.vault.getAbstractFileByPath(path)) return path;
  }
}

function sanitize(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").trim().slice(0, 120) || "Untitled";
}

function slideNumber(path: string): number {
  return Number(path.match(/slide(\d+)\.xml$/)?.[1] ?? 0);
}

function decodeXml(value: string): string {
  return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, "\n").trim().slice(0, LIMITS.extractedBytes);
}

function hashPath(path: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < path.length; index += 1) {
    hash ^= path.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
