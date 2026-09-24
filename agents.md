# Context Bucket / Context Bucket — Agent Handoff

## Project identity

- Repository: `/Users/gabi/CodingProjects/context-bucket`
- Obsidian plugin ID: `context-bucket`
- Plugin name: `Context Bucket`
- Version: `0.1.0`
- Minimum Obsidian: `1.8.10`
- Desktop-only because recording, local process transcription, and local file-backed storage are supported.
- Production entry point: `src/main.ts`, bundled by esbuild to `main.js`.

Context Bucket is a local-first Obsidian plugin for collecting class context and reviewing notes while the user writes. A user creates a context bucket, imports or links sources, attaches a bucket to a Markdown note, pauses after a completed paragraph, and receives review-only AI suggestions for corrections, omissions, clarifications, and Markdown formatting. The plugin never edits a note automatically.

## User workflow currently implemented

1. Open the sidebar from the ribbon or the command **Open context bucket sidebar**.
2. Create one or more buckets.
3. Import multiple files in one picker operation. Supported extensions are `.md`, `.markdown`, `.txt`, `.csv`, `.json`, `.pdf`, `.docx`, `.pptx`, `.wav`, `.mp3`, `.m4a`, `.webm`, `.vtt`, and `.srt`.
4. Imported files are copied into the configured vault folder (default `Sources/<sanitized bucket name>/`). PDF, DOCX, and PPTX import also create searchable extracted text.
5. Attach one bucket to the current Markdown note. One bucket may be attached to many notes; each note has one active bucket. **Detach** only removes the note-to-bucket assignment.
6. Markdown links and embeds in an attached note are resolved against the vault and supported linked files are synchronized as sources. Original linked files are never copied or deleted.
7. Record a lecture, then transcribe it with a local helper. Recordings and transcripts become generated sources.
8. Use live paragraph review or explicit paragraph/document review commands. Review cards are shown in the sidebar.
9. Accept or dismiss each suggestion. Applying a suggestion performs a second exact-anchor safety check immediately before editing.

## Safety and privacy invariants

These are important design constraints; preserve them unless the product requirements intentionally change.

- Model output is never applied without explicit user review.
- Model edits are limited to `replace`, `insert_before`, and `insert_after`; there is no delete operation.
- Every model target must be an exact, non-empty substring that occurs exactly once in the review target.
- The anchor is re-resolved against the current editor document when a suggestion is accepted.
- Missing, ambiguous, oversized, no-op, or otherwise unsafe anchors are marked `stale` and are not applied.
- Model output is parsed defensively: invalid JSON, invalid operations/kinds, low confidence (`< 0.55`), duplicate/unknown source IDs, and malformed replacements are discarded.
- The model receives only the current target plus a bounded amount of retrieved source text, not the whole vault.
- Local HTTP helpers reject non-loopback hosts. Allowed hosts are `localhost`, `127.0.0.0/8`, and `::1`; credentials in URLs are rejected.
- Do not add remote API support without an explicit product/privacy decision.
- Source ingestion limits files to 50 MB and extracted text to approximately 2 MB. Retrieval skips source files over 4 MB and ignores audio records directly.
- Never mutate a note in response to a model response without an explicit accept action.

## Architecture map

### Entry point and lifecycle

- `src/main.ts`: plugin bootstrap, view registration, commands, workspace/metadata/vault event wiring, and coordinator disposal.
- Registered view type: `context-bucket-view`.
- Commands: `open-context-bucket`, `review-current-paragraph`, `review-current-note`.
- Important events: `editor-change`, `file-open`, `layout-change`, metadata cache `changed`, and vault `modify`.
- `onunload()` disposes enhancement, linked-source, and lecture workflows.

### Data model and persistence

- `src/types.ts`: persisted/runtime interfaces and unions.
- `src/defaults.ts`: default settings/data, schema version 2, and defensive normalization.
- `src/services/store.ts`: `ContextStore`, bucket/note assignments, source reconciliation, suggestions, analysis state, queued saves, and active Markdown note resolution.
- Plugin data is stored through Obsidian `loadData()`/`saveData()` under the plugin data file, not a vault folder.
- Persisted shape: `{ schemaVersion, settings, buckets, noteBucketAssignments, suggestions, analysis }`.
- `noteBucketAssignments` maps a note path to one bucket ID.
- `AnalysisState` tracks document revision, last full review revision/time, and completed paragraph fingerprints.
- `SourceRecord` tracks `origin` (`imported`, `linked`, or `generated`), source path, optional extracted path, size, mtime, and `linkedFrom` note paths.
- Suggestions are persisted with status `pending`, `accepted`, `rejected`, or `stale`; pending suggestions are pruned after 30 days and the collection is capped at 1,000.

### Live enhancement

- `src/services/enhancement-coordinator.ts`: debounced live review, explicit review, retrieval/model calls, stale protection, apply/reject/apply-all, and state listeners.
- Default paragraph pause: 1,600 ms.
- Live enhancement only runs for the active attached Markdown note and only when its bucket has sources.
- Paragraph completion defaults to the conservative local heuristic; optional Laya completion detection is supported.
- Paragraph extraction is deliberately conservative and excludes headings, structural blocks, tables, embeds-only content, code/math fences, and very short/large candidates.
- Requests are cancelled/tokened per file so a response cannot be written to the wrong or changed document.
- `src/domain/paragraphs.ts`: paragraph boundaries and completion heuristic.
- `src/domain/suggestions.ts`: exact unique-anchor resolution and human-readable suggestion labels.
- `src/core/fingerprint.ts`: paragraph fingerprinting.

### Retrieval and local AI

- `src/services/context-retrieval.ts`: reads source/extracted text, chunks paragraphs, ranks lexical matches, and enforces the context character budget.
- Retrieval uses token frequency plus IDF-like weighting; a matching chunk should outrank an unrelated chunk.
- `src/integrations/local-http.ts`: loopback URL validation and JSON requests with timeouts.
- `src/services/ollama-client.ts`: Ollama `/api/tags` health/model listing and `/api/chat` structured enhancement request. The client uses `format: "json"`, low temperature, bounded context, and no streaming.
- Ollama system prompt requires JSON only, source-grounded edits, preserving student voice (reinforced with an `AUTHOR_STYLE_SAMPLE` block of surrounding note text), no invented facts/citations, and at most six suggestions (the parser defensively caps input output at 12).
- If no Ollama model is configured, review fails with a clear settings error. Default model: `qwen3.5:4b`; default storage folder: `Sources`.
- `src/integrations/laya-client.ts`: optional local `/v1/systemone` paragraph-completion decision; it does not edit notes. When Laya is enabled it also acts as a style gate: `replace` suggestions whose replacement does not match the author's voice are dropped before display. Gate failures pass suggestions through.
- `src/services/suggestion-decorations.ts`: CodeMirror 6 ViewPlugin that underlines pending suggestion anchors in the note editor using the native accent color. Hovering an anchor shows a hover card (same content as the sidebar card plus Accept/Dismiss) positioned at the bottom-left of the suggestion block with a 250ms hide grace so the pointer can move into the card.
- `src/services/edit-log.ts`: `appendEditLog()` records every accept/dismiss to `<storageFolder>/edits.json` (capped at 5,000 entries).

### Sources and linked files

- `src/domain/source-kinds.ts`: extension-to-source-kind mapping.
- `src/services/source-ingestion.ts`: imported and linked file ingestion, extraction, path naming, sidecars, PDF.js, Mammoth DOCX, and fflate PPTX extraction.
- `src/services/linked-source-coordinator.ts`: debounced link/embed resolution, synchronization, refresh on vault modification, and reconciliation.
- Imported files are copied into the bucket storage folder. Linked files remain at their original `sourcePath`.
- PDF/DOCX/PPTX linked files use generated extracted-text sidecars under the configured storage folder. The sidecar is the retrieval text; the original remains untouched.
- Linked-source reconciliation is reference-counted through `linkedFrom`: a source remains if another attached note still links it.
- If a linked source is no longer referenced, only Context Bucket’s generated sidecar is trashed; the original linked file is not deleted.
- PDF.js worker support is imported from `pdfjs-dist/build/pdf.worker.mjs`; the built plugin must be rebuilt after changing this.
- Imported-source failures are isolated per file; one bad file does not stop a multi-file import.

### Lecture capture

- `src/services/recording-service.ts`: microphone permission, mono capture, level/elapsed state, downsampling, and WAV encoding at 16 kHz/16-bit PCM.
- `src/services/transcription-service.ts`: spawns a configured local executable and consumes newline-delimited JSON messages on stdout.
- `src/services/lecture-workflow.ts`: coordinates recording, saves generated WAV sources, invokes transcription, creates a Markdown transcript beside the recording, and registers the transcript as a generated source.
- The transcription helper is external and is not bundled. Its expected contract is documented in the source comments: one JSON line on stdin, JSON-line progress/result/error messages on stdout.
- The `cancel()` method sends a cancel message and kills the child process.

### UI

- `src/ui/bucket-view.ts`: sidebar rendering, bucket selection/attachment/detach, multi-file import, source list, linked-source status, review cards (Markdown/LaTeX rendered, diff-style change lines, click a card to scroll the editor to its underlined anchor), review buttons with Siri-style review animation and last-scanned label, and lecture controls.
- `src/ui/bucket-modal.ts`: new-bucket modal.
- `src/ui/settings-tab.ts`: live enhancement, debounce, completion mode, Ollama URL/model, context budget, timeout, source folder, and transcription settings.
- `styles.css`: theme-variable-based “field-notebook ledger” styling. It intentionally uses Obsidian CSS variables so light/dark themes remain native (accents use `--text-accent`, `--color-orange`).

## Obsidian CLI live testing

The user has the obsidian CLI enabled. Testing vault (the ONLY permitted vault): `/Users/gabi/CodingProjects/plugin-development`. Pattern: `obsidian vault=plugin-development eval code="..."`, then `obsidian vault=plugin-development reload` after copying `main.js`, `manifest.json`, and `styles.css` into `<vault>/.obsidian/plugins/context-bucket/` (wait ~6s after reload). Long-running async evals may silently drop output: write results to a file in the vault via `app.vault.adapter.write()` and read it back, then delete the test file. Avoid `Set`/spread iteration in evals (older serializer quirks). Never touch the user's other vaults.


## Development commands

Run from `/Users/gabi/CodingProjects/context-bucket`:

```bash
npm install
npm run typecheck   # strict tsc, no emit
npm test            # Vitest safety/unit tests
npm run lint        # ESLint src and tests
npm run build       # typecheck + minified production main.js
npm run build:dev   # typecheck + esbuild watch mode
npm run release     # writes installable dist/ contents
```

The last recorded validation before this handoff was:

- `npm run typecheck` passed.
- `npm test` passed with 12 tests.
- `npm run lint` passed.
- `npm run build` passed.
- `git diff --check -- src tests styles.css README.md` passed.

Tests are currently concentrated in `tests/safety.test.ts` and cover unique anchors, ambiguous/no-op suggestions, model-output filtering, source provenance normalization, supported source kinds, malformed persistence normalization, and retrieval ranking. There are no automated Obsidian integration/E2E tests.

## Installing the built plugin locally

Build first, then copy these files into the vault plugin directory:

```text
<vault>/.obsidian/plugins/context-bucket/main.js
<vault>/.obsidian/plugins/context-bucket/manifest.json
<vault>/.obsidian/plugins/context-bucket/styles.css
```

The README currently shows a historical directory name `context-bucket`; the actual `manifest.json` ID is `context-bucket`. Prefer the manifest ID unless the manifest is intentionally renamed.

After copying, enable **Context Bucket** in Obsidian community-plugin settings and reload the app with `Ctrl/Cmd+P` → **Reload app without saving**. The bundle is generated at `/Users/gabi/CodingProjects/context-bucket/main.js`.

## Repository hygiene and current state

- Git reports `No commits yet on master`; do not assume a clean baseline or rely on commit history.
- `.gitignore` is currently empty. Before committing, add appropriate ignores for `node_modules/`, `.DS_Store`, IDE metadata (`.idea/` unless intentionally tracked), build output if desired, and local vault/test artifacts. Do not delete source or generated plugin files without understanding the release workflow.
- `node_modules/`, `.DS_Store`, `.idea/`, `main.js`, `src/.DS_Store`, and other local files are currently visible in the working tree. Review `git status` before staging.
- `main.js` is the production artifact generated from source. `dist/` is created by `npm run release`; it is not part of the current handoff validation.
- `package-lock.json` is present and should be retained for reproducible installs.
- `index.js` appears unrelated/generated and should not be bundled into the plugin unless intentionally investigated.

## Known limitations and likely next work

1. Add real Obsidian integration tests using a test vault or a controlled mock App/Vault. Current unit tests do not prove open-note detection, editor-change timing, sidecar lifecycle, or sidebar rendering.
2. Verify Ollama behavior with a real local model, including long documents, PDFs with unusual layouts, and model responses that violate the prompt.
3. Review the UI’s handling of large buckets and large suggestion collections; it currently renders synchronously.
4. Consider a progress/cancel surface for multi-file extraction and linked-source synchronization.
5. Consider explicit bucket deletion UI; `ContextStore.deleteBucket()` exists, but the sidebar currently primarily supports creation/selection and source removal.
6. Add a settings health check that lists Ollama models and lets the user select an installed model.
7. Confirm mobile/remote-vault behavior. The manifest is desktop-only, and recording/transcription currently require desktop filesystem/process capabilities.
8. If a transcription helper is maintained separately, document and test its exact JSON-line protocol in its own repository.
9. Keep the PDF worker import and rebuild workflow intact when upgrading `pdfjs-dist`.
10. Do not weaken exact-anchor review, loopback URL enforcement, source budgets, or review-only behavior to make implementation easier.

## Recommended next-agent sequence

1. Read `agents.md`, `README.md`, `package.json`, `src/main.ts`, `src/types.ts`, and the affected coordinator/service files before editing.
2. Run `npm run typecheck`, `npm test`, and `npm run lint` to establish the current baseline.
3. Make the smallest change matching the requested behavior and preserve the existing domain contracts.
4. Add or update safety tests for any change to anchor resolution, persistence normalization, source provenance, retrieval, or model parsing.
5. Run `npm run build` and inspect the emitted bundle when changing imports, PDF extraction, Node APIs, or Obsidian API usage.
6. Use a real vault only for manual Obsidian validation; never use a live vault as a test fixture.
7. Update `README.md` and this handoff when behavior, settings, external helper contracts, or known limitations change.
8. Before staging, inspect `git status` and exclude `node_modules/`, IDE files, `.DS_Store`, and other machine-specific artifacts unless explicitly intended.

## Absolute reference paths

- Plugin source root: `/Users/gabi/CodingProjects/context-bucket/src`
- Tests: `/Users/gabi/CodingProjects/context-bucket/tests/safety.test.ts`
- README: `/Users/gabi/CodingProjects/context-bucket/README.md`
- Build config: `/Users/gabi/CodingProjects/context-bucket/esbuild.config.mjs`
- Generated bundle: `/Users/gabi/CodingProjects/context-bucket/main.js`
- Plugin manifest: `/Users/gabi/CodingProjects/context-bucket/manifest.json`
- Theme CSS: `/Users/gabi/CodingProjects/context-bucket/styles.css`

