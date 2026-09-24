import { Notice, Plugin, TFile, type Editor, type MarkdownFileInfo, type WorkspaceLeaf } from "obsidian";
import { BucketView } from "./ui/bucket-view";
import { ContextBucketSettingsTab } from "./ui/settings-tab";
import { EnhancementCoordinator } from "./services/enhancement-coordinator";
import { LinkedSourceCoordinator } from "./services/linked-source-coordinator";
import { LectureWorkflow } from "./services/lecture-workflow";
import { ContextStore } from "./services/store";
import { syncBucketsFromFolder } from "./services/bucket-sync";
import { buildUnderlineExtension } from "./services/suggestion-decorations";

export const CONTEXT_BUCKET_VIEW_TYPE = "context-bucket-view";

export default class ContextBucketPlugin extends Plugin {
  public store!: ContextStore;
  public coordinator!: EnhancementCoordinator;
  public linkedSources!: LinkedSourceCoordinator;
  public lecture!: LectureWorkflow;
  private refreshUnderlines: (() => void) | null = null;

  public override async onload(): Promise<void> {
    this.store = new ContextStore(this);
    await this.store.load();
    this.coordinator = new EnhancementCoordinator(this.app, this.store);
    this.linkedSources = new LinkedSourceCoordinator(this.app, this.store);
    this.lecture = new LectureWorkflow(this.app, this.store);

    const underliner = buildUnderlineExtension(
      this.app,
      (filePath) => this.store.getPendingSuggestions(filePath),
      { apply: (id) => { this.coordinator.apply(id); }, reject: (id) => { this.coordinator.reject(id); } },
    );
    this.refreshUnderlines = underliner.refresh;
    this.registerEditorExtension(underliner.extension);
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => underliner.refresh()));
    this.store.onChange(() => underliner.refresh());

    this.registerView(CONTEXT_BUCKET_VIEW_TYPE, (leaf: WorkspaceLeaf) => new BucketView(leaf, this));
    this.addSettingTab(new ContextBucketSettingsTab(this.app, this));
    this.registerEvent(this.app.workspace.on("editor-change", (editor: Editor, info: MarkdownFileInfo) => {
      this.coordinator.onEditorChange(editor, info);
    }));
    this.registerEvent(this.app.workspace.on("file-open", (file) => { if (file?.extension === "md") this.linkedSources.schedule(file); }));
    this.registerEvent(this.app.workspace.on("layout-change", () => this.linkedSources.scheduleActive()));
    this.registerEvent(this.app.metadataCache.on("changed", (file) => this.linkedSources.schedule(file)));
    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (file instanceof TFile) void this.linkedSources.refreshModified(file);
    }));
    this.app.workspace.onLayoutReady(() => {
      this.linkedSources.scheduleActive();
      void syncBucketsFromFolder(this.app, this.store).then((added) => {
        if (added > 0) new Notice(`Context Bucket restored ${added} source${added === 1 ? "" : "s"} from the vault folder.`);
      });
    });
    this.addRibbonIcon("inbox", "Open context bucket sidebar", () => { void this.openView(); });
    this.addCommand({ id: "open-context-bucket", name: "Open context bucket sidebar", callback: () => { void this.openView(); } });
    this.addCommand({ id: "review-current-paragraph", name: "Review current paragraph", callback: () => { void this.review("paragraph"); } });
    this.addCommand({ id: "review-current-note", name: "Review current note", callback: () => { void this.review("document"); } });
  }

  public override onunload(): void {
    this.coordinator?.dispose();
    this.linkedSources?.dispose();
    this.lecture?.dispose();
  }

  public async openView(): Promise<void> {
    const leaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf(true);
    await leaf.setViewState({ type: CONTEXT_BUCKET_VIEW_TYPE, active: true });
    void this.app.workspace.revealLeaf(leaf);
  }

  private async review(scope: "paragraph" | "document"): Promise<void> {
    try {
      await this.coordinator.reviewCurrent(scope);
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "Context Bucket could not review this note.");
    }
  }
}

