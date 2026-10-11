# BugReporter — Knowledge Base

Reference for how this Chrome extension works: features, files, data flow, UI/UX and known quirks.
Snapshot of **v1.3.7** (`manifest.json`). Plain JavaScript, no build step, no framework, no tests.

> `README.md` is the user-facing guide. This file covers the internals.

---

## 1. What it does

BugReporter turns screenshots, notes and voice into a ready-to-paste bug ticket (Jira/Linear style) using a vision-capable LLM. The user brings their own API key.

**Core loop:** capture evidence → describe the bug → **Generate Ticket** → refine with chat → **Copy** (rich HTML + image) → paste into the tracker.

### Feature list

| Feature | Where | Notes |
|---|---|---|
| Capture visible tab | Popup → "Capture current screen" | `chrome.tabs.captureVisibleTab` (PNG). Honors capture delay. |
| Capture & annotate | Popup → "Capture & Annotate" | Opens `annotate.html` in a new tab |
| Upload images | Popup → Upload | PNG/JPEG/WebP, multi-select, fills up to the limit |
| Max 6 screenshots | `MAX_SCREENSHOTS` in popup.js | Grid shows at most 3 empty placeholders |
| Edit existing screenshot | ✏️ on thumbnail (capture or result panel) | Reopens the annotator and replaces in place |
| Preview modal | Click thumbnail; 👁 on GIF/video rows; click result-panel GIF | ←/→/Esc for screenshots. GIF/video open in single mode (`showMediaPreview`, no arrows). All closes go through `closePreview()`, which pauses and unloads the video |
| Voice-to-text note | 🎙️ mic button | Web Speech API running in the **content script** of the active page, live transcript into the note |
| Video recording | Popup → Record Video (off by default; enable in Settings) | `recorder.html` uses `getDisplayMedia`, mic mix, optional webcam PiP, transcript, trimming |
| GIF recording | Popup → Record GIF | tabCapture → offscreen doc → gif.js. 12 fps, max 12 s, max 1280 px wide |
| AI ticket generation | Popup → Generate Ticket | Runs in the service worker, survives popup close, cancellable |
| 4 AI providers | Settings | Gemini (default), OpenAI, Anthropic, xAI |
| Refine with AI | Result panel chat box | Sends current ticket + feedback + history + screenshots |
| Edit inputs & regenerate | Result panel → collapsible "edit inputs" | See [Known issues](#10-known-issues--gotchas) |
| Keyboard shortcuts | Cmd/Ctrl+Shift+S, Cmd/Ctrl+Shift+M | Work with the popup closed; toolbar badge feedback (see §7) |
| Rich copy | Result → Copy | Clipboard gets text/plain + text/html (Markdown→HTML) + image/png (single image or vertical composite) |
| Token usage | Under result | Low/Medium/High badge, in/out tokens, cumulative "Session" total |
| Session persistence | `chrome.storage.local` | Popup restores screenshots, note, fields, result and chat on reopen |
| Settings import/export | Settings footer | JSON, **API keys excluded** |
| Default settings on install | `setting-data.json` | Applied once on `onInstalled` (reason `install`) |

---

## 2. File map

```
manifest.json              MV3 config, permissions, commands, content script
background.js              Service worker: prompts, AI calls, generation state, screenshot, GIF orchestration
popup.html / popup.js      Main UI (≈1.5k lines HTML with inline CSS, ≈2k lines JS)
content.js                 Injected into every page: speech recognition + page meta
annotate.html / .js        Full-tab screenshot annotation editor (canvas)
recorder.html / .js        Full-tab video recorder + trimmer
recording-controls.js      Floating REC chip injected into the recorded tab (video)
gif-recording-controls.js  Floating GIF chip injected into the recorded tab
offscreen.html / .js       Offscreen document: tab-capture GIF encoding (+ legacy frame-capture)
settings.html / .js        Options page (opened in a tab, not via options_page)
setting-data.json          Default settings seeded on first install
styles.css                 Shared design tokens/components (loaded by popup, annotate, settings, recorder)
toast.js                   Global showToast() + injected toast CSS
icons.js                   Lucide SVG strings; `icons`, getIcon(), createIcon()
lib/gif.js, gif.worker.js  Vendored gif.js (minified)
icons/                     Toolbar icons (16/32/48/128) + icon2.png (popup logo)
```

`.DS_Store` files are committed. There is no `.gitignore`.

---

## 3. Architecture & contexts

```
┌──────────── popup.html (popup.js) ─────────────┐
│ state, session storage, UI                      │
└──┬──────────────┬───────────────┬───────────────┘
   │runtime msg   │tabs.sendMessage│tabs.create
   ▼              ▼               ▼
background.js   content.js      annotate.html / recorder.html / settings.html
(service worker) (active page)  (extension tabs)
   │  │                              │
   │  └─ fetch → AI provider APIs    └─ executeScript → recording-controls.js (target tab)
   │
   ├─ offscreen.html (offscreen.js + gif.js) ← tabCapture stream id
   └─ executeScript → gif-recording-controls.js (target tab)
```

Contexts communicate in two ways:
1. **`chrome.runtime` / `chrome.tabs` messages**, for live events.
2. **`chrome.storage.local` handoff keys**, for results that must outlive the popup. The popup closes whenever focus leaves it (e.g. when a new tab opens), so the annotator, recorder and GIF flows write their result to storage and the popup picks it up on its next `init()`.

### Storage keys (`chrome.storage.local`, `unlimitedStorage`)

| Key | Writer | Reader | Shape / purpose |
|---|---|---|---|
| `bugReporterSettings` | settings.js, background (install) | everyone | All settings incl. API keys (plain text) |
| `bugReporterSession` | popup.js | popup.js | `{screenshots[], note, component, severity, videoBlobUrl, generatedTicket, showingResult, chatHistory}` |
| `bugReporterGenerationState` | background.js | popup.js | `{isGenerating, generationId, startTime, payload}` → `{ticket, tokenUsage, error, cancelled, completedAt}` |
| `bugReporterUsageStats` | background.js | popup.js | `{totalTokens, ticketCount}`, cumulative and never reset |
| `bugReporterAnnotationData` | popup.js, annotate.js | both | `{screenshot, completed, returnTabId, editIndex?, fromResultPanel?, result?}` |
| `bugReporterVideoRecording` | popup.js, recorder.js | popup.js | `{targetTabId, captureDelay}` → `{videoBlobBase64, videoMimeType, videoExtension, transcript, transcriptAdded, trimMetadata?}` |
| `bugReporterGifRecording` | background (on behalf of offscreen) | popup.js | `{isRecording, rendering, startTime}` → `{gifBlobBase64, completed}` or `{error}` |

### Message types

| Message | From → To | Purpose |
|---|---|---|
| `CHECK_API_KEY` | popup → bg | Is a key set for the selected provider (drives the "⬤ connected" badge) |
| `TEST_API_KEY` | settings → bg | Calls the provider with "Hello", max 10 tokens |
| `CAPTURE_SCREENSHOT` | popup → bg | `captureVisibleTab` → dataUrl |
| `GENERATE_TICKET` | popup → bg | Starts async generation, replies at once with `generationId` |
| `CANCEL_GENERATION` | popup → bg | Aborts the fetch via `AbortController` |
| `CHECK_GENERATION_STATUS` / `CLEAR_GENERATION_STATE` | popup → bg | Polling (1 s) and cleanup |
| `GENERATION_COMPLETE` | bg → popup | Push notification of result (popup may be closed) |
| `GET_USAGE_STATS` | popup → bg | Cumulative token stats |
| `IMPROVE_TICKET` | popup → bg | Chat refinement (synchronous reply) |
| `START_GIF_RECORDING` | popup → bg | Gets tabCapture stream id, creates offscreen doc, injects chip |
| `OFFSCREEN_START_GIF` | bg → offscreen | Begin capture |
| `GIF_RECORDING_CONTROL {stop}` | GIF chip → offscreen | Stop and render |
| `SAVE_GIF_STATE` | offscreen → bg | Offscreen delegates storage writes (chrome.storage unreliable there) |
| `GIF_RECORDING_RENDERING / FINISHED / ERROR` | offscreen → popup/bg | Status; bg removes the chip on FINISHED/ERROR |
| `REMOVE_GIF_RECORDING_CONTROLS` | bg → tab | Remove GIF chip |
| `START_MIC / STOP_MIC / SYNC_TRANSCRIPT / CHECK_MIC_STATE` | popup → content | Speech control |
| `MIC_STATE / MIC_TRANSCRIPT / MIC_ERROR` | content → popup | Speech events |
| `SHORTCUT_SCREENSHOT` | bg → popup | Screenshot taken by shortcut while the popup is open |
| `GET_PAGE_META` | → content | url/title (currently unused; popup reads `tab.url/title`) |
| `RECORDING_CONTROL {pause,resume,stop,restart}` | REC chip → recorder | Video controls |
| `REMOVE_RECORDING_CONTROLS` | recorder → tab | Remove REC chip |
| `OFFSCREEN_CAPTURE`, `PING` | (none) → offscreen | **Dead code.** Legacy desktop-capture path, no sender |

---

## 4. Ticket generation logic (background.js)

1. Popup builds `audioNote` = note text + `Component/Area: …` + `Severity: …` (only for fields enabled in settings), plus `screenInfo` (screen and viewport size of the *popup* window).
2. `GENERATE_TICKET` → bg stores `isGenerating` state, replies immediately, and runs `generateTicket()` in the background.
3. `buildPrompt()` assembles:
   - **System prompt:** senior-QA persona, concise rules (1–3 lines per section, imperative steps, one action per step, name exact UI elements, present tense, optional Markdown rule for `backticks`/**bold**), plus `PRODUCT CONTEXT` and `TECH STACK`.
   - **User prompt:** `REPORTER NOTES`, `RULES` (summary/description guidelines, extra), then "Generate ONLY these sections" followed by section skeletons from `SECTION_TEMPLATES` for each `enabledSections` id, plus `customSections`.
   - The Environment section is filled with real values: browser/OS parsed from the **service worker's** UA, screen info, page title and URL.
4. `callAI()` dispatches by provider. All use temperature 0.2 and max 2048 tokens. Screenshots are sent as labelled image parts:

   | Provider | Endpoint | Model |
   |---|---|---|
   | gemini | `generativelanguage.googleapis.com/v1beta/…/gemini-2.5-flash:generateContent` | gemini-2.5-flash |
   | openai | `api.openai.com/v1/chat/completions` | gpt-4o |
   | anthropic | `api.anthropic.com/v1/messages` (`anthropic-dangerous-direct-browser-access`) | claude-sonnet-4-20250514 |
   | xai | `api.x.ai/v1/chat/completions` | grok-2-vision-1212 |

   Model names are hard-coded in two places each: `call*()` and `testApiKey()`.
5. If the `screenshots` section is enabled, `<img src="data:…">` tags are spliced into `## Screenshots`.
6. Result → `recordUsage()` → generation state → `GENERATION_COMPLETE`. Popup shows result, toasts, clears state. If the popup was closed, the next open picks the result up from `bugReporterGenerationState` ("Ticket generated while popup was closed!").

**Refine (`improveTicket`)**: separate system prompt ("only change what the user asks, return only the ticket") with current ticket, prior feedback and new feedback. Not cancellable, not tracked in usage stats.

**Ticket sections** (settings.js `DEFAULT_SECTIONS`): summary, environment, steps, expected, actual, impact, priority, acceptance, logs, screenshots, workaround, context. The defaults in `setting-data.json` enable only summary/steps/expected/actual/impact.

---

## 5. Media flows

### Screenshot annotation (`annotate.js`)
- Popup stores `{screenshot, returnTabId, editIndex?}` → opens `annotate.html`.
- Canvas is at full image resolution and CSS-scaled to fit. `baseCanvas` holds the raster base, and annotations are objects drawn on top.
- Tools: **draw** (freehand), **arrow** (Shift snaps to 45°), **rect**, **roundrect** (rounded corners; radius = ¼ of the short side, capped), **ellipse** (always drawn as a circle, then 8 handles stretch it into an oval; hit-test is the oval, not its box), **highlight** (thick, ~38% alpha), **text** (inline input, double-click to edit, resizable), **crop**. Color picker, default `#ff6b35`. Instruction text also mentions line/circle/blur, but those have no toolbar button.
- Annotation classes: `Annotation` → `RectAnnotation` (→ `BoxShapeAnnotation` → `RoundRectAnnotation`, `EllipseAnnotation`), `ArrowAnnotation`, `DrawingAnnotation`, `TextAnnotation`. `BoxShapeAnnotation` adds n/s/e/w edge handles and flips cleanly when an edge is dragged past the opposite one. They are selectable, movable and resizable. Enter commits to base, Delete removes.
- History: up to 30 JSON snapshots (base PNG + annotations). Ctrl/Cmd+Z undo, Ctrl+Y / Cmd+Shift+Z redo.
- Crop rasterizes the current canvas and **drops uncommitted annotations**.
- Keys: Esc clears the selection, or discards if nothing is selected. Ctrl/Cmd+Enter saves.
- Save writes `result` + `completed:true`, focuses the return tab and closes. Popup `checkAnnotationResult()` either replaces at `editIndex` or appends.

### Video (`recorder.js`), only when enabled in Settings
- Popup stores `{targetTabId, captureDelay}` → opens `recorder.html`.
- `getDisplayMedia` (user picks screen/window/tab, at `recordingQuality` height). Optional countdown overlay injected into the target tab if a browser tab was chosen.
- Optional webcam: canvas composite at 30 fps, position and size from settings, indigo rounded border.
- Mic + system audio mixed via `AudioContext`. A parallel `SpeechRecognition` builds a transcript.
- MIME preference: mp4/avc1 → mp4 → webm/vp9 → webm.
- Floating REC chip (`recording-controls.js`) in the target tab: draggable, pause/resume, stop, restart.
- On stop the trim UI appears. "Apply Trim" only stores `window.trimMetadata`, and the real trim happens on Save/Download by **re-recording playback in real time** through a canvas + MediaRecorder.
- Save writes base64 video + transcript to storage. Popup turns it into a blob URL and appends `[Voice transcript] …` to notes once.
- **Video is never sent to the AI.** It is download-only.

### GIF (offscreen)
- `chrome.tabCapture.getMediaStreamId` → fresh offscreen doc (`USER_MEDIA`) → `getUserMedia(chromeMediaSource:"tab")`.
- Frames drawn every 1/12 s and fed to gif.js (4 workers, quality 5). Auto-stop at 12 s.
- Popup calls `window.close()` right after starting so the user can interact with the page. The on-page GIF chip (timer `mm:ss / 00:12`, stop) controls it.
- Render timeout 45 s. The popup treats state older than 90 s as stuck and resets it.
- **GIF is never sent to the AI.** It is download-only.

### Voice notes (`content.js`)
- Speech runs in the page (popup can't keep mic access once closed). `continuous + interimResults`. `recognition.lang` = `settings.voiceLanguage` (default `en-US`), read from storage on every `START_MIC`, so the content script answers asynchronously. An `isStarting`/`cancelPendingStart` guard handles a START or STOP arriving during that read. recorder.js uses the same setting for video transcripts.
- Chrome stops recognition on silence, so `onend` auto-restarts unless the user stopped it. `no-speech`, `network` and `aborted` count as recoverable.
- The transcript appends to existing note text. Manual edits during recording sync back via `SYNC_TRANSCRIPT`.
- **Typewriter display** (popup.js `typeNoteTo`): interim transcripts are revealed gradually with `requestAnimationFrame`. The display trails the transcript by `TYPE_LAG_MS` (300ms), at a speed of `backlog / lag`, never below `TYPE_MIN_CPS` (40 chars/s), so it flows at roughly speaking pace. Characters already on screen are never erased: revised words are swapped in place at the same length. On Stop, the final text finishes fast (80ms lag, ≥150 chars/s) and is saved immediately via `saveSession(false, finalText)`. `beforeinput` finishes the pending text before a user keystroke and keeps a mid-text caret where it was. The animation aborts if something else changes the field (clear/reset). It is skipped under `prefers-reduced-motion`.
- **Interim segments**: with fast speech, Chrome returns several non-final results in one event. content.js and recorder.js concatenate them all (`interim += t`). Keeping only the last one made words vanish and reappear.
- Doesn't work on `chrome://` pages, or on tabs opened before the extension was installed/reloaded (no content script yet, so the user sees "Try refreshing the page").

---

## 6. UI / UX

### Popup layout (≈400 px wide, dark slate theme)
1. **Header:** logo (`icons/icon2.png`), title, page domain, auth badge ("⬤ sign in" / "⬤ connected", click → settings), ⚙️ settings.
2. **Stepper:** 1 Capture → 2 Describe → 3 Generate. Auto-advances: no screenshots → step 1; screenshots but no note → step 2; else step 3.
3. **Capture panel**
   - Screenshot grid (thumbs with #n, ✏️ edit, ✕ delete with confirm), count badge, "Clear All" (shown when there are 2+).
   - Button grid: Capture, Capture & Annotate, Upload, Record Video (if enabled), Record GIF (ⓘ tooltips; clicking the ⓘ is swallowed).
   - Video/GIF preview rows with ⬇ download and ✕ delete.
   - Description: mic button + timer, note textarea (fixed height, scrolls, ✕ clear).
   - Component (text) + Severity (Critical/High/Medium/Low), each toggleable in settings.
   - Generate button (disabled until there is a screenshot **or** a note), loading bar, Cancel.
4. **Result panel** (replaces the capture panel)
   - Read-only ticket textarea, "↺ redo" (regenerate), "⎘ Copy".
   - Token usage chips.
   - Collapsible "edit inputs" with note/component/severity + Regenerate.
   - Screenshot strip (click copies the image, hover ✏️ edits), video player, GIF preview with download/remove.
   - "Refine with AI" chat (Enter sends, Shift+Enter newline).
   - "← Start new bug report" (confirm, wipes everything).
5. **Overlays:** toast stack, confirm dialog (promise-based `showConfirmDialog`), image preview modal.

Emojis in popup markup are swapped for Lucide SVGs at load (`replaceEmoji` in popup.js using `icons.js`). Buttons whose innerHTML is rewritten later (e.g. after capture) may show the raw emoji again.

### Design tokens
Popup/`styles.css`: `--bg #0f172a`, `--surface #1e293b`, `--border #334155`, `--accent/--primary #4f46e5` (indigo), `--text #f1f5f9`, `--muted #94a3b8`, `--success #10b981`, `--danger #ef4444`, radius 8 px, system font stack. The video chip uses red, the GIF chip and button use violet (`--accent2`, `#7c3aed`). `toast.js` defaults reference an older palette (`#e8ff47` lime, Syne/JetBrains Mono) as fallbacks.

Note: **popup.js defines its own `showToast`**, which overrides the one from `toast.js` (later script wins) and uses the popup's `#toast-container` and CSS classes.

### Settings page sections
AI Provider (+ per-provider key, Test button, links to key consoles) · Domain Knowledge (product description, tech stack) · Ticket Sections (toggle grid + custom tag input) · Output Formatting (Markdown toggle) · Summary (format/prefix, guidelines) · Description (guidelines, extra instructions) · Popup UI Fields (Component, Severity, Video Recording) · Capture Behavior (delay 0/1/2/3/5 s) · Video Recording Configuration (webcam on/off, position, size %, quality). Sticky footer: Export, Import, dirty-state indicator, Save. Import fills the form only, so the user must click Save.

---

## 7. Permissions rationale

| Permission | Used for |
|---|---|
| `activeTab`, `tabs` | Active tab URL/title, captureVisibleTab, focus/return tabs |
| `scripting` | Inject recording chips and countdown overlay |
| `tabCapture`, `offscreen` | GIF recording |
| `storage`, `unlimitedStorage` | Base64 screenshots/video/GIF in local storage |
| `<all_urls>` host + content script | Speech recognition and capture on any site |

`commands`: **Cmd/Ctrl+Shift+S** (capture) and **Cmd/Ctrl+Shift+M** (mic), handled by `chrome.commands.onCommand` in background.js:
- **Capture**: popup closed → appends to `bugReporterSession.screenshots` (max 6). Popup open → sends `SHORTCUT_SCREENSHOT` to the popup, which owns the session in memory. Detection uses `chrome.runtime.getContexts({contextTypes:["POPUP"]})`. Ignores the capture delay.
- **Mic**: `CHECK_MIC_STATE` → `START_MIC` (seeded with the session note) or `STOP_MIC`. Injects `content.js` if the tab has no receiver.
- While the popup is closed, background persists `MIC_TRANSCRIPT` text into `bugReporterSession.note`, with writes serialized through a promise chain.
- Badge feedback: screenshot count, `MAX`, `REC` (set on `MIC_STATE` true, cleared on false or `MIC_ERROR`), `!` on error.

---

## 8. Settings schema (`bugReporterSettings`)

```js
{
  voiceLanguage: "en-US",                // BCP-47 speech locale, e.g. "en-IN"; Settings → Voice Input
  aiProvider: "gemini" | "openai" | "anthropic" | "xai",
  geminiApiKey, openaiApiKey, anthropicApiKey, xaiApiKey,   // plain text in local storage
  domainContext, techStack,
  summaryFormat, summaryGuidelines, descriptionGuidelines, extraInstructions,
  enabledSections: string[],          // ids from SECTION_TEMPLATES
  customSections: string[],           // free-form "## Name" sections
  useMarkdownFormatting: boolean,     // default true
  enabledFields: ("component"|"severity")[],
  videoRecordingEnabled: boolean,
  webcamEnabled, webcamPosition ("bottom-right"|"bottom-left"|"top-right"|"top-left"),
  webcamSize (% width), recordingQuality (px height, e.g. 720),
  captureDelay (seconds)
}
```
Legacy migrations in settings.js: `apiKey` → `geminiApiKey`; `summaryInclude/Exclude` and `descInclude/Exclude` → the consolidated guideline fields.

---

## 9. Dev workflow

- Load unpacked at `chrome://extensions` (Developer mode). No build or bundling.
- After editing `background.js` or `manifest.json`, reload the extension. After editing `content.js`, reload the extension **and** the target tabs.
- Debug: popup via right-click → Inspect; service worker from the extensions page; offscreen doc in `chrome://inspect/#other`.
- Version bump: `manifest.json` `version` (commits like "chore: increased version").
- Commit style: `feat:`, `fix:`, `chore:`.

---

## 10. Known issues / gotchas

Found while reading the code; none verified at runtime. Fixed: the edit-inputs Regenerate, the duplicated chat feedback, the unhandled shortcuts, the corrupt video Restart and the stale README.

1. **Video "Restart"** now stops the recorder and starts a fresh `MediaRecorder` on the same stream (`startMediaRecorder()` + `isRestarting`), because the first chunk carries the container header. Don't go back to clearing `recordedChunks` mid-recording.
2. **Edit-inputs Regenerate** copies the edited values into the main form and calls `btnRegen.click()`. Generation is async (`{generationId}` reply), so never read `res.ticket` from `GENERATE_TICKET`.
3. **Refine chat** sends the history *before* the new message. The new message goes only as `feedback`.
4. **`saveSession()` persists `videoBlobUrl`**, a blob URL that is invalid after the popup closes. The actual video is recovered from `bugReporterVideoRecording` instead.
5. **Popup re-toasts media on every open.** Video and GIF live in their own storage keys, not in `bugReporterSession`. They stay there until deleted or reset, so every popup open shows the "Video/GIF ready for download!" toast again.
6. **Environment browser/OS** comes from the service worker UA. Screen info comes from the popup window, not the inspected page.
7. **Import** does not restore `captureDelay`.
8. **Dead code:** offscreen `OFFSCREEN_CAPTURE`/`PING`, content `GET_PAGE_META`, `state.recognition`, `autoResizeTextarea`, `createIcon`.
9. API keys are stored unencrypted in `chrome.storage.local`. They are excluded from export and blanked on default-settings seeding.
10. The error text "Gemini error: …" in the generate handler is shown regardless of provider.
11. The usage-level thresholds (1200 / 2500 tokens) are tuned for screenshot-heavy prompts.
