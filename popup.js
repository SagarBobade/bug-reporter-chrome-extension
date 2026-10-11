// popup.js — BugReporter extension popup controller

// ── Icon Replacement on Load ─────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Replace emoji with SVG icons throughout the UI
  const iconReplacements = {
    '🪲': icons.alert,          // Bug icon in logo
    '📸': icons.camera,          // Camera icon
    '✏️': icons.pencil,          // Pencil/edit icon
    '🎬': icons.video,           // Video icon
    '🎙️': icons.mic,             // Microphone icon
    '✨': icons.sparkles,        // Sparkles/generate icon
    '⚙️': icons.settings,        // Settings icon
    '⬇': icons.download,        // Download icon
    '↺': icons.redo,            // Redo/regenerate icon
    '⎘': icons.copy,            // Copy icon
  };

  // Function to recursively replace emoji in text nodes
  function replaceEmoji(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      let text = node.textContent;
      let replaced = false;
      for (const [emoji, svg] of Object.entries(iconReplacements)) {
        if (text.includes(emoji)) {
          replaced = true;
          break;
        }
      }
      if (replaced) {
        const span = document.createElement('span');
        span.innerHTML = node.textContent;
        for (const [emoji, svg] of Object.entries(iconReplacements)) {
          span.innerHTML = span.innerHTML.replace(emoji, svg);
        }
        node.parentNode.replaceChild(span, node);
      }
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      // Skip script and style tags
      if (node.tagName !== 'SCRIPT' && node.tagName !== 'STYLE') {
        Array.from(node.childNodes).forEach(replaceEmoji);
      }
    }
  }

  // Replace emoji after a short delay to ensure DOM is fully loaded
  setTimeout(() => {
    replaceEmoji(document.body);
  }, 10);
});

// ── State ────────────────────────────────────────────────────────────────────
const state = {
  screenshots: [],
  pageUrl: "",
  pageTitle: "",
  isAuthenticated: false,
  recognition: null,
  isListening: false,
  hasRestoredResult: false,
  enabledFields: ["component", "severity"], // Default enabled
  currentGenerationId: null, // Track ongoing generation
  chatHistory: [], // Chat history with AI
  videoBlobUrl: null, // Blob URL for video download (video NOT sent to AI)
  videoExtension: "webm", // File extension matching the recorded video's actual codec
  videoRecordingEnabled: false, // Setting: whether video recording is enabled
  isTranscriptUpdate: false, // Flag to distinguish transcript vs user edits
  gifBlobUrl: null, // Blob URL for GIF download (GIF NOT sent to AI)
};

const MAX_SCREENSHOTS = 6;
const STORAGE_KEY = "bugReporterSession";

// ── DOM refs ─────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const authBadge      = $("auth-badge");
const btnCapture     = $("btn-capture");
const btnAnnotate    = $("btn-annotate");
const btnUpload      = $("btn-upload");
const uploadInput    = $("upload-input");
const btnMic         = $("btn-mic");
const micTimer       = $("mic-timer");
const btnGenerate    = $("btn-generate");
const btnCopy        = $("btn-copy");
const btnRegen       = $("btn-regen");
const btnReset       = $("btn-reset");
const noteInput      = $("note-input");
const fieldComp      = $("field-component");
const fieldSev       = $("field-severity");
const screenshotGrid = $("screenshot-grid");
const shotCount      = $("shot-count");
const btnClearAll    = $("btn-clear-all");
const loadingBar     = $("loading-bar");
const loadingText    = $("loading-text");
const btnCancelGenerate = $("btn-cancel-generate");
const errorBox       = $("error-box");
const capturePanel   = $("capture-panel");
const resultPanel    = $("result-panel");
const resultTextarea = $("result-textarea");
const pageMeta       = $("page-meta");
const inputEditSection = $("input-edit-section");
const inputEditToggle  = $("input-edit-toggle");
const inputEditBody    = $("input-edit-body");
const editNote         = $("edit-note");
const editComponent    = $("edit-component");
const editSeverity     = $("edit-severity");
const btnRegenEdit     = $("btn-regenerate-edit");
const chatSection      = $("chat-section");
const chatHistory      = $("chat-history");
const chatInput        = $("chat-input");
const btnImprove       = $("btn-improve");
const videoSection     = $("video-section");
const btnRecord        = $("btn-record");
const videoPreview     = $("video-preview");
const btnDeleteVideo   = $("btn-delete-video");
const btnDownloadVideo = $("btn-download-video");
const videoInfoText    = $("video-info-text");
const resultVideo      = $("result-video");
const resultVideoPlayer = $("result-video-player");
const btnResultDownloadVideo = $("btn-result-download-video");
const btnResultDeleteVideo = $("btn-result-delete-video");
const btnGif           = $("btn-gif");
const gifPreview       = $("gif-preview");
const btnDeleteGif     = $("btn-delete-gif");
const btnDownloadGif   = $("btn-download-gif");
const infoVideo        = $("info-video");
const infoGif          = $("info-gif");

// The "ⓘ" hints live inside the record buttons so the tooltip shows on hover without
// extra layout — but that means a click on the icon itself would otherwise bubble up
// and start a recording. Swallow it here so it's purely informational.
[infoVideo, infoGif].forEach((el) => {
  if (!el) return;
  el.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
});
const gifInfoText      = $("gif-info-text");
const resultGif        = $("result-gif");
const resultGifPlayer  = $("result-gif-player");
const btnResultDownloadGif = $("btn-result-download-gif");
const btnResultDeleteGif = $("btn-result-delete-gif");

const noteInputWrap    = $("note-input-wrap");
const btnClearNote     = $("btn-clear-note");

// ── Auto-resize note textarea ────────────────────────────────────────────────
// Grows with its content (typed or dictated) so the full text is visible, up to
// NOTE_MAX_ROWS rows; past that it stops growing and scrolls instead.
const NOTE_MAX_ROWS = 10;

function resizeNoteInput({ scrollToEnd = false } = {}) {
  // Hidden (result panel showing) → scrollHeight is 0; re-run when shown again.
  if (noteInput.offsetParent === null) return;

  const cs = getComputedStyle(noteInput);
  const lineHeight = parseFloat(cs.lineHeight);
  const vertical = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
  const borders = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
  const maxHeight = Math.ceil(lineHeight * NOTE_MAX_ROWS + vertical + borders);

  // Collapse first so scrollHeight reflects the content, not the current height
  noteInput.style.height = "auto";
  const contentHeight = noteInput.scrollHeight + borders; // border-box sizing
  noteInput.style.height = Math.min(contentHeight, maxHeight) + "px";
  noteInput.style.overflowY = contentHeight > maxHeight ? "auto" : "hidden";

  // Keep the newest dictated words in view once the box has hit its max size
  if (scrollToEnd) noteInput.scrollTop = noteInput.scrollHeight;
}

// Refreshes everything that depends on the note's text (size + clear button).
function syncNoteInput(opts) {
  updateNoteInputClear();
  resizeNoteInput(opts);
}

// ── Typewriter effect for live dictation ─────────────────────────────────────
// Speech recognition delivers text in bursts and keeps revising its newest words.
// Rather than jumping, the note trails the transcript by ~TYPE_LAG_MS and reveals
// it at a speed proportional to how far behind it is: while you talk it flows
// at roughly your speaking pace instead of dashing out each burst then pausing.
// Revisions to words already on screen are swapped in place — never erased and
// retyped — and revisions to words not yet shown are simply never seen.
const TYPE_LAG_MS = 300;        // how far the display trails speech; higher = slower, smoother
const TYPE_MIN_CPS = 40;        // floor so the last few characters don't crawl
const TYPE_FINAL_LAG_MS = 80;   // after Stop: finish the last words quickly…
const TYPE_FINAL_MIN_CPS = 150; // …at this speed or faster
const prefersReducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

const typewriter = {
  target: "",     // latest transcript we're typing towards
  written: null,  // value we last wrote — differs if someone else changed the field
  rafId: null,
  lastTime: 0,    // timestamp of the previous frame
  carry: 0,       // fractional characters owed from previous frames
  lagMs: TYPE_LAG_MS,
  minCps: TYPE_MIN_CPS,
};

function isNoteTyping() {
  return typewriter.rafId !== null;
}

function cancelNoteTyping() {
  if (typewriter.rafId !== null) cancelAnimationFrame(typewriter.rafId);
  typewriter.rafId = null;
  typewriter.written = null;
}

// Writes `text` into the note as a transcript update (not a user edit).
function setNoteFromTranscript(text, { scrollToEnd = true } = {}) {
  state.isTranscriptUpdate = true;
  noteInput.value = text;
  typewriter.written = text;
  syncNoteInput({ scrollToEnd });
  state.isTranscriptUpdate = false;
  updateSteps();
  updateGenerateBtn();
}

// Jump straight to the latest transcript (user edit, etc.).
function flushNoteTyping() {
  if (!isNoteTyping()) return;
  cancelNoteTyping();
  setNoteFromTranscript(typewriter.target);
}

function typeNoteTo(target, { final = false } = {}) {
  typewriter.target = target;
  typewriter.lagMs = final ? TYPE_FINAL_LAG_MS : TYPE_LAG_MS;
  typewriter.minCps = final ? TYPE_FINAL_MIN_CPS : TYPE_MIN_CPS;
  if (prefersReducedMotion) {
    cancelNoteTyping();
    setNoteFromTranscript(target);
    return;
  }
  if (!isNoteTyping()) {
    typewriter.written = noteInput.value;
    typewriter.lastTime = performance.now();
    typewriter.carry = 0;
    typewriter.rafId = requestAnimationFrame(typeNoteFrame);
  }
}

function typeNoteFrame(now) {
  // The field was changed by something else (clear, reset, regenerate) — stop
  // typing so we don't resurrect text the user just removed.
  if (noteInput.value !== typewriter.written) {
    cancelNoteTyping();
    return;
  }

  const current = noteInput.value;
  const target = typewriter.target;
  if (current === target) {
    typewriter.rafId = null; // caught up — wait for the next transcript update
    return;
  }

  const dt = Math.max(0, Math.min(now - typewriter.lastTime, 100)); // clamp tab-switch gaps
  typewriter.lastTime = now;

  // Characters already on screen stay on screen: if the recognizer revised them,
  // show the revised characters at the same length (an in-place word swap).
  const shown = Math.min(current.length, target.length);
  const backlog = target.length - shown;
  const cps = Math.max(typewriter.minCps, backlog / (typewriter.lagMs / 1000));
  typewriter.carry += cps * dt / 1000;
  const add = Math.min(backlog, Math.floor(typewriter.carry));
  typewriter.carry -= add;

  const next = target.slice(0, shown + add);
  if (next !== current) setNoteFromTranscript(next);
  typewriter.rafId = requestAnimationFrame(typeNoteFrame);
}

// Buckets are calibrated against this app's typical range: a single-screenshot
// ticket with a short note lands well under 1,500 tokens; a full 6-screenshot
// report with a long note can approach 3,000+.
function getUsageLevel(total) {
  if (total < 1200) return { level: "low", label: "Low" };
  if (total < 2500) return { level: "medium", label: "Medium" };
  return { level: "high", label: "High" };
}

function formatCompact(n) {
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  return n.toString();
}

async function getUsageStats() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "GET_USAGE_STATS" }, (response) => {
      resolve(response?.stats || { totalTokens: 0, ticketCount: 0 });
    });
  });
}

async function showTokenUsage(tokenUsage) {
  const tokenUsageEl = $("token-usage");
  if (!tokenUsageEl || !tokenUsage || !tokenUsage.total) return;

  const { level, label } = getUsageLevel(tokenUsage.total);

  const chips = [`<span class="usage-badge usage-${level}">${label}</span>`];
  chips.push(`<span class="stat-chip">${formatCompact(tokenUsage.total)} total</span>`);
  if (tokenUsage.input) chips.push(`<span class="stat-chip">↑${formatCompact(tokenUsage.input)}</span>`);
  if (tokenUsage.output) chips.push(`<span class="stat-chip">↓${formatCompact(tokenUsage.output)}</span>`);

  const rows = [`<div class="token-usage-row">${chips.join("")}</div>`];

  const stats = await getUsageStats();
  if (stats.ticketCount > 0) {
    rows.push(
      `<div class="token-usage-row"><span class="stat-chip">Session: ${formatCompact(stats.totalTokens)} / ${stats.ticketCount} ticket${stats.ticketCount === 1 ? "" : "s"}</span></div>`
    );
  }

  tokenUsageEl.innerHTML = rows.join("");
  tokenUsageEl.style.display = "flex";
}

// Persist session ───────────────────────────────────────────────────────────
function saveSession(includeResult = false, noteOverride = null) {
  const data = {
    screenshots: state.screenshots,
    note:        noteOverride ?? noteInput.value,
    component:   fieldComp.value,
    severity:    fieldSev.value,
    videoBlobUrl: state.videoBlobUrl, // Persist video URL
  };

  // Optionally save the generated result
  if (includeResult && resultTextarea.value) {
    data.generatedTicket = resultTextarea.value;
    data.showingResult = true;
  }

  chrome.storage.local.set({ [STORAGE_KEY]: data });
}

// Save result separately (called after generation)
function saveResult() {
  chrome.storage.local.get(STORAGE_KEY, (result) => {
    const s = result[STORAGE_KEY] || {};
    s.generatedTicket = resultTextarea.value;
    s.showingResult = true;
    s.screenshots = state.screenshots; // Ensure screenshots are saved with result
    s.chatHistory = state.chatHistory; // Save chat history with ticket
    chrome.storage.local.set({ [STORAGE_KEY]: s });
  });
}

async function restoreSession() {
  return new Promise(resolve => {
    chrome.storage.local.get(STORAGE_KEY, (result) => {
      const s = result[STORAGE_KEY];
      if (s) {
        state.screenshots = s.screenshots || [];
        noteInput.value   = s.note      || "";
        fieldComp.value   = s.component || "";
        fieldSev.value    = s.severity  || "Medium";
        state.chatHistory = s.chatHistory || [];
        
        // Restore video if available
        if (s.videoBlobUrl) {
          state.videoBlobUrl = s.videoBlobUrl;
          // Show video UI
          if (videoPreview) {
            videoPreview.style.display = "block";
            btnRecord.style.display = "none";
            videoInfoText.textContent = "🎬 Video recorded (view or download to attach)";
          }
        }

        // Restore generated result if exists
        if (s.showingResult && s.generatedTicket) {
          resultTextarea.value = s.generatedTicket;
          // We'll show the result panel after init completes
          state.hasRestoredResult = true;
        }
      }
      resolve();
    });
  });
}

function clearSession() {
  chrome.storage.local.remove(STORAGE_KEY);
}

// ── Load settings and configure UI fields ─────────────────────────────────────
async function loadFieldSettings() {
  return new Promise(resolve => {
    chrome.storage.local.get("bugReporterSettings", (result) => {
      const settings = result.bugReporterSettings || {};
      const enabledFields = settings.enabledFields || ["component", "severity"];

      // Show/hide Component field
      const componentGroup = document.querySelector('.context-row .field-group:first-child');
      if (enabledFields.includes("component")) {
        if (componentGroup) componentGroup.style.display = "block";
      } else {
        if (componentGroup) componentGroup.style.display = "none";
        fieldComp.value = ""; // Clear if hidden
      }

      // Show/hide Severity field
      const severityGroup = document.querySelector('.context-row .field-group:last-child');
      if (enabledFields.includes("severity")) {
        if (severityGroup) severityGroup.style.display = "block";
        if (!fieldSev.value) fieldSev.value = "Medium"; // Default to Medium
      } else {
        if (severityGroup) severityGroup.style.display = "none";
        fieldSev.value = "Medium"; // Default when hidden
      }

      // Hide entire context row if both fields are disabled
      const contextRow = document.querySelector('.context-row');
      if (!enabledFields.includes("component") && !enabledFields.includes("severity")) {
        if (contextRow) contextRow.style.display = "none";
      } else {
        if (contextRow) contextRow.style.display = "grid";
      }

      state.enabledFields = enabledFields;

      // Video recording setting
      state.videoRecordingEnabled = settings.videoRecordingEnabled || false;
      if (videoSection) {
        videoSection.style.display = state.videoRecordingEnabled ? "block" : "none";
      }

      resolve(enabledFields);
    });
  });
}

// ── Check Generation Status (for background processing) ─────────────────────
async function checkGenerationStatus() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "CHECK_GENERATION_STATUS" }, (response) => {
      const genState = response?.state;
      if (!genState) {
        resolve();
        return;
      }

      if (genState.isGenerating) {
        // Generation is in progress - show loading UI
        state.currentGenerationId = genState.generationId;
        setLoading(true);
        loadingText.textContent = "Still generating ticket…";
        // Start polling for completion
        startGenerationPolling();
      } else if (genState.ticket && !state.hasRestoredResult) {
        // Generation completed while popup was closed - show result
        resultTextarea.value = genState.ticket;
        state.hasRestoredResult = true;
        if (genState.tokenUsage) showTokenUsage(genState.tokenUsage);
        // Clear the generation state since we've consumed the result
        chrome.runtime.sendMessage({ type: "CLEAR_GENERATION_STATE" });
        showToast("Ticket generated while popup was closed!", "success");
      } else if (genState.error && !state.hasRestoredResult) {
        // Generation failed while popup was closed
        showError("Generation failed: " + genState.error);
        chrome.runtime.sendMessage({ type: "CLEAR_GENERATION_STATE" });
      }
      resolve();
    });
  });
}

// Poll for generation completion
let pollingInterval = null;
function startGenerationPolling() {
  if (pollingInterval) return;
  pollingInterval = setInterval(() => {
    chrome.runtime.sendMessage({ type: "CHECK_GENERATION_STATUS" }, (response) => {
      const genState = response?.state;
      if (!genState || !genState.isGenerating) {
        clearInterval(pollingInterval);
        pollingInterval = null;

        if (genState?.ticket) {
          setLoading(false);
          showResult(genState.ticket);
          if (genState.tokenUsage) showTokenUsage(genState.tokenUsage);
          showToast("Ticket generated!", "success");
          chrome.runtime.sendMessage({ type: "CLEAR_GENERATION_STATE" });
        } else if (genState?.error) {
          setLoading(false);
          showError("Generation failed: " + genState.error);
          chrome.runtime.sendMessage({ type: "CLEAR_GENERATION_STATE" });
        } else {
          // No ticket, no error — generation was cancelled or state was cleared elsewhere.
          setLoading(false);
        }
      }
    });
  }, 1000);
}

// Listen for generation complete message from background
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "GENERATION_COMPLETE") {
    if (pollingInterval) {
      clearInterval(pollingInterval);
      pollingInterval = null;
    }
    setLoading(false);
    if (msg.ticket) {
      showResult(msg.ticket);
      if (msg.tokenUsage) showTokenUsage(msg.tokenUsage);
      showToast("Ticket generated!", "success");
    } else if (msg.cancelled) {
      // Cancellation already surfaced by the Cancel button handler — nothing more to show.
    } else if (msg.error) {
      showError("Generation failed: " + msg.error);
    }
    chrome.runtime.sendMessage({ type: "CLEAR_GENERATION_STATE" });
  }
});

// ── Check for Annotation Result ─────────────────────────────────────────────
async function checkAnnotationResult() {
  return new Promise((resolve) => {
    chrome.storage.local.get(ANNOTATION_DATA_KEY, (result) => {
      const data = result[ANNOTATION_DATA_KEY];
      if (data && data.completed && data.result) {
        console.log('Annotation result data:', data); // Debug log
        console.log('Current screenshots length:', state.screenshots.length); // Debug log
        
        // Check if this is an edit of existing screenshot
        if (typeof data.editIndex === "number" && data.editIndex >= 0 && data.editIndex < state.screenshots.length) {
          console.log('Replacing screenshot at index:', data.editIndex); // Debug log
          // Replace existing screenshot
          state.screenshots[data.editIndex] = data.result;
          showToast("Screenshot updated!", "success");
          
          // Save session and update UI regardless of source
          saveSession();
          renderGrid();
          updateGenerateBtn();
          
          // If editing from result panel, return to result panel
          if (data.fromResultPanel) {
            displayResultPanel();
          }
        } else {
          console.log('Adding as new screenshot. EditIndex:', data.editIndex, 'Screenshots length:', state.screenshots.length); // Debug log
          // Add as new screenshot only if we have space and it's truly a new capture
          if (state.screenshots.length < MAX_SCREENSHOTS && (data.editIndex === undefined || data.editIndex === null)) {
            state.screenshots.push(data.result);
            showToast("Annotated screenshot added!", "success");
            saveSession();
            renderGrid();
            updateGenerateBtn();
          } else if (data.editIndex !== undefined && data.editIndex !== null) {
            // This is an edit but index is out of bounds - treat as replacement of last screenshot
            console.warn('Edit index out of bounds, replacing last screenshot');
            if (state.screenshots.length > 0) {
              state.screenshots[state.screenshots.length - 1] = data.result;
              showToast("Screenshot updated!", "success");
              saveSession();
              renderGrid();
              updateGenerateBtn();
              if (data.fromResultPanel) {
                displayResultPanel();
              }
            }
          }
        }
        
        // Clear annotation data
        chrome.storage.local.remove(ANNOTATION_DATA_KEY);
      }
      resolve();
    });
  });
}

// ── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      state.pageUrl   = tab.url || "";
      state.pageTitle = tab.title || "";
      const domain = new URL(tab.url).hostname.replace("www.", "");
      if (pageMeta) pageMeta.textContent = domain.length > 30 ? domain.slice(0, 28) + "…" : domain;
    }
  } catch (e) {
    if (pageMeta) pageMeta.textContent = "Unknown page";
  }

  await restoreSession();
  await loadFieldSettings();

  // Check for ongoing/completed generation
  await checkGenerationStatus();

  // Check for completed annotation
  await checkAnnotationResult();

  // Check for completed video recording (only if video recording is enabled)
  if (state.videoRecordingEnabled) {
    await checkVideoRecording();
  }

  // Check for completed GIF recording
  await checkGifRecording();

  chrome.runtime.sendMessage({ type: "CHECK_API_KEY" }, (res) => {
    if (res?.ok) {
      state.isAuthenticated = true;
      authBadge.textContent = "⬤ connected";
      authBadge.classList.add("connected");
    }
  });

  $("btn-settings").addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("settings.html") });
  });

  // A keystroke during the typing animation: finish revealing the transcript first
  // so the edit applies to the full text (and the animation can't overwrite it).
  // Keep the caret where the user put it, unless it was at the end of the
  // partially typed text — then they're appending, so move it to the new end.
  noteInput.addEventListener("beforeinput", () => {
    if (!isNoteTyping()) return;
    const { selectionStart, selectionEnd, value } = noteInput;
    const caretAtEnd = selectionStart === value.length && selectionEnd === value.length;
    flushNoteTyping();
    if (!caretAtEnd) noteInput.setSelectionRange(selectionStart, selectionEnd);
  });

  noteInput.addEventListener("input",  () => {
    updateSteps(); updateGenerateBtn(); saveSession(); syncNoteInput();
    // Sync manual edits back to content script so speech appends to edited text
    if (state.isListening && !state.isTranscriptUpdate) {
      syncTranscriptToContentScript();
    }
  });
  fieldComp.addEventListener("input",  saveSession);
  fieldSev.addEventListener("change",  saveSession);

  // Clear note button
  btnClearNote.addEventListener("click", () => {
    cancelNoteTyping();
    noteInput.value = "";
    syncNoteInput();
    // While dictating, reset the recognizer's text too — otherwise the next
    // transcript update would bring the cleared text straight back.
    if (state.isListening) syncTranscriptToContentScript();
    updateSteps();
    updateGenerateBtn();
    saveSession();
    noteInput.focus();
  });

  // Initial size + clear button for restored note text
  syncNoteInput();

  setupSpeechRecognition();
  renderGrid();
  updateGenerateBtn();

  // Restore result panel if we had a generated ticket
  if (state.hasRestoredResult) {
    showRestoredResult();
  }
}

// ── Check Mic State (for restoring UI on popup reopen) ───────────────────────
async function checkMicState() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || tab.url?.startsWith("chrome://")) return;

    chrome.tabs.sendMessage(tab.id, { type: "CHECK_MIC_STATE" }, (response) => {
      if (chrome.runtime.lastError) return;
      if (response?.listening) {
        state.isListening = true;
        btnMic.classList.add("recording");
        btnMic.textContent = "⏹️";
        btnMic.title = "Stop recording";
        startMicTimer();
      }
    });
  } catch (e) { /* ignore */ }
}

// ── Speech Recognition (via content script) ──────────────────────────────────
function setupSpeechRecognition() {
  // Check if mic is already recording when popup opens
  checkMicState();

  // Listen for messages from content script
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "MIC_STATE") {
      // Note: content.js auto-restarts recognition across silence gaps — each restart
      // re-sends listening:true (startMicTimer ignores it while running), but
      // listening:false is only sent on a real stop, so the timer stays continuous.
      state.isListening = msg.listening;
      if (msg.listening) {
        btnMic.classList.add("recording");
        btnMic.textContent = "⏹️";
        btnMic.title = "Stop recording";
        startMicTimer(); // no-op if already running; covers starts via keyboard shortcut
      } else {
        btnMic.classList.remove("recording");
        btnMic.textContent = "🎙️";
        btnMic.title = "Record voice note";
        stopMicTimer(); // covers stops via keyboard shortcut
      }
    }

    if (msg.type === "MIC_TRANSCRIPT") {
      if (msg.isFinal) {
        // Recording stopped — finish the last words quickly, but persist the
        // complete text right away in case the popup closes mid-animation.
        typeNoteTo(msg.text, { final: true });
        saveSession(false, msg.text);
      } else {
        typeNoteTo(msg.text);
      }
    }

    if (msg.type === "MIC_ERROR") {
      state.isListening = false;
      btnMic.classList.remove("recording");
      btnMic.textContent = "🎙️";
      stopMicTimer();
      if (msg.error === "not-allowed") {
        showError("Mic denied. Allow microphone access on this page and try again.");
      } else if (msg.error !== "aborted") {
        showError("Speech error: " + msg.error);
      }
    }
  });

  // Mic button click handler
  btnMic.addEventListener("click", async () => {
    clearError();
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        showError("Cannot access this page for voice recording.");
        return;
      }

      // Check if it's a restricted page
      if (tab.url.startsWith("chrome://") || tab.url.startsWith("chrome-extension://")) {
        showError("Voice recording doesn't work on Chrome internal pages. Navigate to a website first.");
        return;
      }

      const messageType = state.isListening ? "STOP_MIC" : "START_MIC";
      const payload = messageType === "START_MIC"
        ? { type: messageType, existingText: noteInput.value ? noteInput.value + " " : "" }
        : { type: messageType };

      chrome.tabs.sendMessage(tab.id, payload, (response) => {
        if (chrome.runtime.lastError) {
          showError("Could not connect to page. Try refreshing the page.");
          return;
        }
        if (!response?.success && messageType === "START_MIC") {
          showError(response?.error || "Failed to start recording.");
          return;
        }
        if (messageType === "START_MIC") {
          startMicTimer();
        } else {
          stopMicTimer();
        }
      });
    } catch (err) {
      showError("Failed to toggle mic: " + err.message);
    }
  });
}

// ── Mic recording timer ──────────────────────────────────────────────────────
let micTimerInterval = null;
let micTimerStart = null;

function startMicTimer() {
  if (micTimerInterval) return;
  micTimerStart = Date.now();
  micTimer.style.display = "block";
  micTimer.textContent = "0:00";
  micTimerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - micTimerStart) / 1000);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    micTimer.textContent = `${mins}:${secs.toString().padStart(2, "0")}`;
  }, 1000);
}

function stopMicTimer() {
  if (micTimerInterval) {
    clearInterval(micTimerInterval);
    micTimerInterval = null;
  }
  micTimer.style.display = "none";
}

// ── Screenshot grid ───────────────────────────────────────────────────────────
function renderGrid() {
  screenshotGrid.innerHTML = "";

  state.screenshots.forEach((src, i) => {
    const thumb = document.createElement("div");
    thumb.className = "screenshot-thumb";
    thumb.title = "Click to preview";

    // Safe DOM creation (no innerHTML with user data)
    const img = document.createElement("img");
    img.src = src;
    img.alt = `Screenshot ${i + 1}`;

    const numSpan = document.createElement("span");
    numSpan.className = "thumb-num";
    numSpan.textContent = `#${i + 1}`;

    // Edit button
    const editBtn = document.createElement("button");
    editBtn.className = "thumb-edit";
    editBtn.dataset.index = i;
    editBtn.title = "Edit";
    editBtn.textContent = "✏️";
    editBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openScreenshotForEdit(i);
    });

    const delBtn = document.createElement("button");
    delBtn.className = "thumb-del";
    delBtn.dataset.index = i;
    delBtn.title = "Remove";
    delBtn.textContent = "✕";
    delBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const confirmed = await showConfirmDialog(
        "Delete Screenshot?",
        `Remove screenshot #${i + 1}? This cannot be undone.`,
        "Delete"
      );
      if (confirmed) removeScreenshot(i);
    });

    // Click thumbnail to preview
    thumb.addEventListener("click", () => showPreview(i));

    thumb.appendChild(img);
    thumb.appendChild(numSpan);
    thumb.appendChild(editBtn);
    thumb.appendChild(delBtn);
    screenshotGrid.appendChild(thumb);
  });

  // No screenshots → hide the whole section (heading + empty placeholders)
  $("screenshots-section").style.display = state.screenshots.length > 0 ? "block" : "none";
  shotCount.style.display = state.screenshots.length > 0 ? "inline-flex" : "none";
  shotCount.textContent = state.screenshots.length;
  btnClearAll.style.display = state.screenshots.length > 1 ? "inline-block" : "none";
  updateSteps();
}

// Open screenshot in annotation editor for editing
async function openScreenshotForEdit(index) {
  const screenshot = state.screenshots[index];
  if (!screenshot) return;

  // Get current tab ID to return to later
  const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });

  // Store screenshot for annotation editor along with return info
  chrome.storage.local.set({
    [ANNOTATION_DATA_KEY]: {
      screenshot: screenshot,
      completed: false,
      returnTabId: currentTab?.id || null,
      editIndex: index  // Track which screenshot we're editing
    }
  }, () => {
    // Open annotation editor in new tab
    chrome.tabs.create({
      url: chrome.runtime.getURL("annotate.html")
    });
  });
}

// Edit screenshot from result panel
async function editScreenshotFromResult(index) {
  if (index < 0 || index >= state.screenshots.length) return;

  const screenshot = state.screenshots[index];
  
  // Get current tab ID to return to later
  const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });

  // Store screenshot for annotation editor along with return info
  chrome.storage.local.set({
    [ANNOTATION_DATA_KEY]: {
      screenshot: screenshot,
      completed: false,
      returnTabId: currentTab?.id || null,
      editIndex: index,  // Track which screenshot we're editing
      fromResultPanel: true  // Flag to return to result panel
    }
  }, () => {
    // Open annotation editor in new tab
    chrome.tabs.create({
      url: chrome.runtime.getURL("annotate.html")
    });
  });
}

function removeScreenshot(index) {
  state.screenshots.splice(index, 1);
  saveSession();
  renderGrid();
  updateGenerateBtn();
}

// ── Steps ─────────────────────────────────────────────────────────────────────
function updateSteps() {
  const s1 = $("step-1"), s2 = $("step-2"), s3 = $("step-3");
  [s1, s2, s3].forEach(s => { s.className = "step"; });
  if (state.screenshots.length === 0) {
    s1.classList.add("active");
  } else if (!noteInput.value.trim()) {
    s1.classList.add("done"); s2.classList.add("active");
  } else {
    s1.classList.add("done"); s2.classList.add("done"); s3.classList.add("active");
  }
}

// ── Capture ───────────────────────────────────────────────────────────────────
const ANNOTATION_DATA_KEY = "bugReporterAnnotationData";

async function getCaptureDelay() {
  return new Promise(resolve => {
    chrome.storage.local.get("bugReporterSettings", (result) => {
      const settings = result.bugReporterSettings || {};
      resolve(settings.captureDelay || 0);
    });
  });
}

async function waitWithCountdown(seconds) {
  if (seconds <= 0) return;
  for (let i = seconds; i > 0; i--) {
    showToast(`Capturing in ${i}…`, "info");
    await new Promise(r => setTimeout(r, 1000));
  }
}

btnCapture.addEventListener("click", async () => {
  if (state.screenshots.length >= MAX_SCREENSHOTS) {
    showError(`Max ${MAX_SCREENSHOTS} screenshots. Remove one first.`); return;
  }
  btnCapture.disabled = true;
  const delay = await getCaptureDelay();
  if (delay > 0) {
    btnCapture.textContent = `Waiting ${delay}s…`;
    await waitWithCountdown(delay);
  }
  btnCapture.textContent = "Capturing…";
  try {
    const res = await chrome.runtime.sendMessage({ type: "CAPTURE_SCREENSHOT" });
    if (res?.ok) {
      state.screenshots.push(res.dataUrl);
      saveSession(); renderGrid(); updateGenerateBtn(); clearError();
    } else {
      showError("Screenshot failed: " + (res?.error || "unknown"));
    }
  } catch (e) {
    showError("Screenshot failed: " + e.message);
  } finally {
    btnCapture.disabled = false;
    btnCapture.innerHTML = `<span>📸</span> Capture current screen <span class="shortcut">click</span>`;
  }
});

// Screenshot taken via keyboard shortcut while the popup is open — background hands
// it over instead of writing storage, so this popup's in-memory session stays authoritative.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== "SHORTCUT_SCREENSHOT" || !msg.dataUrl) return;
  if (state.screenshots.length >= MAX_SCREENSHOTS) {
    showError(`Max ${MAX_SCREENSHOTS} screenshots. Remove one first.`); return;
  }
  state.screenshots.push(msg.dataUrl);
  saveSession(); renderGrid(); updateGenerateBtn(); clearError();
  showToast("Screenshot captured (shortcut)", "success");
});

// ── Capture & Annotate ────────────────────────────────────────────────────────
btnAnnotate.addEventListener("click", async () => {
  if (state.screenshots.length >= MAX_SCREENSHOTS) {
    showError(`Max ${MAX_SCREENSHOTS} screenshots. Remove one first.`); return;
  }
  btnAnnotate.disabled = true;
  const delay = await getCaptureDelay();
  if (delay > 0) {
    btnAnnotate.textContent = `Waiting ${delay}s…`;
    await waitWithCountdown(delay);
  }
  btnAnnotate.textContent = "Capturing…";
  try {
    const res = await chrome.runtime.sendMessage({ type: "CAPTURE_SCREENSHOT" });
    if (res?.ok) {
      // Get current tab ID to return to later
      const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });

      // Store screenshot for annotation editor along with return tab info
      chrome.storage.local.set({
        [ANNOTATION_DATA_KEY]: {
          screenshot: res.dataUrl,
          completed: false,
          returnTabId: currentTab?.id || null
        }
      }, () => {
        // Open annotation editor in new tab
        chrome.tabs.create({
          url: chrome.runtime.getURL("annotate.html")
        });
      });
    } else {
      showError("Screenshot failed: " + (res?.error || "unknown"));
    }
  } catch (e) {
    showError("Screenshot failed: " + e.message);
  } finally {
    btnAnnotate.disabled = false;
    btnAnnotate.innerHTML = `<span>✏️</span> Capture & Annotate <span class="shortcut">crop/mark</span>`;
  }
});

// ── Upload Photo ─────────────────────────────────────────────────────────────
function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

btnUpload.addEventListener("click", () => {
  if (state.screenshots.length >= MAX_SCREENSHOTS) {
    showError(`Max ${MAX_SCREENSHOTS} screenshots. Remove one first.`); return;
  }
  uploadInput.click();
});

uploadInput.addEventListener("change", async () => {
  const files = Array.from(uploadInput.files || []);
  uploadInput.value = ""; // allow re-selecting the same file later

  const room = MAX_SCREENSHOTS - state.screenshots.length;
  if (room <= 0) {
    showError(`Max ${MAX_SCREENSHOTS} screenshots. Remove one first.`); return;
  }
  if (files.length > room) {
    showError(`Only ${room} more screenshot(s) allowed — added the first ${room}.`);
  }

  for (const file of files.slice(0, room)) {
    if (!file.type.startsWith("image/")) continue;
    try {
      const dataUrl = await readFileAsDataUrl(file);
      state.screenshots.push(dataUrl);
    } catch (e) {
      showError("Upload failed: " + e.message);
    }
  }
  saveSession(); renderGrid(); updateGenerateBtn(); clearError();
});

// Record buttons keep their icon and ⓘ hint; status changes only swap the label
// text (rewriting innerHTML would delete the ⓘ and its click-swallow listener).
function setButtonText(btn, text) {
  const label = btn.querySelector(".btn-text");
  if (label) label.textContent = text;
  else btn.textContent = text;
}

// ── Video Recording ───────────────────────────────────────────────────────────
const VIDEO_RECORDING_KEY = "bugReporterVideoRecording";

btnRecord.addEventListener("click", async () => {
  // Get current tab to inject controls into
  const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!currentTab || currentTab.url.startsWith("chrome://") || currentTab.url.startsWith("chrome-extension://")) {
    showError("Cannot record on this page. Navigate to a regular website first.");
    return;
  }

  btnRecord.disabled = true;
  setButtonText(btnRecord, "Opening recorder...");

  // Get capture delay to pass to recorder
  const delay = await getCaptureDelay();

  // Store target tab ID and delay for recorder to use
  chrome.storage.local.set({
    [VIDEO_RECORDING_KEY]: {
      targetTabId: currentTab.id,
      isRecording: false,
      captureDelay: delay // Pass delay to recorder
    }
  }, () => {
    // Open dedicated recording page in new tab
    chrome.tabs.create({
      url: chrome.runtime.getURL("recorder.html")
    });
    
    // Reset button state
    btnRecord.disabled = false;
    setButtonText(btnRecord, "Record Video");
  });
});

// Check for completed video recording when popup opens
async function checkVideoRecording() {
  return new Promise((resolve) => {
    chrome.storage.local.get(VIDEO_RECORDING_KEY, (result) => {
      const data = result[VIDEO_RECORDING_KEY];
      if (data && data.videoBlobBase64) {
        // Restore video blob URL from base64
        const binaryStr = atob(data.videoBlobBase64);
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) {
          bytes[i] = binaryStr.charCodeAt(i);
        }
        const blob = new Blob([bytes], { type: data.videoMimeType || 'video/webm' });
        state.videoBlobUrl = URL.createObjectURL(blob);
        state.videoExtension = data.videoExtension || 'webm';

        // Show video preview (video is NOT sent to AI - only for download)
        videoPreview.style.display = "block";
        btnRecord.style.display = "none";
        videoInfoText.textContent = "🎬 Video recorded (view or download to attach)";

        // Add transcript to notes if available and not already added
        if (data.transcript && data.transcript.trim() && !data.transcriptAdded) {
          const existingNotes = noteInput.value.trim();
          const transcriptText = `[Voice transcript] ${data.transcript.trim()}`;

          if (existingNotes) {
            noteInput.value = existingNotes + "\n\n" + transcriptText;
          } else {
            noteInput.value = transcriptText;
          }
          saveSession();
          updateGenerateBtn();
          showToast("Voice transcript added to notes!", "info");
          
          // Mark transcript as added to prevent re-adding
          data.transcriptAdded = true;
          chrome.storage.local.set({ [VIDEO_RECORDING_KEY]: data });
        }

        showToast("Video ready for download!", "success");

        // Keep the recording data in storage for persistence across popup sessions
        // Only remove when user explicitly deletes or resets
      }
      resolve();
    });
  });
}

// View video in the preview modal — no download needed to check the recording
$("btn-view-video").addEventListener("click", () => {
  if (!state.videoBlobUrl) {
    showToast("No video available to view", "error");
    return;
  }
  showMediaPreview(state.videoBlobUrl, "Video recording", "video");
});

// Download video
btnDownloadVideo.addEventListener("click", () => {
  downloadVideo();
});

// Download video from result panel
btnResultDownloadVideo.addEventListener("click", () => {
  downloadVideo();
});

// Delete video from result panel
btnResultDeleteVideo.addEventListener("click", async () => {
  const confirmed = await showConfirmDialog(
    "Remove Video?",
    "This will remove the video from this bug report. You can still record a new one.",
    "Remove"
  );
  if (confirmed) {
    deleteVideo();
  }
});

function downloadVideo() {
  if (!state.videoBlobUrl) {
    showToast("No video available to download", "error");
    return;
  }

  // Create download link
  const a = document.createElement("a");
  a.href = state.videoBlobUrl;
  a.download = `bug-recording-${Date.now()}.${state.videoExtension}`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  showToast("Video downloaded!", "success");
}

// Shared function to delete video
function deleteVideo() {
  // Revoke blob URL to free memory
  if (state.videoBlobUrl) {
    URL.revokeObjectURL(state.videoBlobUrl);
    state.videoBlobUrl = null;
  }

  // Clear video from storage
  chrome.storage.local.remove(VIDEO_RECORDING_KEY);

  // Reset capture panel UI
  videoPreview.style.display = "none";
  btnRecord.style.display = "block";

  // Update result panel if it's visible
  if (resultVideo) {
    resultVideo.style.display = "none";
    resultVideoPlayer.src = "";
  }
}

// ── GIF Recording ─────────────────────────────────────────────────────────────
const GIF_RECORDING_KEY = "bugReporterGifRecording";

btnGif.addEventListener("click", async () => {
  const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!currentTab || currentTab.url.startsWith("chrome://") || currentTab.url.startsWith("chrome-extension://")) {
    showError("Cannot record on this page. Navigate to a regular website first.");
    return;
  }

  btnGif.disabled = true;
  setButtonText(btnGif, "Starting GIF recording...");

  chrome.runtime.sendMessage({ type: "START_GIF_RECORDING", tabId: currentTab.id }, (res) => {
    btnGif.disabled = false;
    setButtonText(btnGif, "Record GIF");

    if (!res || !res.ok) {
      showError("Failed to start GIF recording: " + (res && res.error ? res.error : "Unknown error"));
      return;
    }

    // Close the popup so the user can interact with the page being recorded —
    // a floating control chip on the page itself stops the recording.
    window.close();
  });
});

// Generous ceiling past the recorder's own 12s capture + 45s render timeout — if a
// recording/rendering flag is still set well past that, the offscreen document died
// without ever reporting back, so treat it as stuck rather than blocking the button
// forever with no way to recover.
const GIF_STUCK_TIMEOUT_MS = 90000;

// Check for an in-progress or completed GIF recording when popup opens
async function checkGifRecording() {
  return new Promise((resolve) => {
    chrome.storage.local.get(GIF_RECORDING_KEY, (result) => {
      const data = result[GIF_RECORDING_KEY];

      if (data && data.gifBlobBase64) {
        const binaryStr = atob(data.gifBlobBase64);
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) {
          bytes[i] = binaryStr.charCodeAt(i);
        }
        const blob = new Blob([bytes], { type: 'image/gif' });
        state.gifBlobUrl = URL.createObjectURL(blob);

        // Show GIF preview (GIF is NOT sent to AI - only for download)
        gifPreview.style.display = "block";
        btnGif.style.display = "none";
        gifInfoText.textContent = "🎞️ GIF recorded (view or download to attach)";

        showToast("GIF ready for download!", "success");
        resolve();
        return;
      }

      if (data && (data.isRecording || data.rendering)) {
        const isStuck = data.startTime && (Date.now() - data.startTime > GIF_STUCK_TIMEOUT_MS);
        if (isStuck) {
          chrome.storage.local.remove(GIF_RECORDING_KEY);
          btnGif.disabled = false;
          setButtonText(btnGif, "Record GIF");
          showToast("Previous GIF recording got stuck and was reset — try again.", "warning");
          resolve();
          return;
        }

        btnGif.disabled = true;
        setButtonText(btnGif, data.rendering
          ? "Rendering GIF… please wait"
          : "Recording GIF… (use on-page control to stop)");
        resolve();
        return;
      }

      if (data && data.error) {
        chrome.storage.local.remove(GIF_RECORDING_KEY);
        btnGif.disabled = false;
        setButtonText(btnGif, "Record GIF");
        showError("GIF recording failed: " + data.error);
      }

      resolve();
    });
  });
}

// Live-update the popup if it's still open through the offscreen recorder's lifecycle
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "GIF_RECORDING_FINISHED") {
    checkGifRecording();
  } else if (msg.type === "GIF_RECORDING_RENDERING") {
    btnGif.disabled = true;
    setButtonText(btnGif, "Rendering GIF… please wait");
  } else if (msg.type === "GIF_RECORDING_ERROR") {
    btnGif.disabled = false;
    setButtonText(btnGif, "Record GIF");
    showError("GIF recording failed: " + (msg.error || "Unknown error"));
  }
});

// View GIF in the preview modal — no download needed to check what was captured
function viewGif() {
  if (!state.gifBlobUrl) {
    showToast("No GIF available to view", "error");
    return;
  }
  showMediaPreview(state.gifBlobUrl, "GIF recording");
}

$("btn-view-gif").addEventListener("click", viewGif);
resultGifPlayer.addEventListener("click", viewGif);

// Download GIF
btnDownloadGif.addEventListener("click", () => {
  downloadGif();
});

// Download GIF from result panel
btnResultDownloadGif.addEventListener("click", () => {
  downloadGif();
});

// Delete GIF from result panel
btnResultDeleteGif.addEventListener("click", async () => {
  const confirmed = await showConfirmDialog(
    "Remove GIF?",
    "This will remove the GIF from this bug report. You can still record a new one.",
    "Remove"
  );
  if (confirmed) {
    deleteGif();
  }
});

function downloadGif() {
  if (!state.gifBlobUrl) {
    showToast("No GIF available to download", "error");
    return;
  }

  const a = document.createElement("a");
  a.href = state.gifBlobUrl;
  a.download = `bug-recording-${Date.now()}.gif`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  showToast("GIF downloaded!", "success");
}

// Shared function to delete GIF
function deleteGif() {
  if (state.gifBlobUrl) {
    URL.revokeObjectURL(state.gifBlobUrl);
    state.gifBlobUrl = null;
  }

  chrome.storage.local.remove(GIF_RECORDING_KEY);

  gifPreview.style.display = "none";
  btnGif.style.display = "block";

  if (resultGif) {
    resultGif.style.display = "none";
    resultGifPlayer.src = "";
  }
  
  // Update session storage
  saveSession();

  showToast("GIF removed", "info");
}

// Delete video
btnDeleteVideo.addEventListener("click", async () => {
  const confirmed = await showConfirmDialog(
    "Delete Video?",
    "Remove the recorded video?",
    "Delete"
  );
  if (!confirmed) return;

  deleteVideo();
});

// Delete GIF
btnDeleteGif.addEventListener("click", async () => {
  const confirmed = await showConfirmDialog(
    "Delete GIF?",
    "Remove the recorded GIF?",
    "Delete"
  );
  if (!confirmed) return;

  deleteGif();
});

// ── Clear all screenshots ──────────────────────────────────────────────────
btnClearAll.addEventListener("click", async () => {
  const count = state.screenshots.length;
  if (count === 0) return;

  const confirmed = await showConfirmDialog(
    "Clear All Screenshots?",
    `Remove all ${count} screenshots? This cannot be undone.`,
    "Clear All"
  );
  if (!confirmed) return;

  state.screenshots = [];
  saveSession();
  renderGrid();
  updateGenerateBtn();
  showToast(`${count} screenshots cleared`, "info");
});

// ── Generate ──────────────────────────────────────────────────────────────────
function updateGenerateBtn() {
  const hasScreenshots = state.screenshots.length > 0;
  const hasNotes = noteInput.value.trim().length > 0;
  const canGenerate = hasScreenshots || hasNotes; // Allow either screenshots OR notes

  btnGenerate.disabled = !canGenerate;
  if (canGenerate) {
    btnGenerate.innerHTML = `<span>✨</span> Generate Ticket`;
  } else {
    btnGenerate.innerHTML = `<span>📝</span> Add media or description first`;
  }
}

btnGenerate.addEventListener("click", async () => {
  const hasScreenshots = state.screenshots.length > 0;
  const hasNotes = noteInput.value.trim().length > 0;

  if (!hasScreenshots && !hasNotes) return;
  setLoading(true); clearError();
  loadingText.textContent = hasScreenshots
    ? "Analyzing screenshots and generating the ticket…"
    : "Generating the ticket…";

  const fullNote = [
    noteInput.value.trim(),
    state.enabledFields.includes("component") && fieldComp.value.trim() ? `Component/Area: ${fieldComp.value.trim()}` : "",
    state.enabledFields.includes("severity") ? `Severity: ${fieldSev.value}` : ""
  ].filter(Boolean).join("\n");

  // Get screen info
  const screenInfo = `${window.screen.width}x${window.screen.height} (viewport: ${window.innerWidth}x${window.innerHeight})`;

  try {
    const res = await chrome.runtime.sendMessage({
      type: "GENERATE_TICKET",
      payload: {
        screenshots: state.screenshots,
        audioNote: fullNote,
        pageUrl: state.pageUrl,
        pageTitle: state.pageTitle,
        screenInfo
      }
    });
    if (res?.ok && res.generationId) {
      // Generation started in background - store ID and start polling
      state.currentGenerationId = res.generationId;
      startGenerationPolling();
    } else if (res?.ok && res.ticket) {
      // Direct response (legacy support)
      showResult(res.ticket);
      setLoading(false);
      showToast("Ticket generated successfully!", "success");
    } else {
      setLoading(false);
      showError("Gemini error: " + (res?.error || "Check API key in Settings ⚙️"));
    }
  } catch (e) {
    setLoading(false);
    showError("Failed: " + e.message);
  }
});

// ── Result ────────────────────────────────────────────────────────────────────
function showResult(ticket) {
  resultTextarea.value = ticket;
  state.chatHistory = []; // Clear chat history for fresh generation
  displayResultPanel();

  // Save the result so it persists across popup close/reopen
  saveResult();
}

// Show result panel when restoring from saved state
function showRestoredResult() {
  displayResultPanel();
}

// Common function to display the result panel UI
function displayResultPanel() {
  capturePanel.style.display = "none";
  resultPanel.classList.add("visible");
  ["step-1","step-2","step-3"].forEach(id => $( id).className = "step done");

  // Populate edit inputs with current values
  editNote.value = noteInput.value;
  editComponent.value = fieldComp.value;
  editSeverity.value = fieldSev.value;

  // Show/hide edit fields based on settings
  const editCompGroup = $("edit-component-group");
  const editSevGroup = $("edit-severity-group");
  if (editCompGroup) editCompGroup.style.display = state.enabledFields.includes("component") ? "block" : "none";
  if (editSevGroup) editSevGroup.style.display = state.enabledFields.includes("severity") ? "block" : "none";

  // Reset expanded state
  inputEditSection.classList.remove("expanded");

  // Render chat history
  renderChatHistory();

  // Show screenshot previews if there are screenshots
  const screenshotsContainer = $("result-screenshots");
  const screenshotsGrid = $("result-screenshots-grid");
  if (state.screenshots.length > 0) {
    screenshotsGrid.innerHTML = "";
    state.screenshots.forEach((src, i) => {
      // Create screenshot container with image and controls
      const screenshotContainer = document.createElement("div");
      screenshotContainer.style.cssText = "position: relative; display: inline-block; margin: 2px;";
      
      const img = document.createElement("img");
      img.src = src;
      img.alt = `Screenshot ${i + 1}`;
      img.title = `Screenshot ${i + 1} - Click to copy`;
      img.style.cssText = "max-width: 110px; height: auto; border-radius: 4px; border: 1px solid var(--border); cursor: pointer; display: block;";
      img.addEventListener("click", () => copyImageToClipboard(src, i + 1));
      
      // Create edit button overlay
      const editBtn = document.createElement("button");
      editBtn.innerHTML = "✏️";
      editBtn.title = `Edit screenshot ${i + 1}`;
      editBtn.style.cssText = `
        position: absolute;
        top: 4px;
        right: 4px;
        background: rgba(0,0,0,0.7);
        border: none;
        border-radius: 4px;
        color: white;
        font-size: 10px;
        padding: 2px 4px;
        cursor: pointer;
        opacity: 0;
        transition: opacity 0.2s;
      `;
      editBtn.addEventListener("click", (e) => {
        e.stopPropagation(); // Prevent triggering image copy
        editScreenshotFromResult(i);
      });
      
      // Show edit button on hover
      screenshotContainer.addEventListener("mouseenter", () => {
        editBtn.style.opacity = "1";
      });
      screenshotContainer.addEventListener("mouseleave", () => {
        editBtn.style.opacity = "0";
      });
      
      screenshotContainer.appendChild(img);
      screenshotContainer.appendChild(editBtn);
      screenshotsGrid.appendChild(screenshotContainer);
    });
    screenshotsContainer.style.display = "block";
  } else {
    screenshotsContainer.style.display = "none";
  }

  // Show video preview and controls if video is available
  if (resultVideo) {
    if (state.videoBlobUrl) {
      resultVideo.style.display = "block";
      resultVideoPlayer.src = state.videoBlobUrl;
    } else {
      resultVideo.style.display = "none";
    }
  }

  // Show GIF preview and controls if a GIF is available
  if (resultGif) {
    if (state.gifBlobUrl) {
      resultGif.style.display = "block";
      resultGifPlayer.src = state.gifBlobUrl;
    } else {
      resultGif.style.display = "none";
    }
  }
}

// Copy a single image to clipboard
async function copyImageToClipboard(dataUrl, index) {
  try {
    const response = await fetch(dataUrl);
    const blob = await response.blob();
    await navigator.clipboard.write([
      new ClipboardItem({ [blob.type]: blob })
    ]);
    showToast(`Screenshot ${index} copied!`, "success");
  } catch (err) {
    // Fallback: open image in new tab for manual copy
    showToast("Right-click the image and select 'Copy image'", "error");
  }
}

// Create composite image from multiple screenshots
async function createCompositeImage(screenshots) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  
  // Load all images first
  const images = await Promise.all(screenshots.map(src => {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }));
  
  // Calculate layout for composite image
  const maxWidth = Math.max(...images.map(img => img.width));
  const totalHeight = images.reduce((sum, img) => sum + img.height, 0);
  const padding = 10;
  const headerHeight = 30;
  
  // Set canvas size
  canvas.width = maxWidth + (padding * 2);
  canvas.height = totalHeight + (padding * (images.length + 1)) + (headerHeight * images.length);
  
  // Fill background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  
  // Draw images with labels
  let currentY = padding;
  images.forEach((img, index) => {
    // Draw label
    ctx.fillStyle = '#333333';
    ctx.font = '16px Arial, sans-serif';
    ctx.fillText(`Screenshot ${index + 1}`, padding, currentY + 20);
    currentY += headerHeight;
    
    // Draw image
    const x = Math.max(0, (canvas.width - img.width) / 2);
    ctx.drawImage(img, x, currentY);
    currentY += img.height + padding;
  });
  
  // Convert to blob
  return new Promise(resolve => {
    canvas.toBlob(resolve, 'image/png', 0.9);
  });
}

// Convert the AI's Markdown output to HTML so rich-text targets (e.g. Jira's
// description editor) render bold/code/lists instead of showing raw asterisks.
function markdownToHtml(md) {
  const escapeHtml = (s) => s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const inline = (s) => escapeHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  const lines = md.split('\n');
  const html = [];
  let listType = null; // 'ul' | 'ol' | null

  const closeList = () => {
    if (listType) { html.push(`</${listType}>`); listType = null; }
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const heading = line.match(/^##\s+(.+)$/);
    const checkbox = line.match(/^-\s+\[ \]\s*(.*)$/);
    const bullet = line.match(/^[-*]\s+(.+)$/);
    const numbered = line.match(/^\d+\.\s+(.+)$/);

    if (heading) {
      closeList();
      html.push(`<h2>${inline(heading[1])}</h2>`);
    } else if (checkbox) {
      if (listType !== 'ul') { closeList(); html.push('<ul>'); listType = 'ul'; }
      html.push(`<li>☐ ${inline(checkbox[1])}</li>`);
    } else if (bullet) {
      if (listType !== 'ul') { closeList(); html.push('<ul>'); listType = 'ul'; }
      html.push(`<li>${inline(bullet[1])}</li>`);
    } else if (numbered) {
      if (listType !== 'ol') { closeList(); html.push('<ol>'); listType = 'ol'; }
      html.push(`<li>${inline(numbered[1])}</li>`);
    } else if (line.trim() === '') {
      closeList();
      html.push('<br>');
    } else {
      closeList();
      html.push(`<p>${inline(line)}</p>`);
    }
  }
  closeList();
  return html.join('\n');
}

function showCopyFeedback(msg) {
  btnCopy.textContent = msg;
  btnCopy.classList.add("copied");
  setTimeout(() => { btnCopy.innerHTML = "⎘ Copy"; btnCopy.classList.remove("copied"); }, 2000);
}

btnCopy.addEventListener("click", async () => {
  try {
    let textContent = resultTextarea.value;
    
    // Add attachment instructions to text content if we have media
    if (state.videoBlobUrl || state.gifBlobUrl) {
      textContent += '\n\n--- ATTACHMENTS ---\n';
      if (state.videoBlobUrl) {
        textContent += '🎬 1 screen recording (use download button below - cannot be pasted directly)\n';
      }
      if (state.gifBlobUrl) {
        textContent += '🎞️ 1 GIF recording (use download button below - cannot be pasted directly)\n';
      }
    }

    // Prepare clipboard items with multiple formats
    const clipboardItems = {};
    
    // Enhanced text content
    clipboardItems['text/plain'] = new Blob([textContent], { type: 'text/plain' });
    
    // Enhanced HTML version
    let htmlContent = markdownToHtml(resultTextarea.value);

    if (state.videoBlobUrl || state.gifBlobUrl) {
      htmlContent += '<br><br><strong>Attachments:</strong><br>';
      if (state.videoBlobUrl) {
        htmlContent += '🎬 1 screen recording (download separately)<br>';
      }
      if (state.gifBlobUrl) {
        htmlContent += '🎞️ 1 GIF recording (download separately)<br>';
      }
    }

    clipboardItems['text/html'] = new Blob([htmlContent], { type: 'text/html' });
    
    // Strategy: Create a composite image if multiple screenshots, or use single image
    if (state.screenshots.length === 1) {
      // Single screenshot - copy as-is
      try {
        const response = await fetch(state.screenshots[0]);
        const blob = await response.blob();
        clipboardItems['image/png'] = blob;
      } catch (err) {
        console.warn('Failed to include screenshot:', err);
      }
    } else if (state.screenshots.length > 1) {
      // Multiple screenshots - create a composite image
      try {
        const compositeBlob = await createCompositeImage(state.screenshots);
        clipboardItems['image/png'] = compositeBlob;
      } catch (err) {
        console.warn('Failed to create composite image, using first screenshot:', err);
        try {
          const response = await fetch(state.screenshots[0]);
          const blob = await response.blob();
          clipboardItems['image/png'] = blob;
        } catch (err2) {
          console.warn('Failed to include any screenshot:', err2);
        }
      }
    }

    // Write everything to clipboard in one operation
    await navigator.clipboard.write([new ClipboardItem(clipboardItems)]);

    showCopyFeedback("✓ Copied!");
    
    let toastMessage = "Ticket copied to clipboard!";
    if (state.screenshots.length === 1) {
      toastMessage = "Ticket + screenshot copied!";
    } else if (state.screenshots.length > 1) {
      toastMessage = `Ticket + composite image (${state.screenshots.length} screenshots) copied!`;
    }
    if (state.videoBlobUrl || state.gifBlobUrl) {
      toastMessage += " Use download button for video/GIF.";
    }

    showToast(toastMessage, "success");

  } catch (err) {
    console.error('Clipboard copy failed:', err);
    // Fallback to plain text copy
    let fallbackText = resultTextarea.value;
    if (state.videoBlobUrl || state.gifBlobUrl) {
      fallbackText += '\n\n--- ATTACHMENTS ---\n';
      if (state.videoBlobUrl) fallbackText += '🎬 1 screen recording (use download button)\n';
      if (state.gifBlobUrl) fallbackText += '🎞️ 1 GIF recording (use download button)\n';
    }

    await navigator.clipboard.writeText(fallbackText);
    showCopyFeedback("✓ Copied!");
    showToast("Ticket copied! Click screenshots individually or use download button for video/GIF.", "warning");
  }
});

btnRegen.addEventListener("click", () => {
  resultPanel.classList.remove("visible");
  capturePanel.style.display = "block";
  resizeNoteInput(); // was hidden while the result panel showed, so re-measure
  inputEditSection.classList.remove("expanded");
  btnGenerate.click();
});

// ── Input Edit Section Toggle ─────────────────────────────────────────────────
inputEditToggle.addEventListener("click", () => {
  inputEditSection.classList.toggle("expanded");
});

// ── Regenerate from Edit Section ──────────────────────────────────────────────
// Generation is asynchronous (GENERATE_TICKET replies with a generationId, and the
// ticket arrives later via GENERATION_COMPLETE/polling), so rather than awaiting a
// ticket here, copy the edited inputs into the main form and reuse the same
// generate path as the "↺ redo" button — loading bar, cancel, and background
// completion while the popup is closed all keep working.
btnRegenEdit.addEventListener("click", () => {
  const hasScreenshots = state.screenshots.length > 0;
  const hasNotes = editNote.value.trim().length > 0;
  if (!hasScreenshots && !hasNotes) {
    showToast("Add a description or screenshot first", "error");
    return;
  }

  // Update main inputs from edit fields
  noteInput.value = editNote.value;
  fieldComp.value = editComponent.value;
  fieldSev.value = editSeverity.value;
  saveSession();
  updateNoteInputClear();
  updateGenerateBtn();
  // Capture panel is hidden here; btnRegen re-shows it and resizes the note

  btnRegen.click();
});

btnReset.addEventListener("click", async () => {
  const confirmed = await showConfirmDialog(
    "Start New Report?",
    "This will clear all screenshots, notes, and the generated ticket. This cannot be undone.",
    "Clear All"
  );
  if (!confirmed) return;

  state.screenshots = [];
  state.hasRestoredResult = false;
  state.chatHistory = [];
  if (state.videoBlobUrl) {
    URL.revokeObjectURL(state.videoBlobUrl);
    state.videoBlobUrl = null;
  }
  if (state.gifBlobUrl) {
    URL.revokeObjectURL(state.gifBlobUrl);
    state.gifBlobUrl = null;
  }
  // Clear video/GIF recording data
  chrome.storage.local.remove(VIDEO_RECORDING_KEY);
  chrome.storage.local.remove(GIF_RECORDING_KEY);
  noteInput.value = ""; fieldComp.value = ""; fieldSev.value = "Medium";
  resultTextarea.value = "";
  clearSession();
  resultPanel.classList.remove("visible");
  capturePanel.style.display = "block";
  syncNoteInput(); // shrink back to empty size + hide clear button
  $("result-screenshots").style.display = "none";
  if (resultVideo) resultVideo.style.display = "none";
  if (resultGif) resultGif.style.display = "none";
  chatHistory.innerHTML = "";

  // Reset video UI
  videoPreview.style.display = "none";
  if (state.videoRecordingEnabled && btnRecord) {
    btnRecord.style.display = "block";
  }

  // Reset GIF UI
  gifPreview.style.display = "none";
  btnGif.style.display = "block";

  renderGrid(); updateGenerateBtn(); clearError();
  showToast("Bug report cleared", "info");
});

// ── Auth badge → open settings ────────────────────────────────────────────────
authBadge.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("settings.html") });
});

// ── Helpers ───────────────────────────────────────────────────────────────────
// Sync user edits back to content script's finalTranscript during recording
async function syncTranscriptToContentScript() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;
    chrome.tabs.sendMessage(tab.id, {
      type: "SYNC_TRANSCRIPT",
      text: noteInput.value + " "
    });
  } catch (e) { /* ignore */ }
}

function setLoading(on) {
  btnGenerate.disabled = on;
  loadingBar.classList.toggle("visible", on);
  loadingText.classList.toggle("visible", on);
  btnCancelGenerate.style.display = on ? "block" : "none";
  btnGenerate.innerHTML = on ? `<span>⏳</span> Generating…` : `<span>✨</span> Generate Ticket`;
}

btnCancelGenerate.addEventListener("click", async () => {
  if (!state.currentGenerationId) return;
  btnCancelGenerate.disabled = true;
  try {
    await chrome.runtime.sendMessage({ type: "CANCEL_GENERATION", generationId: state.currentGenerationId });
  } catch (e) { /* ignore */ }
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }
  state.currentGenerationId = null;
  setLoading(false);
  btnCancelGenerate.disabled = false;
  showToast("Ticket generation cancelled", "info");
});
function showError(msg) { errorBox.textContent = msg; errorBox.classList.add("visible"); }
function clearError()   { errorBox.classList.remove("visible"); errorBox.textContent = ""; }

// Update clear button visibility based on note input content
function updateNoteInputClear() {
  if (noteInput.value.trim()) {
    noteInputWrap.classList.add("has-text");
  } else {
    noteInputWrap.classList.remove("has-text");
  }
}

// ── Toast Notifications ──────────────────────────────────────────────────────
function showToast(message, type = "info", duration = 3000) {
  const container = $("toast-container");
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add("hiding");
    setTimeout(() => toast.remove(), 200);
  }, duration);
}

// ── Confirmation Dialog ──────────────────────────────────────────────────────
let dialogResolve = null;

function showConfirmDialog(title, message, confirmText = "Confirm") {
  return new Promise((resolve) => {
    dialogResolve = resolve;
    $("dialog-title").textContent = title;
    $("dialog-message").textContent = message;
    $("dialog-confirm").textContent = confirmText;
    $("dialog-overlay").classList.add("visible");
  });
}

$("dialog-cancel").addEventListener("click", () => {
  $("dialog-overlay").classList.remove("visible");
  if (dialogResolve) dialogResolve(false);
});

$("dialog-confirm").addEventListener("click", () => {
  $("dialog-overlay").classList.remove("visible");
  if (dialogResolve) dialogResolve(true);
});

// ── Image Preview Modal ──────────────────────────────────────────────────────
let previewIndex = 0;

function showPreview(index) {
  if (state.screenshots.length === 0) return;
  previewIndex = index;
  $("preview-modal").classList.remove("single");
  showPreviewElement("image");
  updatePreview();
  $("preview-modal").classList.add("visible");
}

// Show one standalone item (the recorded GIF or video) in the same modal — no
// prev/next navigation, and the counter slot shows a caption instead.
function showMediaPreview(src, caption, kind = "image") {
  $("preview-modal").classList.add("single");
  showPreviewElement(kind);
  $("preview-counter").textContent = caption;
  if (kind === "video") {
    const video = $("preview-video");
    video.src = src;
    video.currentTime = 0;
    video.play().catch(() => { /* autoplay blocked or not ready — controls still work */ });
  } else {
    $("preview-image").src = src;
    $("preview-image").alt = caption;
  }
  $("preview-modal").classList.add("visible");
}

// Only one of <img>/<video> is shown at a time; hiding the video also stops it.
function showPreviewElement(kind) {
  $("preview-image").style.display = kind === "image" ? "" : "none";
  $("preview-video").style.display = kind === "video" ? "" : "none";
  if (kind !== "video") stopPreviewVideo();
}

function stopPreviewVideo() {
  const video = $("preview-video");
  video.pause();
  // Drop the source so audio can't keep playing behind the popup after closing
  video.removeAttribute("src");
  video.load();
}

// Every close path (✕, Esc, backdrop) goes through here so video always stops.
function closePreview() {
  $("preview-modal").classList.remove("visible");
  stopPreviewVideo();
}

$("preview-video").addEventListener("error", () => {
  // Ignore the (async) error fired by load() after stopPreviewVideo() removed src
  if (!$("preview-video").getAttribute("src")) return;
  closePreview();
  showToast("Couldn't play the video — try downloading it instead", "error");
});

function isSinglePreview() {
  return $("preview-modal").classList.contains("single");
}

function updatePreview() {
  $("preview-image").src = state.screenshots[previewIndex];
  $("preview-counter").textContent = `${previewIndex + 1} / ${state.screenshots.length}`;
}

$("preview-modal").addEventListener("click", (e) => {
  if (e.target === $("preview-modal")) closePreview();
});

$("preview-close").addEventListener("click", closePreview);

$("preview-prev").addEventListener("click", (e) => {
  e.stopPropagation();
  if (isSinglePreview()) return; // arrow keys still call .click() on the hidden buttons
  previewIndex = (previewIndex - 1 + state.screenshots.length) % state.screenshots.length;
  updatePreview();
});

$("preview-next").addEventListener("click", (e) => {
  e.stopPropagation();
  if (isSinglePreview()) return;
  previewIndex = (previewIndex + 1) % state.screenshots.length;
  updatePreview();
});

// Keyboard navigation for preview
document.addEventListener("keydown", (e) => {
  if ($("preview-modal").classList.contains("visible")) {
    if (e.key === "Escape") closePreview();
    if (e.key === "ArrowLeft") $("preview-prev").click();
    if (e.key === "ArrowRight") $("preview-next").click();
  }
});

// ── Chat with AI ──────────────────────────────────────────────────────────────
function renderChatHistory() {
  chatHistory.innerHTML = "";
  state.chatHistory.forEach(msg => {
    const div = document.createElement("div");
    div.className = `chat-message ${msg.role}`;
    div.textContent = msg.content;
    chatHistory.appendChild(div);
  });
  // Scroll to bottom
  chatHistory.scrollTop = chatHistory.scrollHeight;
}

btnImprove.addEventListener("click", async () => {
  const feedback = chatInput.value.trim();
  if (!feedback) return;
  if (!resultTextarea.value) return;

  // Snapshot history *before* adding this message — background sends `feedback`
  // separately as NEW FEEDBACK, so including it here would duplicate it in the prompt.
  const priorHistory = state.chatHistory.slice();

  // Add user message to chat
  state.chatHistory.push({ role: "user", content: feedback });
  renderChatHistory();
  chatInput.value = "";

  // Show loading state
  btnImprove.disabled = true;
  btnImprove.classList.add("loading");
  btnImprove.innerHTML = "<span>⟳</span>";

  try {
    const res = await chrome.runtime.sendMessage({
      type: "IMPROVE_TICKET",
      payload: {
        currentTicket: resultTextarea.value,
        feedback,
        chatHistory: priorHistory,
        screenshots: state.screenshots
      }
    });

    if (res?.ok && res.ticket) {
      // Add AI response to chat
      state.chatHistory.push({ role: "ai", content: "Ticket updated ✓" });
      renderChatHistory();

      // Update ticket
      resultTextarea.value = res.ticket;
      saveResult();
      showToast("Ticket improved!", "success");
    } else {
      state.chatHistory.push({ role: "ai", content: "Error: " + (res?.error || "Failed") });
      renderChatHistory();
      showToast("Error: " + (res?.error || "Failed"), "error");
    }
  } catch (e) {
    state.chatHistory.push({ role: "ai", content: "Error: " + e.message });
    renderChatHistory();
    showToast("Error: " + e.message, "error");
  } finally {
    btnImprove.disabled = false;
    btnImprove.classList.remove("loading");
    btnImprove.innerHTML = "<span>↑</span>";
  }
});

// Allow Enter to send (Shift+Enter for newline)
chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    btnImprove.click();
  }
});

init();

// Note: Video trimming functionality moved to recorder.js screen for better UX
