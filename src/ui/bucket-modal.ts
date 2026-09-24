import { Modal } from "obsidian";

export class BucketModal extends Modal {
  private input: HTMLInputElement | null = null;
  private submitButton: HTMLButtonElement | null = null;

  public constructor(app: ConstructorParameters<typeof Modal>[0], private readonly onSubmit: (name: string) => void) {
    super(app);
  }

  public override onOpen(): void {
    this.titleEl.setText("New context bucket");
    this.modalEl.addClass("context-bucket-bucket-modal");
    this.contentEl.empty();
    const copy = this.contentEl.createEl("p", { text: "Keep the slides, readings, and lecture context for one class or topic together." });
    copy.addClass("context-bucket-muted");
    this.input = this.contentEl.createEl("input", { type: "text", value: "" });
    this.input.placeholder = "e.g. Cognitive Psychology — Week 3";
    this.input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") this.submit();
    });
    const row = this.contentEl.createEl("div");
    row.addClass("context-bucket-modal-actions");
    const cancel = row.createEl("button", { text: "Cancel" });
    cancel.type = "button";
    cancel.addEventListener("click", () => this.close());
    this.submitButton = row.createEl("button", { text: "Create bucket" });
    this.submitButton.type = "button";
    this.submitButton.addClass("mod-cta");
    this.submitButton.addEventListener("click", () => this.submit());
    window.setTimeout(() => this.input?.focus(), 0);
  }

  public override onClose(): void {
    this.contentEl.empty();
  }

  private submit(): void {
    const name = this.input?.value.trim() ?? "";
    if (!name) {
      this.input?.focus();
      return;
    }
    this.onSubmit(name);
    this.close();
  }
}
