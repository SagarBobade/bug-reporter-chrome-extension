# 🐛 BugReporter — Ticket Generator Chrome Extension

Capture screenshots of UI bugs, add context notes, and generate copy-paste ready bug reports using Gemini AI — authenticated with your own Google account.

---

## 🚀 Setup (One-time, ~10 mins)

### Step 1 — Get your OAuth Client ID

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a new project (or select an existing one)
3. Go to **APIs & Services → Library**
4. Search for **"Generative Language API"** → Enable it
5. Go to **APIs & Services → Credentials**
6. Click **Create Credentials → OAuth 2.0 Client ID**
7. Choose **Application type: Chrome Extension**
8. For **Item ID**, use your extension's ID (see Step 3 below)
9. Copy the generated **Client ID**

### Step 2 — Add your Client ID to the extension

Open `manifest.json` and replace:
```json
"client_id": "YOUR_OAUTH_CLIENT_ID.apps.googleusercontent.com"
```
with your actual Client ID from Step 1.

### Step 3 — Load the extension in Chrome

1. Open Chrome → go to `chrome://extensions/`
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked**
4. Select this folder (`BugReporter/`)
5. Note your **Extension ID** (looks like `abcdefghijklmnopqrstuvwxyz123456`)
6. Go back to Google Cloud Console → your OAuth credential → add this Extension ID

### Step 4 — Generate icons (optional)

The extension needs icon files. Create simple PNG icons in the `icons/` folder:
- `icon16.png` (16×16)
- `icon48.png` (48×48)  
- `icon128.png` (128×128)

You can use any bug/camera emoji screenshot and resize it, or use a free icon generator.

---

## 🎯 How to Use

1. **Navigate** to the page with the bug
2. **Click the BugReporter extension icon** in your toolbar
3. **Sign in** with Google (first time only — click "⬤ sign in")
4. **Click "Capture current screen"** at each relevant state
   - Capture the initial state
   - Reproduce the bug, capture again
   - Capture error states, console, etc.
5. **Add notes** — type what you were doing, what broke, what you expected
6. **Fill in Component** (e.g. "Checkout Flow") and **Severity**
7. **Click "Generate Ticket"** ✨
8. **Copy** the result and paste into

---

## 📋 Generated Ticket Format

```
## Summary
[Component]: [What broke] in [specific action]

## Environment
- Browser: Chrome
- Page: [title]
- URL: [url]

## Steps to Reproduce
1. Navigate to...
2. Click on...
3. Observe that...

## Expected Behavior
[What should happen]

## Actual Behavior
[What actually happened]

## Impact
[Who is affected, how severely]

## Priority
P2 — [brief justification]

## Acceptance Criteria
- [ ] ...
- [ ] ...

## Additional Context
[UI state observations, visible errors, etc.]
```

---

## ⚠️ Limitations

| Limitation | Detail |
|---|---|
| **Free tier rate limits** | Gemini free tier = ~15 requests/min, 1M tokens/day |
| **Screenshot only** | No video — capture key moments manually |
| **Voice note** | Records audio but transcription requires additional setup (see below) |
| **Max screenshots** | 6 per ticket (keeps API payload reasonable) |

### Enabling Real Voice Transcription
The mic button records audio. To get actual speech-to-text:
- Use the **Web Speech API** (Chrome built-in, free): replace the `mediaRecorder` block in `popup.js` with `SpeechRecognition`
- Or send audio to Gemini with `audio/webm` mime type (experimental)

---

## 🔧 Customization

### Change the template
Edit the prompt in `background.js` → `callGeminiVision()` → `userPrompt` string.

### Add more ticket types
In `popup.html`, add a `<select>` for ticket type and pass it as context to the prompt.

### Change Gemini model
In `background.js`, update `"model": "gemini-2.0-flash"` to `"gemini-1.5-pro"` for higher quality (uses more quota).

---

## 📁 File Structure

```
BugReporter
├── manifest.json      # Extension config + OAuth scopes
├── background.js      # Service worker: auth + Gemini API calls
├── popup.html         # Extension popup UI
├── popup.js           # Popup logic: capture, notes, generate
├── content.js         # Gets page URL/title from active tab
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── README.md
```
