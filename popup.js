// popup.js — BugReporter extension popup controller

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
};

const MAX_SCREENSHOTS = 6;
const STORAGE_KEY = "bugReporterSession";

// ── DOM refs ─────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const authBadge      = $("auth-badge");
const btnCapture     = $("btn-capture");
const btnMic         = $("btn-mic");
const btnGenerate    = $("btn-generate");
const btnCopy        = $("btn-copy");
const btnRegen       = $("btn-regen");
const btnReset       = $("btn-reset");
const noteInput      = $("note-input");
const fieldComp      = $("field-component");
const fieldSev       = $("field-severity");
const screenshotGrid = $("screenshot-grid");
const shotCount      = $("shot-count");
const loadingBar     = $("loading-bar");
const loadingText    = $("loading-text");
const errorBox       = $("error-box");
const capturePanel   = $("capture-panel");
const resultPanel    = $("result-panel");
const resultTextarea = $("result-textarea");
const pageMeta       = $("page-meta");

// ── Persist session ───────────────────────────────────────────────────────────
function saveSession(includeResult = false) {
  const data = {
    screenshots: state.screenshots,
    note:        noteInput.value,
    component:   fieldComp.value,
    severity:    fieldSev.value,
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
      resolve(enabledFields);
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
      pageMeta.textContent = domain.length > 30 ? domain.slice(0, 28) + "…" : domain;
    }
  } catch (e) {
    pageMeta.textContent = "Unknown page";
  }

  await restoreSession();
  await loadFieldSettings();

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

  noteInput.addEventListener("input",  () => { updateSteps(); updateGenerateBtn(); saveSession(); });
  fieldComp.addEventListener("input",  saveSession);
  fieldSev.addEventListener("change",  saveSession);

  setupSpeechRecognition();
  renderGrid();
  updateGenerateBtn();

  // Restore result panel if we had a generated ticket
  if (state.hasRestoredResult) {
    showRestoredResult();
  }
}

// ── Speech Recognition (via content script) ──────────────────────────────────
function setupSpeechRecognition() {
  // Listen for messages from content script
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "MIC_STATE") {
      state.isListening = msg.listening;
      if (msg.listening) {
        btnMic.classList.add("recording");
        btnMic.textContent = "⏹️";
        btnMic.title = "Stop recording";
      } else {
        btnMic.classList.remove("recording");
        btnMic.textContent = "🎙️";
        btnMic.title = "Record voice note";
      }
    }

    if (msg.type === "MIC_TRANSCRIPT") {
      noteInput.value = msg.text;
      updateSteps();
      updateGenerateBtn();
      if (msg.isFinal) {
        saveSession();
      }
    }

    if (msg.type === "MIC_ERROR") {
      state.isListening = false;
      btnMic.classList.remove("recording");
      btnMic.textContent = "🎙️";
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
        }
      });
    } catch (err) {
      showError("Failed to toggle mic: " + err.message);
    }
  });
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
    thumb.appendChild(delBtn);
    screenshotGrid.appendChild(thumb);
  });

  const remaining = Math.min(3, MAX_SCREENSHOTS - state.screenshots.length);
  for (let i = 0; i < remaining; i++) {
    const empty = document.createElement("div");
    empty.className = "screenshot-empty";
    empty.textContent = "+";
    screenshotGrid.appendChild(empty);
  }

  shotCount.style.display = state.screenshots.length > 0 ? "inline-flex" : "none";
  shotCount.textContent = state.screenshots.length;
  updateSteps();
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
btnCapture.addEventListener("click", async () => {
  if (state.screenshots.length >= MAX_SCREENSHOTS) {
    showError(`Max ${MAX_SCREENSHOTS} screenshots. Remove one first.`); return;
  }
  btnCapture.disabled = true;
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

// ── Generate ──────────────────────────────────────────────────────────────────
function updateGenerateBtn() {
  const has = state.screenshots.length > 0;
  btnGenerate.disabled = !has;
  btnGenerate.innerHTML = has
    ? `<span>✨</span> Generate Ticket`
    : `<span>📸</span> Capture a screenshot first`;
}

btnGenerate.addEventListener("click", async () => {
  if (state.screenshots.length === 0) return;
  setLoading(true); clearError();

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
    if (res?.ok) {
      showResult(res.ticket);
      showToast("Ticket generated successfully!", "success");
    } else {
      showError("Gemini error: " + (res?.error || "Check API key in Settings ⚙️"));
    }
  } catch (e) {
    showError("Failed: " + e.message);
  } finally {
    setLoading(false);
  }
});

// ── Result ────────────────────────────────────────────────────────────────────
function showResult(ticket) {
  resultTextarea.value = ticket;
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

  // Show screenshot previews if there are screenshots
  const screenshotsContainer = $("result-screenshots");
  const screenshotsGrid = $("result-screenshots-grid");
  if (state.screenshots.length > 0) {
    screenshotsGrid.innerHTML = "";
    state.screenshots.forEach((src, i) => {
      const img = document.createElement("img");
      img.src = src;
      img.alt = `Screenshot ${i + 1}`;
      img.title = `Screenshot ${i + 1} - Click to copy`;
      img.style.cssText = "max-width: 110px; height: auto; border-radius: 4px; border: 1px solid var(--border); cursor: pointer;";
      img.addEventListener("click", () => copyImageToClipboard(src, i + 1));
      screenshotsGrid.appendChild(img);
    });
    screenshotsContainer.style.display = "block";
  } else {
    screenshotsContainer.style.display = "none";
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

function showCopyFeedback(msg) {
  btnCopy.textContent = msg;
  btnCopy.classList.add("copied");
  setTimeout(() => { btnCopy.innerHTML = "⎘ Copy"; btnCopy.classList.remove("copied"); }, 2000);
}

btnCopy.addEventListener("click", async () => {
  try {
    // Try to copy as rich HTML with images for rich text editors
    const textContent = resultTextarea.value;

    // Create HTML version with embedded images
    let htmlContent = textContent
      .replace(/^## (.+)$/gm, '<h2>$1</h2>')
      .replace(/\n/g, '<br>');

    // Try to write both HTML and plain text to clipboard
    const textBlob = new Blob([textContent], { type: 'text/plain' });
    const htmlBlob = new Blob([htmlContent], { type: 'text/html' });

    await navigator.clipboard.write([
      new ClipboardItem({
        'text/plain': textBlob,
        'text/html': htmlBlob
      })
    ]);

    showCopyFeedback("✓ Copied!");
    showToast("Ticket copied to clipboard!", "success");
  } catch (err) {
    // Fallback to plain text copy
    await navigator.clipboard.writeText(resultTextarea.value);
    showCopyFeedback("✓ Copied!");
    showToast("Ticket copied to clipboard!", "success");
  }
});

btnRegen.addEventListener("click", () => {
  resultPanel.classList.remove("visible");
  capturePanel.style.display = "block";
  btnGenerate.click();
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
  noteInput.value = ""; fieldComp.value = ""; fieldSev.value = "Medium";
  resultTextarea.value = "";
  clearSession();
  resultPanel.classList.remove("visible");
  capturePanel.style.display = "block";
  $("result-screenshots").style.display = "none";
  renderGrid(); updateGenerateBtn(); clearError();
  showToast("Bug report cleared", "info");
});

// ── Auth badge → open settings ────────────────────────────────────────────────
authBadge.addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("settings.html") });
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function setLoading(on) {
  btnGenerate.disabled = on;
  loadingBar.classList.toggle("visible", on);
  loadingText.classList.toggle("visible", on);
  btnGenerate.innerHTML = on ? `<span>⏳</span> Analyzing…` : `<span>✨</span> Generate Ticket`;
}
function showError(msg) { errorBox.textContent = msg; errorBox.classList.add("visible"); }
function clearError()   { errorBox.classList.remove("visible"); errorBox.textContent = ""; }

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
  updatePreview();
  $("preview-modal").classList.add("visible");
}

function updatePreview() {
  $("preview-image").src = state.screenshots[previewIndex];
  $("preview-counter").textContent = `${previewIndex + 1} / ${state.screenshots.length}`;
}

$("preview-modal").addEventListener("click", (e) => {
  if (e.target === $("preview-modal")) {
    $("preview-modal").classList.remove("visible");
  }
});

$("preview-close").addEventListener("click", () => {
  $("preview-modal").classList.remove("visible");
});

$("preview-prev").addEventListener("click", (e) => {
  e.stopPropagation();
  previewIndex = (previewIndex - 1 + state.screenshots.length) % state.screenshots.length;
  updatePreview();
});

$("preview-next").addEventListener("click", (e) => {
  e.stopPropagation();
  previewIndex = (previewIndex + 1) % state.screenshots.length;
  updatePreview();
});

// Keyboard navigation for preview
document.addEventListener("keydown", (e) => {
  if ($("preview-modal").classList.contains("visible")) {
    if (e.key === "Escape") $("preview-modal").classList.remove("visible");
    if (e.key === "ArrowLeft") $("preview-prev").click();
    if (e.key === "ArrowRight") $("preview-next").click();
  }
});

init();
