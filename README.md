# Context Bucket for Obsidian

Context Bucket is a local-first Obsidian plugin for collecting class context and reviewing notes while you write. Put slides, readings, teacher notes, and lecture transcripts into a **context bucket**. When you stop typing a completed paragraph, Context Bucket retrieves relevant excerpts and asks a local Ollama model to suggest corrections, critical omissions, clarifications, and Markdown formatting.

## Safety model

Context Bucket never changes a note automatically. Model output is stored as a review card with:

- the proposed edit and a plain-language explanation;
- a confidence score;
- the source IDs used as evidence;
- explicit **Accept** and **Dismiss** controls.

An accepted suggestion is applied only when its exact anchor still occurs once in the current note. Outdated, ambiguous, oversized, or no-op suggestions are marked stale and are not applied.

## Requirements

- Obsidian 1.8.10 or newer.
- A local Ollama installation for note enhancement.
- A desktop vault for microphone recording and local file-backed transcription.
- Optional: a local Laya completion service and a JSON-line transcription helper.

Ollama must be reachable at a loopback URL. Start Ollama, install a model, then copy the exact model name into settings, for example:

```bash
ollama serve
ollama pull llama3.2:3b
```

## Install for development

```bash
npm install
npm run build
```

Copy `main.js`, `manifest.json`, and `styles.css` into:

```text
<vault>/.obsidian/plugins/context-bucket/
```

Then enable **Context Bucket** under Obsidian’s community plugin settings. The ribbon inbox icon opens the sidebar; the command palette also exposes paragraph and whole-note review commands.

## Workflow

1. Create a bucket in the Context Bucket sidebar.
2. Import one or more Markdown/text, PDF, DOCX, PPTX, audio, or transcript files with **Import files**. Imported documents are copied into the configured vault folder and searchable text is generated where supported. Each file is processed independently, so one failed file does not block the rest.
3. Attach a bucket to the open Markdown note from the sidebar. A bucket can be attached to many notes, but each note has exactly one active bucket. **Detach** removes only that note’s attachment; it does not delete the bucket or its manually imported files.
4. When an attached note changes, Context Bucket resolves its Markdown links and embeds against the vault. Supported linked files (`.md`, text formats, PDF, DOCX, PPTX, audio, and transcripts) are added as **linked** sources. The original vault file is never copied or deleted. Linked PDF/DOCX/PPTX text is refreshed when the original changes; removing an unlink removes the generated text sidecar only.
5. Record a lecture with the sidebar control. The WAV is saved in the bucket. Configure the local transcription helper and select **Transcribe** to save a Markdown transcript and add it to retrieval.
6. Pause after a completed paragraph, or use **Review paragraph** / **Review note**.
7. Inspect the review cards and accept only the changes you want.

## Settings

settings include live enhancement, debounce interval, completion mode, Ollama URL/model, context character budget, request timeout, source storage folder, and transcription helper/model-folder paths. The optional Laya URL controls paragraph completion detection; the default heuristic mode is local and conservative.

## Privacy

Bucket source files stay in the vault. The plugin sends only the configured note target and a bounded set of retrieved source excerpts to the local enhancement service. No remote API is required. The transcription helper is invoked locally and is not bundled with the plugin.

## Development checks

```bash
npm run typecheck
npm test
npm run lint
npm run build
```
