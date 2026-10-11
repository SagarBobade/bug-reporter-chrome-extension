# 🐛 BugReporter — Ticket Generator

A Chrome extension (Manifest V3) that turns screenshots, notes, voice and screen recordings into copy-paste-ready bug tickets using an AI model. You bring your own API key, and you can choose **Gemini, OpenAI, Anthropic (Claude) or xAI (Grok)**.

---

## ✨ Features

- **Capture:** screenshot the visible tab, capture and annotate, or upload images (up to 6 per ticket).
- **Annotate:** freehand draw, arrows (Shift snaps to 45°), rectangles, rounded rectangles, circles (stretch them into ovals), highlighter, text and crop, with undo/redo. Shapes can be selected, moved and resized.
- **Voice notes:** dictate the bug description with the mic button. It uses Chrome's built-in speech recognition, so it's free and needs no setup.
- **Video recording** (optional): record a screen, window or tab with mic audio. Options include a webcam picture-in-picture, an automatic voice transcript added to your notes, and trimming before you save.
- **GIF recording:** record up to 12 seconds of the current tab as an animated GIF.
- **AI ticket generation:** produces a structured ticket (Summary, Steps to Reproduce, Expected/Actual, Impact and more). It runs in the background, so you can close the popup, and you can cancel it.
- **Refine with AI:** chat with the AI to tweak the ticket ("make it shorter", "add a step for login").
- **Rich copy:** copies the ticket as formatted HTML plus the screenshots (several screenshots are combined into one image), ready to paste into Jira, Linear and similar tools.
- **Keyboard shortcuts:** capture screenshots and toggle voice notes without opening the popup.
- **Configurable output:** choose which sections appear, add custom sections, product context, tech stack and summary/description writing rules. Settings can be exported and imported as JSON.
- **Token usage:** shows the tokens used per ticket and the running total.

> Video and GIF recordings are **not sent to the AI**. They are for download, so you can attach them to your ticket. Only screenshots and text are sent.

---

## 🚀 Installation

1. Clone or download this folder.
2. Open `chrome://extensions/` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.
4. Pin the extension to your toolbar.

There's no build step. The extension is plain JavaScript.

## 🔑 Setup: add an API key

1. Click the extension icon, then **⚙️** (or the "⬤ sign in" badge) to open Settings.
2. Choose an **AI provider** and paste your key:

   | Provider | Model used | Get a key |
   |---|---|---|
   | Gemini (default) | `gemini-2.5-flash` | [Google AI Studio](https://aistudio.google.com/apikey) |
   | OpenAI | `gpt-4o` | [OpenAI Platform](https://platform.openai.com/api-keys) |
   | Anthropic | `claude-sonnet-4-20250514` | [Anthropic Console](https://console.anthropic.com/settings/keys) |
   | xAI | `grok-2-vision-1212` | [xAI Console](https://console.x.ai/) |

3. Click **Test**, then **Save Settings**. The popup badge changes to "⬤ connected".

On first install, default settings are loaded from `setting-data.json`. API keys always start empty.

> Keys are stored locally in `chrome.storage.local` and sent only to the provider you selected. They are **not** included when you export settings.

---

## 🎯 How to use

1. Go to the page with the bug.
2. Open the extension and add evidence:
   - **Capture current screen**, **Capture & Annotate** or **Upload**
   - optionally **Record GIF** or **Record Video** (turn on video in Settings → Popup UI Fields)
3. Describe the bug. Type it, or click 🎙️ to dictate.
4. Optionally set **Component** and **Severity**.
5. Click **✨ Generate Ticket**. You need at least one screenshot or a description.
6. Review the ticket. You can:
   - refine it in **Refine with AI**,
   - open **edit inputs** to change the note/component/severity and click **Regenerate**,
   - click **↺ redo** to regenerate with the same inputs.
7. Click **⎘ Copy** and paste into your tracker. Download the video or GIF separately and attach it.
8. Click **← Start new bug report** to clear everything.

Your work is saved automatically. Closing and reopening the popup keeps your screenshots, notes, the generated ticket and the chat.

### ⌨️ Keyboard shortcuts

| Shortcut (Windows/Linux · macOS) | Action |
|---|---|
| `Ctrl+Shift+S` · `⌘+Shift+S` | Capture the visible tab into the current report |
| `Ctrl+Shift+M` · `⌘+Shift+M` | Start or stop the voice note |

- The shortcuts work while the popup is closed. The toolbar badge shows what happened: the screenshot count (e.g. `3`), `MAX` when 6 screenshots are already attached, `REC` while the mic is on, and `!` on error (for example on `chrome://` pages).
- Shortcut screenshots are taken instantly. The "Delay Before Capture" setting applies only to the popup buttons.
- Chrome may skip a suggested shortcut that clashes with another extension. To check or change them, go to `chrome://extensions/shortcuts`.

---

## ⚙️ Settings

| Section | What it controls |
|---|---|
| Voice Input | **Voice Language**: the language and accent you dictate in. Matching your accent (e.g. English (India)) noticeably improves voice-to-text accuracy. Applies to voice notes and video transcripts |
| AI Provider | Provider and per-provider API keys (with a Test button) |
| Domain Knowledge | Product description and tech stack, added to the prompt |
| Ticket Sections | Summary, Environment, Steps, Expected, Actual, Impact, Priority, Acceptance Criteria, Logs, Screenshots, Workaround, Additional Context, plus your own custom sections |
| Output Formatting | Use Markdown (`code`, **bold**) for exact values instead of quotes |
| Summary / Description | Title format and writing guidelines for the AI |
| Popup UI Fields | Show/hide Component, Severity and Video Recording |
| Capture Behavior | Delay before capture (0–5 s), useful for opening menus or hover states |
| Video Recording | Webcam on/off, webcam position and size, recording quality |

**Export** and **Import** (in the footer) share a team configuration as JSON. After importing, click **Save** to apply it.

---

## 📁 Project structure

```
manifest.json              MV3 config: permissions, shortcuts, content script
background.js              Service worker: prompt building, AI calls, background generation,
                           screenshots, keyboard shortcuts, GIF orchestration
popup.html / popup.js      Main popup UI
content.js                 Runs on pages: speech recognition for voice notes
annotate.html / .js        Screenshot annotation editor (opens in a tab)
recorder.html / .js        Video recorder and trimmer (opens in a tab)
recording-controls.js      Floating REC controls injected into the recorded page
gif-recording-controls.js  Floating GIF controls injected into the recorded page
offscreen.html / .js       Offscreen document that captures and encodes GIFs
settings.html / .js        Settings page
setting-data.json          Default settings applied on first install
styles.css, toast.js, icons.js   Shared styles, toasts, SVG icons
lib/gif.js, gif.worker.js  Vendored gif.js encoder
icons/                     Extension icons
knowledge.md               Detailed internals: data flow, storage keys, messages, known issues
```

See **[knowledge.md](knowledge.md)** for architecture, storage keys, message types and implementation notes.

---

## 🔧 Development

- After changing `background.js` or `manifest.json`, click **Reload** on `chrome://extensions`.
- After changing `content.js`, reload the extension **and** refresh any open tabs. (The mic shortcut injects the script into tabs that don't have it yet.)
- To debug:
  - popup: right-click the popup and choose **Inspect**
  - service worker: the "service worker" link on `chrome://extensions`
  - GIF offscreen document: `chrome://inspect/#other`
- To change models or the prompt, edit `callGemini` / `callOpenAI` / `callAnthropic` / `callXAI`, `testApiKey` and `buildPrompt` in `background.js`.

## ⚠️ Limitations

| Limitation | Detail |
|---|---|
| Screenshots per ticket | 6 max, to keep the AI request size reasonable |
| GIF length | 12 s max, 12 fps, up to 1280 px wide |
| Restricted pages | Capture, recording and voice don't work on `chrome://` or extension pages |
| Voice accuracy | Uses Chrome's built-in speech recognition, so pick your accent under Settings → Voice Language |
| API rate limits | Depend on your provider plan |
