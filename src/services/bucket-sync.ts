import { TFile, TFolder, type App } from "obsidian";
import { sourceKind } from "../domain/source-kinds";
import type { ContextStore } from "./store";

/**
 * Rebuilds buckets from the storage folder layout on plugin load so a fresh
 * install (or a re-download) recovers buckets from the vault itself.
 *
 * Layout: <storageFolder>/<bucket name>/<source files>
 * A bucket is created for each subfolder that contains at least one supported
 * source file. Existing buckets with the same name keep their identity; only
 * missing sources are added. Nothing is ever deleted from the vault.
 */
export async function syncBucketsFromFolder(app: App, store: ContextStore): Promise<number> {
  const storageFolder = store.settings.storageFolder || "Context Bucket";
  const root = app.vault.getAbstractFileByPath(storageFolder);
  if (!(root instanceof TFolder)) return Promise.resolve(0);

  let addedSources = 0;
  for (const child of root.children) {
    if (!(child instanceof TFolder)) continue;
    const bucketName = child.name;
    const files = collectSupportedFiles(child);
    if (!files.length) continue;

    let bucket = store.buckets.find((item) => item.name.toLowerCase() === bucketName.toLowerCase());
    if (!bucket) bucket = store.createBucket(bucketName);

    for (const file of files) {
      const already = bucket.sources.some((source) => source.sourcePath === file.path);
      if (already) continue;
      const kind = sourceKind(file.extension.toLowerCase());
      if (!kind) continue;
      store.addSource({
        id: crypto.randomUUID(),
        bucketId: bucket.id,
        name: file.name,
        kind,
        sourcePath: file.path,
        extractedPath: file.path,
        createdAt: file.stat.ctime,
        size: file.stat.size,
        origin: "imported",
        sourceMtime: file.stat.mtime,
      });
      addedSources += 1;
    }
  }
  return Promise.resolve(addedSources);
}

function collectSupportedFiles(folder: TFolder): TFile[] {
  const files: TFile[] = [];
  for (const child of folder.children) {
    if (child instanceof TFolder) files.push(...collectSupportedFiles(child));
    else if (child instanceof TFile && sourceKind(child.extension.toLowerCase())) files.push(child);
  }
  return files;
}