import { PluginSettingTab, Setting, type App } from "obsidian";
import type ContextBucketPlugin from "../main";
import type { ContextBucketSettings } from "../types";

export class ContextBucketSettingsTab extends PluginSettingTab {
  public constructor(app: App, private readonly plugin: ContextBucketPlugin) { super(app, plugin); }

  public override display(): void {
    const { containerEl } = this;
    const settings = this.plugin.store.settings;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Context Bucket settings" });
    containerEl.createEl("p", { text: "Context Bucket keeps note edits review-only. Model requests are restricted to local loopback services.", cls: "context-bucket-muted" });

    new Setting(containerEl).setName("Live enhancement").setDesc("Review completed paragraphs after you pause typing.")
      .addToggle((toggle) => toggle.setValue(settings.liveEnhancement).onChange((value) => this.persist({ liveEnhancement: value })));
    new Setting(containerEl).setName("Paragraph pause").setDesc("Milliseconds to wait after typing stops.")
      .addText((text) => text.setValue(String(settings.paragraphPauseMs)).onChange((value) => this.persist({ paragraphPauseMs: toNumber(value, settings.paragraphPauseMs) })));
    new Setting(containerEl).setName("Completion detector").setDesc("Use the conservative local heuristic or the optional Laya service.")
      .addDropdown((dropdown) => dropdown.addOptions({ heuristic: "Heuristic", laya: "Laya" }).setValue(settings.completionMode).onChange((value) => this.persist({ completionMode: value as ContextBucketSettings["completionMode"] })));
    new Setting(containerEl).setName("Completion threshold").setDesc("Laya confidence threshold for treating a paragraph as complete.")
      .addText((text) => text.setValue(String(settings.completionThreshold)).onChange((value) => this.persist({ completionThreshold: toNumber(value, settings.completionThreshold) })));

    containerEl.createEl("h3", { text: "Local model" });
    new Setting(containerEl).setName("Ollama URL").setDesc("Loopback URL, usually http://127.0.0.1:11434.")
      .addText((text) => text.setValue(settings.enhancementBaseUrl).onChange((value) => this.persist({ enhancementBaseUrl: value })));
    new Setting(containerEl).setName("Ollama model").setDesc("Exact model name returned by Ollama, for example llama3.2:3b.")
      .addText((text) => text.setValue(settings.enhancementModel).onChange((value) => this.persist({ enhancementModel: value })));
    new Setting(containerEl).setName("Context budget").setDesc("Maximum characters of relevant source excerpts sent to the model.")
      .addText((text) => text.setValue(String(settings.contextCharacterBudget)).onChange((value) => this.persist({ contextCharacterBudget: toNumber(value, settings.contextCharacterBudget) })));
    new Setting(containerEl).setName("Request timeout").setDesc("Model request timeout in milliseconds.")
      .addText((text) => text.setValue(String(settings.requestTimeoutMs)).onChange((value) => this.persist({ requestTimeoutMs: toNumber(value, settings.requestTimeoutMs) })));

    containerEl.createEl("h3", { text: "Lecture transcription" });
    new Setting(containerEl).setName("Transcription helper").setDesc("Absolute path to the local JSON-line transcription helper executable.")
      .addText((text) => text.setValue(settings.transcriptionHelperPath).onChange((value) => this.persist({ transcriptionHelperPath: value })));
    new Setting(containerEl).setName("Model folder").setDesc("Optional folder passed to the transcription helper.")
      .addText((text) => text.setValue(settings.transcriptionModelFolder).onChange((value) => this.persist({ transcriptionModelFolder: value })));
    new Setting(containerEl).setName("Source storage folder").setDesc("Vault folder for imported and recorded sources.")
      .addText((text) => text.setValue(settings.storageFolder).onChange((value) => this.persist({ storageFolder: value })));
  }

  private persist(update: Partial<ContextBucketSettings>): void {
    this.plugin.store.updateSettings(update);
  }
}

function toNumber(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

